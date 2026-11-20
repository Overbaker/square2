import { compareStrings } from './canonical-json.mjs';
import { daysBetween, isIsoDate } from './clock.mjs';
import { PathError, hasControlChar, toPosixPath } from './fingerprint.mjs';
import { formatDiagnostic } from './violation.mjs';
import { YamlError, errorMessage, parseYaml } from './yaml.mjs';

export const DEFAULT_MAX_TTL_DAYS = 90;
const REQUIRED = /** @type {const} */ (['id', 'rule_id', 'scope', 'reason', 'owner', 'adr', 'created_at', 'expires_at']);
const ALLOWED = new Set([...REQUIRED, 'fingerprint', 'renews']);
const INSTEAD_INVALID = 'give every exception id, rule_id, a narrow scope, reason, owner, adr and created_at/expires_at within the TTL cap';
const INSTEAD_EXPIRED = 'fix the cause, or register a renewal as a new id with `renews: <old id>`';
const INSTEAD_UNREADABLE = 'repair the exceptions file so the previous commit parses, or push the repair as its own change';
const INSTEAD_MUTATED = 'restore the original expires_at and add a new entry with `renews: <old id>`';

/**
 * @typedef {object} Exception
 * @property {string} id
 * @property {string} rule_id
 * @property {string} scope
 * @property {string} [fingerprint]
 * @property {string} reason
 * @property {string} owner
 * @property {string} adr
 * @property {string} created_at
 * @property {string} expires_at
 * @property {string} [renews]
 */

/**
 * @typedef {object} ExceptionsResult
 * @property {Exception[]} valid sorted by id
 * @property {string[]} diagnostics `[S2-EXC-INVALID] …` lines
 */

/**
 * @param {unknown} config parsed `.square2/config.yaml`
 * @returns {number}
 */
export function ttlCapFromConfig(config) {
  if (config && typeof config === 'object' && !Array.isArray(config) && 'max_exception_ttl_days' in config) {
    const v = config.max_exception_ttl_days;
    if (typeof v === 'number' && Number.isInteger(v) && v >= 1) return v;
    throw new TypeError('max_exception_ttl_days must be a positive integer');
  }
  return DEFAULT_MAX_TTL_DAYS;
}

/**
 * @param {string} id
 * @param {string} detail
 * @returns {string}
 */
function invalid(id, detail) {
  return formatDiagnostic('S2-EXC-INVALID', `${id} ${detail}`, INSTEAD_INVALID);
}

/**
 * A segment is wildcard-only when it consists of `*` and `?` and contains a `*`.
 * @param {string} seg
 * @returns {boolean}
 */
function isWildcardOnlySegment(seg) {
  return /^[*?]+$/.test(seg) && seg.includes('*');
}

/**
 * True when every segment of the glob is wildcard-only (`*`, `**`, `**\/?*`, `*?`, …),
 * so the scope would match any path at that depth or deeper.
 * @param {string} scope
 * @returns {boolean}
 */
export function isOverWideScope(scope) {
  const segs = scope.trim().replace(/\\/g, '/').split('/').filter((s) => s !== '' && s !== '.');
  return segs.length === 0 || segs.every(isWildcardOnlySegment);
}

/**
 * Parse `.square2/exceptions.yaml` into raw entries. Empty file means none.
 * @param {string} text
 * @returns {{ entries: unknown[], diagnostics: string[] }}
 */
export function parseExceptions(text) {
  let doc;
  try {
    doc = parseYaml(text);
  } catch (err) {
    const what = err instanceof YamlError ? 'invalid YAML' : 'unreadable';
    return { entries: [], diagnostics: [invalid('exceptions.yaml', `${what} (${errorMessage(err)})`)] };
  }
  if (doc === null) return { entries: [], diagnostics: [] };
  if (typeof doc !== 'object' || Array.isArray(doc) || Object.keys(doc).length !== 1 || !('exceptions' in doc) ||
      !(doc.exceptions === null || Array.isArray(doc.exceptions))) {
    return { entries: [], diagnostics: [invalid('exceptions.yaml', 'must contain only an `exceptions:` list')] };
  }
  return { entries: doc.exceptions ?? [], diagnostics: [] };
}

/**
 * @param {unknown[]} entries
 * @param {{ ruleIds: Iterable<string>, today: string, maxTtlDays?: number }} opts
 * @returns {ExceptionsResult}
 */
