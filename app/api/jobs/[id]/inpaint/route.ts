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
    const { mask, maskPublicUrl, maskPaths } = await request.json()
    if (!mask && !maskPublicUrl && (!maskPaths || maskPaths.length === 0)) {
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

    if (maskPaths && maskPaths.length > 0) {
      // Download all selected SAM masks and combine with pixel OR
      const allRaws = await Promise.all(
        (maskPaths as string[]).map(async (path) => {
          const { data, error } = await supabaseServer.storage.from('processed').download(path)
          if (error || !data) return null
          const buf = Buffer.from(await data.arrayBuffer())
          const { data: raw } = await sharp(buf)
            .resize(imgWidth, imgHeight, { fit: 'fill' })
            .greyscale()
            .raw()
            .toBuffer({ resolveWithObject: true })
          return raw as Buffer
        })
      )

      // OR-combine SAM masks
      const combined = Buffer.alloc(imgWidth * imgHeight, 0)
      for (const raw of allRaws) {
        if (!raw) continue
        for (let i = 0; i < raw.length; i++) {
          if (raw[i] > 128) combined[i] = 255
        }
      }

      // Also OR-combine brush canvas mask if provided (shadows painted by user)
      if (mask) {
        const base64Data = (mask as string).replace(/^data:image\/png;base64,/, '')
        const brushBuf = Buffer.from(base64Data, 'base64')
        const { data: brushRaw } = await sharp(brushBuf)
          .resize(imgWidth, imgHeight, { fit: 'fill' })
          .greyscale()
          .raw()
          .toBuffer({ resolveWithObject: true })
        for (let i = 0; i < (brushRaw as Buffer).length; i++) {
          if ((brushRaw as Buffer)[i] > 10) combined[i] = 255
        }
      }

      // Manual pixel dilation R=20 on SAM areas only (brush areas already have user margin)
      const R = 20
      const dilated = Buffer.from(combined) // start with combined (brush areas already included)
      for (let y = 0; y < imgHeight; y++) {
        for (let x = 0; x < imgWidth; x++) {
          if (combined[y * imgWidth + x] > 128) {
            const yMin = Math.max(0, y - R)
            const yMax = Math.min(imgHeight - 1, y + R)
            const xMin = Math.max(0, x - R)
            const xMax = Math.min(imgWidth - 1, x + R)
            for (let ny = yMin; ny <= yMax; ny++) {
              dilated.fill(255, ny * imgWidth + xMin, ny * imgWidth + xMax + 1)
            }
          }
        }
      }

      const dilatedPng = await sharp(dilated, { raw: { width: imgWidth, height: imgHeight, channels: 1 } })
        .png()
        .toBuffer()

      const uploadPath = `${id}_mask.png`
      await supabaseServer.storage.from('processed').upload(uploadPath, dilatedPng, {
        contentType: 'image/png', upsert: true,
      })
      const { data: urlData } = supabaseServer.storage.from('processed').getPublicUrl(uploadPath)
      finalMaskUrl = urlData.publicUrl

    } else if (maskPublicUrl) {
      // Legacy single-mask URL path (kept for backward compat)
      const maskRes = await fetch(maskPublicUrl as string)
      const rawMask = Buffer.from(await maskRes.arrayBuffer())
      const { data: pixels, info } = await sharp(rawMask).greyscale().raw().toBuffer({ resolveWithObject: true })
      const w = info.width, h = info.height, R = 20
      const dilated = Buffer.alloc(w * h, 0)
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if ((pixels as Buffer)[y * w + x] > 128) {
            const yMin = Math.max(0, y - R), yMax = Math.min(h - 1, y + R)
            const xMin = Math.max(0, x - R), xMax = Math.min(w - 1, x + R)
            for (let ny = yMin; ny <= yMax; ny++) dilated.fill(255, ny * w + xMin, ny * w + xMax + 1)
          }
        }
      }
      const dilatedPng = await sharp(dilated, { raw: { width: w, height: h, channels: 1 } }).png().toBuffer()
      const uploadPath = `${id}_mask.png`
      await supabaseServer.storage.from('processed').upload(uploadPath, dilatedPng, { contentType: 'image/png', upsert: true })
      const { data: urlData } = supabaseServer.storage.from('processed').getPublicUrl(uploadPath)
      finalMaskUrl = urlData.publicUrl

    } else {
      // Brush mode: canvas base64 → resize to image dims → slight smoothing → upload
      const base64Data = (mask as string).replace(/^data:image\/png;base64,/, '')
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
