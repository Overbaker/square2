import { createHash } from 'node:crypto';

/** Invalid input to fingerprinting (control characters, bad paths). */
export class FingerprintInputError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'FingerprintInputError';
  }
}

export class PathError extends FingerprintInputError {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'PathError';
  }
}

/**
 * SHA-256 of a string (UTF-8) or bytes, lowercase hex.
 * @param {string | Uint8Array} input
 * @returns {string}
 */
export function sha256Hex(input) {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * True when the text contains a C0 control character (U+0000..U+001F).
 * @param {string} text
 * @returns {boolean}
 */
export function hasControlChar(text) {
  return /[\u0000-\u001f]/.test(text);
}

/**
 * Collapse whitespace runs to one space, then trim.
 * @param {string} subject
 * @returns {string}
 */
export function normalizeSubject(subject) {
  return subject.normalize('NFC').replace(/\s+/gu, ' ').trim();
}

/**
 * Repo-relative POSIX path in Unicode NFC: backslashes become slashes,
 * leading `./` segments are stripped first, then empty and `.` segments are
 * dropped. Absolute paths, drive letters and `..`
 * segments throw PathError.
 * @param {string} path
 * @returns {string}
 */
export function toPosixPath(path) {
  if (typeof path !== 'string') throw new PathError('path must be a string');
  if (hasControlChar(path)) throw new PathError(`control character in path: ${JSON.stringify(path)}`);
  const p = path.normalize('NFC').replace(/\\/g, '/').replace(/^(?:\.\/+)+/, '');
  if (p.startsWith('/')) throw new PathError(`absolute path not allowed: ${JSON.stringify(path)}`);
  if (/^[A-Za-z]:/.test(p)) throw new PathError(`drive-letter path not allowed: ${JSON.stringify(path)}`);
  const segs = p.split('/').filter((s) => s !== '' && s !== '.');
  if (segs.includes('..')) throw new PathError(`'..' segment not allowed: ${JSON.stringify(path)}`);
  if (segs.length === 0) throw new PathError(`empty path: ${JSON.stringify(path)}`);
  return segs.join('/');
}

/**
 * sha256(rule_id \0 posix path \0 normalized subject). Line numbers never participate.
 * @param {string} ruleId
 * @param {string} path
 * @param {string} subject
 * @returns {string}
 */
export function fingerprint(ruleId, path, subject) {
  if (typeof ruleId !== 'string' || typeof subject !== 'string') throw new FingerprintInputError('rule id and subject must be strings');
  if (hasControlChar(ruleId)) throw new FingerprintInputError(`control character in rule id: ${JSON.stringify(ruleId)}`);
  const normalized = normalizeSubject(subject);
  if (hasControlChar(normalized)) throw new FingerprintInputError(`control character in subject: ${JSON.stringify(normalized)}`);
  return sha256Hex(ruleId + '\0' + toPosixPath(path) + '\0' + normalized);
}
