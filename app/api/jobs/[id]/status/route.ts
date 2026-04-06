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

    // Detecting stage (enhancing) — DINO is running synchronously in process route
    // This state is brief; if we're here, process route is still running or just finished
    if (job.status === 'enhancing') {
      return Response.json(job)
    }

    // Removing stage (decluttering) — LaMa is running
    if (job.status === 'decluttering' && job.replicate_id_inpaint) {
      const lamaPrediction = await replicate.predictions.get(job.replicate_id_inpaint)

      if (lamaPrediction.status === 'failed' || lamaPrediction.status === 'canceled') {
        // LaMa failed - get original signed URL as fallback
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

      if (lamaPrediction.status === 'succeeded') {
        let outputUrl: string
        if (Array.isArray(lamaPrediction.output)) {
          outputUrl = lamaPrediction.output[0]
        } else if (typeof lamaPrediction.output === 'string') {
          outputUrl = lamaPrediction.output
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
