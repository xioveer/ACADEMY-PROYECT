  import {
    getCurrentUser, onAuthStateChange, signInWithPassword, signUp, signInWithGoogle, signOut,
    validatePasswordPolicy, requiresTwoFactor, requestTwoFactorCode, verifyTwoFactorCode,
    updatePassword,
  } from './lib/auth.js';
  import { isSupabaseConfigured, supabase } from './lib/supabaseClient.js';
  import * as db from './lib/db.js';
  import { uploadOriginalFile, uploadAvatar } from './lib/storage.js';
  import { initAnalytics, trackPageView, trackEvent } from './lib/analytics.js';
  import { searchAll } from './lib/search.js';

  /* ── CONFIGURACIÓN ── */
  const WEBHOOK_URL        = import.meta.env.VITE_WEBHOOK_URL;        // submit del job (n8n)
  const STATUS_WEBHOOK_URL = import.meta.env.VITE_STATUS_WEBHOOK_URL; // consulta de estado (n8n)

  if (!WEBHOOK_URL || !STATUS_WEBHOOK_URL) {
    console.error(
      '[EduInclusiva] Faltan VITE_WEBHOOK_URL / VITE_STATUS_WEBHOOK_URL. ' +
      'Copiá .env.example a .env, completá los valores y reiniciá el servidor de desarrollo.'
    );
  }

  const CONSENT_KEY  = 'edu_consent_v1';
  const ACCESSIBILITY_ONBOARDING_KEY = 'edu_accessibility_profile_v1';
  const HISTORY_MAX  = 30;   // tope de entradas mostradas/guardadas (ver también src/lib/db.js)
  const IMAGE_TYPES  = ['image/jpeg', 'image/png', 'image/webp'];
  const UPLOAD_TIMEOUT_MS    = 120000;         // tope para el envío inicial (archivos grandes en conexión lenta)
  const POLL_INTERVAL_MS     = 2000;           // intervalo base de polling
  const POLL_INTERVAL_MAX_MS = 8000;           // techo del backoff exponencial ante errores transitorios
  const POLL_TIMEOUT_MS      = 5 * 60 * 1000;  // tope total de espera del job (antes: 48 intentos fijos ≈ 2min, insuficiente para archivos grandes)
  const JOB_DONE_STATUSES  = ['done', 'completed', 'success', 'finished'];
  const JOB_ERROR_STATUSES = ['error', 'failed', 'failure'];
  const NOT_FOUND_MAX_STREAK = 5; // reintentos tolerados antes de tratar 'not_found' como error definitivo

  /* Etapas reales reportadas por el workflow de n8n (columna `stage` del job) */
  const STAGE_LABELS = {
    en_cola:            'En cola, esperando procesamiento…',
    analizando_con_ia:  'Analizando con inteligencia artificial…',
    queued:             'En cola, esperando procesamiento…',
    extracting:         'Extrayendo el contenido del documento…',
    chunking:           'Preparando fragmentos para RAG…',
    retrieving:         'Buscando contexto relevante…',
    adapting:           'Adaptando el contenido con IA…',
    completed:          '¡Listo!',
    listo:               '¡Listo!',
    failed:              'Error en el procesamiento',
    error:                'Error en el procesamiento',
  };

  /* Ids del DOM que usan processContent/renderResult/setProgress/TTS/etc.
     S.ui apunta siempre a los ids de la vista activa — así toda la lógica
     compartida (fetch, sanitización, polling, historial) es una sola
     implementación que sirve a las 6 vistas, sin duplicarla. */
  const DEFAULT_UI = {
    textInputId: 'text-input', fileInputId: 'file-input', uploadZoneId: 'upload-zone',
    filePreviewId: 'file-preview', fileNameId: 'file-name', previewThumbId: 'preview-thumb',
    processBtnId: 'process-btn', progressWrapId: 'progress-wrap',
    progressFillId: 'progress-fill', progressLabelId: 'progress-label',
    resultSectionId: 'result-section', resultHtmlId: 'result-html-main', resultRawId: 'result-raw',
    ttsPlayBtnId: 'tts-play-btn', ttsRateId: 'tts-rate', readingModeBtnId: 'reading-mode-btn',
    autoSpeak: false,
  };
  const suffixedUi = (suffix, overrides = {}) => ({
    textInputId: 'text-input-' + suffix, fileInputId: 'file-input-' + suffix,
    uploadZoneId: 'upload-zone-' + suffix, filePreviewId: 'file-preview-' + suffix,
    fileNameId: 'file-name-' + suffix, previewThumbId: 'preview-thumb-' + suffix,
    processBtnId: 'process-btn-' + suffix, progressWrapId: 'progress-wrap-' + suffix,
    progressFillId: 'progress-fill-' + suffix, progressLabelId: 'progress-label-' + suffix,
    resultSectionId: 'result-section-' + suffix, resultHtmlId: 'result-html-' + suffix,
    resultRawId: 'result-raw-' + suffix,
    ttsPlayBtnId: 'tts-play-btn-' + suffix, ttsRateId: 'tts-rate-' + suffix,
    readingModeBtnId: null, autoSpeak: false,
    ...overrides,
  });
  const VIEW_UI = {
    docente:  { ...DEFAULT_UI },
    ceguera:  suffixedUi('ceguera', { autoSpeak: true }),
    auditivo: suffixedUi('auditivo', { ttsPlayBtnId: null, ttsRateId: null }),
    'baja-vision': suffixedUi('baja-vision'),
    tdah:     suffixedUi('tdah'),
  };

  /* Perfil + adaptaciones que cada vista especializada del Lobby fuerza al entrar
     (esas vistas no muestran el grid de checkboxes de Docente). */
  const LOBBY_PROFILE_DEFAULTS = {
    ceguera:       { profile: 'ceguera',      adaptations: ['ceguera'] },
    auditivo:      { profile: 'auditivo',     adaptations: ['auditiva'] },
    'baja-vision': { profile: 'baja-vision',  adaptations: ['baja_vision'] },
    tdah:          { profile: 'tdah',         adaptations: ['tdah'] },
  };

  /* ── ESTADO GLOBAL ── */
  const S = {
    file: null, fileType: null, fileBase64: null, fileMime: null,
    extractedText: '', // contenido normalizado del último documento extraído
    extracting: false, // true mientras se extrae texto de un archivo en el navegador
    extractionId: 0,   // invalida extracciones que terminan después de cambiar de archivo
    adaptations: new Set(),
    profile: 'tdah',
    resultText: '',   // texto plano para TTS y descarga
    pollAbort: null,  // { cancelled: bool, xhr } — permite cancelar el envío/polling en curso
    ui: { ...DEFAULT_UI },   // ids activos: los reasigna el router en cada navegación
    tdahStep: 1,
    currentUser: null,  // { id?, email, name, avatarUrl? } — id solo existe con sesión Supabase real
    historyCache: [],   // último historial cargado (Supabase o localStorage), usado por el buscador
    pendingTwoFactorUser: null, // usuario ya autenticado (email+pass) esperando código 2FA antes de abrir la app
  };

  /* ══════════════════════════════════════════════
     AUTH — delega en src/lib/auth.js (Supabase real
     si está configurado; localStorage demo si no)
  ══════════════════════════════════════════════ */
  function switchTab(t) {
    hideTwoFactorPanel();
    ['login','register'].forEach(id => {
      const active = id === t;
      document.getElementById('tab-' + id).classList.toggle('active', active);
      document.getElementById('tab-' + id).setAttribute('aria-selected', active);
      document.getElementById('panel-' + id).classList.toggle('active', active);
    });
    document.getElementById('login-error').textContent = '';
    document.getElementById('reg-error').textContent = '';
  }

  async function doLogin() {
    const email = document.getElementById('login-email').value.trim().toLowerCase();
    const pass  = document.getElementById('login-pass').value;
    const err   = document.getElementById('login-error');
    err.textContent = '';
    const { user, error } = await signInWithPassword(email, pass);
    if (error) { err.textContent = error; return; }

    if (requiresTwoFactor(user)) {
      S.pendingTwoFactorUser = user;
      const { error: sendError } = await requestTwoFactorCode(user.email);
      if (sendError) { err.textContent = sendError; S.pendingTwoFactorUser = null; return; }
      showTwoFactorPanel(user.email);
      return;
    }
    await onSignedIn(user, 'password');
  }

  /* ── 2FA (login admin) ── */
  function showTwoFactorPanel(email) {
    document.querySelector('#auth-modal .modal-tabs').style.display = 'none';
    document.querySelector('#auth-modal .btn-google').style.display = 'none';
    document.querySelector('#auth-modal .auth-divider').style.display = 'none';
    document.getElementById('panel-login').classList.remove('active');
    document.getElementById('panel-register').classList.remove('active');
    document.getElementById('twofa-email-hint').textContent = email;
    document.getElementById('twofa-code').value = '';
    document.getElementById('twofa-error').textContent = '';
    document.getElementById('panel-2fa').classList.add('active');
    document.getElementById('twofa-code').focus();
  }

  function hideTwoFactorPanel() {
    S.pendingTwoFactorUser = null;
    document.querySelector('#auth-modal .modal-tabs').style.display = '';
    document.querySelector('#auth-modal .btn-google').style.display = '';
    document.querySelector('#auth-modal .auth-divider').style.display = '';
    document.getElementById('panel-2fa').classList.remove('active');
  }

  async function doVerifyTwoFactor() {
    const code = document.getElementById('twofa-code').value.trim();
    const err  = document.getElementById('twofa-error');
    err.textContent = '';
    if (!S.pendingTwoFactorUser) { hideTwoFactorPanel(); switchTab('login'); return; }
    if (!/^\d{6}$/.test(code)) { err.textContent = 'Ingresá los 6 dígitos del código.'; return; }

    const { success, error } = await verifyTwoFactorCode(S.pendingTwoFactorUser.email, code);
    if (!success) { err.textContent = error; return; }

    const user = S.pendingTwoFactorUser;
    S.pendingTwoFactorUser = null;
    document.getElementById('panel-2fa').classList.remove('active');
    await onSignedIn(user, 'password+2fa');
  }

  async function doResendTwoFactor() {
    if (!S.pendingTwoFactorUser) return;
    const err = document.getElementById('twofa-error');
    err.textContent = '';
    const { error } = await requestTwoFactorCode(S.pendingTwoFactorUser.email);
    if (error) { err.textContent = error; return; }
    showToast('Te reenviamos el código por correo 📩');
  }

  function doCancelTwoFactor() {
    hideTwoFactorPanel();
    switchTab('login');
  }

  async function doRegister() {
    const name  = document.getElementById('reg-name').value.trim();
    const email = document.getElementById('reg-email').value.trim().toLowerCase();
    const pass  = document.getElementById('reg-pass').value;
    const err   = document.getElementById('reg-error');
    err.textContent = '';
    const { user, error, needsEmailConfirmation } = await signUp(name, email, pass);
    if (error) { err.textContent = error; return; }
    if (needsEmailConfirmation) {
      showToast('Cuenta creada. Revisá tu correo para confirmarla ✅');
      switchTab('login');
      return;
    }
    trackEvent('sign_up', { method: 'password' });
    await onSignedIn(user, 'password');
  }

  async function doGoogleAuth() {
    showToast('Conectando con Google…');
    const { user, error } = await signInWithGoogle();
    if (error) { showToast('No se pudo conectar con Google: ' + error, 'error'); return; }
    if (!user) return; // Supabase real: el navegador ya está redirigiendo a Google
    await onSignedIn(user, 'google');
  }

  async function onSignedIn(user, method) {
    trackEvent('login', { method });
    await showApp(user);
    showToast('¡Bienvenid@, ' + (user.name || user.email) + '! 🎉');
  }

  async function doLogout() {
    closeUserMenu();
    await signOut(); // supabase.auth.signOut() en modo real; limpia la sesión demo en memoria si no
    // Logout defensivo: sessionStorage.clear() cubre cualquier resto de sesión
    // (Supabase guarda ahí el token, ver lib/supabaseClient.js) — importante en
    // equipos compartidos, no solo confiar en signOut() del SDK.
    try { window.sessionStorage.clear(); } catch {}
    resetToLoggedOutUi();
  }

  function resetToLoggedOutUi() {
    S.currentUser = null;
    S.historyCache = [];
    S.pendingTwoFactorUser = null;
    S.file = null; S.fileType = null; S.fileBase64 = null; S.fileMime = null;
    S.extractedText = '';
    S.resultText = '';
    S.adaptations = new Set();
    document.getElementById('app-main').classList.remove('visible');
    document.getElementById('auth-modal').classList.remove('hidden');
    document.getElementById('accessibility-onboarding')?.classList.add('hidden');
    document.getElementById('logout-btn').style.display = 'none';
    document.getElementById('user-badge').innerHTML = '';
    document.getElementById('avatar-upload-btn').style.display = 'none';
    document.getElementById('login-email').value = '';
    document.getElementById('login-pass').value = '';
    clearAll();
    stopSpeech();
    document.body.classList.remove(...Object.values(ONBOARDING_PROFILES).map(item => item.theme));
    // Vuelve a la pantalla de login sin recarga completa: limpia el hash de ruta
    // (deja la URL en index.html "limpio") y el modal de auth ya quedó visible arriba.
    window.history.replaceState(null, '', location.pathname + location.search);
  }

  /* ── Menú flotante de perfil (Ajustes / Cerrar sesión) ── */
  function toggleUserMenu() {
    const menu = document.getElementById('user-menu');
    const btn = document.getElementById('user-menu-toggle');
    if (!menu || !btn) return;
    const willOpen = menu.classList.contains('hidden');
    menu.classList.toggle('hidden', !willOpen);
    btn.setAttribute('aria-expanded', String(willOpen));
  }

  function closeUserMenu() {
    document.getElementById('user-menu')?.classList.add('hidden');
    document.getElementById('user-menu-toggle')?.setAttribute('aria-expanded', 'false');
  }

  document.addEventListener('click', e => {
    const wrap = document.getElementById('user-menu-wrap');
    if (wrap && !wrap.contains(e.target)) closeUserMenu();
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeUserMenu(); });

  async function showApp(user) {
    S.currentUser = user;
    document.getElementById('auth-modal').classList.add('hidden');
    const demoNote = document.getElementById('auth-demo-note');
    if (demoNote) demoNote.style.display = isSupabaseConfigured ? 'none' : 'flex';

    renderUserBadge(user);
    document.getElementById('avatar-upload-btn').style.display = (isSupabaseConfigured && user.id) ? 'inline-flex' : 'none';
    if (window._lucide) window._lucide.createIcons({ icons: window._lucide.icons });

    const [prefs, history] = await Promise.all([
      db.getPreferences(user.id),
      db.getHistory(user.id),
    ]);
    if (prefs?.profile) S.profile = prefs.profile;
    if (prefs?.adaptations?.length) S.adaptations = new Set(prefs.adaptations);
    S.historyCache = history;

    // El perfil se elige explícitamente después de cada inicio de sesión. La
    // selección se recuerda para preseleccionarla, pero no se da por sentada.
    openAccessibilityOnboarding();
  }

  const ONBOARDING_PROFILES = {
    'low-vision': { theme: 'theme-low-vision', route: 'baja-vision', profile: 'visual', adaptations: ['baja_vision', 'ceguera'] },
    dyslexia:     { theme: 'theme-dyslexia', route: 'docente', profile: 'dislexia', adaptations: ['dislexia'] },
    neuro:        { theme: 'theme-neurodivergent', route: 'tdah', profile: 'tdah', adaptations: ['tdah'] },
    blind:        { theme: 'theme-blind', route: 'ceguera', profile: 'visual', adaptations: ['ceguera'] },
    deaf:         { theme: 'theme-deaf', route: 'auditivo', profile: 'auditivo', adaptations: ['auditiva'] },
    standard:     { theme: 'theme-standard', route: 'docente', profile: 'tdah', adaptations: [] },
  };

  function setAccessibilityTheme(profileKey) {
    const option = ONBOARDING_PROFILES[profileKey] || ONBOARDING_PROFILES.standard;
    document.body.classList.remove(...Object.values(ONBOARDING_PROFILES).map(item => item.theme));
    document.body.classList.add(option.theme);
    document.body.dataset.accessibilityProfile = profileKey;
  }

  function openAccessibilityOnboarding() {
    const modal = document.getElementById('accessibility-onboarding');
    modal?.classList.remove('hidden');
    document.getElementById('app-main').classList.remove('visible');
    document.getElementById('logout-btn').style.display = 'inline-flex';
    const saved = localStorage.getItem(ACCESSIBILITY_ONBOARDING_KEY);
    modal?.querySelectorAll('[data-accessibility-profile]').forEach(button => {
      button.setAttribute('aria-pressed', String(button.dataset.accessibilityProfile === saved));
    });
    requestAnimationFrame(() => modal?.querySelector('[data-accessibility-profile]')?.focus());
  }

  /* Persiste el perfil de accesibilidad (localStorage + Supabase si hay
     sesión real) y aplica su tema — sin decidir qué hacer con la UI
     alrededor (eso lo definen los dos callers de abajo). */
  function persistAccessibilityProfile(profileKey) {
    const option = ONBOARDING_PROFILES[profileKey] || ONBOARDING_PROFILES.standard;
    localStorage.setItem(ACCESSIBILITY_ONBOARDING_KEY, profileKey);
    setAccessibilityTheme(profileKey);
    S.profile = option.profile;
    S.adaptations = new Set(option.adaptations);
    db.savePreferences(S.currentUser?.id, S.profile, Array.from(S.adaptations));
    return option;
  }

  function chooseAccessibilityProfile(profileKey) {
    const option = persistAccessibilityProfile(profileKey);
    document.getElementById('accessibility-onboarding')?.classList.add('hidden');
    document.getElementById('app-main').classList.add('visible');
    navigateTo(option.route);
    showToast('Perfil de accesibilidad configurado', 'ok');
  }

  /* Cambio de perfil por defecto desde Ajustes: solo persiste + aplica el
     tema, sin navegar ni tocar el modal de onboarding (a diferencia de
     chooseAccessibilityProfile, que se usa en el flujo de bienvenida). */
  function doUpdateDefaultProfile() {
    const select = document.getElementById('settings-profile-select');
    if (!select) return;
    persistAccessibilityProfile(select.value);
    showToast('Preferencia de accesibilidad guardada ✅');
  }

  function renderUserBadge(user) {
    const rawName = user.name || user.email || '';
    const initials = escHtml(rawName.split(' ').map(w => w[0]).join('').slice(0,2).toUpperCase());
    const badge = document.getElementById('user-badge');
    badge.innerHTML = user.avatarUrl
      ? `<img src="${escHtml(user.avatarUrl)}" alt="" class="user-avatar" style="object-fit:cover" />
         <span>${escHtml(rawName)}</span>`
      : `<div class="user-avatar" aria-hidden="true">${initials}</div>
         <span>${escHtml(rawName)}</span>`;
  }

  /* ══════════════════════════════════════════════
     AJUSTES — cuenta/credenciales, preferencias de
     accesibilidad y estado del 2FA (ver AUTH_SECURITY.md)
  ══════════════════════════════════════════════ */
  function renderSettingsView() {
    if (!S.currentUser) return;

    const emailEl = document.getElementById('settings-email');
    if (emailEl) emailEl.textContent = S.currentUser.email || '—';

    const select = document.getElementById('settings-profile-select');
    if (select) select.value = localStorage.getItem(ACCESSIBILITY_ONBOARDING_KEY) || 'standard';

    ['settings-pass-current', 'settings-pass-new', 'settings-pass-confirm'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
    const err = document.getElementById('settings-pass-error');
    const ok  = document.getElementById('settings-pass-success');
    if (err) err.textContent = '';
    if (ok)  ok.textContent = '';

    render2FAStatus();
  }

  function render2FAStatus() {
    const pill = document.getElementById('settings-2fa-pill');
    const desc = document.getElementById('settings-2fa-desc');
    if (!pill || !desc) return;

    if (!isSupabaseConfigured) {
      pill.textContent = 'No disponible';
      pill.style.color = 'var(--color-muted)';
      pill.style.background = 'color-mix(in srgb, var(--color-muted) 16%, transparent)';
      desc.textContent = 'El 2FA por correo requiere Supabase configurado — no está disponible en modo demo.';
      return;
    }

    if (S.currentUser?.role === 'admin') {
      pill.textContent = 'Activo';
      pill.style.color = 'var(--color-accent)';
      pill.style.background = 'color-mix(in srgb, var(--color-accent) 16%, transparent)';
      desc.textContent = 'Tu cuenta es admin: en cada inicio de sesión te vamos a pedir un código de 6 dígitos enviado por correo antes de abrir la app.';
    } else {
      pill.textContent = 'No aplica';
      pill.style.color = 'var(--color-muted)';
      pill.style.background = 'color-mix(in srgb, var(--color-muted) 16%, transparent)';
      desc.textContent = 'Hoy el 2FA por correo solo se exige a cuentas admin. Tu cuenta no lo necesita.';
    }
  }

  async function doUpdatePassword() {
    const current = document.getElementById('settings-pass-current').value;
    const next    = document.getElementById('settings-pass-new').value;
    const confirm = document.getElementById('settings-pass-confirm').value;
    const err = document.getElementById('settings-pass-error');
    const ok  = document.getElementById('settings-pass-success');
    err.textContent = '';
    ok.textContent = '';

    if (!current || !next || !confirm) { err.textContent = 'Completá todos los campos.'; return; }
    const policyError = validatePasswordPolicy(next);
    if (policyError) { err.textContent = policyError; return; }
    if (next !== confirm) { err.textContent = 'Las contraseñas nuevas no coinciden.'; return; }

    const { error } = await updatePassword(current, next);
    if (error) { err.textContent = error; return; }

    document.getElementById('settings-pass-current').value = '';
    document.getElementById('settings-pass-new').value = '';
    document.getElementById('settings-pass-confirm').value = '';
    ok.textContent = 'Contraseña actualizada ✅';
    trackEvent('password_update', {});
  }

  /* ══════════════════════════════════════════════
     AVATAR (Supabase Storage)
  ══════════════════════════════════════════════ */
  function triggerAvatarUpload() {
    document.getElementById('avatar-file-input').click();
  }

  async function handleAvatarSelect(e) {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file || !S.currentUser?.id) return;
    showToast('Subiendo foto de perfil…');
    const url = await uploadAvatar(file, S.currentUser.id);
    if (!url) { showToast('No se pudo subir la imagen', 'error'); return; }
    S.currentUser = { ...S.currentUser, avatarUrl: url };
    renderUserBadge(S.currentUser);
    if (window._lucide) window._lucide.createIcons({ icons: window._lucide.icons });
    showToast('Foto de perfil actualizada ✅');
  }

  /* ══════════════════════════════════════════════
     ROUTER — Lobby + 5 interfaces especializadas
  ══════════════════════════════════════════════ */
  const ROUTES = ['lobby', 'ceguera', 'auditivo', 'baja-vision', 'tdah', 'docente', 'ajustes'];

  function currentRoute() {
    const r = (location.hash || '').replace(/^#\/?/, '');
    return ROUTES.includes(r) ? r : null;
  }

  /* Fija S.profile/S.adaptations para una vista especializada (sin tocar el
     selector/checkboxes internos de Docente, que usan applyProfile()). */
  function forceProfile(route) {
    const def = LOBBY_PROFILE_DEFAULTS[route];
    if (!def) return;
    S.profile = def.profile;
    S.adaptations = new Set(def.adaptations);
  }

  function navigateTo(route) {
    if (!ROUTES.includes(route)) route = 'lobby';
    if (currentRoute() === route) { renderRoute(); return; }
    location.hash = '/' + route;
  }

  function renderRoute() {
    const route = currentRoute() || 'lobby';
    if (route === 'ajustes' && !S.currentUser) { navigateTo('lobby'); return; }
    if (route !== 'tdah') document.body.classList.remove('neuro-focus-mode');
    const prevRoute = document.querySelector('.view.active')?.id.replace('view-', '');
    if (prevRoute === 'ceguera' && route !== 'ceguera') stopSpeech();

    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('view-' + route)?.classList.add('active');

    S.ui = { ...(VIEW_UI[route] || VIEW_UI.docente) };

    if (route === 'docente') {
      const checked = document.querySelector('input[name="adaptation-profile"]:checked');
      applyProfile(checked ? checked.value : S.profile);
    } else if (route !== 'ajustes') {
      forceProfile(route);
    }

    if (route === 'ajustes') renderSettingsView();
    if (route === 'tdah') goToTdahStep(1);
    if (route === 'ceguera' && prevRoute !== 'ceguera') {
      speak('Perfil ceguera y audio navegación activado. Escribí o pegá el contenido, o subí un archivo, y presioná procesar y escuchar.');
    }
    if (route === 'auditivo') {
      ['auditivo-step-received', 'auditivo-step-processing', 'auditivo-step-done'].forEach(id => {
        document.getElementById(id)?.classList.remove('is-active', 'is-done');
      });
      document.getElementById('auditivo-step-received')?.classList.add('is-active');
    }

    window.scrollTo(0, 0);
    if (window._lucide) window._lucide.createIcons({ icons: window._lucide.icons });
    trackPageView(route);
  }

  window.addEventListener('hashchange', renderRoute);

  /* ══════════════════════════════════════════════
     WIZARD TDAH — pasos-tarjeta (contenido → confirmar → resultado)
  ══════════════════════════════════════════════ */
  function goToTdahStep(step) {
    S.tdahStep = step;
    [1, 2, 3].forEach(n => {
      document.getElementById('tdah-step-' + n)?.classList.toggle('active', n === step);
    });
    const fill = document.getElementById('tdah-progress-fill');
    if (fill) fill.style.width = Math.round((step / 3) * 100) + '%';
    const label = document.getElementById('tdah-progress-label');
    if (label) label.textContent = 'Paso ' + step + ' de 3';
  }
  function nextTdahStep() {
    if (S.tdahStep === 1) {
      const txt = document.getElementById(S.ui.textInputId).value.trim();
      if (!S.file && !txt) { showToast('Subí un archivo o pegá texto primero', 'warn'); return; }
    }
    goToTdahStep(Math.min(S.tdahStep + 1, 3));
  }
  function prevTdahStep() {
    goToTdahStep(Math.max(S.tdahStep - 1, 1));
  }
  /* Botón del paso 2 (Confirmar): avanza al paso 3 y dispara el procesamiento */
  function submitTdahStep() {
    goToTdahStep(3);
    processContent();
  }

  window.addEventListener('DOMContentLoaded', async () => {
    if (localStorage.getItem(CONSENT_KEY)) initAnalytics();

    // En modo Supabase, mantiene la sesión sincronizada (login/logout/expiración
    // de token, incluida la vuelta del redirect de Google OAuth). No-op en modo demo.
    onAuthStateChange(user => {
      if (user) showApp(user);
      else if (S.currentUser) resetToLoggedOutUi();
    });

    const user = await getCurrentUser();
    if (user) await showApp(user);

    if (!localStorage.getItem(CONSENT_KEY)) {
      document.getElementById('consent-banner')?.classList.remove('hidden');
    }
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      const legal = document.getElementById('modal-legal');
      if (legal && !legal.classList.contains('hidden')) closeLegalModal();
      const history = document.getElementById('modal-history');
      if (history && !history.classList.contains('hidden')) closeHistoryModal();
      closeGlobalSearch();
      return;
    }
    if (e.key !== 'Enter') return;
    const modal = document.getElementById('auth-modal');
    if (modal && !modal.classList.contains('hidden')) {
      const panel = document.querySelector('.tab-panel.active');
      if (panel?.id === 'panel-login') doLogin();
      if (panel?.id === 'panel-register') doRegister();
    }
  });

  document.addEventListener('click', e => {
    if (!e.target.closest('.header-search')) closeGlobalSearch();
  });

  /* ══════════════════════════════════════════════
     LEGAL (términos / privacidad / deslinde de IA)
     + CONSENTIMIENTO DE ALMACENAMIENTO LOCAL
  ══════════════════════════════════════════════ */
  function switchLegalTab(t) {
    ['terms','privacy','disclaimer'].forEach(id => {
      const active = id === t;
      document.getElementById('ltab-' + id).classList.toggle('active', active);
      document.getElementById('ltab-' + id).setAttribute('aria-selected', active);
      document.getElementById('lpanel-' + id).classList.toggle('active', active);
    });
  }

  function openLegalModal(tab) {
    switchLegalTab(tab || 'terms');
    document.getElementById('modal-legal')?.classList.remove('hidden');
    if (window._lucide) window._lucide.createIcons({ icons: window._lucide.icons });
  }

  function closeLegalModal() {
    document.getElementById('modal-legal')?.classList.add('hidden');
  }

  function acceptConsent() {
    localStorage.setItem(CONSENT_KEY, '1');
    document.getElementById('consent-banner')?.classList.add('hidden');
    initAnalytics();
  }

  /* ══════════════════════════════════════════════
     BUSCADOR GLOBAL (header) — src/lib/search.js
  ══════════════════════════════════════════════ */
  let _searchDebounceTimer = null;
  function onGlobalSearchInput(query) {
    clearTimeout(_searchDebounceTimer);
    _searchDebounceTimer = setTimeout(() => renderSearchResults(query), 120);
  }

  function onGlobalSearchKeydown(e) {
    if (e.key === 'Escape') { closeGlobalSearch(); e.target.blur(); }
  }

  function renderSearchResults(query) {
    const box = document.getElementById('global-search-results');
    if (!box) return;
    const q = (query || '').trim();
    if (!q) { box.classList.add('hidden'); box.innerHTML = ''; return; }

    const results = searchAll(q, S.historyCache);
    if (results.length === 0) {
      box.innerHTML = `<div class="search-result-empty">Sin resultados para "${escHtml(q)}"</div>`;
      box.classList.remove('hidden');
      return;
    }

    box.innerHTML = results.map((r, i) => `
      <button type="button" class="search-result-item" data-idx="${i}" role="option">
        <span class="search-result-label">${escHtml(r.label)}</span>
        <span class="search-result-sublabel">${escHtml(r.sublabel || '')}</span>
      </button>`).join('');
    box.classList.remove('hidden');
    box.querySelectorAll('.search-result-item').forEach((btn, i) => {
      btn.onclick = () => executeSearchResult(results[i]);
    });
  }

  function executeSearchResult(result) {
    closeGlobalSearch();
    if (result.type === 'view') { navigateTo(result.route); return; }
    if (result.type === 'action') {
      if (result.action === 'lobby') navigateTo('lobby');
      if (result.action === 'history') openHistoryModal();
      return;
    }
    if (result.type === 'legal') { openLegalModal(result.tab); return; }
    if (result.type === 'history') { loadHistoryItem(result.historyId); return; }
  }

  function closeGlobalSearch() {
    const box = document.getElementById('global-search-results');
    if (box) { box.classList.add('hidden'); box.innerHTML = ''; }
  }

  /* ══════════════════════════════════════════════
     PERFIL DE ADAPTACIÓN (Paso 1)
  ══════════════════════════════════════════════ */
  const PROFILE_PRIORITIES = {
    tdah:      ['opt-tdah'],
    dislexia:  ['opt-dislexia'],
    visual:    ['opt-baja-vision', 'opt-ceguera'],
    cognitiva: ['opt-cognitiva'],
  };

  const PROFILE_NAMES = {
    tdah: 'TDAH',
    dislexia: 'Dislexia',
    visual: 'Discapacidad visual',
    cognitiva: 'Discapacidad cognitiva',
  };

  /* Aplica el perfil (clase en <body>, tarjeta activa, checkboxes prioritarios) sin notificar */
  function applyProfile(profile) {
    S.profile = profile;

    document.querySelectorAll('.profile-card').forEach(card => {
      const input = card.querySelector('input[type="radio"]');
      card.classList.toggle('active', input?.value === profile);
    });

    document.body.className = document.body.className.replace(/\bprofile-\S+/g, '').trim();
    document.body.classList.add('profile-' + profile);

    document.querySelectorAll('.section-priority').forEach(el => {
      el.classList.remove('section-priority');
      el.querySelectorAll('.priority-badge').forEach(b => b.remove());
    });

    (PROFILE_PRIORITIES[profile] || []).forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      el.classList.add('section-priority');
      const labelEl = el.querySelector('.adapt-label');
      if (labelEl && !labelEl.querySelector('.priority-badge')) {
        const b = document.createElement('span');
        b.className = 'priority-badge'; b.textContent = 'Prioridad'; labelEl.appendChild(b);
      }
      const chk = el.querySelector('input[type="checkbox"]');
      if (chk && !chk.checked) { chk.checked = true; S.adaptations.add(chk.value); }
      el.classList.add('checked');
    });
  }

  /* Handler del onchange en las tarjetas de perfil: aplica + notifica + persiste preferencia */
  function selectProfile(input) {
    applyProfile(input.value);
    showToast('Perfil ' + (PROFILE_NAMES[input.value] || input.value) + ' activado');
    db.savePreferences(S.currentUser?.id, S.profile, Array.from(S.adaptations));
  }

  /* ══════════════════════════════════════════════
     MANEJO DE ARCHIVOS — Universal + Base64 limpio
  ══════════════════════════════════════════════ */
  function triggerFileInput() {
    document.getElementById(S.ui.fileInputId).click();
  }
  function handleFileSelect(e) { processFile(e.target.files[0]); }
  function handleDragOver(e) {
    e.preventDefault();
    document.getElementById(S.ui.uploadZoneId).classList.add('dragover');
  }
  function handleDrop(e) {
    e.preventDefault();
    document.getElementById(S.ui.uploadZoneId).classList.remove('dragover');
    processFile(e.dataTransfer.files[0]);
  }

  function processFile(file) {
    if (!file) return;
    S.extractionId += 1;
    S.file = file; S.fileBase64 = null; S.fileMime = file.type; S.extractedText = '';
    const isImg = IMAGE_TYPES.includes(file.type);
    S.fileType = isImg ? 'image' : 'text-file';

    const preview = document.getElementById(S.ui.filePreviewId);
    document.getElementById(S.ui.fileNameId).textContent = file.name + ' (' + fmtBytes(file.size) + ')';
    preview.classList.add('visible');
    const thumb = document.getElementById(S.ui.previewThumbId);

    if (isImg) {
      const reader = new FileReader();
      reader.onload = ev => {
        S.fileBase64 = ev.target.result.split(',')[1];
        thumb.src = ev.target.result;
        thumb.alt = 'Vista previa de ' + file.name;
        thumb.style.display = 'block';
      };
      reader.onerror = () => showToast('Error al leer la imagen', 'error');
      reader.readAsDataURL(file);
    } else {
      thumb.style.display = 'none';
      thumb.src = '';
      extractTextFromFile(file, S.extractionId); // extrae localmente y vuelca el texto en el textarea
    }
  }

  function clearFile() {
    S.extractionId += 1;
    S.extracting = false;
    S.file = null; S.fileBase64 = null; S.fileMime = null; S.fileType = null; S.extractedText = '';
    document.getElementById(S.ui.fileInputId).value = '';
    document.getElementById(S.ui.filePreviewId).classList.remove('visible');
    const thumb = document.getElementById(S.ui.previewThumbId);
    thumb.style.display = 'none'; thumb.src = '';
  }

  function fmtBytes(b) {
    if (b < 1024) return b + ' B';
    if (b < 1048576) return (b/1024).toFixed(1) + ' KB';
    return (b/1048576).toFixed(1) + ' MB';
  }

  /* ══════════════════════════════════════════════
     EXTRACCIÓN DE TEXTO EN EL NAVEGADOR — PDF / DOCX / XLSX / PPTX / TXT
     (soluciona que el payload viaje vacío hacia n8n; todo se
     procesa localmente, el archivo original nunca se sube al
     webhook — si Supabase Storage está configurado, se sube por
     separado y en paralelo, ver processContent())
  ══════════════════════════════════════════════ */
  const MAX_EXTRACT_FILE_SIZE = 50 * 1024 * 1024; // permite documentos educativos pesados

  /* Carga pdfjs-dist / mammoth de forma diferida (dynamic import) para no
     inflar el bundle inicial con librerías que la mayoría de las visitas
     nunca va a usar. Se cachean en una promesa para no reimportar dos veces. */
  let _pdfjsPromise = null;
  function loadPdfjs() {
    if (!_pdfjsPromise) {
      _pdfjsPromise = Promise.all([
        import('pdfjs-dist'),
        import('pdfjs-dist/build/pdf.worker.mjs?url'),
      ]).then(([pdfjsLib, workerUrl]) => {
        pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl.default;
        return pdfjsLib;
      });
    }
    return _pdfjsPromise;
  }

  let _mammothPromise = null;
  function loadMammoth() {
    if (!_mammothPromise) _mammothPromise = import('mammoth').then(m => m.default ?? m);
    return _mammothPromise;
  }

  let _jszipPromise = null;
  function loadJsZip() {
    if (!_jszipPromise) _jszipPromise = import('jszip').then(m => m.default ?? m);
    return _jszipPromise;
  }

  /* Normaliza texto de cualquier origen antes de mostrarlo o enviarlo.
     Conserva párrafos y tablas legibles, pero elimina caracteres invisibles,
     espacios repetidos y saltos de línea excesivos que degradan el payload. */
  function cleanExtractedText(value) {
    return String(value || '')
      .normalize('NFKC')
      .replace(/\r\n?/g, '\n')
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200D\uFEFF]/g, '')
      .replace(/[\t\f\v ]+/g, ' ')
      .replace(/ *\n */g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  async function extractPdfText(file) {
    const pdfjsLib = await loadPdfjs();
    const buffer = await file.arrayBuffer();
    let pdf;
    try {
      pdf = await pdfjsLib.getDocument({
        data: buffer,
        cMapUrl: '/pdfjs/cmaps/',
        cMapPacked: true,
        standardFontDataUrl: '/pdfjs/standard_fonts/',
      }).promise;
    } catch {
      throw new Error('El PDF está dañado, protegido con contraseña o no es un PDF válido.');
    }

    const parts = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      const lines = [];
      let line = '';
      for (const item of content.items) {
        line += item.str;
        if (item.hasEOL) { lines.push(line); line = ''; }
        else if (item.str) line += ' ';
      }
      if (line) lines.push(line);
      parts.push(lines.join('\n'));
    }
    return parts.join('\n\n');
  }

  async function extractDocxText(file) {
    const mammoth = await loadMammoth();
    const arrayBuffer = await file.arrayBuffer();
    let result;
    try {
      result = await mammoth.extractRawText({ arrayBuffer });
    } catch {
      throw new Error('El archivo .docx está dañado o no es un documento de Word válido.');
    }
    return result.value;
  }

  function xmlTextElements(root) {
    return Array.from(root.getElementsByTagName('*')).filter(node => node.localName === 't');
  }

  function textFromXml(root) {
    return xmlTextElements(root).map(node => node.textContent || '').join('');
  }

  async function extractXlsxText(file) {
    const JSZip = await loadJsZip();
    let zip;
    try {
      zip = await JSZip.loadAsync(await file.arrayBuffer());
    } catch {
      throw new Error('El archivo .xlsx está dañado o no es un libro de Excel válido.');
    }

    const parseXml = async path => {
      const entry = zip.file(path);
      if (!entry) return null;
      const xml = await entry.async('text');
      const doc = new DOMParser().parseFromString(xml, 'application/xml');
      if (doc.querySelector('parsererror')) throw new Error('El libro contiene XML inválido.');
      return doc;
    };
    try {
      const sharedStringsXml = await parseXml('xl/sharedStrings.xml');
      const sharedStrings = sharedStringsXml
        ? Array.from(sharedStringsXml.getElementsByTagName('*')).filter(node => node.localName === 'si').map(textFromXml)
        : [];
      const workbookXml = await parseXml('xl/workbook.xml');
      if (!workbookXml) throw new Error('El libro no contiene hojas legibles.');
      const relationsXml = await parseXml('xl/_rels/workbook.xml.rels');
      const relationTargets = new Map(Array.from(relationsXml?.getElementsByTagName('*') || [])
        .filter(node => node.localName === 'Relationship')
        .map(node => [node.getAttribute('Id'), node.getAttribute('Target')]));
      const sheets = Array.from(workbookXml.getElementsByTagName('*')).filter(node => node.localName === 'sheet');

      const extracted = await Promise.all(sheets.map(async (sheet, index) => {
        const relationId = sheet.getAttribute('r:id');
        const target = relationTargets.get(relationId);
        const path = target ? `xl/${target.replace(/^\/+/, '')}` : `xl/worksheets/sheet${index + 1}.xml`;
        const sheetXml = await parseXml(path);
        if (!sheetXml) return `Hoja: ${sheet.getAttribute('name') || index + 1} (vacía)`;
        const rows = Array.from(sheetXml.getElementsByTagName('*')).filter(node => node.localName === 'row')
          .map(row => Array.from(row.getElementsByTagName('*')).filter(node => node.localName === 'c').map(cell => {
            const type = cell.getAttribute('t');
            if (type === 'inlineStr') return textFromXml(cell);
            const value = Array.from(cell.getElementsByTagName('*')).find(node => node.localName === 'v')?.textContent || '';
            if (type === 's') return sharedStrings[Number(value)] || '';
            if (type === 'b') return value === '1' ? 'Sí' : 'No';
            return value;
          }).filter(Boolean).join(' | ')).filter(Boolean);
        const name = sheet.getAttribute('name') || `Hoja ${index + 1}`;
        return rows.length ? `Hoja: ${name}\n${rows.join('\n')}` : `Hoja: ${name} (vacía)`;
      }));
      return extracted.join('\n\n');
    } catch (err) {
      if (err.message) throw err;
      throw new Error('No se pudo leer el contenido del libro de Excel.');
    }
  }

  function slideNumber(path) {
    return Number((/slide(\d+)\.xml$/i.exec(path) || [])[1] || 0);
  }

  async function extractPptxText(file) {
    const JSZip = await loadJsZip();
    let zip;
    try {
      zip = await JSZip.loadAsync(await file.arrayBuffer());
    } catch {
      throw new Error('El archivo .pptx está dañado o no es una presentación válida.');
    }
    const slidePaths = Object.keys(zip.files)
      .filter(path => /^ppt\/slides\/slide\d+\.xml$/i.test(path))
      .sort((a, b) => slideNumber(a) - slideNumber(b));
    if (!slidePaths.length) throw new Error('La presentación no contiene diapositivas legibles.');

    const slides = await Promise.all(slidePaths.map(async (path, index) => {
      const xml = await zip.file(path).async('text');
      const documentXml = new DOMParser().parseFromString(xml, 'application/xml');
      if (documentXml.querySelector('parsererror')) throw new Error('Una diapositiva contiene XML inválido.');
      const text = xmlTextElements(documentXml)
        .map(node => node.textContent || '').filter(Boolean).join(' ');
      return text ? `Diapositiva ${index + 1}:\n${text}` : '';
    }));
    return slides.filter(Boolean).join('\n\n');
  }

  /* Feedback visual reutilizando el nombre de archivo ya visible (sin
     necesidad de markup extra por vista) */
  function setExtractingUi(on) {
    const nameEl = document.getElementById(S.ui.fileNameId);
    if (!nameEl) return;
    if (on) {
      nameEl.dataset.originalText = nameEl.textContent;
      nameEl.innerHTML = '<i data-lucide="loader-2" style="width:13px;height:13px;animation:spin 1s linear infinite;vertical-align:-2px"></i> Extrayendo texto…';
      if (window._lucide) window._lucide.createIcons({ icons: window._lucide.icons });
    } else if (nameEl.dataset.originalText) {
      nameEl.textContent = nameEl.dataset.originalText;
      delete nameEl.dataset.originalText;
    }
  }

  async function extractTextFromFile(file, extractionId) {
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    const textInput = document.getElementById(S.ui.textInputId);

    if (file.size > MAX_EXTRACT_FILE_SIZE) {
      showToast(`"${file.name}" supera el máximo permitido (${fmtBytes(MAX_EXTRACT_FILE_SIZE)})`, 'error');
      clearFile();
      return;
    }
    if (ext === 'doc') {
      showToast('El formato .doc (Word 97-2003) no es compatible. Convertilo a .docx o .txt.', 'error');
      clearFile();
      return;
    }

    S.extracting = true;
    setExtractingUi(true);

    try {
      let text = '';
      if (ext === 'pdf' || file.type === 'application/pdf') {
        text = await extractPdfText(file);
      } else if (ext === 'docx' || file.type.includes('wordprocessingml')) {
        text = await extractDocxText(file);
      } else if (ext === 'xlsx' || file.type.includes('spreadsheetml')) {
        text = await extractXlsxText(file);
      } else if (ext === 'pptx' || file.type.includes('presentationml')) {
        text = await extractPptxText(file);
      } else if (ext === 'txt' || file.type === 'text/plain' || file.type === '') {
        text = await file.text();
      } else {
        throw new Error('Formato no soportado. Usá PDF, DOCX, XLSX, PPTX o TXT.');
      }

      text = cleanExtractedText(text);

      if (!text) {
        throw new Error('No se pudo extraer texto de este archivo (¿está vacío o es una imagen escaneada sin texto?).');
      }

      if (extractionId !== S.extractionId) return;
      textInput.value = text;
      S.extractedText = text;
      showToast('Texto extraído de "' + file.name + '" ✅');
    } catch (err) {
      console.error('[EduInclusiva] Error extrayendo texto del archivo:', err);
      showToast('No se pudo leer "' + file.name + '": ' + err.message, 'error');
      if (extractionId === S.extractionId) clearFile();
    } finally {
      if (extractionId === S.extractionId) {
        S.extracting = false;
        setExtractingUi(false);
      }
    }
  }

  /* ══════════════════════════════════════════════
     ADAPTACIONES
  ══════════════════════════════════════════════ */
  function toggleAdapt(chk, id) {
    chk.checked ? S.adaptations.add(chk.value) : S.adaptations.delete(chk.value);
    document.getElementById(id).classList.toggle('checked', chk.checked);
  }

  /* ══════════════════════════════════════════════
     PROCESAR → WEBHOOK
  ══════════════════════════════════════════════ */
  async function processContent() {
    if (S.extracting) { showToast('Esperá, todavía se está extrayendo el texto del archivo…', 'warn'); return; }
    const txt = cleanExtractedText(document.getElementById(S.ui.textInputId).value);
    // El textarea es la fuente de verdad: permite editar la extracción antes de enviarla.
    S.extractedText = txt;
    if (S.fileType === 'text-file' && !S.extractedText) {
      showToast('El documento está vacío o no se pudo extraer texto', 'error');
      return;
    }
    if (!S.file && !txt) { showToast('Subí un archivo o pegá texto primero', 'warn'); return; }
    if (S.adaptations.size === 0) { showToast('Elegí al menos una adaptación', 'warn'); return; }
    if (S.fileType === 'image' && !S.fileBase64) { showToast('Esperá, la imagen aún se está leyendo…', 'warn'); return; }

    setProcessing(true);

    const user = S.currentUser || {};

    /* Sube el archivo original a Supabase Storage en paralelo, sin bloquear
       el flujo principal — nunca forma parte del payload de n8n. No-op si
       Storage no está configurado o el usuario está en modo demo. */
    const uploadPromise = (S.file && S.currentUser?.id)
      ? uploadOriginalFile(S.file, S.currentUser.id)
      : Promise.resolve(null);

    /* Payload hacia n8n. Las claves deben coincidir EXACTAMENTE con las que lee
       el nodo "2 · Edit Fields (Normalizar)" del workflow EduInclusiva AI
       (body.text_content, body.content_type, body.image_base64, body.image_mime,
       body.adaptations, body.profile, body.idioma) — cualquier otro nombre llega
       vacío al normalizador y el job termina en error "contenido no legible".
       Nunca se hace fetch de un documento sin texto extraído. Se agregan claves
       auxiliares (userEmail, fileName, timestamp) como metadata útil, ignoradas
       por el normalizador pero sin costo. */
    const payload = {
      text_content: S.extractedText,
      content_type: S.fileType === 'image' ? 'image' : (S.fileType === 'text-file' ? 'file' : 'text'),
      profile:      S.profile,
      adaptations:  Array.from(S.adaptations),
      image_base64: S.fileType === 'image' ? S.fileBase64 : null,   // string base64 puro, sin prefijo data:, solo si es imagen
      image_mime:   S.fileType === 'image' ? S.fileMime : null,     // "image/jpeg" | "image/png" | "image/webp"
      idioma:       'es',
      userEmail:    user.email || 'anonimo',
      fileName:     S.file?.name || null,
      timestamp:    new Date().toISOString(),
    };

    setProgress(12, 'Enviando contenido…');

    const abortToken = { cancelled: false, xhr: null };
    S.pollAbort = abortToken;

    try {
      const res = await postJSON(WEBHOOK_URL, payload, {
        timeoutMs: UPLOAD_TIMEOUT_MS,
        abortToken,
        // Progreso REAL de bytes subidos (no estimado): útil cuando el archivo es grande
        // y la petición tardaría en completarse sin dar ninguna señal al usuario.
        onUploadProgress: (frac) => {
          setProgress(12 + Math.round(frac * 16), frac < 1 ? 'Subiendo contenido…' : 'Contenido enviado, esperando confirmación…');
        },
      });

      const rawText = res.text;                        // nunca lanza, siempre devuelve string

      if (!res.ok) {
        const httpMsg = rawText.trim() || `HTTP ${res.status} ${res.statusText}`;
        renderFallback(`El servidor respondió con un error (${res.status}):\n${httpMsg}`);
        showToast('El servidor devolvió un error ' + res.status, 'error');
        return;
      }

      if (!rawText.trim()) {
        renderFallback(
          '✅ El backend recibió la solicitud correctamente.\n\n' +
          'El workflow de n8n procesó el contenido pero no devolvió texto adaptado en la respuesta. ' +
          'Revisá el nodo de respuesta en n8n y asegurate de que devuelva el campo ' +
          '"adapted_text" o "output" en el body.'
        );
        showToast('Solicitud recibida en el backend ✅', 'ok');
        return;
      }

      let data;
      try {
        data = JSON.parse(rawText);
      } catch {
        data = { adapted_text: rawText };
      }

      const jobId = data?.job_id ?? data?.jobId ?? data?.id ?? null;
      const status = (data?.status || '').toLowerCase();

      // Modo asíncrono: el webhook devolvió un job_id (y todavía no el resultado final) → polling
      if (jobId && !JOB_DONE_STATUSES.includes(status)) {
        setProgress(30, 'Job encolado, esperando procesamiento…');
        let finalData;
        try {
          finalData = isSupabaseConfigured
            ? await pollJobStatusFromSupabase(jobId, abortToken)
            : await pollJobStatus(jobId, abortToken);
        } catch (pollErr) {
          if (abortToken.cancelled) return;
          console.error('[EduInclusiva] poll error:', pollErr);
          renderFallback('⚠️ Error consultando el estado del job en n8n.\n\nDetalle: ' + pollErr.message);
          showToast('El job no pudo completarse', 'error');
          return;
        }
        if (abortToken.cancelled || finalData === null) return;
        setProgress(98, '¡Listo!');
        renderResult(finalData, uploadPromise);
        return;
      }

      // Modo síncrono: el webhook ya devolvió el resultado final directamente
      setProgress(98, '¡Listo!');
      renderResult(data, uploadPromise);

    } catch (err) {
      if (abortToken.cancelled || err?.aborted) return;
      console.error('[EduInclusiva] fetch error:', err);
      const esTimeout = err?.timeout === true;
      renderFallback(
        '⚠️ No se pudo conectar con el servidor.\n\n' +
        'Causa probable: ' + (esTimeout
          ? 'el archivo es muy grande o la conexión es lenta, y el envío superó el tiempo máximo de espera.'
          : 'error de red, CORS bloqueado o el webhook de n8n no está activo.') + '\n\n' +
        'Detalle técnico: ' + err.message
      );
      showToast(esTimeout ? 'El envío tardó demasiado' : 'Sin conexión con el servidor', 'error');
    } finally {
      if (S.pollAbort === abortToken) S.pollAbort = null;
      setTimeout(() => setProcessing(false), 700);
    }
  }

  /* Envía JSON por XHR (en vez de fetch) para poder reportar progreso REAL de subida
     (evento `upload.onprogress`, no disponible con fetch) y aplicar un timeout duro:
     con archivos grandes, fetch puede quedarse "colgado" sin ninguna señal para el
     usuario ni forma de cortar la espera. abortToken.xhr permite cancelarlo desde
     clearAll() si el usuario limpia el formulario a mitad de la subida. */
  function postJSON(url, payload, { timeoutMs, onUploadProgress, abortToken } = {}) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      if (abortToken) abortToken.xhr = xhr;
      xhr.open('POST', url, true);
      xhr.setRequestHeader('Content-Type', 'application/json');
      if (timeoutMs) xhr.timeout = timeoutMs;
      xhr.upload.onprogress = (e) => {
        if (onUploadProgress && e.lengthComputable) onUploadProgress(e.loaded / e.total);
      };
      xhr.onload = () => resolve({ ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status, statusText: xhr.statusText, text: xhr.responseText });
      xhr.onerror = () => reject(new Error('Error de red al enviar el contenido.'));
      xhr.ontimeout = () => reject(Object.assign(new Error('El envío superó los ' + Math.round(timeoutMs / 1000) + 's de espera máxima.'), { timeout: true }));
      xhr.onabort = () => reject(Object.assign(new Error('cancelled'), { aborted: true }));
      xhr.send(JSON.stringify(payload));
    });
  }

  /* ══════════════════════════════════════════════
     POLLING ASÍNCRONO DE ESTADO DEL JOB (n8n)
  ══════════════════════════════════════════════ */
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  /* Traduce el `progress`/`stage` reales que reporta la Data Table de jobs en n8n
     (columnas agregadas junto con el checkpoint "4b · Actualizar Job (Analizando IA)")
     a un porcentaje y una etiqueta legibles. Si el backend no reporta progreso
     (workflows viejos o sin el campo), cae a una estimación razonable. */
  function jobProgressPct(data, status) {
    const n = Number(data?.progress);
    if (Number.isFinite(n)) return Math.min(Math.max(n, 5), 95);
    return status === 'processing' ? 60 : 40;
  }
  function jobStageLabel(data, status) {
    return STAGE_LABELS[data?.stage] || (status === 'processing' ? 'Procesando…' : 'Verificando estado del job…');
  }

  const RAG_STATUS_PROGRESS = {
    queued: 5,
    extracting: 20,
    chunking: 40,
    retrieving: 60,
    adapting: 80,
    completed: 100,
    failed: 100,
  };

  /** Consulta el estado persistido por n8n para un job de RAG. */
  async function checkJobStatus(jobId) {
    if (!supabase) throw new Error('Supabase no está configurado.');

    const { data, error } = await supabase
      .from('jobs')
      .select('progress_status, result_data')
      .eq('id', jobId)
      .maybeSingle();

    if (error) throw error;
    return data;
  }

  /**
   * Consulta Supabase cada tres segundos. Los errores de red son transitorios:
   * se registran y el siguiente tick vuelve a intentarlo sin cerrar el job.
   */
  function pollJobStatusFromSupabase(jobId, abortToken) {
    return new Promise((resolve, reject) => {
      let inFlight = false;
      const stop = () => {
        clearInterval(intervalId);
        if (abortToken?.supabaseInterval === intervalId) abortToken.supabaseInterval = null;
      };
      const cancel = () => {
        stop();
        resolve(null);
      };

      const check = async () => {
        if (abortToken?.cancelled) {
          cancel();
          return;
        }
        if (inFlight) return;
        inFlight = true;

        try {
          const job = await checkJobStatus(jobId);
          if (!job) {
            console.warn('[EduInclusiva] Job no disponible todavía:', jobId);
            return;
          }

          const progressStatus = String(job.progress_status || 'queued').toLowerCase();
          setProgress(RAG_STATUS_PROGRESS[progressStatus] ?? 40, jobStageLabel({ stage: progressStatus }, 'processing'));

          if (progressStatus === 'completed') {
            stop();
            resolve(job.result_data);
          } else if (progressStatus === 'failed' || progressStatus === 'error') {
            stop();
            reject(new Error('El job de procesamiento finalizó con error.'));
          }
        } catch (err) {
          // No se rechaza: el siguiente intervalo reintenta la consulta.
          console.warn('[EduInclusiva] Error transitorio consultando el job:', err);
        } finally {
          inFlight = false;
        }
      };

      const intervalId = setInterval(check, 3000);
      if (abortToken) {
        abortToken.supabaseInterval = intervalId;
        abortToken.cancelSupabasePoll = cancel;
      }
      check();
    });
  }

  /**
   * Consulta STATUS_WEBHOOK_URL hasta que el job termine (éxito o error) o se
   * supere POLL_TIMEOUT_MS. Usa un intervalo con backoff exponencial (hasta
   * POLL_INTERVAL_MAX_MS) ante errores transitorios de red/HTTP, y un límite
   * de tiempo total en vez de un número fijo de intentos, para no cortar la
   * espera antes de tiempo con archivos grandes que tardan más en procesarse.
   * abortToken permite cancelar el loop si el usuario limpia el formulario.
   */
  async function pollJobStatus(jobId, abortToken) {
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    let delay = POLL_INTERVAL_MS;
    let notFoundStreak = 0;

    while (Date.now() < deadline) {
      if (abortToken.cancelled) return null;

      await sleep(delay);
      if (abortToken.cancelled) return null;

      let data;
      try {
        const url = STATUS_WEBHOOK_URL + '?job_id=' + encodeURIComponent(jobId);
        const res = await fetch(url, { method: 'GET' });
        const rawText = await res.text();

        if (!res.ok) {
          // Error transitorio del servidor de estado: reintentar con backoff
          console.warn('[EduInclusiva] status check HTTP ' + res.status);
          delay = Math.min(Math.round(delay * 1.6), POLL_INTERVAL_MAX_MS);
          continue;
        }
        try { data = JSON.parse(rawText); } catch { data = { status: rawText.trim() }; }
      } catch (err) {
        // Error de red puntual: reintentar con backoff
        console.warn('[EduInclusiva] status check network error:', err);
        delay = Math.min(Math.round(delay * 1.6), POLL_INTERVAL_MAX_MS);
        continue;
      }

      delay = POLL_INTERVAL_MS; // la consulta respondió correctamente: resetear el backoff

      const status = (data?.status || '').toLowerCase();

      if (status === 'not_found') {
        // El job puede tardar un instante en quedar visible tras el insert; tolerar
        // unos pocos "not_found" antes de tratarlo como error definitivo.
        if (++notFoundStreak >= NOT_FOUND_MAX_STREAK) {
          throw new Error(`No se encontró el job en el servidor (job_id: ${jobId}).`);
        }
        continue;
      }
      notFoundStreak = 0;

      if (JOB_DONE_STATUSES.includes(status)) {
        return data;
      }
      if (JOB_ERROR_STATUSES.includes(status)) {
        throw new Error(data?.error || data?.message || 'El job de n8n finalizó con error.');
      }

      // status en 'processing' / etc. → seguir esperando, mostrando el progreso real
      setProgress(jobProgressPct(data, status), jobStageLabel(data, status));
    }

    throw new Error(`Tiempo de espera agotado esperando el job (${jobId}) tras ${Math.round(POLL_TIMEOUT_MS / 1000)}s.`);
  }

  /* Muestra un mensaje de estado amigable en el área de resultado (sin romper la UI) */
  function renderFallback(msg) {
    const section  = document.getElementById(S.ui.resultSectionId);
    const container = document.getElementById(S.ui.resultHtmlId);
    const isPositive = msg.startsWith('✅');

    container.innerHTML =
      `<div style="
          display:flex;gap:.8rem;align-items:flex-start;
          padding:1.1rem 1.2rem;
          border-radius:var(--radius-sm);
          border:1.5px solid ${isPositive ? '#A7F3D0' : 'var(--color-border)'};
          background:${isPositive ? '#F0FDF4' : 'var(--color-primary-xl)'};
        ">
        <span style="font-size:1.4rem;flex-shrink:0">${isPositive ? '✅' : '⚠️'}</span>
        <div>
          <p style="font-weight:700;font-family:var(--font-ui);margin-bottom:.4rem;color:${isPositive ? '#065F46' : 'var(--color-text)'}">
            ${isPositive ? 'Solicitud procesada' : 'Aviso del sistema'}
          </p>
          <p style="font-size:.9rem;color:var(--color-muted);white-space:pre-wrap;line-height:1.6">${escHtml(msg.replace(/^[✅⚠️]\s*/,''))}</p>
        </div>
      </div>`;

    S.resultText = msg;
    document.getElementById(S.ui.resultRawId).textContent = '(sin JSON — respuesta vacía o texto plano)';
    section.classList.add('visible');
    if (window._lucide) window._lucide.createIcons({ icons: window._lucide.icons });
    requestAnimationFrame(() => section.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  }

  /* Escape HTML básico para texto insertado en innerHTML */
  function escHtml(s) {
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  /* ══════════════════════════════════════════════
     RENDER RESULTADO — HTML sanitizado
  ══════════════════════════════════════════════ */
  function renderResult(data, uploadPromise) {
    const raw =
      data?.adapted_text ?? data?.result ?? data?.output ?? data?.html ??
      data?.text ?? data?.content ??
      (Array.isArray(data) && data[0]
        ? (data[0].adapted_text ?? data[0].output ?? data[0].text ?? JSON.stringify(data[0]))
        : null) ??
      JSON.stringify(data, null, 2);

    const content = typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2);

    const looksLikeHtml = /<(p|h[1-6]|ul|ol|li|strong|em|br|div|table|blockquote|hr)[\s>]/i.test(content);

    const container = document.getElementById(S.ui.resultHtmlId);

    if (looksLikeHtml) {
      container.innerHTML = sanitizeHtml(content);
    } else {
      container.innerHTML = plainToHtml(content);
    }
    enhanceNeurodivergentResult(container);

    S.resultText = container.innerText || container.textContent || content;
    saveToHistory(container.innerHTML, uploadPromise);
    db.savePreferences(S.currentUser?.id, S.profile, Array.from(S.adaptations));

    document.getElementById(S.ui.resultRawId).textContent = JSON.stringify(data, null, 2);

    const section = document.getElementById(S.ui.resultSectionId);
    section.classList.add('visible');
    if (window._lucide) window._lucide.createIcons({ icons: window._lucide.icons });
    requestAnimationFrame(() => section.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    showToast('Contenido adaptado ✅');
    trackEvent('adapt_content', { profile: S.profile, adaptations: Array.from(S.adaptations).join(',') });
    if (S.ui.autoSpeak) speak(S.resultText);

    document.getElementById('auditivo-step-processing')?.classList.remove('is-active');
    document.getElementById('auditivo-step-processing')?.classList.add('is-done');
    document.getElementById('auditivo-step-done')?.classList.add('is-active');
  }

  /* Añade una jerarquía visual mínima sin alterar el contenido enviado por la IA.
     El backend recibe profile=tdah; esta capa garantiza que la lectura en pantalla
     empiece con un bloque breve y reconocible para reducir la carga cognitiva. */
  function enhanceNeurodivergentResult(container) {
    if (!document.body.classList.contains('theme-neurodivergent')) return;
    container.classList.add('neuro-result');
    const firstParagraph = container.querySelector('p');
    const existingSummary = container.querySelector('.neuro-executive-summary');
    if (firstParagraph && !existingSummary) firstParagraph.classList.add('neuro-executive-summary');
    container.querySelectorAll('ol').forEach(list => {
      if (!list.previousElementSibling?.matches('h2,h3')) {
        const heading = document.createElement('h3');
        heading.textContent = 'Pasos clave';
        list.before(heading);
      }
    });
  }

  /* Sanitizador ligero — lista blanca de etiquetas seguras */
  const ALLOWED_TAGS = new Set([
    'p','br','strong','b','em','i','u','s','h1','h2','h3','h4','h5','h6',
    'ul','ol','li','blockquote','code','pre','hr','span','div','table',
    'thead','tbody','tr','th','td','caption','figure','figcaption','mark'
  ]);
  const STRIP_TAGS = /(<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<iframe[\s\S]*?<\/iframe>|on\w+="[^"]*"|on\w+='[^']*'|javascript:[^"']*)*/gi;

  function sanitizeHtml(html) {
    let clean = html.replace(STRIP_TAGS, '');
    const doc = new DOMParser().parseFromString(clean, 'text/html');
    function walk(node, out) {
      node.childNodes.forEach(child => {
        if (child.nodeType === 3) { // texto
          out.appendChild(document.createTextNode(child.textContent));
        } else if (child.nodeType === 1) {
          const tag = child.tagName.toLowerCase();
          if (ALLOWED_TAGS.has(tag)) {
            const el = document.createElement(tag);
            /* 'id' queda excluido a propósito: un id inyectado por el contenido
               del webhook podría colisionar/"clobbear" ids reales del DOM. */
            ['class','lang','dir','colspan','rowspan','scope'].forEach(attr => {
              if (child.hasAttribute(attr)) el.setAttribute(attr, child.getAttribute(attr));
            });
            walk(child, el);
            out.appendChild(el);
          } else {
            walk(child, out); // bajar al contenido aunque la tag no esté permitida
          }
        }
      });
    }
    const frag = document.createDocumentFragment();
    walk(doc.body, frag);
    const wrapper = document.createElement('div');
    wrapper.appendChild(frag);
    return wrapper.innerHTML;
  }

  /* Markdown básico → HTML (para cuando la IA devuelve Markdown en lugar de HTML) */
  function plainToHtml(text) {
    return text
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/^### (.+)$/gm,'<h3>$1</h3>')
      .replace(/^## (.+)$/gm,'<h2>$1</h2>')
      .replace(/^# (.+)$/gm,'<h1>$1</h1>')
      .replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>')
      .replace(/\*(.+?)\*/g,'<em>$1</em>')
      .replace(/^- (.+)$/gm,'<li>$1</li>')
      .replace(/(<li>[\s\S]+?<\/li>)/g,'<ul>$1</ul>')
      .replace(/\n{2,}/g,'</p><p>')
      .replace(/^(?!<[hHulp])(.+)$/gm,'<p>$1</p>')
      .replace(/<\/ul><ul>/g,'')  // fusionar listas consecutivas
      .trim();
  }

  /* ══════════════════════════════════════════════
     HISTORIAL DE ADAPTACIONES — delega en src/lib/db.js
     (Supabase real si hay sesión; localStorage si no)
  ══════════════════════════════════════════════ */

  /* Llamada desde renderResult() en cada adaptación exitosa. No bloquea el
     render: espera la subida a Storage (si corresponde) antes de guardar
     el registro, pero eso ocurre después de que la UI ya se actualizó. */
  async function saveToHistory(renderedHtml, uploadPromise) {
    const text = (S.resultText || '').trim();
    if (!text) return;

    const fileUrl = uploadPromise ? await uploadPromise.catch(() => null) : null;
    const entry = {
      title: text.slice(0, 40) + (text.length > 40 ? '…' : ''),
      profile: S.profile,
      content: text,
      adaptations: Array.from(S.adaptations),
      html: renderedHtml,
      fileUrl,
    };
    const saved = await db.saveToHistory(S.currentUser?.id, entry);
    S.historyCache = [saved, ...S.historyCache].slice(0, HISTORY_MAX);
  }

  function renderHistoryListUi(list) {
    const container = document.getElementById('history-list');
    const emptyMsg  = document.getElementById('history-empty');
    const countEl   = document.getElementById('history-count');

    countEl.textContent = list.length + (list.length === 1 ? ' guardada' : ' guardadas');
    container.innerHTML = '';

    if (list.length === 0) {
      emptyMsg.style.display = 'block';
      return;
    }
    emptyMsg.style.display = 'none';

    list.forEach(item => {
      const row = document.createElement('div');
      row.className = 'history-item';
      row.setAttribute('role', 'listitem');

      const main = document.createElement('button');
      main.type = 'button';
      main.className = 'history-item-main';
      main.setAttribute('aria-label', 'Cargar adaptación: ' + (item.title || ''));
      main.onclick = () => loadHistoryItem(item.id);

      const title = document.createElement('span');
      title.className = 'history-item-title';
      title.textContent = item.title || '(sin título)';   // textContent: nunca interpreta HTML

      const meta = document.createElement('span');
      meta.className = 'history-item-meta';
      const dateStr = new Date(item.timestamp).toLocaleString('es', { dateStyle: 'medium', timeStyle: 'short' });
      meta.textContent = (PROFILE_NAMES[item.profile] || item.profile || '') + ' · ' + dateStr;

      main.appendChild(title);
      main.appendChild(meta);

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'btn btn-ghost btn-sm history-item-delete';
      delBtn.setAttribute('aria-label', 'Eliminar esta adaptación');
      delBtn.innerHTML = '<i data-lucide="trash-2" style="width:13px;height:13px"></i>';
      delBtn.onclick = e => { e.stopPropagation(); deleteHistoryItem(item.id); };

      row.appendChild(main);
      row.appendChild(delBtn);
      container.appendChild(row);
    });

    if (window._lucide) window._lucide.createIcons({ icons: window._lucide.icons });
  }

  async function openHistoryModal() {
    S.historyCache = await db.getHistory(S.currentUser?.id);
    renderHistoryListUi(S.historyCache);
    document.getElementById('modal-history')?.classList.remove('hidden');
  }
  function closeHistoryModal() {
    document.getElementById('modal-history')?.classList.add('hidden');
  }

  /* Carga una adaptación previa en el Panel 2 (ver / escuchar / descargar de nuevo) */
  function loadHistoryItem(id) {
    const item = S.historyCache.find(h => h.id === id);
    if (!item) { showToast('No se encontró esa adaptación', 'error'); return; }

    const container = document.getElementById(S.ui.resultHtmlId);
    // re-sanitizar igual que en el primer render: aunque el HTML guardado ya
    // salió sanitizado, es una capa extra de defensa sin costo real.
    container.innerHTML = item.html ? sanitizeHtml(item.html) : plainToHtml(item.content || '');
    S.resultText = container.innerText || container.textContent || item.content || '';

    document.getElementById(S.ui.resultRawId).textContent = JSON.stringify(item, null, 2);
    const section = document.getElementById(S.ui.resultSectionId);
    section.classList.add('visible');
    document.getElementById('rtab-html') && switchResultTab('html'); // solo existe en Docente
    closeHistoryModal();

    if (window._lucide) window._lucide.createIcons({ icons: window._lucide.icons });
    requestAnimationFrame(() => section.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    showToast('Adaptación cargada desde el historial');
    if (S.ui.autoSpeak) speak(S.resultText);
  }

  async function deleteHistoryItem(id) {
    await db.deleteHistoryItem(S.currentUser?.id, id);
    S.historyCache = S.historyCache.filter(h => h.id !== id);
    renderHistoryListUi(S.historyCache);
    showToast('Adaptación eliminada del historial');
  }

  async function clearHistory() {
    if (S.historyCache.length === 0) return;
    if (!window.confirm('¿Borrar todo el historial de adaptaciones? Esta acción no se puede deshacer.')) return;
    await db.clearHistory(S.currentUser?.id);
    S.historyCache = [];
    renderHistoryListUi(S.historyCache);
    showToast('Historial borrado');
  }

  /* ══════════════════════════════════════════════
     TTS
  ══════════════════════════════════════════════ */
  /* Narración genérica (usada para autonarrar resultados y para las
     instrucciones habladas del perfil Ceguera al entrar a la vista) */
  function speak(text, onEnd) {
    if (!('speechSynthesis' in window) || !text) return;
    window.speechSynthesis.cancel();
    const utt = new SpeechSynthesisUtterance(text);
    utt.lang = 'es-MX';
    const rateEl = S.ui.ttsRateId && document.getElementById(S.ui.ttsRateId);
    utt.rate = rateEl ? parseFloat(rateEl.value) : 0.95;
    if (onEnd) utt.onend = onEnd;
    window.speechSynthesis.speak(utt);
  }

  function speakResult() {
    if (!S.ui.ttsPlayBtnId) return;
    if (!('speechSynthesis' in window)) { showToast('Tu navegador no soporta síntesis de voz', 'warn'); return; }
    const btn = document.getElementById(S.ui.ttsPlayBtnId);
    speak(S.resultText, () => {
      btn.innerHTML = '<i data-lucide="play" style="width:14px;height:14px"></i> Escuchar';
      if (window._lucide) window._lucide.createIcons({ icons: window._lucide.icons });
    });
    btn.innerHTML = '<i data-lucide="volume-2" style="width:14px;height:14px;animation:spin 1s linear infinite"></i> Escuchando…';
    if (window._lucide) window._lucide.createIcons({ icons: window._lucide.icons });
  }
  function stopSpeech() {
    window.speechSynthesis?.cancel();
    const btn = S.ui.ttsPlayBtnId && document.getElementById(S.ui.ttsPlayBtnId);
    if (btn) {
      btn.innerHTML = '<i data-lucide="play" style="width:14px;height:14px"></i> Escuchar';
      if (window._lucide) window._lucide.createIcons({ icons: window._lucide.icons });
    }
  }

  /* ══════════════════════════════════════════════
     PROGRESO
  ══════════════════════════════════════════════ */
  function setProgress(pct, label) {
    document.getElementById(S.ui.progressFillId).style.width = pct + '%';
    document.getElementById(S.ui.progressLabelId).innerHTML =
      `<i data-lucide="loader-2" style="width:13px;height:13px;animation:spin 1s linear infinite"></i>${escHtml(String(label))}`;
    if (window._lucide) window._lucide.createIcons({ icons: window._lucide.icons });
  }
  function setProcessing(on) {
    const btn = document.getElementById(S.ui.processBtnId);
    const wrap = document.getElementById(S.ui.progressWrapId);
    btn.disabled = on;
    btn.innerHTML = on
      ? '<i data-lucide="loader-2" style="width:16px;height:16px;animation:spin 1s linear infinite"></i> Procesando…'
      : '<i data-lucide="refresh-cw" style="width:16px;height:16px"></i> Adaptar contenido';
    wrap.classList.toggle('visible', on);
    if (window._lucide) window._lucide.createIcons({ icons: window._lucide.icons });
    if (!on) { setTimeout(() => wrap.classList.remove('visible'), 800); }

    /* Stepper visual del perfil Auditivo (solo existe en esa vista; no-op en el resto) */
    document.getElementById('auditivo-step-received')?.classList.toggle('is-done', on);
    document.getElementById('auditivo-step-processing')?.classList.toggle('is-active', on);
  }

  /* ══════════════════════════════════════════════
     TABS RESULTADO
  ══════════════════════════════════════════════ */
  function switchResultTab(tab) {
    document.querySelectorAll('.result-tab').forEach(t => { t.classList.remove('active'); t.setAttribute('aria-selected','false'); });
    document.querySelectorAll('.result-content').forEach(c => c.classList.remove('active'));
    document.getElementById('rtab-' + tab)?.classList.add('active');
    document.getElementById('rtab-' + tab)?.setAttribute('aria-selected','true');
    document.getElementById('rcontent-' + tab)?.classList.add('active');
  }

  /* ══════════════════════════════════════════════
     UTILIDADES
  ══════════════════════════════════════════════ */
  function copyResult() {
    navigator.clipboard.writeText(S.resultText)
      .then(() => showToast('Texto copiado ✅'))
      .catch(() => showToast('No se pudo copiar', 'error'));
  }
  function downloadTxt() {
    if (!S.resultText) return;
    const a = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(new Blob([S.resultText], { type: 'text/plain;charset=utf-8' })),
      download: 'eduinclusiva_adaptado.txt',
    });
    a.click(); URL.revokeObjectURL(a.href);
  }
  /* Imprime solo el resultado adaptado (ver @media print); desde el diálogo
     del navegador el usuario puede elegir "Guardar como PDF" como destino. */
  function printResult() {
    if (!S.resultText) { showToast('No hay contenido para imprimir', 'warn'); return; }
    window.print();
  }
  /* Alterna tipografía accesible + espaciado ampliado sobre el resultado adaptado */
  function toggleReadingMode() {
    if (!S.ui.readingModeBtnId) return;
    const area = document.getElementById(S.ui.resultHtmlId);
    const btn  = document.getElementById(S.ui.readingModeBtnId);
    const on = area.classList.toggle('reading-mode');
    btn.setAttribute('aria-pressed', String(on));
    showToast(on ? 'Modo lectura activado' : 'Modo lectura desactivado');
  }
  function toggleNeuroFocus() {
    const on = document.body.classList.toggle('neuro-focus-mode');
    const btn = document.getElementById('neuro-focus-btn');
    btn?.setAttribute('aria-pressed', String(on));
    if (btn) btn.innerHTML = on
      ? '<i data-lucide="x" style="width:13px;height:13px"></i> Salir de lectura limpia'
      : '<i data-lucide="book-open" style="width:13px;height:13px"></i> Enfoque / Lectura limpia';
    if (window._lucide) window._lucide.createIcons({ icons: window._lucide.icons });
    showToast(on ? 'Lectura limpia activada' : 'Lectura limpia desactivada');
  }
  function clearAll() {
    document.body.classList.remove('neuro-focus-mode');
    document.getElementById('neuro-focus-btn')?.setAttribute('aria-pressed', 'false');
    if (S.pollAbort) {
      S.pollAbort.cancelled = true;
      if (S.pollAbort.xhr) { try { S.pollAbort.xhr.abort(); } catch { /* ya finalizado */ } }
      if (S.pollAbort.cancelSupabasePoll) S.pollAbort.cancelSupabasePoll();
      else if (S.pollAbort.supabaseInterval) clearInterval(S.pollAbort.supabaseInterval);
      S.pollAbort = null;
      setProcessing(false);
    }
    document.getElementById(S.ui.textInputId).value = '';
    clearFile();
    document.querySelectorAll('.adapt-option').forEach(el => {
      el.classList.remove('checked', 'section-priority');
      el.querySelector('input[type="checkbox"]').checked = false;
      el.querySelectorAll('.priority-badge').forEach(b => b.remove());
    });
    S.adaptations.clear(); S.resultText = '';
    document.getElementById(S.ui.resultSectionId).classList.remove('visible');
    document.getElementById(S.ui.resultHtmlId).innerHTML = '';
    document.getElementById(S.ui.resultRawId).textContent = '';
    stopSpeech();
  }

  let _toastTimer = null;
  function showToast(msg, type = 'ok') {
    const t = document.getElementById('toast');
    const icon = type === 'error' ? '✕' : type === 'warn' ? '⚠' : '✓';
    t.innerHTML = `<span>${icon}</span><span>${escHtml(String(msg))}</span>`;
    t.style.background = type === 'error' ? '#DC2626' : type === 'warn' ? '#D97706' : 'var(--color-text)';
    t.classList.add('show');
    const visualAlert = document.getElementById('visual-alert-region');
    if (visualAlert) {
      visualAlert.textContent = msg;
      visualAlert.dataset.type = type;
    }
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => t.classList.remove('show'), 3400);
  }

  /* ══════════════════════════════════════════════
     EXPOSICIÓN GLOBAL
     (index.html invoca estas funciones vía onclick/onchange
     inline; al ser este archivo un módulo ES, no quedan
     accesibles en window por defecto)
  ══════════════════════════════════════════════ */
  Object.assign(window, {
    switchTab, doLogin, doRegister, doLogout, doGoogleAuth, selectProfile,
    triggerFileInput, handleFileSelect, handleDragOver, handleDrop, clearFile,
    toggleAdapt, processContent, clearAll, copyResult, downloadTxt,
    printResult, toggleReadingMode,
    toggleNeuroFocus,
    switchResultTab, speakResult, stopSpeech,
    openLegalModal, closeLegalModal, switchLegalTab, acceptConsent,
    openHistoryModal, closeHistoryModal, loadHistoryItem, deleteHistoryItem, clearHistory,
    navigateTo, nextTdahStep, prevTdahStep, submitTdahStep,
    onGlobalSearchInput, onGlobalSearchKeydown, triggerAvatarUpload, handleAvatarSelect,
    chooseAccessibilityProfile,
    doVerifyTwoFactor, doResendTwoFactor, doCancelTwoFactor,
    toggleUserMenu, doUpdatePassword, doUpdateDefaultProfile,
  });
