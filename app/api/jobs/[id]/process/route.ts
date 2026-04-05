import { NextRequest } from 'next/server'
import { supabaseServer } from '@/lib/supabase'
import { replicate, ENHANCE_VERSION } from '@/lib/replicate'

export const runtime = 'nodejs'
export const maxDuration = 30

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params

    const { data: job, error } = await supabaseServer
      .from('jobs')
      .select('*')
      .eq('id', id)
      .single()

    if (error || !job) {
      return Response.json({ error: 'Job not found' }, { status: 404 })
    }

    if (job.status !== 'pending' && job.status !== 'error') {
      return Response.json({ error: `Job is already ${job.status}` }, { status: 400 })
    }

    // Get signed URL for original image
    const { data: signedUrlData, error: signedUrlError } = await supabaseServer.storage
      .from('originals')
      .createSignedUrl(job.original_filename, 3600)

    if (signedUrlError || !signedUrlData?.signedUrl) {
      return Response.json({ error: 'Failed to get signed URL' }, { status: 500 })
    }

    // Fetch latest version of the enhancement model dynamically
    const enhanceModel = await replicate.models.get('nightmareai', 'real-esrgan')
    const enhanceVersion = enhanceModel.latest_version?.id
    if (!enhanceVersion) throw new Error('Could not get latest version of real-esrgan')

    // Start enhancement prediction
    const enhancePrediction = await replicate.predictions.create({
      version: enhanceVersion,
      input: {
        image: signedUrlData.signedUrl,
        scale_factor: 2,
        face_enhance: false,
        model: 'RealESRGAN_x4plus',
      },
    })

    // Save prediction ID and update status
    await supabaseServer
      .from('jobs')
      .update({
        status: 'enhancing',
        replicate_id_enhance: enhancePrediction.id,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)

    return Response.json({ message: 'Processing started', jobId: id })
  } catch (error) {
    console.error('Failed to start processing:', error)
    return Response.json(
      { error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}
