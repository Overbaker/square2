import { compareStrings } from './canonical-json.mjs';
import { PathError, fingerprint, hasControlChar, normalizeSubject, toPosixPath } from './fingerprint.mjs';

/**
 * What an engine adapter reports.
 * @typedef {object} RawViolation
 * @property {string} rule_id
 * @property {string} path repo-relative
 * @property {string} subject engine-reported target (import specifier, suppression text, symbol)
 * @property {number} [line] 1-based, display only
 * @property {number} [column] 1-based, display only
 * @property {string} [message] human message; defaults to the subject
 */

/**
 * A fingerprinted violation.
 * @typedef {object} Violation
 * @property {string} rule_id
 * @property {string} path
 * @property {string} subject normalized
 * @property {string} message
 * @property {number | null} line
 * @property {number | null} column
 * @property {string} fingerprint
 * @property {number} occurrence 0-based index among equal fingerprints, by position
 */

export const RULE_ID_PATTERN = /^[A-Z0-9]+(-[A-Z0-9]+)+$/;
const CODE_PATTERN = /^[A-Z0-9-]+$/;
export const ADAPTER_INVALID = 'S2-ADAPTER-INVALID';

/** Invalid engine adapter output; callers map it to exit code 2. */
export class AdapterOutputError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'AdapterOutputError';
    this.code = ADAPTER_INVALID;
  }

  /** @returns {string} */
  get diagnostic() {
    return formatDiagnostic(ADAPTER_INVALID, this.message, 'make the engine adapter report repo-relative POSIX paths, valid rule ids and string subjects');
  }
}

/**
 * @param {number | null} a
 * @param {number | null} b
 * @returns {number}
 */
function comparePos(a, b) {
  const x = a ?? Number.MAX_SAFE_INTEGER;
  const y = b ?? Number.MAX_SAFE_INTEGER;
  return x - y;
}

/**
 * Order used to assign occurrence indexes within one fingerprint.
 * @param {Omit<Violation, 'occurrence'>} a
 * @param {Omit<Violation, 'occurrence'>} b
 * @returns {number}
 */
function comparePosition(a, b) {
  return comparePos(a.line, b.line) || comparePos(a.column, b.column) || compareStrings(a.message, b.message);
}

/**
 * Total, deterministic order for reporting.
 * @param {Violation} a
 * @param {Violation} b
 * @returns {number}
 */
export function compareViolations(a, b) {
  return (
    compareStrings(a.path, b.path) ||
    comparePos(a.line, b.line) ||
    comparePos(a.column, b.column) ||
    compareStrings(a.rule_id, b.rule_id) ||
    compareStrings(a.fingerprint, b.fingerprint) ||
    a.occurrence - b.occurrence ||
    compareStrings(a.message, b.message)
  );
}

/**
 * @param {unknown} n
 * @returns {number | null}
 */
function position(n) {
  return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Fingerprint raw engine output and assign occurrence indexes by position.
 * The result does not depend on the input order.
 * @param {RawViolation[]} raws
 * @returns {Violation[]}
 */
export function finalizeViolations(raws) {
  /** @type {Map<string, Omit<Violation, 'occurrence'>[]>} */
  const groups = new Map();
  if (!Array.isArray(raws)) throw new AdapterOutputError('adapter output must be a list');
  for (const raw of raws) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new AdapterOutputError('violation must be an object');
    if (typeof raw.rule_id !== 'string' || typeof raw.path !== 'string' || typeof raw.subject !== 'string') {
      throw new AdapterOutputError('violation requires string rule_id, path and subject');
    }
    if (!RULE_ID_PATTERN.test(raw.rule_id)) throw new AdapterOutputError(`invalid rule id ${JSON.stringify(raw.rule_id)}`);
    let path;
    try {
      path = toPosixPath(raw.path);
    } catch (err) {
      if (err instanceof PathError) throw new AdapterOutputError(`rule ${raw.rule_id}: ${err.message}`);
      throw err;
    }
    const subject = normalizeSubject(raw.subject);
    if (hasControlChar(subject)) throw new AdapterOutputError(`rule ${raw.rule_id}: control character in subject ${JSON.stringify(subject)}`);
    const v = {
      rule_id: raw.rule_id,
      path,
      subject,
      message: typeof raw.message === 'string' && raw.message !== '' ? raw.message : subject,
      line: position(raw.line),
      column: position(raw.column),
      fingerprint: fingerprint(raw.rule_id, path, subject),
    };
    const list = groups.get(v.fingerprint);
    if (list) list.push(v);
    else groups.set(v.fingerprint, [v]);
  }
  /** @type {Violation[]} */
  const out = [];
  for (const list of groups.values()) {
    list.sort(comparePosition);
    list.forEach((v, occurrence) => out.push({ ...v, occurrence }));
  }
  return out.sort(compareViolations);
}

/**
 * Make text safe for a single diagnostic line.
 * @param {string} text
 * @returns {string}
 */
export function escapeLine(text) {
  if (typeof text !== 'string') throw new TypeError('escapeLine expects a string');
  return text.replace(/[\\\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, (ch) => {
    switch (ch) {
      case '\\': return '\\\\';
      case '\n': return '\\n';
      case '\r': return '\\r';
      case '\t': return '\\t';
      default: return '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0');
    }
  });
}

/**
 * `[CODE] <head> — Instead: <instead>` on one line.
 * @param {string} code
 * @param {string} head
 * @param {string} instead
 * @returns {string}
 */
export function formatDiagnostic(code, head, instead) {
  if (!CODE_PATTERN.test(code)) throw new TypeError(`invalid diagnostic code: ${code}`);
  const h = escapeLine(head).trim() || '-';
  const i = escapeLine(instead).trim() || '-';
  return `[${code}] ${h} — Instead: ${i}`;
}

/**
 * `[RULE_ID] <path>[:<line>] <message> — Instead: <instead>`
 * @param {{ rule_id: string, path: string, line?: number | null, message: string }} v
 * @param {string} instead
 * @returns {string}
 */
export function formatViolationLine(v, instead) {
  const loc = v.line ? `${v.path}:${v.line}` : v.path;
  return formatDiagnostic(v.rule_id, `${loc} ${v.message}`, instead);
}
