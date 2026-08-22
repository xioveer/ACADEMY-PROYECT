#!/usr/bin/env node
/**
 * loop-validator.js — Evaluator/Guardián de producción.
 *
 * Principio: el generador (quien escribe el código) no se juzga a sí mismo.
 * Este script es un verificador *independiente* que corre después de que el
 * código ya fue escrito: compila dist/ desde cero, y audita el resultado
 * final en busca de clases CSS huérfanas y grillas del dashboard mal
 * formadas — sin asumir nada de lo que el generador "dice" que hizo.
 *
 * Uso:
 *   node scripts/loop-validator.js            (build + auditoría completa)
 *   node scripts/loop-validator.js --skip-build (audita el dist/ existente)
 *
 * Exit code 0  → apto para producción.
 * Exit code 1  → bloqueado (build roto o clase huérfana confirmada).
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const SKIP_BUILD = process.argv.includes('--skip-build');

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

/* Clases compuestas en tiempo de ejecución vía concatenación de strings en
   src/main.js (p. ej. `'profile-' + profile`, `'view-' + route`). Una
   búsqueda por substring literal nunca las va a "encontrar" en el bundle,
   así que quedan exentas de la auditoría de huérfanas en vez de generar
   falsos positivos. */
const DYNAMIC_CLASS_PREFIXES = [
  'profile-', 'theme-', 'view-', 'result-section-', 'result-html-',
  'lobby-card-', 'is-', 'opt-',
];

/* Grillas fijas del dashboard docente: N columnas explícitas → la cantidad
   de hijos directos debe ser múltiplo de N o queda una fila incompleta.
   Las grillas con auto-fit/auto-fill (profile-grid, adapt-grid, etc.) son
   responsivas por diseño y no entran en esta categoría: se reportan como
   métrica, no como posible desalineación. */
const FIXED_DASHBOARD_GRIDS = [
  { cls: 'docente-grid', tracks: 2 },
  { cls: 'docente-stats-grid', tracks: 2 },
  { cls: 'content-input-grid', tracks: 2 },
];
const RESPONSIVE_DASHBOARD_GRIDS = ['profile-grid', 'adapt-grid'];

let failures = 0;
let warnings = 0;

function section(title) {
  console.log('\n' + '─'.repeat(60));
  console.log(title);
  console.log('─'.repeat(60));
}

function ok(msg) { console.log('  ✔ ' + msg); }
function warn(msg) { console.log('  ⚠ ' + msg); warnings++; }
function fail(msg) { console.log('  ✘ ' + msg); failures++; }

/* ══════════════════════════════════════════════
   CHECK 1 — dist/ compila sin errores
══════════════════════════════════════════════ */
function checkBuild() {
  section('1/3 · BUILD — dist/ compila sin errores');

  if (SKIP_BUILD) {
    warn('--skip-build: no se recompiló, se audita el dist/ existente tal cual está.');
    if (!existsSync(path.join(DIST, 'index.html'))) {
      fail('No existe dist/index.html y se pidió --skip-build. Corré el build primero.');
    }
    return;
  }

  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(npmCmd, ['run', 'build'], {
    cwd: ROOT,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });

  if (result.error) {
    fail('No se pudo ejecutar "npm run build": ' + result.error.message);
    return;
  }
  if (result.status !== 0) {
    fail('vite build terminó con código ' + result.status);
    const tail = (result.stdout + result.stderr).trim().split('\n').slice(-25).join('\n');
    console.log('    ── salida (últimas líneas) ──\n    ' + tail.replace(/\n/g, '\n    '));
    return;
  }

  const distIndex = path.join(DIST, 'index.html');
  if (!existsSync(distIndex) || readFileSync(distIndex, 'utf8').trim().length < 500) {
    fail('El build terminó en 0 pero dist/index.html no existe o quedó vacío.');
    return;
  }
  ok('vite build salió con código 0.');
  ok('dist/index.html generado (' + readFileSync(distIndex, 'utf8').length + ' bytes).');
}

