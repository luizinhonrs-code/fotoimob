import { NextRequest } from 'next/server'
import { supabaseServer } from '@/lib/supabase'
import { replicate, SAM_VERSION, INPAINT_VERSION, CLUTTER_PROMPT } from '@/lib/replicate'

export const runtime = 'nodejs'
export const maxDuration = 30

async function saveToProcessedBucket(imageUrl: string, filename: string): Promise<string> {
  const response = await fetch(imageUrl)
  if (!response.ok) throw new Error(`Failed to fetch image: ${response.statusText}`)

  const arrayBuffer = await response.arrayBuffer()
  const buffer = Buffer.from(arrayBuffer)
  const contentType = response.headers.get('content-type') || 'image/jpeg'
  const ext = contentType.includes('png') ? 'png' : 'jpg'
  const storagePath = `${filename}.${ext}`

  const { error } = await supabaseServer.storage
    .from('processed')
    .upload(storagePath, buffer, { contentType, upsert: true })

  if (error) throw new Error(`Failed to upload: ${error.message}`)

  const { data: urlData } = supabaseServer.storage
    .from('processed')
    .getPublicUrl(storagePath)

  return urlData.publicUrl
}

export async function GET(
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

    // If job is in a terminal state, return as-is
    if (job.status === 'done' || job.status === 'error' || job.status === 'pending') {
      return Response.json(job)
    }

    // --- ENHANCING stage ---
    if (job.status === 'enhancing' && job.replicate_id_enhance) {
      const prediction = await replicate.predictions.get(job.replicate_id_enhance)

      if (prediction.status === 'failed' || prediction.status === 'canceled') {
        await supabaseServer.from('jobs').update({
          status: 'error',
          error_message: prediction.error || 'Enhancement failed',
          updated_at: new Date().toISOString(),
        }).eq('id', id)
        return Response.json({ ...job, status: 'error' })
      }

      if (prediction.status === 'succeeded') {
        // Get the output URL
        let outputUrl: string
        if (Array.isArray(prediction.output)) {
          outputUrl = prediction.output[0]
        } else if (typeof prediction.output === 'string') {
          outputUrl = prediction.output
        } else {
          await supabaseServer.from('jobs').update({
            status: 'error',
            error_message: 'Unexpected enhancement output format',
            updated_at: new Date().toISOString(),
          }).eq('id', id)
          return Response.json({ ...job, status: 'error' })
        }

        // Save enhanced image
        const enhancedUrl = await saveToProcessedBucket(outputUrl, `${id}_enhanced`)

        // Start SAM prediction
        const samPrediction = await replicate.predictions.create({
          model: 'adirik/grounded-sam',
          input: {
            image: enhancedUrl,
            prompt: CLUTTER_PROMPT,
            box_threshold: 0.3,
            text_threshold: 0.25,
          },
        })

        await supabaseServer.from('jobs').update({
          enhanced_url: enhancedUrl,
          status: 'decluttering',
          replicate_id_sam: samPrediction.id,
          updated_at: new Date().toISOString(),
        }).eq('id', id)

        return Response.json({ ...job, status: 'decluttering', enhanced_url: enhancedUrl })
      }

      // Still processing
      return Response.json(job)
    }

    // --- DECLUTTERING stage ---
    if (job.status === 'decluttering' && job.replicate_id_sam) {
      // Check if we're in inpainting sub-stage
      if (job.replicate_id_inpaint) {
        const inpaintPrediction = await replicate.predictions.get(job.replicate_id_inpaint)

        if (inpaintPrediction.status === 'failed' || inpaintPrediction.status === 'canceled') {
          // Inpainting failed - just use enhanced as final
          await supabaseServer.from('jobs').update({
            decluttered_url: job.enhanced_url,
            status: 'done',
            updated_at: new Date().toISOString(),
          }).eq('id', id)
          return Response.json({ ...job, status: 'done', decluttered_url: job.enhanced_url })
        }

        if (inpaintPrediction.status === 'succeeded') {
          let inpaintOutputUrl: string
          if (Array.isArray(inpaintPrediction.output)) {
            inpaintOutputUrl = inpaintPrediction.output[0]
          } else if (typeof inpaintPrediction.output === 'string') {
            inpaintOutputUrl = inpaintPrediction.output
          } else {
            // Fallback to enhanced
            await supabaseServer.from('jobs').update({
              decluttered_url: job.enhanced_url,
              status: 'done',
              updated_at: new Date().toISOString(),
            }).eq('id', id)
            return Response.json({ ...job, status: 'done', decluttered_url: job.enhanced_url })
          }

          const finalUrl = await saveToProcessedBucket(inpaintOutputUrl, `${id}_final`)

          await supabaseServer.from('jobs').update({
            decluttered_url: finalUrl,
            status: 'done',
            updated_at: new Date().toISOString(),
          }).eq('id', id)

          return Response.json({ ...job, status: 'done', decluttered_url: finalUrl })
        }

        // Still inpainting
        return Response.json(job)
      }

      // Check SAM prediction
      const samPrediction = await replicate.predictions.get(job.replicate_id_sam)

      if (samPrediction.status === 'failed' || samPrediction.status === 'canceled') {
        // SAM failed - use enhanced as final
        await supabaseServer.from('jobs').update({
          decluttered_url: job.enhanced_url,
          status: 'done',
          updated_at: new Date().toISOString(),
        }).eq('id', id)
        return Response.json({ ...job, status: 'done', decluttered_url: job.enhanced_url })
      }

      if (samPrediction.status === 'succeeded') {
        // Check if mask was found
        const hasMask =
          samPrediction.output &&
          typeof samPrediction.output === 'object' &&
          'mask' in samPrediction.output &&
          samPrediction.output.mask

        if (hasMask) {
          const maskUrl = (samPrediction.output as { mask: string }).mask

          // Start inpainting
          const inpaintPrediction = await replicate.predictions.create({
            model: 'stability-ai/stable-diffusion-inpainting',
            input: {
              image: job.enhanced_url,
              mask: maskUrl,
              prompt: 'clean empty floor, clean counter, professional real estate photo, tidy room, no clutter',
              num_inference_steps: 50,
              guidance_scale: 7.5,
            },
          })

          await supabaseServer.from('jobs').update({
            replicate_id_inpaint: inpaintPrediction.id,
            updated_at: new Date().toISOString(),
          }).eq('id', id)

          return Response.json({ ...job, status: 'decluttering' })
        } else {
          // No clutter found - enhanced is the final
          await supabaseServer.from('jobs').update({
            decluttered_url: job.enhanced_url,
            status: 'done',
            updated_at: new Date().toISOString(),
          }).eq('id', id)
          return Response.json({ ...job, status: 'done', decluttered_url: job.enhanced_url })
        }
      }

      // SAM still processing
      return Response.json(job)
    }

    return Response.json(job)
  } catch (error) {
    console.error('Status check error:', error)
    return Response.json(
      { error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}
