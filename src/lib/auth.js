/* ══════════════════════════════════════════════
   AUTH — wrapper único sobre Supabase Auth

   Con Supabase configurado (isSupabaseConfigured === true), delega en
   supabase.auth real: email/contraseña + Google OAuth. La sesión la
   persiste el propio SDK (ver storage custom en supabaseClient.js:
   sessionStorage, no localStorage — mitigación XSS del lado cliente).

   Sin Supabase configurado, cae al modo demo original de la app: usuarios
   y sesión en memoria (nunca en localStorage — antes se guardaba ahí,
   ver AUTH_SECURITY.md punto 1), incluyendo el "Google demo" — así la
   app sigue siendo 100% usable sin backend. La sesión demo se pierde al
   recargar la pestaña; es el mismo trade-off que aceptamos para el modo
   Supabase real al mover el storage a sessionStorage.

   Reforzado además con: rate limiting anti fuerza bruta (server-side vía
   RPC de Supabase cuando hay backend real; en memoria como mitigación
   débil en modo demo), política de contraseñas y 2FA por correo para
   logins admin. Ver AUTH_SECURITY.md para el detalle completo.
══════════════════════════════════════════════ */
import { supabase, isSupabaseConfigured } from './supabaseClient.js';
import { getAvatarSignedUrl } from './storage.js';

const LS_USERS_KEY = 'edu_users'; // solo la "base" de usuarios demo (nombre + hash), no la sesión activa

const getDemoUsers = () => { try { return JSON.parse(localStorage.getItem(LS_USERS_KEY) || '{}'); } catch { return {}; } };
const saveDemoUsers = u => localStorage.setItem(LS_USERS_KEY, JSON.stringify(u));

/* Sesión demo: variable en memoria (módulo), nunca localStorage/sessionStorage.
   Se pierde al recargar la pestaña — trade-off aceptado a cambio de no dejar
   ningún rastro de sesión persistido en el navegador. */
let demoSessionUser = null;
const getDemoSession = () => demoSessionUser;
const setDemoSession = user => { demoSessionUser = user; };
const clearDemoSession = () => { demoSessionUser = null; };

/* ── Política de contraseñas (punto 5) ──────────────────────────────── */
const PASSWORD_POLICY_MSG = 'La contraseña debe tener mínimo 8 caracteres, con al menos una mayúscula, un número y un carácter especial.';

/** Devuelve el mensaje de error si la contraseña no cumple la política, o null si es válida. */
export function validatePasswordPolicy(password) {
  if (!password || password.length < 8) return PASSWORD_POLICY_MSG;
  if (!/[A-Z]/.test(password)) return PASSWORD_POLICY_MSG;
  if (!/[0-9]/.test(password)) return PASSWORD_POLICY_MSG;
  if (!/[^A-Za-z0-9]/.test(password)) return PASSWORD_POLICY_MSG;
  return null;
}

/* ── Hash con salt (Web Crypto) para las contraseñas del modo demo ──────
   Reemplaza el btoa() anterior (codificación reversible, no hashing real).
   Sigue sin ser un almacenamiento "de producción" — el modo demo vive
   entero en el navegador de quien lo usa — pero ya no guarda la
   contraseña en texto trivialmente recuperable. */
function randomSaltHex() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}
async function hashPassword(password, saltHex) {
  const data = new TextEncoder().encode(saltHex + ':' + password);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}
async function createDemoUserRecord(email, password, name) {
  const salt = randomSaltHex();
  const hash = await hashPassword(password, salt);
  return { email, name, salt, hash, role: 'user' };
}
async function verifyDemoPassword(password, record) {
  if (!record?.salt || !record?.hash) return false; // formato viejo (btoa) ya no es válido
  return (await hashPassword(password, record.salt)) === record.hash;
}

/* ── Rate limiting (punto 4) ─────────────────────────────────────────
   Modo Supabase real: RPC server-side (check_rate_limit / register_*,
   ver supabase/migrations/20260820_auth_security_hardening.sql) — no se
   puede evadir borrando el storage del navegador.
   Modo demo: no hay servidor, así que esto es solo un Map en memoria.
   Mitigación débil y documentada como tal (alcanza para frenar un script
   simple, no a un atacante que recarga la página). */
