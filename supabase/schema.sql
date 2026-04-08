-- Enable UUID extension
create extension if not exists "uuid-ossp";

-- Jobs table to track each photo
create table if not exists jobs (
  id uuid default uuid_generate_v4() primary key,
  original_filename text not null,
  original_url text not null,
  enhanced_url text,
  decluttered_url text,
  status text default 'pending' check (status in ('pending', 'enhancing', 'decluttering', 'polishing', 'done', 'error')),
  replicate_id_enhance text,
  replicate_id_sam text,
  replicate_id_inpaint text,
  error_message text,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now()
);

-- Storage buckets (run manually in Supabase dashboard):
-- 1. Create bucket "originals" (public: false)
-- 2. Create bucket "processed" (public: true)

-- RLS Policies (permissive for personal tool)
alter table jobs enable row level security;

create policy "Allow all operations on jobs"
  on jobs for all
  using (true)
  with check (true);
