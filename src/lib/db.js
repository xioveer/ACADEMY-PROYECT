/* ══════════════════════════════════════════════
   DB — historial de adaptaciones + preferencias de accesibilidad

   Con Supabase configurado y sesión real, lee/escribe en las tablas
   `adaptation_history` / `accessibility_preferences` (ver supabase/schema.sql).
   Sin Supabase (o en modo demo), usa localStorage — misma forma de datos
   que ya usaba la app, para no perder compatibilidad con historiales
   guardados previamente en el navegador.
══════════════════════════════════════════════ */
import { supabase, isSupabaseConfigured } from './supabaseClient.js';

const HISTORY_KEY = 'edu_history_v1';
const HISTORY_MAX = 30;
const PREFS_KEY = 'edu_prefs_v1';

const genId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

/* ── Local (demo / fallback) ── */
const getLocalHistory = () => { try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); } catch { return []; } };
const saveLocalHistory = list => {
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(list)); }
  catch (e) { console.warn('[EduInclusiva] No se pudo guardar el historial (¿localStorage lleno?):', e); }
};

/** `userId` null/undefined ⇒ sin sesión Supabase real ⇒ se usa localStorage siempre. */
function useSupabase(userId) {
  return isSupabaseConfigured && Boolean(userId);
}

export async function getHistory(userId) {
  if (!useSupabase(userId)) return getLocalHistory();
  const { data, error } = await supabase
    .from('adaptation_history')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(HISTORY_MAX);
  if (error) { console.error('[EduInclusiva] getHistory error:', error); return []; }
  return data.map(row => ({
    id: row.id,
    timestamp: row.created_at,
    title: row.title,
    profile: row.profile,
    content: row.content,
    adaptations: row.adaptations || [],
    html: row.html,
    fileUrl: row.file_url || null,
  }));
}

export async function saveToHistory(userId, entry) {
  const record = {
    id: genId(),
    timestamp: new Date().toISOString(),
    title: entry.title,
    profile: entry.profile,
    content: entry.content,
    adaptations: entry.adaptations,
    html: entry.html,
    fileUrl: entry.fileUrl || null,
  };

  if (!useSupabase(userId)) {
    const list = [record, ...getLocalHistory()].slice(0, HISTORY_MAX);
    saveLocalHistory(list);
    return record;
  }

  const { data, error } = await supabase.from('adaptation_history').insert({
    user_id: userId,
    title: record.title,
    profile: record.profile,
    content: record.content,
    adaptations: record.adaptations,
    html: record.html,
    file_url: record.fileUrl,
  }).select().single();

  if (error) { console.error('[EduInclusiva] saveToHistory error:', error); return record; }
  return { ...record, id: data.id, timestamp: data.created_at };
}

export async function deleteHistoryItem(userId, id) {
  if (!useSupabase(userId)) {
    saveLocalHistory(getLocalHistory().filter(h => h.id !== id));
    return;
  }
  const { error } = await supabase.from('adaptation_history').delete().eq('id', id).eq('user_id', userId);
  if (error) console.error('[EduInclusiva] deleteHistoryItem error:', error);
}

export async function clearHistory(userId) {
  if (!useSupabase(userId)) {
    localStorage.removeItem(HISTORY_KEY);
    return;
  }
  const { error } = await supabase.from('adaptation_history').delete().eq('user_id', userId);
  if (error) console.error('[EduInclusiva] clearHistory error:', error);
}

/* ── Preferencias de accesibilidad (perfil + adaptaciones activas) ── */
export async function getPreferences(userId) {
  if (!useSupabase(userId)) {
    try { return JSON.parse(localStorage.getItem(PREFS_KEY) || 'null'); } catch { return null; }
  }
  const { data, error } = await supabase
    .from('accessibility_preferences')
    .select('profile, adaptations')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) { console.error('[EduInclusiva] getPreferences error:', error); return null; }
  return data;
}

export async function savePreferences(userId, profile, adaptations) {
  if (!useSupabase(userId)) {
    try { localStorage.setItem(PREFS_KEY, JSON.stringify({ profile, adaptations })); } catch {}
    return;
  }
  const { error } = await supabase.from('accessibility_preferences').upsert({
    user_id: userId,
    profile,
    adaptations,
    updated_at: new Date().toISOString(),
  });
  if (error) console.error('[EduInclusiva] savePreferences error:', error);
}
