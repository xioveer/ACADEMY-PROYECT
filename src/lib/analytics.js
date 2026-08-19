/* ══════════════════════════════════════════════
   ANALYTICS — Google Analytics 4 (gtag.js)

   Respeta el banner de consentimiento ya existente: initAnalytics() solo
   inyecta el script de Google y arranca gtag si el usuario ya aceptó el
   aviso de almacenamiento local (CONSENT_KEY). No hay tracking antes de
   ese consentimiento. Si no hay VITE_GA_MEASUREMENT_ID configurado, todas
   las funciones son no-op.
══════════════════════════════════════════════ */

/* Ojo: NO se usa window.__GA_MEASUREMENT_ID__ (stash del <head>) como fuente de
   verdad acá — cuando VITE_GA_MEASUREMENT_ID no está definida, Vite deja el
   placeholder "%VITE_GA_MEASUREMENT_ID%" literal en el HTML (string truthy),
   lo que activaría GA4 con un ID inválido. import.meta.env es la única fuente
   confiable: Vite la reemplaza estáticamente por undefined/string real. */
const MEASUREMENT_ID = import.meta.env.VITE_GA_MEASUREMENT_ID || '';

let initialized = false;

export function isAnalyticsConfigured() {
  return Boolean(MEASUREMENT_ID);
}

/** Inyecta gtag.js y lo inicializa. Idempotente — seguro llamarla más de una vez. */
export function initAnalytics() {
  if (initialized || !MEASUREMENT_ID) return;
  initialized = true;

  const script = document.createElement('script');
  script.async = true;
  script.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(MEASUREMENT_ID);
  document.head.appendChild(script);

  window.dataLayer = window.dataLayer || [];
  window.gtag = function gtag() { window.dataLayer.push(arguments); };
  window.gtag('js', new Date());
  // send_page_view desactivado: las vistas se reportan a mano vía trackPageView()
  // en cada navegación del router hash-based (no hay recargas de página reales).
  window.gtag('config', MEASUREMENT_ID, { send_page_view: false, anonymize_ip: true });
}

export function trackPageView(route) {
  if (!initialized || !window.gtag) return;
  window.gtag('event', 'page_view', {
    page_path: '/' + route,
    page_title: route,
    page_location: location.href,
  });
}

export function trackEvent(name, params = {}) {
  if (!initialized || !window.gtag) return;
  window.gtag('event', name, params);
}
