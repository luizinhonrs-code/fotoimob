import { NextRequest } from 'next/server'
import { supabaseServer } from '@/lib/supabase'

export const runtime = 'nodejs'

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params

    // Fetch job to get original filename for storage cleanup
    const { data: job, error: fetchError } = await supabaseServer
      .from('jobs')
      .select('original_filename')
      .eq('id', id)
      .single()

    if (fetchError || !job) {
      return Response.json({ error: 'Job not found' }, { status: 404 })
    }

    // Delete original file from 'originals' bucket
    await supabaseServer.storage
      .from('originals')
      .remove([job.original_filename])

    // List all files in 'processed' bucket that belong to this job (prefix = job id)
    const { data: processedFiles } = await supabaseServer.storage
      .from('processed')
      .list('', { limit: 200, search: id })

    if (processedFiles && processedFiles.length > 0) {
      await supabaseServer.storage
        .from('processed')
        .remove(processedFiles.map((f) => f.name))
    }

    // Delete the job record from the database
    const { error: deleteError } = await supabaseServer
      .from('jobs')
      .delete()
      .eq('id', id)

    if (deleteError) throw new Error(deleteError.message)

    return Response.json({ success: true })
  } catch (error) {
    console.error('Delete job error:', error)
    return Response.json(
      { error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}
