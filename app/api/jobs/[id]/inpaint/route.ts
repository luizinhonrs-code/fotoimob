import { NextRequest } from 'next/server'
import { supabaseServer } from '@/lib/supabase'
import { replicate } from '@/lib/replicate'
import sharp from 'sharp'

export const runtime = 'nodejs'
export const maxDuration = 30

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  try {
    const { mask, maskPublicUrl } = await request.json()
    if (!mask && !maskPublicUrl) {
      return Response.json({ error: 'Mask is required' }, { status: 400 })
    }

    const { data: job, error } = await supabaseServer
      .from('jobs')
      .select('*')
      .eq('id', id)
      .single()

    if (error || !job) {
      return Response.json({ error: 'Job not found' }, { status: 404 })
    }

    // Determine source image: use already-processed image if available, else original
    let imageUrl: string
    if (job.decluttered_url) {
      imageUrl = job.decluttered_url
    } else {
      const { data: signedUrlData, error: signedUrlError } = await supabaseServer.storage
        .from('originals')
        .createSignedUrl(job.original_filename, 3600)
      if (signedUrlError || !signedUrlData?.signedUrl) {
        return Response.json({ error: 'Failed to get image URL' }, { status: 500 })
      }
      imageUrl = signedUrlData.signedUrl
    }

    // Get source image dimensions so we can resize mask to match exactly
    const imgResponse = await fetch(imageUrl)
    const imgBuffer = Buffer.from(await imgResponse.arrayBuffer())
    const imgMeta = await sharp(imgBuffer).metadata()
    const imgWidth = imgMeta.width!
    const imgHeight = imgMeta.height!

    let finalMaskUrl: string

    if (maskPublicUrl) {
      // Click mode: download clean SAM mask, apply manual pixel-level dilation (+20px box),
      // then re-upload. Manual dilation guarantees a hard binary mask — Sharp's blur+threshold
      // pipeline produces a gradient that confuses LaMa.
      const maskRes = await fetch(maskPublicUrl)
      const rawMask = Buffer.from(await maskRes.arrayBuffer())

      // Get raw greyscale pixels
      const { data: pixels, info } = await sharp(rawMask)
        .greyscale()
        .raw()
        .toBuffer({ resolveWithObject: true })

      const w = info.width
      const h = info.height
      const R = 20 // dilation radius in pixels

      // Forward-mark dilation: for each white source pixel, mark all pixels
      // within an R×R box as white in the output. Guaranteed binary output.
      const dilated = Buffer.alloc(w * h, 0)
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (pixels[y * w + x] > 128) {
            const yMin = Math.max(0, y - R)
            const yMax = Math.min(h - 1, y + R)
            const xMin = Math.max(0, x - R)
            const xMax = Math.min(w - 1, x + R)
            for (let ny = yMin; ny <= yMax; ny++) {
              dilated.fill(255, ny * w + xMin, ny * w + xMax + 1)
            }
          }
        }
      }

      const dilatedMask = await sharp(dilated, { raw: { width: w, height: h, channels: 1 } })
        .png()
        .toBuffer()

      const dilatedPath = `${id}_mask.png`
      await supabaseServer.storage.from('processed').upload(dilatedPath, dilatedMask, {
        contentType: 'image/png',
        upsert: true,
      })
      const { data: dilatedUrlData } = supabaseServer.storage.from('processed').getPublicUrl(dilatedPath)
      finalMaskUrl = dilatedUrlData.publicUrl
    } else {
      // Brush mode: canvas base64 → resize to image dims → slight smoothing → upload
      const base64Data = mask.replace(/^data:image\/png;base64,/, '')
      const rawMaskBuffer = Buffer.from(base64Data, 'base64')
      const maskBuffer = await sharp(rawMaskBuffer)
        .resize(imgWidth, imgHeight, { fit: 'fill' })
        .blur(5)
        .threshold(128)
        .png()
        .toBuffer()
      const uploadPath = `${id}_mask.png`
      await supabaseServer.storage.from('processed').upload(uploadPath, maskBuffer, {
        contentType: 'image/png',
        upsert: true,
      })
      const { data: maskUrlData } = supabaseServer.storage.from('processed').getPublicUrl(uploadPath)
      finalMaskUrl = maskUrlData.publicUrl
    }

    // LaMa inpainting — use pinned version that is confirmed working
    const LAMA_VERSION = '0e3a841c913f597c1e4c321560aa69e2bc1f15c65f8c366caafc379240efd8ba'

    const lamaPrediction = await replicate.predictions.create({
      version: LAMA_VERSION,
      input: {
        image: imageUrl,
        mask: finalMaskUrl,
      },
    })

    await supabaseServer.from('jobs').update({
      status: 'decluttering',
      replicate_id_inpaint: lamaPrediction.id,
      replicate_id_enhance: null,
      error_message: null,
      updated_at: new Date().toISOString(),
    }).eq('id', id)

    return Response.json({ message: 'Removal started', jobId: id })
  } catch (error) {
    console.error('Inpaint error:', error)
    await supabaseServer.from('jobs').update({
      status: 'error',
      error_message: error instanceof Error ? error.message : 'Unknown error',
      updated_at: new Date().toISOString(),
    }).eq('id', id)
    return Response.json(
      { error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}
