import { supabaseServer } from '@/lib/supabase'

export const runtime = 'nodejs'

export async function GET() {
  try {
    const { data: jobs, error } = await supabaseServer
      .from('jobs')
      .select('*')
      .order('created_at', { ascending: false })

    if (error) {
      return Response.json({ error: error.message }, { status: 500 })
    }

    return Response.json({ jobs })
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}
