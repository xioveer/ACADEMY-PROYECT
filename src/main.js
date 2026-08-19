  /* ── CONFIGURACIÓN ── */
  const WEBHOOK_URL        = import.meta.env.VITE_WEBHOOK_URL;        // submit del job (n8n)
  const STATUS_WEBHOOK_URL = import.meta.env.VITE_STATUS_WEBHOOK_URL; // consulta de estado (n8n)

  if (!WEBHOOK_URL || !STATUS_WEBHOOK_URL) {
    console.error(
      '[EduInclusiva] Faltan VITE_WEBHOOK_URL / VITE_STATUS_WEBHOOK_URL. ' +
      'Copiá .env.example a .env, completá los valores y reiniciá el servidor de desarrollo.'
    );
  }

  const LS_USER_KEY  = 'edu_user_v2';
  const IMAGE_TYPES  = ['image/jpeg', 'image/png', 'image/webp'];
  const POLL_INTERVAL_MS  = 2500;   // frecuencia de consulta del estado del job
  const POLL_MAX_ATTEMPTS = 48;     // 48 × 2.5s ≈ 2 min de timeout total
  const JOB_DONE_STATUSES  = ['done', 'completed', 'success', 'finished'];
  const JOB_ERROR_STATUSES = ['error', 'failed', 'failure'];

  /* ── ESTADO GLOBAL ── */
  const S = {
    file: null, fileType: null, fileBase64: null, fileMime: null,
    adaptations: new Set(),
    profile: 'tdah',
    resultText: '',   // texto plano para TTS y descarga
    pollAbort: null,  // { cancelled: bool } — permite cancelar el polling en curso
  };

  /* ══════════════════════════════════════════════
     AUTH
  ══════════════════════════════════════════════ */
  const getUsers = () => { try { return JSON.parse(localStorage.getItem('edu_users') || '{}'); } catch { return {}; } };
  const saveUsers = u => localStorage.setItem('edu_users', JSON.stringify(u));
  const getCurrentUser = () => { try { return JSON.parse(localStorage.getItem(LS_USER_KEY)); } catch { return null; } };

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

  function doLogin() {
    const email = document.getElementById('login-email').value.trim().toLowerCase();
    const pass  = document.getElementById('login-pass').value;
    const err   = document.getElementById('login-error');
    err.textContent = '';
    if (!email || !pass) { err.textContent = 'Completá todos los campos.'; return; }
    if (pass.length < 6) { err.textContent = 'Contraseña mínimo 6 caracteres.'; return; }
    const users = getUsers();
    if (users[email] && users[email].pass !== btoa(pass)) { err.textContent = 'Contraseña incorrecta.'; return; }
    if (!users[email]) {
      users[email] = { email, pass: btoa(pass), name: email.split('@')[0] };
      saveUsers(users);
    }
    localStorage.setItem(LS_USER_KEY, JSON.stringify({ email, name: users[email].name }));
    showApp(users[email]);
    showToast('¡Bienvenid@, ' + users[email].name + '! 🎉');
  }

  function doRegister() {
    const name  = document.getElementById('reg-name').value.trim();
    const email = document.getElementById('reg-email').value.trim().toLowerCase();
    const pass  = document.getElementById('reg-pass').value;
    const err   = document.getElementById('reg-error');
    err.textContent = '';
    if (!name || !email || !pass) { err.textContent = 'Completá todos los campos.'; return; }
    if (pass.length < 6)  { err.textContent = 'Contraseña mínimo 6 caracteres.'; return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { err.textContent = 'Email inválido.'; return; }
    const users = getUsers();
    if (users[email]) { err.textContent = 'Ese email ya está registrado.'; return; }
    users[email] = { email, pass: btoa(pass), name };
    saveUsers(users);
    localStorage.setItem(LS_USER_KEY, JSON.stringify({ email, name }));
    showApp({ name, email });
    showToast('Cuenta creada. ¡Bienvenid@, ' + name + '! 🎉');
  }

  function doGoogleAuth() {
    showToast('Conectando con Google…');
    setTimeout(() => {
      const email = 'demo.google@eduinclusiva.ai';
      const name  = 'Cuenta de Google (demo)';
      const users = getUsers();
      if (!users[email]) {
        users[email] = { email, name, pass: btoa('google-oauth-demo') };
        saveUsers(users);
      }
      localStorage.setItem(LS_USER_KEY, JSON.stringify({ email, name: users[email].name }));
      showApp(users[email]);
      showToast('¡Bienvenid@! Sesión iniciada con Google (demo) 🎉');
    }, 700);
  }

  function doLogout() {
    localStorage.removeItem(LS_USER_KEY);
    document.getElementById('app-main').classList.remove('visible');
    document.getElementById('auth-modal').classList.remove('hidden');
    document.getElementById('logout-btn').style.display = 'none';
    document.getElementById('user-badge').innerHTML = '';
    document.getElementById('login-email').value = '';
    document.getElementById('login-pass').value = '';
    clearAll();
  }

  function showApp(user) {
    document.getElementById('auth-modal').classList.add('hidden');
    document.getElementById('app-main').classList.add('visible');
    document.getElementById('logout-btn').style.display = 'inline-flex';
    const initials = user.name.split(' ').map(w => w[0]).join('').slice(0,2).toUpperCase();
    document.getElementById('user-badge').innerHTML =
      `<div class="user-avatar" aria-hidden="true">${initials}</div>
       <span>${user.name}</span>`;
    if (window._lucide) window._lucide.createIcons({ icons: window._lucide.icons });
  }

  window.addEventListener('DOMContentLoaded', () => {
    const user = getCurrentUser();
    if (user) showApp(user);
    applyProfile(S.profile);
  });

  document.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    const modal = document.getElementById('auth-modal');
    if (modal && !modal.classList.contains('hidden')) {
      const panel = document.querySelector('.tab-panel.active');
      if (panel?.id === 'panel-login') doLogin();
      if (panel?.id === 'panel-register') doRegister();
    }
  });

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

  /* Handler del onchange en las tarjetas de perfil: aplica + notifica */
  function selectProfile(input) {
    applyProfile(input.value);
    showToast('Perfil ' + (PROFILE_NAMES[input.value] || input.value) + ' activado');
  }

  /* ══════════════════════════════════════════════
     MANEJO DE ARCHIVOS — Universal + Base64 limpio
  ══════════════════════════════════════════════ */
  function triggerFileInput() {
    document.getElementById('file-input').click();
  }
  function handleFileSelect(e) { processFile(e.target.files[0]); }
  function handleDragOver(e) {
    e.preventDefault();
    document.getElementById('upload-zone').classList.add('dragover');
  }
  function handleDrop(e) {
    e.preventDefault();
    document.getElementById('upload-zone').classList.remove('dragover');
    processFile(e.dataTransfer.files[0]);
  }

  function processFile(file) {
    if (!file) return;
    S.file = file; S.fileBase64 = null; S.fileMime = file.type;
    const isImg = IMAGE_TYPES.includes(file.type);
    S.fileType = isImg ? 'image' : 'text-file';

    const preview = document.getElementById('file-preview');
    document.getElementById('file-name').textContent = file.name + ' (' + fmtBytes(file.size) + ')';
    preview.classList.add('visible');
    const thumb = document.getElementById('preview-thumb');

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
      if (file.type === 'text/plain') {
        const r = new FileReader();
        r.onload = ev => { document.getElementById('text-input').value = ev.target.result; };
        r.readAsText(file);
      }
    }
  }

  function clearFile() {
    S.file = null; S.fileBase64 = null; S.fileMime = null; S.fileType = null;
    document.getElementById('file-input').value = '';
    document.getElementById('file-preview').classList.remove('visible');
    const thumb = document.getElementById('preview-thumb');
    thumb.style.display = 'none'; thumb.src = '';
  }

  function fmtBytes(b) {
    if (b < 1024) return b + ' B';
    if (b < 1048576) return (b/1024).toFixed(1) + ' KB';
    return (b/1048576).toFixed(1) + ' MB';
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
    const txt = document.getElementById('text-input').value.trim();
    if (!S.file && !txt) { showToast('Subí un archivo o pegá texto primero', 'warn'); return; }
    if (S.adaptations.size === 0) { showToast('Elegí al menos una adaptación', 'warn'); return; }
    if (S.fileType === 'image' && !S.fileBase64) { showToast('Esperá, la imagen aún se está leyendo…', 'warn'); return; }

    setProcessing(true);

    const user = getCurrentUser() || {};
    const payload = {
      timestamp:   new Date().toISOString(),
      user_email:  user.email || 'anonimo',
      adaptations: Array.from(S.adaptations),
      profile:     S.profile,
    };

    if (S.fileType === 'image') {
      Object.assign(payload, {
        content_type:   'image',
        image_base64:   S.fileBase64,     // string base64 puro, sin prefijo data:
        image_mime:     S.fileMime,       // "image/jpeg" | "image/png" | "image/webp"
        image_filename: S.file.name,
        text_content:   txt || '',
      });
    } else if (S.fileType === 'text-file') {
      Object.assign(payload, { content_type: 'file', text_content: txt, filename: S.file?.name || '' });
    } else {
      Object.assign(payload, { content_type: 'text', text_content: txt });
    }

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
        renderResult(finalData);
        return;
      }

      // Modo síncrono: el webhook ya devolvió el resultado final directamente
      setProgress(98, '¡Listo!');
      renderResult(data);

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
    const section  = document.getElementById('result-section');
    const container = document.getElementById('result-html-main');
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
    document.getElementById('result-raw').textContent = '(sin JSON — respuesta vacía o texto plano)';
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
  function renderResult(data) {
    const raw =
      data?.adapted_text ?? data?.result ?? data?.output ?? data?.html ??
      data?.text ?? data?.content ??
      (Array.isArray(data) && data[0]
        ? (data[0].adapted_text ?? data[0].output ?? data[0].text ?? JSON.stringify(data[0]))
        : null) ??
      JSON.stringify(data, null, 2);

    const content = typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2);

    const looksLikeHtml = /<(p|h[1-6]|ul|ol|li|strong|em|br|div|table|blockquote|hr)[\s>]/i.test(content);

    const container = document.getElementById('result-html-main');

    if (looksLikeHtml) {
      container.innerHTML = sanitizeHtml(content);
    } else {
      container.innerHTML = plainToHtml(content);
    }

    S.resultText = container.innerText || container.textContent || content;

    document.getElementById('result-raw').textContent = JSON.stringify(data, null, 2);

    const section = document.getElementById('result-section');
    section.classList.add('visible');
    if (window._lucide) window._lucide.createIcons({ icons: window._lucide.icons });
    requestAnimationFrame(() => section.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    showToast('Contenido adaptado ✅');
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
            ['class','id','lang','dir','colspan','rowspan','scope'].forEach(attr => {
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
     TTS
  ══════════════════════════════════════════════ */
  function speakResult() {
    if (!('speechSynthesis' in window)) { showToast('Tu navegador no soporta síntesis de voz', 'warn'); return; }
    stopSpeech();
    const utt = new SpeechSynthesisUtterance(S.resultText);
    utt.lang = 'es-MX';
    utt.rate = parseFloat(document.getElementById('tts-rate').value);
    utt.onend = () => {
      document.getElementById('tts-play-btn').innerHTML =
        '<i data-lucide="play" style="width:14px;height:14px"></i> Reproducir';
      if (window._lucide) window._lucide.createIcons({ icons: window._lucide.icons });
    };
    document.getElementById('tts-play-btn').innerHTML =
      '<i data-lucide="volume-2" style="width:14px;height:14px;animation:spin 1s linear infinite"></i> Reproduciendo…';
    if (window._lucide) window._lucide.createIcons({ icons: window._lucide.icons });
    window.speechSynthesis.speak(utt);
  }
  function stopSpeech() {
    window.speechSynthesis?.cancel();
    document.getElementById('tts-play-btn').innerHTML =
      '<i data-lucide="play" style="width:14px;height:14px"></i> Reproducir';
    if (window._lucide) window._lucide.createIcons({ icons: window._lucide.icons });
  }

  /* ══════════════════════════════════════════════
     PROGRESO
  ══════════════════════════════════════════════ */
  function setProgress(pct, label) {
    document.getElementById('progress-fill').style.width = pct + '%';
    document.getElementById('progress-label').innerHTML =
      `<i data-lucide="loader-2" style="width:13px;height:13px;animation:spin 1s linear infinite"></i>${label}`;
    if (window._lucide) window._lucide.createIcons({ icons: window._lucide.icons });
  }
  function setProcessing(on) {
    const btn = document.getElementById('process-btn');
    const wrap = document.getElementById('progress-wrap');
    btn.disabled = on;
    btn.innerHTML = on
      ? '<i data-lucide="loader-2" style="width:16px;height:16px;animation:spin 1s linear infinite"></i> Procesando…'
      : '<i data-lucide="refresh-cw" style="width:16px;height:16px"></i> Adaptar contenido';
    wrap.classList.toggle('visible', on);
    if (window._lucide) window._lucide.createIcons({ icons: window._lucide.icons });
    if (!on) { setTimeout(() => wrap.classList.remove('visible'), 800); }
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
  function clearAll() {
    if (S.pollAbort) { S.pollAbort.cancelled = true; S.pollAbort = null; setProcessing(false); }
    document.getElementById('text-input').value = '';
    clearFile();
    document.querySelectorAll('.adapt-option').forEach(el => {
      el.classList.remove('checked', 'section-priority');
      el.querySelector('input[type="checkbox"]').checked = false;
      el.querySelectorAll('.priority-badge').forEach(b => b.remove());
    });
    S.adaptations.clear(); S.resultText = '';
    document.getElementById('result-section').classList.remove('visible');
    document.getElementById('result-html-main').innerHTML = '';
    document.getElementById('result-raw').textContent = '';
    stopSpeech();
  }

  let _toastTimer = null;
  function showToast(msg, type = 'ok') {
    const t = document.getElementById('toast');
    const icon = type === 'error' ? '✕' : type === 'warn' ? '⚠' : '✓';
    t.innerHTML = `<span>${icon}</span><span>${msg}</span>`;
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
    switchResultTab, speakResult, stopSpeech,
  });
