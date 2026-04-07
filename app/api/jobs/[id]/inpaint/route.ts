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
    const { mask, maskPath } = await request.json()
    if (!mask && !maskPath) {
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

    let maskBuffer: Buffer

    if (maskPath) {
      // Click mode: download full-resolution mask saved by segment route — no canvas round-trip
      const { data: maskDownload, error: dlErr } = await supabaseServer.storage
        .from('processed')
        .download(maskPath)
      if (dlErr || !maskDownload) throw new Error('Failed to download stored mask')
      const rawMask = Buffer.from(await maskDownload.arrayBuffer())
      // Dilate mask so LaMa has context to blend edges cleanly.
      // blur(15) expands ~15px beyond SAM edges, then threshold(60) binarises hard.
      // normalise() first ensures full 0-255 range before threshold.
      maskBuffer = await sharp(rawMask)
        .resize(imgWidth, imgHeight, { fit: 'fill' })
        .normalise()
        .blur(15)
        .normalise()
        .threshold(60)
        .png()
        .toBuffer()
    } else {
      // Brush mode: canvas base64 → resize to image dims → light smoothing
      const base64Data = mask.replace(/^data:image\/png;base64,/, '')
      const rawMaskBuffer = Buffer.from(base64Data, 'base64')
      maskBuffer = await sharp(rawMaskBuffer)
        .resize(imgWidth, imgHeight, { fit: 'fill' })
        .blur(5)
        .threshold(128)
        .png()
        .toBuffer()
    }

    const uploadPath = `${id}_mask.png`
    await supabaseServer.storage.from('processed').upload(uploadPath, maskBuffer, {
      contentType: 'image/png',
      upsert: true,
    })
    const { data: maskUrlData } = supabaseServer.storage.from('processed').getPublicUrl(uploadPath)
    const maskPublicUrl = maskUrlData.publicUrl

    // LaMa inpainting — use pinned version that is confirmed working
    const LAMA_VERSION = '0e3a841c913f597c1e4c321560aa69e2bc1f15c65f8c366caafc379240efd8ba'

    const lamaPrediction = await replicate.predictions.create({
      version: LAMA_VERSION,
      input: {
        image: imageUrl,
        mask: maskPublicUrl,
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