export function validateExceptions(entries, opts) {
  if (!isIsoDate(opts.today)) throw new TypeError('validateExceptions requires today as YYYY-MM-DD');
  const ruleIds = new Set(opts.ruleIds);
  const cap = opts.maxTtlDays ?? DEFAULT_MAX_TTL_DAYS;
  /** @type {string[]} */
  const diagnostics = [];
  /** @type {Exception[]} */
  const valid = [];
  /** @type {Map<string, number>} */
  const idCount = new Map();
  for (const e of entries) {
    if (e && typeof e === 'object' && !Array.isArray(e) && 'id' in e && typeof e.id === 'string') idCount.set(e.id, (idCount.get(e.id) ?? 0) + 1);
  }
  entries.forEach((raw, index) => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      diagnostics.push(invalid(`#${index + 1}`, 'is not a mapping'));
      return;
    }
    const e = /** @type {Record<string, unknown>} */ (raw);
    const id = typeof e.id === 'string' && e.id.trim() !== '' ? e.id : `#${index + 1}`;
    /** @type {string[]} */
    const problems = [];
    for (const k of REQUIRED) {
      if (typeof e[k] !== 'string' || /** @type {string} */ (e[k]).trim() === '') problems.push(`missing ${k}`);
    }
    for (const k of Object.keys(e)) if (!ALLOWED.has(k)) problems.push(`unknown field ${k}`);
    if (typeof e.id === 'string' && (idCount.get(e.id) ?? 0) > 1) problems.push('duplicate id');
    if (typeof e.rule_id === 'string' && e.rule_id !== '' && !ruleIds.has(e.rule_id)) problems.push(`unknown rule_id ${e.rule_id}`);
    /** @type {string | null} */
    let scope = null;
    if (typeof e.scope === 'string' && e.scope.trim() !== '') {
      if (hasControlChar(e.scope)) problems.push(`scope ${JSON.stringify(e.scope)} contains a control character`);
      else if (isOverWideScope(e.scope)) problems.push(`scope ${JSON.stringify(e.scope)} is too wide`);
      else {
        try {
          scope = toPosixPath(e.scope.trim());
        } catch (err) {
          if (!(err instanceof PathError)) throw err;
          problems.push(`scope ${JSON.stringify(e.scope)} is not a repo-relative glob`);
        }
      }
    }
    if (e.fingerprint !== undefined && !(typeof e.fingerprint === 'string' && /^[0-9a-f]{64}$/.test(e.fingerprint))) problems.push('fingerprint must be a sha256 hex');
    if (e.renews !== undefined && !(typeof e.renews === 'string' && e.renews.trim() !== '' && e.renews !== e.id)) problems.push('renews must name a different id');
    const datesOk = isIsoDate(e.created_at) && isIsoDate(e.expires_at);
    if (typeof e.created_at === 'string' && e.created_at !== '' && !isIsoDate(e.created_at)) problems.push('created_at must be YYYY-MM-DD');
    if (typeof e.expires_at === 'string' && e.expires_at !== '' && !isIsoDate(e.expires_at)) problems.push('expires_at must be YYYY-MM-DD');
    if (datesOk) {
      const ttl = daysBetween(/** @type {string} */ (e.created_at), /** @type {string} */ (e.expires_at));
      if (daysBetween(opts.today, /** @type {string} */ (e.created_at)) > 0) problems.push('created_at is in the future');
      if (ttl < 0) problems.push('expires_at is before created_at');
      else if (ttl > cap) problems.push(`TTL ${ttl} days exceeds the cap of ${cap}`);
    }
    if (problems.length > 0) {
      diagnostics.push(invalid(id, problems.join('; ')));
      return;
    }
    /** @type {Exception} */
    const x = {
      id: /** @type {string} */ (e.id),
      rule_id: /** @type {string} */ (e.rule_id),
      scope: /** @type {string} */ (scope),
      reason: /** @type {string} */ (e.reason),
      owner: /** @type {string} */ (e.owner),
      adr: /** @type {string} */ (e.adr),
      created_at: /** @type {string} */ (e.created_at),
      expires_at: /** @type {string} */ (e.expires_at),
    };
    if (typeof e.fingerprint === 'string') x.fingerprint = e.fingerprint;
    if (typeof e.renews === 'string') x.renews = e.renews;
    valid.push(x);
  });
  valid.sort((a, b) => compareStrings(a.id, b.id));
  return { valid, diagnostics };
}

/**
 * Live through the end of `expires_at` (UTC); expired on any later date.
 * @param {{ expires_at: string }} exception
 * @param {string} today YYYY-MM-DD
 * @returns {boolean}
 */
export function isExpired(exception, today) {
  return daysBetween(exception.expires_at, today) > 0;
}

/**
 * @param {Exception[]} valid
 * @param {string} today
 * @returns {{ live: Exception[], expired: Exception[], diagnostics: string[] }}
 */
export function splitByExpiry(valid, today) {
  const expired = valid.filter((x) => isExpired(x, today));
  const live = valid.filter((x) => !isExpired(x, today));
  return { live, expired, diagnostics: expired.map((x) => formatDiagnostic('S2-EXC-EXPIRED', `${x.id} expired on ${x.expires_at} (rule ${x.rule_id}, scope ${x.scope})`, INSTEAD_EXPIRED)) };
}

/**
 * `[S2-EXC-MUTATED]` for every id whose `expires_at` differs from the previous commit's file.
 * @param {string | null} previousText
 * @param {unknown[]} currentEntries
 * @returns {string[]}
 */
