/* ══════════════════════════════════════════════
   AUTH — wrapper único sobre Supabase Auth

   Con Supabase configurado (isSupabaseConfigured === true), delega en
   supabase.auth real: email/contraseña + Google OAuth, sesión persistida
   por el propio SDK.

   Sin Supabase configurado, cae al modo demo original de la app: usuarios
   y sesión en localStorage (mismas claves que ya se usaban), incluyendo
   el "Google demo" — así la app sigue siendo 100% usable sin backend.
══════════════════════════════════════════════ */
import { supabase, isSupabaseConfigured } from './supabaseClient.js';

const LS_USER_KEY = 'edu_user_v2';
const LS_USERS_KEY = 'edu_users';

const getDemoUsers = () => { try { return JSON.parse(localStorage.getItem(LS_USERS_KEY) || '{}'); } catch { return {}; } };
const saveDemoUsers = u => localStorage.setItem(LS_USERS_KEY, JSON.stringify(u));
const getDemoSession = () => { try { return JSON.parse(localStorage.getItem(LS_USER_KEY)); } catch { return null; } };
const setDemoSession = user => localStorage.setItem(LS_USER_KEY, JSON.stringify(user));
const clearDemoSession = () => localStorage.removeItem(LS_USER_KEY);

/** Normaliza el user de Supabase (auth.users + user_metadata) a {email, name} */
function normalizeSupabaseUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email || '',
    name: user.user_metadata?.name || user.user_metadata?.full_name || (user.email || '').split('@')[0],
    avatarUrl: user.user_metadata?.avatar_url || null,
  };
}

/** Sesión actual al arrancar la app. */
export async function getCurrentUser() {
  if (isSupabaseConfigured) {
    const { data, error } = await supabase.auth.getSession();
    if (error) { console.error('[EduInclusiva] getSession error:', error); return null; }
    return normalizeSupabaseUser(data.session?.user);
  }
  return getDemoSession();
}

/** Suscribe a cambios de sesión (login/logout/token refresh). Solo aplica en modo Supabase. */
export function onAuthStateChange(callback) {
  if (!isSupabaseConfigured) return () => {};
  const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
    callback(normalizeSupabaseUser(session?.user));
  });
  return () => sub.subscription.unsubscribe();
}

export async function signInWithPassword(email, password) {
  if (isSupabaseConfigured) {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return { user: null, error: translateAuthError(error) };
    return { user: normalizeSupabaseUser(data.user), error: null };
  }

  // Modo demo: cualquier email + contraseña (mín. 6) funciona; crea el usuario la primera vez.
  if (!email || !password) return { user: null, error: 'Completá todos los campos.' };
  if (password.length < 6) return { user: null, error: 'Contraseña mínimo 6 caracteres.' };
  const users = getDemoUsers();
  if (users[email] && users[email].pass !== btoa(password)) return { user: null, error: 'Contraseña incorrecta.' };
  if (!users[email]) {
    users[email] = { email, pass: btoa(password), name: email.split('@')[0] };
    saveDemoUsers(users);
  }
  const user = { email, name: users[email].name };
  setDemoSession(user);
  return { user, error: null };
}

export async function signUp(name, email, password) {
  if (isSupabaseConfigured) {
    const { data, error } = await supabase.auth.signUp({
      email, password, options: { data: { name } },
    });
    if (error) return { user: null, error: translateAuthError(error), needsEmailConfirmation: false };
    // Si la confirmación por correo está activa en el proyecto, Supabase no
    // devuelve sesión hasta que el usuario confirme el link enviado por mail.
    const needsEmailConfirmation = !data.session;
    return { user: normalizeSupabaseUser(data.user), error: null, needsEmailConfirmation };
  }

  if (!name || !email || !password) return { user: null, error: 'Completá todos los campos.', needsEmailConfirmation: false };
  if (password.length < 6) return { user: null, error: 'Contraseña mínimo 6 caracteres.', needsEmailConfirmation: false };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { user: null, error: 'Email inválido.', needsEmailConfirmation: false };
  const users = getDemoUsers();
  if (users[email]) return { user: null, error: 'Ese email ya está registrado.', needsEmailConfirmation: false };
  users[email] = { email, pass: btoa(password), name };
  saveDemoUsers(users);
  const user = { name, email };
  setDemoSession(user);
  return { user, error: null, needsEmailConfirmation: false };
}

export async function signInWithGoogle() {
  if (isSupabaseConfigured) {
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: location.origin + location.pathname },
    });
    // El navegador redirige a Google; si hay error, lo devolvemos, si no,
    // la ejecución termina acá (la página se va a navegar afuera).
    if (error) return { user: null, error: translateAuthError(error) };
    return { user: null, error: null };
  }

  // Modo demo: simula la ida y vuelta de OAuth con un usuario fijo.
  await new Promise(r => setTimeout(r, 700));
  const email = 'demo.google@eduinclusiva.ai';
  const name = 'Cuenta de Google (demo)';
  const users = getDemoUsers();
  if (!users[email]) {
    users[email] = { email, name, pass: btoa('google-oauth-demo') };
    saveDemoUsers(users);
  }
  const user = { email, name: users[email].name };
  setDemoSession(user);
  return { user, error: null };
}

export async function signOut() {
  if (isSupabaseConfigured) {
    await supabase.auth.signOut();
    return;
  }
  clearDemoSession();
}

/** Traduce los mensajes de error más comunes de Supabase Auth al español. */
function translateAuthError(error) {
  const msg = (error?.message || '').toLowerCase();
  if (msg.includes('invalid login credentials')) return 'Email o contraseña incorrectos.';
  if (msg.includes('user already registered')) return 'Ese email ya está registrado.';
  if (msg.includes('email not confirmed')) return 'Confirmá tu correo antes de iniciar sesión (revisá tu bandeja de entrada).';
  if (msg.includes('password should be at least')) return 'Contraseña mínimo 6 caracteres.';
  if (msg.includes('unable to validate email')) return 'Email inválido.';
  return error?.message || 'Ocurrió un error inesperado.';
}
