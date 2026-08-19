  import { getCurrentUser, onAuthStateChange, signInWithPassword, signUp, signInWithGoogle, signOut } from './lib/auth.js';
  import { isSupabaseConfigured } from './lib/supabaseClient.js';
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
  const HISTORY_MAX  = 30;   // tope de entradas mostradas/guardadas (ver también src/lib/db.js)
  const IMAGE_TYPES  = ['image/jpeg', 'image/png', 'image/webp'];
  const POLL_INTERVAL_MS  = 2500;   // frecuencia de consulta del estado del job
  const POLL_MAX_ATTEMPTS = 48;     // 48 × 2.5s ≈ 2 min de timeout total
  const JOB_DONE_STATUSES  = ['done', 'completed', 'success', 'finished'];
  const JOB_ERROR_STATUSES = ['error', 'failed', 'failure'];

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
    extracting: false, // true mientras se extrae texto de un archivo en el navegador
    extractionId: 0,   // invalida extracciones que terminan después de cambiar de archivo
    adaptations: new Set(),
    profile: 'tdah',
    resultText: '',   // texto plano para TTS y descarga
    pollAbort: null,  // { cancelled: bool } — permite cancelar el polling en curso
    ui: { ...DEFAULT_UI },   // ids activos: los reasigna el router en cada navegación
    tdahStep: 1,
    currentUser: null,  // { id?, email, name, avatarUrl? } — id solo existe con sesión Supabase real
    historyCache: [],   // último historial cargado (Supabase o localStorage), usado por el buscador
  };

  /* ══════════════════════════════════════════════
     AUTH — delega en src/lib/auth.js (Supabase real
     si está configurado; localStorage demo si no)
  ══════════════════════════════════════════════ */
  function switchTab(t) {
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
    await onSignedIn(user, 'password');
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
    await signOut();
    resetToLoggedOutUi();
  }

  function resetToLoggedOutUi() {
    S.currentUser = null;
    S.historyCache = [];
    document.getElementById('app-main').classList.remove('visible');
    document.getElementById('auth-modal').classList.remove('hidden');
    document.getElementById('logout-btn').style.display = 'none';
    document.getElementById('user-badge').innerHTML = '';
    document.getElementById('avatar-upload-btn').style.display = 'none';
    document.getElementById('login-email').value = '';
    document.getElementById('login-pass').value = '';
    clearAll();
    stopSpeech();
    window.history.replaceState(null, '', location.pathname + location.search); // limpia el hash de ruta
  }

  async function showApp(user) {
    S.currentUser = user;
    document.getElementById('auth-modal').classList.add('hidden');
    document.getElementById('app-main').classList.add('visible');
    document.getElementById('logout-btn').style.display = 'inline-flex';
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

    navigateTo(currentRoute() || 'lobby');
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
  const ROUTES = ['lobby', 'ceguera', 'auditivo', 'baja-vision', 'tdah', 'docente'];

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
    const prevRoute = document.querySelector('.view.active')?.id.replace('view-', '');
    if (prevRoute === 'ceguera' && route !== 'ceguera') stopSpeech();

    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('view-' + route)?.classList.add('active');

    S.ui = { ...(VIEW_UI[route] || VIEW_UI.docente) };

    if (route === 'docente') {
      const checked = document.querySelector('input[name="adaptation-profile"]:checked');
      applyProfile(checked ? checked.value : S.profile);
    } else {
      forceProfile(route);
    }

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
    S.file = file; S.fileBase64 = null; S.fileMime = file.type;
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
    S.file = null; S.fileBase64 = null; S.fileMime = null; S.fileType = null;
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

    /* Payload hacia n8n. Claves principales: content, profile, adaptations,
       fileBase64, userEmail. Se agregan claves auxiliares (contentType,
       fileMime, fileName, timestamp) como metadata útil para el workflow. */
    const payload = {
      content:     txt || '',                                      // texto plano (input directo o extraído del archivo)
      profile:     S.profile,
      adaptations: Array.from(S.adaptations),
      fileBase64:  S.fileType === 'image' ? S.fileBase64 : null,    // string base64 puro, sin prefijo data:, solo si es imagen
      userEmail:   user.email || 'anonimo',
      contentType: S.fileType === 'image' ? 'image' : (S.fileType === 'text-file' ? 'file' : 'text'),
      fileMime:    S.fileType === 'image' ? S.fileMime : null,      // "image/jpeg" | "image/png" | "image/webp"
      fileName:    S.file?.name || null,
      timestamp:   new Date().toISOString(),
    };

    setProgress(12, 'Enviando contenido…');

    const abortToken = { cancelled: false };
    S.pollAbort = abortToken;

    try {
      const res = await fetch(WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const rawText = await res.text();               // nunca lanza, siempre devuelve string

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
          finalData = await pollJobStatus(jobId, abortToken);
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
      if (abortToken.cancelled) return;
      console.error('[EduInclusiva] fetch error:', err);
      renderFallback(
        '⚠️ No se pudo conectar con el servidor.\n\n' +
        'Causa probable: error de red, CORS bloqueado o el webhook de n8n no está activo.\n\n' +
        'Detalle técnico: ' + err.message
      );
      showToast('Sin conexión con el servidor', 'error');
    } finally {
      if (S.pollAbort === abortToken) S.pollAbort = null;
      setTimeout(() => setProcessing(false), 700);
    }
  }

  /* ══════════════════════════════════════════════
     POLLING ASÍNCRONO DE ESTADO DEL JOB (n8n)
  ══════════════════════════════════════════════ */
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  /**
   * Consulta STATUS_WEBHOOK_URL cada POLL_INTERVAL_MS hasta que el job
   * termine (éxito o error) o se supere POLL_MAX_ATTEMPTS.
   * abortToken permite cancelar el loop si el usuario limpia el formulario.
   */
  async function pollJobStatus(jobId, abortToken) {
    for (let attempt = 1; attempt <= POLL_MAX_ATTEMPTS; attempt++) {
      if (abortToken.cancelled) return null;

      await sleep(POLL_INTERVAL_MS);
      if (abortToken.cancelled) return null;

      const pct = Math.min(30 + Math.round((attempt / POLL_MAX_ATTEMPTS) * 65), 95);
      setProgress(pct, `Verificando estado del job… (${attempt}/${POLL_MAX_ATTEMPTS})`);

      let data;
      try {
        const url = STATUS_WEBHOOK_URL + '?job_id=' + encodeURIComponent(jobId);
        const res = await fetch(url, { method: 'GET' });
        const rawText = await res.text();

        if (!res.ok) {
          // Error transitorio del servidor de estado: reintentar hasta agotar los intentos
          console.warn('[EduInclusiva] status check HTTP ' + res.status);
          continue;
        }
        try { data = JSON.parse(rawText); } catch { data = { status: rawText.trim() }; }
      } catch (err) {
        // Error de red puntual: reintentar en el siguiente intento
        console.warn('[EduInclusiva] status check network error:', err);
        continue;
      }

      const status = (data?.status || '').toLowerCase();

      if (JOB_DONE_STATUSES.includes(status)) {
        return data;
      }
      if (JOB_ERROR_STATUSES.includes(status)) {
        throw new Error(data?.error || data?.message || 'El job de n8n finalizó con error.');
      }
      // status en 'queued' / 'processing' / etc. → seguir esperando
    }

    throw new Error(`Tiempo de espera agotado esperando el job (${jobId}) tras ${POLL_MAX_ATTEMPTS} intentos.`);
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
  function clearAll() {
    if (S.pollAbort) { S.pollAbort.cancelled = true; S.pollAbort = null; setProcessing(false); }
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
    switchResultTab, speakResult, stopSpeech,
    openLegalModal, closeLegalModal, switchLegalTab, acceptConsent,
    openHistoryModal, closeHistoryModal, loadHistoryItem, deleteHistoryItem, clearHistory,
    navigateTo, nextTdahStep, prevTdahStep, submitTdahStep,
    onGlobalSearchInput, onGlobalSearchKeydown, triggerAvatarUpload, handleAvatarSelect,
  });
