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
    const { mask } = await request.json()
    if (!mask) {
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

    // Decode mask from base64, resize to match image dimensions
    const base64Data = mask.replace(/^data:image\/png;base64,/, '')
    const rawMaskBuffer = Buffer.from(base64Data, 'base64')
    const maskBuffer = await sharp(rawMaskBuffer)
      .resize(imgWidth, imgHeight, { fit: 'fill' })
      .png()
      .toBuffer()

    const maskPath = `${id}_mask.png`
    await supabaseServer.storage.from('processed').upload(maskPath, maskBuffer, {
      contentType: 'image/png',
      upsert: true,
    })
    const { data: maskUrlData } = supabaseServer.storage.from('processed').getPublicUrl(maskPath)
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
