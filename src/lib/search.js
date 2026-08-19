/* ══════════════════════════════════════════════
   BUSCADOR GLOBAL — interfaces, accesos rápidos, historial

   Índice estático de "lugares" navegables de la app + el historial de
   adaptaciones (que se pasa por parámetro porque es asíncrono / depende
   de la sesión). Búsqueda simple por substring, sin dependencias.
══════════════════════════════════════════════ */

const STATIC_INDEX = [
  { type: 'view', label: 'Ceguera / Audio-Navegación', sublabel: 'Interfaz', route: 'ceguera',
    keywords: 'ceguera ciego audio navegacion voz' },
  { type: 'view', label: 'Auditivo (Sordera / Hipoacusia)', sublabel: 'Interfaz', route: 'auditivo',
    keywords: 'auditivo sordera hipoacusia sordo' },
  { type: 'view', label: 'Baja Visión', sublabel: 'Interfaz', route: 'baja-vision',
    keywords: 'baja vision contraste' },
  { type: 'view', label: 'TDAH / Neurodivergencia', sublabel: 'Interfaz', route: 'tdah',
    keywords: 'tdah neurodivergencia enfoque pasos' },
  { type: 'view', label: 'Docente / Estándar', sublabel: 'Interfaz', route: 'docente',
    keywords: 'docente estandar perfiles combinables' },
  { type: 'action', label: 'Cambiar de perfil', sublabel: 'Acceso rápido', action: 'lobby',
    keywords: 'cambiar perfil interfaz volver lobby' },
  { type: 'action', label: 'Historial de adaptaciones', sublabel: 'Acceso rápido', action: 'history',
    keywords: 'historial adaptaciones guardadas' },
  { type: 'legal', label: 'Términos de Servicio', sublabel: 'Legal', tab: 'terms',
    keywords: 'terminos servicio legal' },
  { type: 'legal', label: 'Política de Privacidad', sublabel: 'Legal', tab: 'privacy',
    keywords: 'privacidad datos' },
  { type: 'legal', label: 'Aviso de Deslinde de Responsabilidad de IA', sublabel: 'Legal', tab: 'disclaimer',
    keywords: 'deslinde responsabilidad ia disclaimer' },
];

const norm = s => (s || '').toString().normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/**
 * @param {string} query
 * @param {Array} history - lista de entradas del historial ({id, title, profile})
 * @returns {Array<{type, label, sublabel, route?, action?, tab?, historyId?}>}
 */
export function searchAll(query, history = []) {
  const q = norm(query).trim();
  if (!q) return [];

  const staticMatches = STATIC_INDEX
    .filter(item => norm(item.label + ' ' + item.keywords).includes(q))
    .map(({ keywords, ...item }) => item);

  const historyMatches = history
    .filter(h => norm((h.title || '') + ' ' + (h.profile || '')).includes(q))
    .slice(0, 8)
    .map(h => ({
      type: 'history',
      label: h.title || '(sin título)',
      sublabel: 'Historial · ' + (h.profile || ''),
      historyId: h.id,
    }));

  return [...staticMatches, ...historyMatches].slice(0, 20);
}
