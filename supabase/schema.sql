-- ══════════════════════════════════════════════════════
-- EduInclusiva AI — Esquema de Supabase
--
-- Cómo aplicarlo:
--   1. Entrá a tu proyecto en https://app.supabase.com
--   2. SQL Editor → New query
--   3. Pegá todo este archivo y ejecutalo (Run)
--   4. Storage → confirmá que se crearon los buckets "avatars" y "uploads"
-- ══════════════════════════════════════════════════════

-- ── profiles ──────────────────────────────────────────
-- Espejo público de auth.users con datos de perfil editables por el usuario.
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  name text,
  avatar_url text,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

drop policy if exists "profiles: select own" on public.profiles;
create policy "profiles: select own" on public.profiles
  for select using (auth.uid() = id);

drop policy if exists "profiles: update own" on public.profiles;
create policy "profiles: update own" on public.profiles
  for update using (auth.uid() = id);

drop policy if exists "profiles: insert own" on public.profiles;
create policy "profiles: insert own" on public.profiles
  for insert with check (auth.uid() = id);

-- Auto-crea la fila de profiles cuando alguien se registra (email/contraseña o Google).
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email, name, avatar_url)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'name', new.raw_user_meta_data ->> 'full_name', split_part(new.email, '@', 1)),
    new.raw_user_meta_data ->> 'avatar_url'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ── accessibility_preferences ─────────────────────────
create table if not exists public.accessibility_preferences (
  user_id uuid primary key references auth.users (id) on delete cascade,
  profile text,
  adaptations text[] not null default '{}',
  updated_at timestamptz not null default now()
);

alter table public.accessibility_preferences enable row level security;

drop policy if exists "prefs: select own" on public.accessibility_preferences;
create policy "prefs: select own" on public.accessibility_preferences
  for select using (auth.uid() = user_id);

drop policy if exists "prefs: upsert own" on public.accessibility_preferences;
create policy "prefs: upsert own" on public.accessibility_preferences
  for insert with check (auth.uid() = user_id);

drop policy if exists "prefs: update own" on public.accessibility_preferences;
create policy "prefs: update own" on public.accessibility_preferences
  for update using (auth.uid() = user_id);

-- ── adaptation_history ────────────────────────────────
create table if not exists public.adaptation_history (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  title text,
  profile text,
  content text,
  html text,
  adaptations text[] not null default '{}',
  file_url text,
  created_at timestamptz not null default now()
);

create index if not exists adaptation_history_user_created_idx
  on public.adaptation_history (user_id, created_at desc);

alter table public.adaptation_history enable row level security;

drop policy if exists "history: select own" on public.adaptation_history;
create policy "history: select own" on public.adaptation_history
  for select using (auth.uid() = user_id);

drop policy if exists "history: insert own" on public.adaptation_history;
create policy "history: insert own" on public.adaptation_history
  for insert with check (auth.uid() = user_id);

drop policy if exists "history: delete own" on public.adaptation_history;
create policy "history: delete own" on public.adaptation_history
  for delete using (auth.uid() = user_id);

-- ── Storage: buckets ───────────────────────────────────
insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', false)
on conflict (id) do nothing;

insert into storage.buckets (id, name, public)
values ('uploads', 'uploads', false)
on conflict (id) do nothing;

-- ── Storage: policies ──────────────────────────────────
-- Convención de paths: {user_id}/archivo.ext — cada usuario solo puede
-- leer/escribir dentro de su propia carpeta (storage.foldername(name)[1]).

drop policy if exists "avatars: public read" on storage.objects;
drop policy if exists "avatars: owner read" on storage.objects;
create policy "avatars: owner read" on storage.objects
  for select using (bucket_id = 'avatars' and auth.uid()::text = (storage.foldername(name))[1]);

drop policy if exists "avatars: owner write" on storage.objects;
create policy "avatars: owner write" on storage.objects
  for insert with check (bucket_id = 'avatars' and auth.uid()::text = (storage.foldername(name))[1]);

drop policy if exists "avatars: owner update" on storage.objects;
create policy "avatars: owner update" on storage.objects
  for update using (bucket_id = 'avatars' and auth.uid()::text = (storage.foldername(name))[1]);

drop policy if exists "avatars: owner delete" on storage.objects;
create policy "avatars: owner delete" on storage.objects
  for delete using (bucket_id = 'avatars' and auth.uid()::text = (storage.foldername(name))[1]);

drop policy if exists "uploads: owner read" on storage.objects;
create policy "uploads: owner read" on storage.objects
  for select using (bucket_id = 'uploads' and auth.uid()::text = (storage.foldername(name))[1]);

drop policy if exists "uploads: owner write" on storage.objects;
create policy "uploads: owner write" on storage.objects
  for insert with check (bucket_id = 'uploads' and auth.uid()::text = (storage.foldername(name))[1]);

drop policy if exists "uploads: owner delete" on storage.objects;
create policy "uploads: owner delete" on storage.objects
  for delete using (bucket_id = 'uploads' and auth.uid()::text = (storage.foldername(name))[1]);
