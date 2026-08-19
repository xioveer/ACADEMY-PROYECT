/* ══════════════════════════════════════════════
   Cliente Supabase — Auth + Database + Storage

   Se activa solo si VITE_SUPABASE_URL y VITE_SUPABASE_ANON_KEY están
   definidas. Si faltan, `supabase` queda en null y el resto de la app
   (lib/auth, lib/db, lib/storage) cae automáticamente al modo demo
   basado en localStorage — así el build y el dev server funcionan sin
   credenciales reales.
══════════════════════════════════════════════ */
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const isSupabaseConfigured = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

export const supabase = isSupabaseConfigured
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    })
  : null;

if (!isSupabaseConfigured) {
  console.warn(
    '[EduInclusiva] Supabase no está configurado (faltan VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY). ' +
    'La app sigue funcionando en modo demo (sesión e historial en localStorage). ' +
    'Ver README.md → "Configurar Supabase" para activar autenticación y persistencia reales.'
  );
}