/* ══════════════════════════════════════════════
   Utilidades de parseo HTML/CSS liviano (sin dependencias)
══════════════════════════════════════════════ */
function stripStyleBlocks(html) {
  return html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
}

function extractCssClassNames(html) {
  const styleBlocks = html.match(/<style[^>]*>[\s\S]*?<\/style>/gi) || [];
  const css = styleBlocks.join('\n').replace(/\/\*[\s\S]*?\*\//g, '');
  const classes = new Set();
  const re = /\.([a-zA-Z_-][\w-]*)/g;
  let m;
  while ((m = re.exec(css))) classes.add(m[1]);
  return classes;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function corpusHasClass(corpus, name) {
  const re = new RegExp('(?<![\\w-])' + escapeRegExp(name) + '(?![\\w-])');
  return re.test(corpus);
}

/* Tokeniza HTML a partir de un offset y devuelve, para el elemento cuyo tag
   de apertura termina en `openTagEnd`, la posición donde cierra ese mismo
   elemento — trackeando profundidad de anidamiento con un tokenizer simple
   (no es un parser HTML completo, pero es suficiente para contenedores de
   layout sin contenido "raro" tipo <script>/<style> anidados). */
function findMatchingClose(html, openTagEnd) {
  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)([^>]*?)(\/?)>/g;
  tagRe.lastIndex = openTagEnd;
  let depth = 1;
  let m;
  while ((m = tagRe.exec(html))) {
    const [, closing, tagName, , selfClose] = m;
    const lower = tagName.toLowerCase();
    if (VOID_TAGS.has(lower) || selfClose) continue;
    if (closing) {
      depth--;
      if (depth === 0) return { closeStart: m.index, tagEnd: tagRe.lastIndex };
    } else {
      depth++;
    }
  }
  return null;
}

function countDirectChildren(html, openTagEnd, closeStart) {
  const inner = html.slice(openTagEnd, closeStart);
  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)([^>]*?)(\/?)>/g;
  let depth = 0;
  let count = 0;
  let m;
  while ((m = tagRe.exec(inner))) {
    const [, closing, tagName, , selfClose] = m;
    const lower = tagName.toLowerCase();
    const isVoid = VOID_TAGS.has(lower) || !!selfClose;
    if (closing) {
      depth--;
    } else {
      if (depth === 0) count++;
      if (!isVoid) depth++;
    }
  }
  return count;
}

function findGridContainer(html, cls) {
  // OJO: \b trata "-" como límite de palabra, así que \bprofile-grid\b
  // matchearía también dentro de "accessibility-profile-grid". Por eso acá
  // se captura el atributo class completo y se compara token por token
  // (separados por espacios), como hace el navegador con classList.
  const tagRe = /<([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*\bclass="([^"]*)"[^>]*>/g;
  let m;
  while ((m = tagRe.exec(html))) {
    const tokens = m[2].split(/\s+/).filter(Boolean);
    if (tokens.includes(cls)) {
      const openTagEnd = m.index + m[0].length;
      const closeInfo = findMatchingClose(html, openTagEnd);
      if (!closeInfo) return null;
      return { openTagEnd, closeStart: closeInfo.closeStart };
    }
  }
  return null;
}

