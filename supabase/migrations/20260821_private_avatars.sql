-- EduInclusiva AI — privacidad de avatares
--
-- Convierte el bucket histórico de avatares en privado. Las aplicaciones
-- cliente deben leerlos mediante URLs firmadas; no se deben exponer URLs
-- públicas permanentes de fotos de perfil.

update storage.buckets
set public = false
where id = 'avatars';

drop policy if exists "avatars: public read" on storage.objects;
drop policy if exists "avatars: owner read" on storage.objects;
create policy "avatars: owner read" on storage.objects
  for select using (
    bucket_id = 'avatars'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

drop policy if exists "avatars: owner delete" on storage.objects;
create policy "avatars: owner delete" on storage.objects
  for delete using (
    bucket_id = 'avatars'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

-- Las versiones anteriores persistían la URL pública. Conservamos únicamente
-- la ruta interna del objeto para que el cliente pueda emitir una URL firmada.
update public.profiles
set avatar_url = split_part(
  split_part(avatar_url, '/storage/v1/object/public/avatars/', 2),
  '?',
  1
)
where avatar_url like '%/storage/v1/object/public/avatars/%';
