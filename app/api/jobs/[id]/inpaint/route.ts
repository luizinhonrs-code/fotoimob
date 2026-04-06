import { NextRequest } from 'next/server'
import { supabaseServer } from '@/lib/supabase'
import { replicate } from '@/lib/replicate'

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

    // Upload mask to Supabase
    const base64Data = mask.replace(/^data:image\/png;base64,/, '')
    const maskBuffer = Buffer.from(base64Data, 'base64')
    const maskPath = `${id}_mask.png`

    await supabaseServer.storage.from('processed').upload(maskPath, maskBuffer, {
      contentType: 'image/png',
      upsert: true,
    })
    const { data: maskUrlData } = supabaseServer.storage.from('processed').getPublicUrl(maskPath)
    const maskPublicUrl = maskUrlData.publicUrl

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

    // Start LaMa inpainting
    const lamaModel = await replicate.models.get('zylim0702', 'remove-object')
    const lamaVersion = lamaModel.latest_version?.id
    if (!lamaVersion) throw new Error('Could not get remove-object model version')

    const lamaPrediction = await replicate.predictions.create({
      version: lamaVersion,
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
