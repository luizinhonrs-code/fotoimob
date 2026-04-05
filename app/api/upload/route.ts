import { NextRequest } from 'next/server'
import { supabaseServer } from '@/lib/supabase'

export const runtime = 'nodejs'

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData()
    const files = formData.getAll('files') as File[]

    if (!files || files.length === 0) {
      return Response.json({ error: 'No files provided' }, { status: 400 })
    }

    const jobs = []

    for (const file of files) {
      if (!file.type.startsWith('image/')) {
        continue
      }

      const timestamp = Date.now()
      const safeFilename = file.name.replace(/[^a-zA-Z0-9._-]/g, '_')
      const storagePath = `${timestamp}_${safeFilename}`

      // Upload to Supabase storage
      const arrayBuffer = await file.arrayBuffer()
      const buffer = Buffer.from(arrayBuffer)

      const { error: uploadError } = await supabaseServer.storage
        .from('originals')
        .upload(storagePath, buffer, {
          contentType: file.type,
          upsert: false,
        })

      if (uploadError) {
        console.error('Upload error:', uploadError)
        return Response.json({ error: `Failed to upload ${file.name}: ${uploadError.message}` }, { status: 500 })
      }

      // Get public or signed URL
      const { data: urlData } = await supabaseServer.storage
        .from('originals')
        .createSignedUrl(storagePath, 86400) // 24 hours

      const originalUrl = urlData?.signedUrl || storagePath

      // Create job record
      const { data: job, error: dbError } = await supabaseServer
        .from('jobs')
        .insert({
          original_filename: storagePath,
          original_url: originalUrl,
          status: 'pending',
        })
        .select()
        .single()

      if (dbError) {
        console.error('DB error:', dbError)
        return Response.json({ error: `Failed to create job: ${dbError.message}` }, { status: 500 })
      }

      jobs.push(job)
    }

    return Response.json({ jobs })
  } catch (error) {
    console.error('Upload route error:', error)
    return Response.json(
      { error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}