const RATE_LIMIT_MAX_ATTEMPTS = 5;
const RATE_LIMIT_LOCK_MS = 15 * 60 * 1000;
const demoRateLimit = new Map(); // email -> { count, lockedUntil }

function checkDemoRateLimit(email) {
  const e = demoRateLimit.get(email);
  if (e?.lockedUntil && e.lockedUntil > Date.now()) return { allowed: false, lockedUntil: e.lockedUntil };
  return { allowed: true };
}
function registerDemoFailedAttempt(email) {
  const e = demoRateLimit.get(email) || { count: 0, lockedUntil: null };
  e.count += 1;
  if (e.count >= RATE_LIMIT_MAX_ATTEMPTS) e.lockedUntil = Date.now() + RATE_LIMIT_LOCK_MS;
  demoRateLimit.set(email, e);
}
function registerDemoSuccess(email) { demoRateLimit.delete(email); }

function formatLockMessage(lockedUntil) {
  const untilMs = typeof lockedUntil === 'number' ? lockedUntil : new Date(lockedUntil).getTime();
  const mins = Math.max(1, Math.ceil((untilMs - Date.now()) / 60000));
  return `Demasiados intentos fallidos. Probá de nuevo en ${mins} min.`;
}

/** Completa los datos del perfil que no deben confiarse al JWT. */
async function hydrateUserProfile(user) {
  if (!user || !isSupabaseConfigured) return user;
  const { data, error } = await supabase
    .from('profiles')
    .select('role, avatar_url')
    .eq('id', user.id)
    .maybeSingle();
  if (error) {
    console.error('[EduInclusiva] No se pudo cargar el perfil:', error);
    return user;
  }
  user.role = data?.role || 'user';
  if (data?.avatar_url) user.avatarUrl = await getAvatarSignedUrl(data.avatar_url, user.id);
  return user;
}

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
    const user = normalizeSupabaseUser(data.session?.user);
    if (user) await hydrateUserProfile(user);
    return user;
  }
  return getDemoSession();
}

/** Suscribe a cambios de sesión (login/logout/token refresh). Solo aplica en modo Supabase. */
export function onAuthStateChange(callback) {
  if (!isSupabaseConfigured) return () => {};
  const { data: sub } = supabase.auth.onAuthStateChange(async (_event, session) => {
    const user = normalizeSupabaseUser(session?.user);
    if (user) await hydrateUserProfile(user);
    callback(user);
  });
  return () => sub.subscription.unsubscribe();
}

export async function signInWithPassword(email, password) {
  const normalizedEmail = (email || '').trim().toLowerCase();

  if (isSupabaseConfigured) {
    const { data: rl } = await supabase.rpc('check_rate_limit', { p_identifier: normalizedEmail });
    if (rl && rl.allowed === false) return { user: null, error: formatLockMessage(rl.locked_until) };

    const { data, error } = await supabase.auth.signInWithPassword({ email: normalizedEmail, password });
    if (error) {
      await supabase.rpc('register_failed_attempt', { p_identifier: normalizedEmail });
      return { user: null, error: translateAuthError(error) };
    }
    await supabase.rpc('register_successful_attempt', { p_identifier: normalizedEmail });
    const user = normalizeSupabaseUser(data.user);
    await hydrateUserProfile(user);
    return { user, error: null };
  }

  // Modo demo: cualquier email + contraseña que cumpla la política funciona; crea el usuario la primera vez.
  const rl = checkDemoRateLimit(normalizedEmail);
  if (!rl.allowed) return { user: null, error: formatLockMessage(rl.lockedUntil) };
  if (!normalizedEmail || !password) return { user: null, error: 'Completá todos los campos.' };

  const users = getDemoUsers();
  if (users[normalizedEmail]) {
    const ok = await verifyDemoPassword(password, users[normalizedEmail]);
    if (!ok) { registerDemoFailedAttempt(normalizedEmail); return { user: null, error: 'Contraseña incorrecta.' }; }
  } else {
    const policyError = validatePasswordPolicy(password);
    if (policyError) { registerDemoFailedAttempt(normalizedEmail); return { user: null, error: policyError }; }
    users[normalizedEmail] = await createDemoUserRecord(normalizedEmail, password, normalizedEmail.split('@')[0]);
    saveDemoUsers(users);
  }
  registerDemoSuccess(normalizedEmail);
  const user = { email: normalizedEmail, name: users[normalizedEmail].name, role: users[normalizedEmail].role || 'user' };
  setDemoSession(user);
  return { user, error: null };
}

