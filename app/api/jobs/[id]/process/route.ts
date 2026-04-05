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

    // Start enhancement prediction (using model name, no version hash needed)
    const enhancePrediction = await replicate.predictions.create({
      model: 'philz1337x/clarity-upscaler',
      input: {
        image: signedUrlData.signedUrl,
        scale_factor: 2,
        sharpen: 0.2,
        creativity: 0.35,
        resemblance: 0.6,
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
