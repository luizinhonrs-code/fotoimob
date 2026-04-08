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
  const { data: urlData } = supabaseServer.storage.from('processed').getPublicUrl(storagePath)
  return urlData.publicUrl
}

// Enhancement step disabled to prevent race-condition credit drain.
// Will be re-enabled with a proper queue when needed.

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

    // Terminal or pending states
    if (job.status === 'done' || job.status === 'error' || job.status === 'pending') {
      return Response.json(job)
    }

    // Legacy detecting stage
    if (job.status === 'enhancing') {
      return Response.json(job)
    }

    // AI Edit stage — p-image-edit running
    if (job.status === 'editing' && job.replicate_id_edit) {
      const editPrediction = await replicate.predictions.get(job.replicate_id_edit)

      if (editPrediction.status === 'failed' || editPrediction.status === 'canceled') {
        await supabaseServer.from('jobs').update({
          status: 'error',
          error_message: 'Edit failed: ' + (editPrediction.error ?? 'unknown'),
          updated_at: new Date().toISOString(),
        }).eq('id', id)
        return Response.json({ ...job, status: 'error' })
      }

      if (editPrediction.status === 'succeeded') {
        let outputUrl: string
        if (Array.isArray(editPrediction.output)) {
          outputUrl = editPrediction.output[0]
        } else if (typeof editPrediction.output === 'string') {
          outputUrl = editPrediction.output
        } else {
          outputUrl = job.original_url
        }

        const editedUrl = await saveToProcessedBucket(outputUrl, `${id}_edited`)

        // Save edited URL + transition to upscaling
        await supabaseServer.from('jobs').update({
          ai_edited_url: editedUrl,
          status: 'upscaling',
          updated_at: new Date().toISOString(),
        }).eq('id', id).eq('status', 'editing')

        // Atomic lock — only one poll starts the upscale
        const { data: won } = await supabaseServer
          .from('jobs')
          .update({ replicate_id_upscale: 'pending', updated_at: new Date().toISOString() })
          .eq('id', id)
          .eq('status', 'upscaling')
          .is('replicate_id_upscale', null)
          .select('id')

        if (!won || won.length === 0) {
          return Response.json({ ...job, status: 'upscaling', ai_edited_url: editedUrl })
        }

        try {
          const upscalePrediction = await replicate.predictions.create({
            model: 'prunaai/p-image-upscale',
            input: { image: editedUrl },
          })
          await supabaseServer.from('jobs').update({
            replicate_id_upscale: upscalePrediction.id,
            updated_at: new Date().toISOString(),
          }).eq('id', id)
        } catch {
          // Upscale failed to start — use edited result as final
          await supabaseServer.from('jobs').update({
            decluttered_url: editedUrl,
            status: 'done',
            replicate_id_upscale: null,
            updated_at: new Date().toISOString(),
          }).eq('id', id)
          return Response.json({ ...job, status: 'done', decluttered_url: editedUrl })
        }

        return Response.json({ ...job, status: 'upscaling', ai_edited_url: editedUrl })
      }

      return Response.json(job)
    }

    // Upscaling stage — p-image-upscale running
    if (job.status === 'upscaling' && job.replicate_id_upscale && job.replicate_id_upscale !== 'pending') {
      const upscalePrediction = await replicate.predictions.get(job.replicate_id_upscale)

      if (upscalePrediction.status === 'failed' || upscalePrediction.status === 'canceled') {
        // Fallback to edited result
        const fallback = job.ai_edited_url || job.original_url
        await supabaseServer.from('jobs').update({
          decluttered_url: fallback,
          status: 'done',
          updated_at: new Date().toISOString(),
        }).eq('id', id)
        return Response.json({ ...job, status: 'done', decluttered_url: fallback })
      }

      if (upscalePrediction.status === 'succeeded') {
        let outputUrl: string
        if (Array.isArray(upscalePrediction.output)) {
          outputUrl = upscalePrediction.output[0]
        } else if (typeof upscalePrediction.output === 'string') {
          outputUrl = upscalePrediction.output
        } else {
          outputUrl = job.ai_edited_url || job.original_url
        }

        const finalUrl = await saveToProcessedBucket(outputUrl, `${id}_final`)
        await supabaseServer.from('jobs').update({
          decluttered_url: finalUrl,
          status: 'done',
          updated_at: new Date().toISOString(),
        }).eq('id', id)
        return Response.json({ ...job, status: 'done', decluttered_url: finalUrl })
      }

      return Response.json(job)
    }

    // Removing stage — inpainting model running
    if (job.status === 'decluttering' && job.replicate_id_inpaint) {
      const inpaintPrediction = await replicate.predictions.get(job.replicate_id_inpaint)

      if (inpaintPrediction.status === 'failed' || inpaintPrediction.status === 'canceled') {
        const { data: signedUrlData } = await supabaseServer.storage
          .from('originals')
          .createSignedUrl(job.original_filename, 3600)

        let fallbackUrl = job.original_url
        if (signedUrlData?.signedUrl) {
          try {
            fallbackUrl = await saveToProcessedBucket(signedUrlData.signedUrl, `${id}_final`)
          } catch { /* use original_url */ }
        }

        await supabaseServer.from('jobs').update({
          decluttered_url: fallbackUrl,
          status: 'done',
          error_message: 'Removal failed - returned original',
          updated_at: new Date().toISOString(),
        }).eq('id', id)
        return Response.json({ ...job, status: 'done', decluttered_url: fallbackUrl })
      }

      if (inpaintPrediction.status === 'succeeded') {
        let outputUrl: string
        if (Array.isArray(inpaintPrediction.output)) {
          outputUrl = inpaintPrediction.output[0]
        } else if (typeof inpaintPrediction.output === 'string') {
          outputUrl = inpaintPrediction.output
        } else {
          outputUrl = job.original_url
        }

        // Save inpainted result to our bucket
        const inpaintedUrl = await saveToProcessedBucket(outputUrl, `${id}_inpainted`)

        // Step 1: Always save URL + transition status atomically (safe to repeat — WHERE limits to 'decluttering' only).
        await supabaseServer.from('jobs').update({
          decluttered_url: inpaintedUrl,
          status: 'polishing',
          updated_at: new Date().toISOString(),
        }).eq('id', id).eq('status', 'decluttering')

        // Step 2: Separate enhancement lock — only the first poll that sees null enhance ID starts it.
        const { data: won } = await supabaseServer
          .from('jobs')
          .update({
            replicate_id_enhance: 'pending', // placeholder — replaced below
            updated_at: new Date().toISOString(),
          })
          .eq('id', id)
          .eq('status', 'polishing')
          .is('replicate_id_enhance', null)
          .select('id')

        if (!won || won.length === 0) {
          // Another poll already claimed the enhancement slot
          return Response.json({ ...job, status: 'polishing', decluttered_url: inpaintedUrl })
        }

        // We won the race — start the enhancement prediction
        try {
          const enhModel = await replicate.models.get('nightmareai', 'real-esrgan')
          const enhVersion = enhModel.latest_version?.id
          if (!enhVersion) throw new Error('No enhancer version')
          const enhPrediction = await replicate.predictions.create({
            version: enhVersion,
            input: {
              image: inpaintedUrl,
              scale: 2,
              face_enhance: false,
            },
          })
          await supabaseServer.from('jobs').update({
            replicate_id_enhance: enhPrediction.id,
            updated_at: new Date().toISOString(),
          }).eq('id', id)
          return Response.json({ ...job, status: 'polishing', decluttered_url: inpaintedUrl })
        } catch {
          // Enhancement failed to start — go straight to done with inpainted result
          await supabaseServer.from('jobs').update({
            status: 'done',
            replicate_id_enhance: null,
            updated_at: new Date().toISOString(),
          }).eq('id', id)
          return Response.json({ ...job, status: 'done', decluttered_url: inpaintedUrl })
        }
      }

      // Still running
      return Response.json(job)
    }

    // Polishing stage — quality enhancement running
    // Guard: 'pending' is a placeholder set during the window between lock acquisition and real ID write.
    // Calling replicate.predictions.get('pending') would throw, so we just wait it out.
    if (job.status === 'polishing' && job.replicate_id_enhance && job.replicate_id_enhance !== 'pending') {
      const enhancePrediction = await replicate.predictions.get(job.replicate_id_enhance)

      if (enhancePrediction.status === 'failed' || enhancePrediction.status === 'canceled') {
        // Enhancement failed — keep inpainted result (already in decluttered_url)
        await supabaseServer.from('jobs').update({
          status: 'done',
          updated_at: new Date().toISOString(),
        }).eq('id', id)
        return Response.json({ ...job, status: 'done' })
      }

      if (enhancePrediction.status === 'succeeded') {
        let outputUrl: string
        if (Array.isArray(enhancePrediction.output)) {
          outputUrl = enhancePrediction.output[0]
        } else if (typeof enhancePrediction.output === 'string') {
          outputUrl = enhancePrediction.output
        } else {
          // No output — keep inpainted result
          await supabaseServer.from('jobs').update({
            status: 'done',
            updated_at: new Date().toISOString(),
          }).eq('id', id)
          return Response.json({ ...job, status: 'done' })
        }

        const finalUrl = await saveToProcessedBucket(outputUrl, `${id}_final`)
        await supabaseServer.from('jobs').update({
          decluttered_url: finalUrl,
          status: 'done',
          updated_at: new Date().toISOString(),
        }).eq('id', id)
        return Response.json({ ...job, status: 'done', decluttered_url: finalUrl })
      }

      // Still running
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