export async function signUp(name, email, password) {
  const normalizedEmail = (email || '').trim().toLowerCase();
  const policyError = validatePasswordPolicy(password);

  if (isSupabaseConfigured) {
    if (!name || !normalizedEmail || !password) return { user: null, error: 'Completá todos los campos.', needsEmailConfirmation: false };
    if (policyError) return { user: null, error: policyError, needsEmailConfirmation: false };
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) return { user: null, error: 'Email inválido.', needsEmailConfirmation: false };

    // Se separa del namespace de login: bloquear registros no debe bloquear
    // el acceso de una cuenta existente con el mismo correo.
    const rateLimitIdentifier = `signup:${normalizedEmail}`;
    const { data: rl, error: rateLimitError } = await supabase
      .rpc('check_rate_limit', { p_identifier: rateLimitIdentifier });
    if (rateLimitError || !rl) {
      console.error('[EduInclusiva] No se pudo verificar el rate limit de registro:', rateLimitError);
      return { user: null, error: 'No se pudo verificar la seguridad del registro. Intentá nuevamente.', needsEmailConfirmation: false };
    }
    if (rl.allowed === false) return { user: null, error: formatLockMessage(rl.locked_until), needsEmailConfirmation: false };

    const { data, error } = await supabase.auth.signUp({
      email: normalizedEmail, password, options: { data: { name } },
    });
    if (error) {
      await supabase.rpc('register_failed_attempt', { p_identifier: rateLimitIdentifier });
      return { user: null, error: translateAuthError(error), needsEmailConfirmation: false };
    }
    await supabase.rpc('register_successful_attempt', { p_identifier: rateLimitIdentifier });
    // Si la confirmación por correo está activa en el proyecto, Supabase no
    // devuelve sesión hasta que el usuario confirme el link enviado por mail.
    const needsEmailConfirmation = !data.session;
    const user = normalizeSupabaseUser(data.user);
    if (user && !needsEmailConfirmation) await hydrateUserProfile(user);
    return { user, error: null, needsEmailConfirmation };
  }

  if (!name || !normalizedEmail || !password) return { user: null, error: 'Completá todos los campos.', needsEmailConfirmation: false };
  if (policyError) return { user: null, error: policyError, needsEmailConfirmation: false };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) return { user: null, error: 'Email inválido.', needsEmailConfirmation: false };
  const users = getDemoUsers();
  if (users[normalizedEmail]) return { user: null, error: 'Ese email ya está registrado.', needsEmailConfirmation: false };
  users[normalizedEmail] = await createDemoUserRecord(normalizedEmail, password, name);
  saveDemoUsers(users);
  const user = { name, email: normalizedEmail, role: 'user' };
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
    users[email] = await createDemoUserRecord(email, 'google-oauth-demo-Az$1', name);
    saveDemoUsers(users);
  }
  const user = { email, name: users[email].name, role: users[email].role || 'user' };
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

/* ── Cambio de contraseña (vista de Ajustes) ────────────────────────────
   Reautentica con la contraseña vigente antes de aplicar el cambio (para
   que alguien con la pestaña abierta pero sin la contraseña actual no
   pueda tomar la cuenta). La reautenticación pasa por signInWithPassword,
   así que también queda cubierta por el rate limiting del punto 4. */
