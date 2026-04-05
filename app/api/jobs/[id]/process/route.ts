import { NextRequest } from 'next/server'
import { supabaseServer } from '@/lib/supabase'
import { replicate } from '@/lib/replicate'

export const runtime = 'nodejs'
export const maxDuration = 30

const CLUTTER_PROMPT = 'bottles, bags, handbag, purse, laundry, dishes, cups, personal care products, cosmetics, toiletries, clothing, shoes, socks, toys, clutter, mess, personal items'
const NEGATIVE_MASK_PROMPT = 'sink, toilet, bathtub, shower, furniture, wall, floor, ceiling, door, window, mirror, bed, sofa, couch, chair, table, lamp'

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

    // Step 1: Start grounded_sam to detect clutter and generate mask
    const samModel = await replicate.models.get('schananas', 'grounded_sam')
    const samVersion = samModel.latest_version?.id
    if (!samVersion) throw new Error('Could not get latest version of schananas/grounded_sam')

    const samPrediction = await replicate.predictions.create({
      version: samVersion,
      input: {
        image: signedUrlData.signedUrl,
        mask_prompt: CLUTTER_PROMPT,
        negative_mask_prompt: NEGATIVE_MASK_PROMPT,
        adjustment_factor: 5,
      },
    })

    // Save prediction ID and update status to 'enhancing' (detecting stage)
    await supabaseServer
      .from('jobs')
      .update({
        status: 'enhancing',
        replicate_id_sam: samPrediction.id,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)

    return Response.json({ message: 'Processing started', jobId: id })
  } catch (error) {
    console.error('Failed to start processing:', error)
    await supabaseServer
      .from('jobs')
      .update({
        status: 'error',
        error_message: error instanceof Error ? error.message : 'Unknown error',
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
    return Response.json(
      { error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}
