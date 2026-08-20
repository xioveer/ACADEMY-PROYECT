-- EduInclusiva AI — seguimiento de jobs y preparación para RAG
--
-- Migración aditiva e idempotente. Puede ejecutarse tanto en un proyecto que
-- ya tenga public.jobs como en uno creado a partir del schema.sql actual.

create table if not exists public.jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users (id) on delete set null,
  status text not null default 'queued',
  progress_status text not null default 'queued',
  extracted_chunks jsonb not null default '[]'::jsonb,
  result_data jsonb,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.jobs
  add column if not exists progress_status text not null default 'queued',
  add column if not exists extracted_chunks jsonb not null default '[]'::jsonb,
  add column if not exists result_data jsonb;

comment on column public.jobs.progress_status is
  'Etapa legible del pipeline: queued, extracting, chunking, retrieving, adapting, completed o failed.';
comment on column public.jobs.extracted_chunks is
  'Fragmentos de texto extraído para RAG. Formato recomendado: [{"index": 0, "text": "…", "char_count": 123}].';

create index if not exists jobs_user_created_idx
  on public.jobs (user_id, created_at desc);

create index if not exists jobs_status_created_idx
  on public.jobs (status, created_at desc);

-- El navegador usa los webhooks de n8n; n8n debe usar una credencial de
-- servidor (service_role), que no queda restringida por RLS. Los usuarios
-- autenticados solo pueden consultar sus propios trabajos si esa lectura se
-- habilita en una versión futura del frontend.
alter table public.jobs enable row level security;

drop policy if exists "jobs: select own" on public.jobs;
create policy "jobs: select own" on public.jobs
  for select using (auth.uid() = user_id);
