import { NextRequest } from 'next/server'
import { supabaseServer } from '@/lib/supabase'
import { replicate } from '@/lib/replicate'

export const runtime = 'nodejs'
export const maxDuration = 30

const EDIT_PROMPT =
  'High-end professional real estate photograph, strictly maintaining original colors, architecture, and layout. ' +
  'Balanced natural lighting with a bright, clean, and inviting atmosphere. ' +
  'Non-destructive enhancement: improve clarity and exposure without oversaturating or shifting color tones. ' +
  'For interiors: meticulously tidy and decluttered surfaces, removing personal items while keeping original furniture. ' +
  'For exteriors: clean and pristine environment, removing ground debris or stains. ' +
  'Optimize highlights and shadows for a natural HDR look, keeping vibrant but true-to-life color accuracy. ' +
  'Sharp, crisp textures on all original materials. No new objects added, strictly improving the existing scene.'

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  try {
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

    // Start p-image-edit prediction (async — status route polls for completion)
    const prediction = await replicate.predictions.create({
      model: 'prunaai/p-image-edit',
      input: {
        image: signedUrlData.signedUrl,
        prompt: EDIT_PROMPT,
        ratio: 'match_input',
        seed: 992629,
      },
    })

    await supabaseServer.from('jobs').update({
      status: 'editing',
      replicate_id_edit: prediction.id,
      replicate_id_enhance: null,
      replicate_id_inpaint: null,
      replicate_id_upscale: null,
      error_message: null,
      updated_at: new Date().toISOString(),
    }).eq('id', id)

    return Response.json({ message: 'Edit started', jobId: id })
  } catch (error) {
    console.error('Failed to start edit:', error)
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
