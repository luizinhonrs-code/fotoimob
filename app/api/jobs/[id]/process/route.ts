import { NextRequest } from 'next/server'
import { supabaseServer } from '@/lib/supabase'
import {
  replicate,
  pollPrediction,
  ENHANCE_VERSION,
  SAM_VERSION,
  INPAINT_VERSION,
  CLUTTER_PROMPT,
} from '@/lib/replicate'

export const runtime = 'nodejs'
// Allow long-running processing (up to 10 minutes)
export const maxDuration = 600

async function updateJob(jobId: string, updates: Record<string, unknown>) {
  const { error } = await supabaseServer
    .from('jobs')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', jobId)

  if (error) {
    console.error('Failed to update job:', error)
  }
}

async function saveToProcessedBucket(
  imageUrl: string,
  filename: string
): Promise<string> {
  // Fetch the image
  const response = await fetch(imageUrl)
  if (!response.ok) {
    throw new Error(`Failed to fetch image from ${imageUrl}: ${response.statusText}`)
  }

  const arrayBuffer = await response.arrayBuffer()
  const buffer = Buffer.from(arrayBuffer)
  const contentType = response.headers.get('content-type') || 'image/jpeg'
  const ext = contentType.includes('png') ? 'png' : 'jpg'
  const storagePath = `${filename}.${ext}`

  const { error } = await supabaseServer.storage
    .from('processed')
    .upload(storagePath, buffer, {
      contentType,
      upsert: true,
    })

  if (error) {
    throw new Error(`Failed to upload to processed bucket: ${error.message}`)
  }

  // Get public URL (processed bucket is public)
  const { data: urlData } = supabaseServer.storage
    .from('processed')
    .getPublicUrl(storagePath)

  return urlData.publicUrl
}

async function processJob(jobId: string) {
  try {
    // Get job from DB
    const { data: job, error: jobError } = await supabaseServer
      .from('jobs')
      .select('*')
      .eq('id', jobId)
      .single()

    if (jobError || !job) {
      console.error('Job not found:', jobId)
      return
    }

    // Step 1: Enhancement
    await updateJob(jobId, { status: 'enhancing' })

    // Get a fresh signed URL for the original
    const { data: signedUrlData, error: signedUrlError } = await supabaseServer.storage
      .from('originals')
      .createSignedUrl(job.original_filename, 3600)

    if (signedUrlError || !signedUrlData?.signedUrl) {
      throw new Error(`Failed to get signed URL: ${signedUrlError?.message}`)
    }

    const originalSignedUrl = signedUrlData.signedUrl

    const enhancePrediction = await replicate.predictions.create({
      version: ENHANCE_VERSION,
      input: {
        image: originalSignedUrl,
        scale_factor: 2,
        sharpen: 0.2,
        creativity: 0.35,
        resemblance: 0.6,
      },
    })

    await updateJob(jobId, { replicate_id_enhance: enhancePrediction.id })

    const enhancedResult = await pollPrediction(enhancePrediction.id)

    // Extract the output URL
    let enhancedOutputUrl: string
    if (Array.isArray(enhancedResult.output)) {
      enhancedOutputUrl = enhancedResult.output[0]
    } else if (typeof enhancedResult.output === 'string') {
      enhancedOutputUrl = enhancedResult.output
    } else {
      throw new Error('Unexpected enhancement output format')
    }

    // Save enhanced image to Supabase processed bucket
    const enhancedUrl = await saveToProcessedBucket(
      enhancedOutputUrl,
      `${jobId}_enhanced`
    )

    await updateJob(jobId, { enhanced_url: enhancedUrl, status: 'decluttering' })

    // Step 2: Grounded SAM to detect clutter
    const samPrediction = await replicate.predictions.create({
      version: SAM_VERSION,
      input: {
        image: enhancedUrl,
        prompt: CLUTTER_PROMPT,
        box_threshold: 0.3,
        text_threshold: 0.25,
      },
    })

    await updateJob(jobId, { replicate_id_sam: samPrediction.id })

    const samResult = await pollPrediction(samPrediction.id)

    // Step 3: Inpainting if mask found
    const hasMask =
      samResult.output &&
      typeof samResult.output === 'object' &&
      'mask' in samResult.output &&
      samResult.output.mask

    if (hasMask) {
      const maskUrl = (samResult.output as { mask: string }).mask

      const inpaintPrediction = await replicate.predictions.create({
        version: INPAINT_VERSION,
        input: {
          image: enhancedUrl,
          mask: maskUrl,
          prompt:
            'clean empty floor, clean counter, professional real estate photo, tidy room, no clutter',
          num_inference_steps: 50,
          guidance_scale: 7.5,
        },
      })

      await updateJob(jobId, { replicate_id_inpaint: inpaintPrediction.id })

      const inpaintResult = await pollPrediction(inpaintPrediction.id)

      let inpaintOutputUrl: string
      if (Array.isArray(inpaintResult.output)) {
        inpaintOutputUrl = inpaintResult.output[0]
      } else if (typeof inpaintResult.output === 'string') {
        inpaintOutputUrl = inpaintResult.output
      } else {
        throw new Error('Unexpected inpainting output format')
      }

      const finalUrl = await saveToProcessedBucket(inpaintOutputUrl, `${jobId}_final`)

      await updateJob(jobId, {
        decluttered_url: finalUrl,
        status: 'done',
      })
    } else {
      // No clutter found, use enhanced as final
      await updateJob(jobId, {
        decluttered_url: enhancedUrl,
        status: 'done',
      })
    }
  } catch (error) {
    console.error(`Processing failed for job ${jobId}:`, error)
    await updateJob(jobId, {
      status: 'error',
      error_message: error instanceof Error ? error.message : 'Unknown processing error',
    })
  }
}

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params

    // Verify job exists
    const { data: job, error } = await supabaseServer
      .from('jobs')
      .select('id, status')
      .eq('id', id)
      .single()

    if (error || !job) {
      return Response.json({ error: 'Job not found' }, { status: 404 })
    }

    if (job.status !== 'pending' && job.status !== 'error') {
      return Response.json(
        { error: `Job is already ${job.status}` },
        { status: 400 }
      )
    }

    // Start processing in background (don't await)
    processJob(id).catch((err) => {
      console.error('Background processing error:', err)
    })

    return Response.json({ message: 'Processing started', jobId: id })
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}
