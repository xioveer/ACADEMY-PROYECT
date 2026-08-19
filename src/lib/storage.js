/* ══════════════════════════════════════════════
   STORAGE — Supabase Storage (archivos originales + avatares)

   Canal aparte y opcional: nunca forma parte del payload que se envía al
   webhook de n8n (eso sigue siendo solo texto extraído / base64 de imagen,
   ver processContent() en main.js). Si Supabase no está configurado o el
   usuario está en modo demo, todas las funciones son no-op silencioso —
   nunca bloquean ni rompen el flujo principal de adaptación.
══════════════════════════════════════════════ */
import { supabase, isSupabaseConfigured } from './supabaseClient.js';

export const MAX_UPLOAD_FILE_SIZE = 50 * 1024 * 1024; // mismo límite que la extracción de texto

const UPLOADS_BUCKET = 'uploads';
const AVATARS_BUCKET = 'avatars';

const sanitizeFileName = name =>
  name.normalize('NFKD').replace(/[^\w.\-]+/g, '_').slice(-120);

/** Sube el archivo original a un bucket privado, particionado por usuario. Devuelve la URL pública/firmada o null. */
export async function uploadOriginalFile(file, userId) {
  if (!isSupabaseConfigured || !userId || !file) return null;
  if (file.size > MAX_UPLOAD_FILE_SIZE) return null;

  const path = `${userId}/${Date.now()}_${sanitizeFileName(file.name)}`;
  const { error } = await supabase.storage.from(UPLOADS_BUCKET).upload(path, file, {
    contentType: file.type || 'application/octet-stream',
    upsert: false,
  });
  if (error) { console.warn('[EduInclusiva] uploadOriginalFile error (no bloquea el flujo):', error); return null; }

  const { data: signed, error: signErr } = await supabase.storage
    .from(UPLOADS_BUCKET)
    .createSignedUrl(path, 60 * 60 * 24 * 7); // 7 días
  if (signErr) { console.warn('[EduInclusiva] createSignedUrl error:', signErr); return null; }
  return signed?.signedUrl || null;
}

/** Sube/reemplaza el avatar del usuario y actualiza profiles.avatar_url. Devuelve la URL pública o null. */
export async function uploadAvatar(file, userId) {
  if (!isSupabaseConfigured || !userId || !file) return null;
  if (file.size > 5 * 1024 * 1024) return null; // 5 MB alcanza y sobra para un avatar

  const ext = (file.name.split('.').pop() || 'jpg').toLowerCase();
  const path = `${userId}/avatar.${ext}`;
  const { error } = await supabase.storage.from(AVATARS_BUCKET).upload(path, file, {
    contentType: file.type || 'image/jpeg',
    upsert: true,
  });
  if (error) { console.warn('[EduInclusiva] uploadAvatar error:', error); return null; }

  const { data } = supabase.storage.from(AVATARS_BUCKET).getPublicUrl(path);
  const avatarUrl = data?.publicUrl ? `${data.publicUrl}?t=${Date.now()}` : null;

  if (avatarUrl) {
    const { error: profileErr } = await supabase
      .from('profiles')
      .update({ avatar_url: avatarUrl })
      .eq('id', userId);
    if (profileErr) console.warn('[EduInclusiva] No se pudo actualizar profiles.avatar_url:', profileErr);

    const { error: metaErr } = await supabase.auth.updateUser({ data: { avatar_url: avatarUrl } });
    if (metaErr) console.warn('[EduInclusiva] No se pudo actualizar el metadata del usuario:', metaErr);
  }

  return avatarUrl;
}
