import { NextRequest } from 'next/server'
import { supabaseServer } from '@/lib/supabase'
import { replicate } from '@/lib/replicate'

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

    // Terminal states — return as-is
    if (job.status === 'done' || job.status === 'error' || job.status === 'pending') {
      return Response.json(job)
    }

    // --- STAGE 1: DETECTING (enhancing status = grounded_sam running) ---
    if (job.status === 'enhancing' && job.replicate_id_sam) {
      const samPrediction = await replicate.predictions.get(job.replicate_id_sam)

      if (samPrediction.status === 'failed' || samPrediction.status === 'canceled') {
        // SAM failed - mark as done with original image
        const { data: signedUrlData } = await supabaseServer.storage
          .from('originals')
          .createSignedUrl(job.original_filename, 3600)
        await supabaseServer.from('jobs').update({
          decluttered_url: signedUrlData?.signedUrl || job.original_url,
          status: 'done',
          error_message: 'Object detection failed - returned original',
          updated_at: new Date().toISOString(),
        }).eq('id', id)
        return Response.json({ ...job, status: 'done' })
      }

      if (samPrediction.status === 'succeeded') {
        // grounded_sam output is an array of 4 image URLs:
        // [0] = annotated_picture_mask (original + colored overlays)
        // [1] = neg_annotated_picture_mask
        // [2] = mask.jpg (binary mask - white=detected objects)
        // [3] = inverted_mask.jpg
        const output = samPrediction.output

        // Get the original image signed URL for inpainting
        const { data: signedUrlData } = await supabaseServer.storage
          .from('originals')
          .createSignedUrl(job.original_filename, 3600)

        const originalUrl = signedUrlData?.signedUrl || job.original_url

        // Check if we got a valid mask
        let maskUrl: string | null = null
        if (Array.isArray(output) && output.length >= 3 && output[2]) {
          maskUrl = output[2] // mask.jpg is index 2
        } else if (typeof output === 'object' && output !== null && 'mask' in output) {
          maskUrl = (output as { mask: string }).mask
        }

        if (!maskUrl) {
          // No mask = no clutter detected, return original
          const finalUrl = await saveToProcessedBucket(originalUrl, `${id}_final`)
          await supabaseServer.from('jobs').update({
            decluttered_url: finalUrl,
            status: 'done',
            updated_at: new Date().toISOString(),
          }).eq('id', id)
          return Response.json({ ...job, status: 'done', decluttered_url: finalUrl })
        }

        // Clutter detected! Start bria/eraser with the mask
        const eraserPrediction = await replicate.predictions.create({
          model: 'bria/eraser',
          input: {
            image: originalUrl,
            mask: maskUrl,
          },
        })

        await supabaseServer.from('jobs').update({
          status: 'decluttering',
          replicate_id_inpaint: eraserPrediction.id,
          updated_at: new Date().toISOString(),
        }).eq('id', id)

        return Response.json({ ...job, status: 'decluttering' })
      }

      // Still detecting
      return Response.json(job)
    }

    // --- STAGE 2: REMOVING (decluttering status = bria/eraser running) ---
    if (job.status === 'decluttering' && job.replicate_id_inpaint) {
      const eraserPrediction = await replicate.predictions.get(job.replicate_id_inpaint)

      if (eraserPrediction.status === 'failed' || eraserPrediction.status === 'canceled') {
        // Eraser failed - use original as fallback
        const { data: signedUrlData } = await supabaseServer.storage
          .from('originals')
          .createSignedUrl(job.original_filename, 3600)
        const fallbackUrl = await saveToProcessedBucket(
          signedUrlData?.signedUrl || job.original_url,
          `${id}_final`
        )
        await supabaseServer.from('jobs').update({
          decluttered_url: fallbackUrl,
          status: 'done',
          error_message: 'Removal failed - returned best available',
          updated_at: new Date().toISOString(),
        }).eq('id', id)
        return Response.json({ ...job, status: 'done', decluttered_url: fallbackUrl })
      }

      if (eraserPrediction.status === 'succeeded') {
        let outputUrl: string
        if (Array.isArray(eraserPrediction.output)) {
          outputUrl = eraserPrediction.output[0]
        } else if (typeof eraserPrediction.output === 'string') {
          outputUrl = eraserPrediction.output
        } else {
          outputUrl = job.original_url
        }

        const finalUrl = await saveToProcessedBucket(outputUrl, `${id}_final`)

        await supabaseServer.from('jobs').update({
          decluttered_url: finalUrl,
          status: 'done',
          updated_at: new Date().toISOString(),
        }).eq('id', id)

        return Response.json({ ...job, status: 'done', decluttered_url: finalUrl })
      }

      // Still removing
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