export function detectMutations(previousText, currentEntries) {
  if (previousText === null) return [];
  /** @param {string} reason */
  const unreadable = (reason) => [formatDiagnostic('S2-EXC-MUTATED', `previous exceptions file unreadable: ${reason}`, INSTEAD_UNREADABLE)];
  const prev = parseExceptions(previousText);
  if (prev.diagnostics.length > 0) return unreadable(prev.diagnostics.map(stripCode).join('; '));
  /** @type {Map<string, string>} */
  const before = new Map();
  for (const [i, e] of prev.entries.entries()) {
    if (!(e && typeof e === 'object' && !Array.isArray(e))) return unreadable(`entry #${i + 1} is not a mapping`);
    const id = 'id' in e ? e.id : undefined;
    const exp = 'expires_at' in e ? e.expires_at : undefined;
    if (typeof id !== 'string' || id.trim() === '') return unreadable(`entry #${i + 1} has no string id`);
    if (!isIsoDate(exp)) return unreadable(`entry ${id} has no ISO expires_at`);
    if (before.has(id)) return unreadable(`duplicate id ${id}`);
    before.set(id, exp);
  }
  /** @type {string[]} */
  const out = [];
  for (const e of currentEntries) {
    if (!(e && typeof e === 'object' && !Array.isArray(e))) continue;
    const id = 'id' in e ? e.id : undefined;
    const now = 'expires_at' in e ? e.expires_at : undefined;
    if (typeof id !== 'string' || !isIsoDate(now)) continue;
    const old = before.get(id);
    if (old !== undefined && old !== now) {
      out.push(formatDiagnostic('S2-EXC-MUTATED', `${id} expires_at changed from ${old} to ${now}`, INSTEAD_MUTATED));
    }
  }
  return out.sort(compareStrings);
}

/**
 * @param {string} line a formatted diagnostic
 * @returns {string} its head without the code and the Instead part
 */
function stripCode(line) {
  return line.replace(/^\[[A-Z0-9-]+\] /, '').replace(/ — Instead: .*$/, '');
}

/**
 * Match one path segment against one glob segment (`*` any run, `?` one
 * character, both within the segment). Linear-time greedy matching with a
 * single backtrack point, no RegExp.
 * @param {string} glob
 * @param {string} text
 * @returns {boolean}
 */
export function matchSegment(glob, text) {
  const g = Array.from(glob);
  const t = Array.from(text);
  let gi = 0;
  let ti = 0;
  let star = -1;
  let mark = 0;
  while (ti < t.length) {
    if (gi < g.length && (g[gi] === '?' || (g[gi] !== '*' && g[gi] === t[ti]))) {
      gi++;
      ti++;
    } else if (gi < g.length && g[gi] === '*') {
      star = gi++;
      mark = ti;
    } else if (star >= 0) {
      gi = star + 1;
      ti = ++mark;
    } else {
      return false;
    }
  }
  while (gi < g.length && g[gi] === '*') gi++;
  return gi === g.length;
}

/**
 * Glob match over `/` segments. A segment that is exactly `**` matches zero
 * or more path segments; any other segment is matched by matchSegment.
 * Dynamic programming over segment positions: O(glob segments × path segments).
 * @param {string} glob
 * @param {string} path repo-relative POSIX path
 * @returns {boolean}
 */
export function globMatch(glob, path) {
  const gs = glob.split('/').filter((s) => s !== '' && s !== '.');
  const ps = path.split('/').filter((s) => s !== '');
  // reach[j]: glob prefix consumed so far can end exactly before path segment j
  let reach = new Array(ps.length + 1).fill(false);
  reach[0] = true;
  for (const seg of gs) {
    const next = new Array(ps.length + 1).fill(false);
    if (seg === '**') {
      let any = false;
      for (let j = 0; j <= ps.length; j++) {
        any = any || reach[j];
        next[j] = any;
      }
    } else {
      for (let j = 0; j < ps.length; j++) if (reach[j] && matchSegment(seg, ps[j])) next[j + 1] = true;
    }
    reach = next;
  }
  return reach[ps.length];
}

/**
 * @param {Exception} exception
 * @param {import('./violation.mjs').Violation} v
 * @returns {boolean}
 */
export function exceptionMatches(exception, v) {
  if (exception.rule_id !== v.rule_id) return false;
  if (exception.fingerprint !== undefined && exception.fingerprint !== v.fingerprint) return false;
  return globMatch(exception.scope, v.path);
}

/**
 * @param {import('./violation.mjs').Violation[]} violations not covered by the baseline
 * @param {Exception[]} live
 * @returns {{ excepted: { violation: import('./violation.mjs').Violation, exception_id: string }[], remaining: import('./violation.mjs').Violation[] }}
 */
export function applyExceptions(violations, live) {
  /** @type {{ violation: import('./violation.mjs').Violation, exception_id: string }[]} */
  const excepted = [];
  /** @type {import('./violation.mjs').Violation[]} */
  const remaining = [];
  for (const v of violations) {
    const hit = live.find((x) => exceptionMatches(x, v));
    if (hit) excepted.push({ violation: v, exception_id: hit.id });
    else remaining.push(v);
  }
  return { excepted, remaining };
}
