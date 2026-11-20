/**
 * @typedef {{ key: string, value: string }} Trailer
 */

const TRAILER = /^([A-Za-z0-9][A-Za-z0-9-]*)\s*:\s*(.+)$/;

/**
 * Trailers of a commit message: the lines of its last paragraph that look
 * like `Key: value` (git's own rule needs at least one trailer line; other
 * lines in that paragraph are ignored).
 * @param {string} message
 * @returns {Trailer[]}
 */
export function parseTrailers(message) {
  const paragraphs = message.replace(/\r\n/g, '\n').trim().split(/\n\s*\n/);
  if (paragraphs.length < 2) return [];
  const last = paragraphs[paragraphs.length - 1].split('\n');
  /** @type {Trailer[]} */
  const out = [];
  for (const line of last) {
    const m = TRAILER.exec(line.trim());
    if (m) out.push({ key: m[1], value: m[2].trim() });
  }
  return out;
}

/**
 * `Co-Authored-By` values (key compared case-insensitively).
 * @param {string} message
 * @returns {string[]}
 */
export function coAuthors(message) {
  return parseTrailers(message).filter((t) => t.key.toLowerCase() === 'co-authored-by').map((t) => t.value);
}
