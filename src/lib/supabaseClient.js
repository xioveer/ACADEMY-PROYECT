/* ══════════════════════════════════════════════
   Cliente Supabase — Auth + Database + Storage

   Se activa solo si VITE_SUPABASE_URL y VITE_SUPABASE_ANON_KEY están
   definidas. Si faltan, `supabase` queda en null y el resto de la app
   (lib/auth, lib/db, lib/storage) cae automáticamente al modo demo
   basado en localStorage — así el build y el dev server funcionan sin
   credenciales reales.

   Almacenamiento de sesión: este es un SPA estático (Vercel, sin servidor
   propio), así que no existe forma de setear cookies HttpOnly reales —
   eso solo lo puede hacer un backend al responder el request. Como
   mitigación del lado cliente usamos sessionStorage en vez de
   localStorage: el token no sobrevive al cierre de la pestaña/navegador
   ni se comparte entre pestañas (localStorage sí hace ambas cosas), lo
   que reduce la ventana de exposición ante un XSS. Sigue siendo legible
   por JS mientras la pestaña está abierta — ver AUTH_SECURITY.md para el
   detalle de esta decisión y la alternativa (proxy de auth vía n8n con
   Set-Cookie real) si en el futuro se agrega un backend.
══════════════════════════════════════════════ */
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const isSupabaseConfigured = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

/** Adaptador de storage que usa sessionStorage en vez de localStorage (ver nota arriba). */
const sessionOnlyStorage = {
  getItem: key => { try { return window.sessionStorage.getItem(key); } catch { return null; } },
  setItem: (key, value) => { try { window.sessionStorage.setItem(key, value); } catch {} },
  removeItem: key => { try { window.sessionStorage.removeItem(key); } catch {} },
};

export const supabase = isSupabaseConfigured
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        storage: sessionOnlyStorage,
      },
    })
  : null;

if (!isSupabaseConfigured) {
  console.warn(
    '[EduInclusiva] Supabase no está configurado (faltan VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY). ' +
    'La app sigue funcionando en modo demo (sesión e historial en localStorage). ' +
    'Ver README.md → "Configurar Supabase" para activar autenticación y persistencia reales.'
  );
}