export async function updatePassword(currentPassword, newPassword) {
  const policyError = validatePasswordPolicy(newPassword);
  if (policyError) return { error: policyError };

  if (isSupabaseConfigured) {
    const { data: sessionData } = await supabase.auth.getSession();
    const email = sessionData.session?.user?.email;
    if (!email) return { error: 'No hay una sesión activa.' };

    const { error: reauthError } = await signInWithPassword(email, currentPassword);
    if (reauthError) return { error: 'La contraseña actual no es correcta.' };

    const { error } = await supabase.auth.updateUser({ password: newPassword });
    if (error) return { error: translateAuthError(error) };
    return { error: null };
  }

  // Modo demo
  const session = getDemoSession();
  if (!session?.email) return { error: 'No hay una sesión activa.' };
  const users = getDemoUsers();
  const record = users[session.email];
  if (!record) return { error: 'No hay una sesión activa.' };
  const ok = await verifyDemoPassword(currentPassword, record);
  if (!ok) return { error: 'La contraseña actual no es correcta.' };

  users[session.email] = await createDemoUserRecord(session.email, newPassword, record.name);
  users[session.email].role = record.role || 'user';
  saveDemoUsers(users);
  return { error: null };
}

/* ── 2FA por correo (punto 3) ─────────────────────────────────────────
   Solo aplica a logins admin y solo con Supabase real configurado (el
   modo demo no tiene backend que envíe correos). El código lo genera y
   envía n8n (Gmail/Resend) — el frontend nunca lo genera ni lo ve en
   texto plano; solo dispara el pedido y verifica lo que el usuario tipeó
   contra el hash guardado en Supabase. Ver AUTH_SECURITY.md para el
   contrato exacto que debe implementar el webhook de n8n. */
const OTP_REQUEST_WEBHOOK_URL = import.meta.env.VITE_2FA_REQUEST_WEBHOOK_URL;

/** true si este login debe pasar por el paso de 2FA antes de otorgar sesión en la UI. */
export function requiresTwoFactor(user) {
  return Boolean(isSupabaseConfigured && user?.role === 'admin');
}

/** Dispara el envío del código de 6 dígitos vía el webhook de n8n. */
export async function requestTwoFactorCode(email) {
  if (!OTP_REQUEST_WEBHOOK_URL) {
    console.error('[EduInclusiva] Falta VITE_2FA_REQUEST_WEBHOOK_URL — ver AUTH_SECURITY.md para configurar el webhook de n8n que envía el código.');
    return { error: 'La verificación en dos pasos no está configurada. Contactá al administrador.' };
  }
  try {
    const res = await fetch(OTP_REQUEST_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    if (!res.ok) return { error: 'No se pudo enviar el código. Intentá de nuevo en unos minutos.' };
    return { error: null };
  } catch {
    return { error: 'No se pudo enviar el código. Revisá tu conexión.' };
  }
}

/** Verifica el código tipeado por el usuario contra el hash guardado en Supabase. */
export async function verifyTwoFactorCode(email, code) {
  if (!isSupabaseConfigured) return { success: false, error: 'No disponible en modo demo.' };
  const { data, error } = await supabase.rpc('verify_otp_code', { p_email: email, p_code: code });
  if (error) return { success: false, error: 'No se pudo verificar el código. Intentá de nuevo.' };
  if (!data?.success) {
    const reasons = {
      no_code: 'No hay un código activo para este correo. Solicitá uno nuevo.',
      too_many_attempts: 'Demasiados intentos con ese código. Solicitá uno nuevo.',
      invalid_code: 'Código incorrecto.',
    };
    return { success: false, error: reasons[data?.reason] || 'Código incorrecto.' };
  }
  return { success: true, error: null };
}

/** Traduce los mensajes de error más comunes de Supabase Auth al español. */
function translateAuthError(error) {
  const msg = (error?.message || '').toLowerCase();
  if (msg.includes('invalid login credentials')) return 'Email o contraseña incorrectos.';
  if (msg.includes('user already registered')) return 'Ese email ya está registrado.';
  if (msg.includes('email not confirmed')) return 'Confirmá tu correo antes de iniciar sesión (revisá tu bandeja de entrada).';
  if (msg.includes('password should be at least')) return 'Contraseña mínimo 8 caracteres, con mayúscula, número y carácter especial.';
  if (msg.includes('unable to validate email')) return 'Email inválido.';
  return error?.message || 'Ocurrió un error inesperado.';
}