/* ══════════════════════════════════════════════
   CHECK 2 — clases CSS huérfanas
══════════════════════════════════════════════ */
function checkOrphanClasses() {
  section('2/3 · CLASES CSS HUÉRFANAS');

  const distIndex = path.join(DIST, 'index.html');
  if (!existsSync(distIndex)) {
    fail('No existe dist/index.html — no se puede auditar (¿falló el build?).');
    return;
  }
  const html = readFileSync(distIndex, 'utf8');
  const definedClasses = extractCssClassNames(html);

  const assetsDir = path.join(DIST, 'assets');
  let jsCorpus = '';
  if (existsSync(assetsDir)) {
    for (const f of readdirSync(assetsDir)) {
      if (f.endsWith('.js') || f.endsWith('.mjs')) {
        jsCorpus += readFileSync(path.join(assetsDir, f), 'utf8') + '\n';
      }
    }
  }
  const htmlCorpus = stripStyleBlocks(html);
  const corpus = htmlCorpus + '\n' + jsCorpus;

  const orphans = [];
  const dynamicSkipped = [];
  for (const cls of definedClasses) {
    if (DYNAMIC_CLASS_PREFIXES.some(p => cls.startsWith(p))) {
      dynamicSkipped.push(cls);
      continue;
    }
    if (!corpusHasClass(corpus, cls)) orphans.push(cls);
  }

  ok(definedClasses.size + ' clases CSS definidas en dist/index.html.');
  ok(dynamicSkipped.length + ' excluidas por ser compuestas en runtime (prefijos: ' + DYNAMIC_CLASS_PREFIXES.join(', ') + ').');

  if (orphans.length === 0) {
    ok('0 clases huérfanas — toda clase estática definida se usa en el HTML o en el bundle JS.');
  } else {
    orphans.sort();
    fail(orphans.length + ' clase(s) CSS definidas pero nunca referenciadas: ' + orphans.map(c => '.' + c).join(', '));
  }
}

/* ══════════════════════════════════════════════
   CHECK 3 — integridad de grillas del dashboard
══════════════════════════════════════════════ */
function checkDashboardGrids() {
  section('3/3 · GRILLAS DEL DASHBOARD (#view-docente)');

  const distIndex = path.join(DIST, 'index.html');
  if (!existsSync(distIndex)) {
    fail('No existe dist/index.html — no se puede auditar (¿falló el build?).');
    return;
  }
  const html = readFileSync(distIndex, 'utf8');

  for (const { cls, tracks } of FIXED_DASHBOARD_GRIDS) {
    const container = findGridContainer(html, cls);
    if (!container) {
      fail('.' + cls + ' — no se encontró en dist/index.html (¿se borró o renombró la clase?).');
      continue;
    }
    const children = countDirectChildren(html, container.openTagEnd, container.closeStart);
    if (children === 0) {
      fail('.' + cls + ' — el contenedor existe pero no tiene hijos directos.');
    } else if (children % tracks !== 0) {
      warn('.' + cls + ' (' + tracks + ' columnas fijas) tiene ' + children + ' hijo(s) — última fila incompleta.');
    } else {
      ok('.' + cls + ' — ' + children + ' hijo(s) directo(s), múltiplo exacto de ' + tracks + ' columnas.');
    }
  }

  for (const cls of RESPONSIVE_DASHBOARD_GRIDS) {
    const container = findGridContainer(html, cls);
    if (!container) {
      fail('.' + cls + ' — no se encontró en dist/index.html (¿se borró o renombró la clase?).');
      continue;
    }
    const children = countDirectChildren(html, container.openTagEnd, container.closeStart);
    if (children === 0) {
      fail('.' + cls + ' — el contenedor existe pero no tiene hijos directos.');
    } else {
      ok('.' + cls + ' (auto-fit/auto-fill, responsiva) — ' + children + ' hijo(s) directo(s). Métrica informativa, sin fila fija que romper.');
    }
  }
}

/* ══════════════════════════════════════════════
   MAIN
══════════════════════════════════════════════ */
console.log('EduInclusiva AI — loop-validator.js (Evaluator/Guardián)');
console.log('Auditoría independiente previa al visto bueno de producción.');

checkBuild();
if (failures === 0 || SKIP_BUILD) {
  checkOrphanClasses();
  checkDashboardGrids();
} else {
  console.log('\nSe salta el resto de los checks: sin un dist/ válido no hay nada que auditar.');
}

section('RESUMEN');
console.log('  Fallas:      ' + failures);
console.log('  Advertencias: ' + warnings);

if (failures > 0) {
  console.log('\n✘ BLOQUEADO — no apto para producción. Corregí lo anterior y volvé a correr el validador.');
  process.exit(1);
} else {
  console.log('\n✔ APTO PARA PRODUCCIÓN — métricas limpias.');
  process.exit(0);
}
