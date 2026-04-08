import { createClient } from '@supabase/supabase-js'

export const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
)

// Server-side client using anon key (same key, different instance for clarity)
export const supabaseServer = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
)

export type Job = {
  id: string
  original_filename: string
  original_url: string
  enhanced_url: string | null
  decluttered_url: string | null
  ai_edited_url: string | null
  status:
    | 'pending'
    | 'enhancing'     // legacy
    | 'editing'       // p-image-edit running
    | 'upscaling'     // p-image-upscale running
    | 'decluttering'  // legacy / manual inpaint
    | 'polishing'     // legacy
    | 'done'
    | 'error'
  replicate_id_enhance: string | null
  replicate_id_sam: string | null
  replicate_id_inpaint: string | null
  replicate_id_edit: string | null
  replicate_id_upscale: string | null
  error_message: string | null
  created_at: string
  updated_at: string
}
