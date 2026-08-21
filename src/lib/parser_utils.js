/**
 * Utilidades de preparación de texto para RAG.
 *
 * `chunkDocument` devuelve fragmentos de un máximo de `maxChars` caracteres.
 * Conserva párrafos y oraciones completas siempre que una oración no exceda
 * por sí misma el límite; en ese caso usa el límite de palabra más cercano.
 */

export const DEFAULT_CHUNK_SIZE = 1000;

function normalizeDocument(text) {
  return String(text || '')
    .normalize('NFKC')
    .replace(/\r\n?/g, '\n')
    .replace(/[\t\f\v ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function splitSentences(paragraph, locale) {
  if (typeof Intl?.Segmenter === 'function') {
    return Array.from(new Intl.Segmenter(locale, { granularity: 'sentence' }).segment(paragraph), entry => entry.segment.trim())
      .filter(Boolean);
  }

  return paragraph.match(/[^.!?…]+(?:[.!?…]+(?:["'»”)]*)|$)/g)?.map(sentence => sentence.trim()).filter(Boolean) || [paragraph];
}

function splitOversizedText(text, maxChars) {
  const pieces = [];
  let remaining = text.trim();

  while (remaining.length > maxChars) {
    const candidate = remaining.slice(0, maxChars + 1);
    const breakAt = Math.max(candidate.lastIndexOf(' '), candidate.lastIndexOf('\n'));
    const end = breakAt > 0 ? breakAt : maxChars;
    pieces.push(remaining.slice(0, end).trim());
    remaining = remaining.slice(end).trim();
  }
  if (remaining) pieces.push(remaining);
  return pieces;
}

/**
 * Divide un documento en chunks semánticamente útiles para embedding o RAG.
 *
 * @param {string} text Texto ya extraído del documento.
 * @param {{ maxChars?: number, locale?: string }} options
 * @returns {string[]} Chunks no vacíos, cada uno de hasta `maxChars` caracteres.
 */
export function chunkDocument(text, { maxChars = DEFAULT_CHUNK_SIZE, locale = 'es' } = {}) {
  if (!Number.isInteger(maxChars) || maxChars < 100) {
    throw new RangeError('maxChars debe ser un entero de al menos 100 caracteres.');
  }

  const documentText = normalizeDocument(text);
  if (!documentText) return [];

  const chunks = [];
  let current = '';
  let previousWasParagraph = false;

  const append = (unit, isNewParagraph) => {
    const separator = current ? (isNewParagraph || previousWasParagraph ? '\n\n' : ' ') : '';
    if (current.length + separator.length + unit.length <= maxChars) {
      current += separator + unit;
      previousWasParagraph = false;
      return;
    }

    if (current) chunks.push(current);
    current = '';
    previousWasParagraph = false;

    const pieces = splitOversizedText(unit, maxChars);
    if (pieces.length > 1) {
      chunks.push(...pieces.slice(0, -1));
      current = pieces.at(-1);
    } else {
      current = pieces[0] || '';
    }
  };

  for (const paragraph of documentText.split('\n\n')) {
    const sentences = splitSentences(paragraph, locale);
    sentences.forEach((sentence, index) => append(sentence, index === 0 && Boolean(current)));
    previousWasParagraph = true;
  }
  if (current) chunks.push(current);

  return chunks;
}
