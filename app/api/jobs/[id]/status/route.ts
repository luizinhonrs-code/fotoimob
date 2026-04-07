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

    // Detecting stage — DINO running synchronously in process route
    if (job.status === 'enhancing') {
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

        // Save inpainted result
        const inpaintedUrl = await saveToProcessedBucket(outputUrl, `${id}_inpainted`)

        // Atomic transition to 'polishing': only one poll wins this race.
        // Uses conditional update (only if still 'decluttering' AND enhance ID not yet set).
        const { data: won } = await supabaseServer
          .from('jobs')
          .update({
            decluttered_url: inpaintedUrl,
            status: 'polishing',
            replicate_id_enhance: 'pending', // placeholder — replaced below
            updated_at: new Date().toISOString(),
          })
          .eq('id', id)
          .eq('status', 'decluttering')
          .is('replicate_id_enhance', null)
          .select('id')

        if (!won || won.length === 0) {
          // Another poll already started enhancement — just return current state
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
          // Enhancement failed to start — go straight to done
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
    if (job.status === 'polishing' && job.replicate_id_enhance) {
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
