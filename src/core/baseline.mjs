import { canonicalDocument, compareStrings } from './canonical-json.mjs';
import { isIsoDate } from './clock.mjs';
import { PathError, fingerprint, hasControlChar, normalizeSubject, toPosixPath } from './fingerprint.mjs';
import { RULE_ID_PATTERN, formatDiagnostic } from './violation.mjs';
import { errorMessage, parseYaml } from './yaml.mjs';

export const BASELINE_SCHEMA_VERSION = 1;

/**
 * @typedef {object} BaselineEntry
 * @property {string} fingerprint
 * @property {string} rule_id
 * @property {string} path
 * @property {string} subject
 * @property {number} count >= 1
 */

/**
 * Normalized: one entry per fingerprint, sorted by fingerprint.
 * @typedef {{ schema_version: number, entries: BaselineEntry[] }} Baseline
 */

/**
 * @typedef {object} Approval
 * @property {string} id
 * @property {string} approver
 * @property {string} date
 * @property {string} reason
 * @property {string} adr
 */

export class BaselineError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = 'BaselineError';
    this.code = code;
  }
}

/**
 * Merge duplicates (multiset union) and sort.
 * @param {BaselineEntry[]} entries
 * @returns {Baseline}
 */
export function normalizeBaseline(entries) {
  /** @type {Map<string, BaselineEntry>} */
  const map = new Map();
  for (const e of entries) {
    const prev = map.get(e.fingerprint);
    if (prev) {
      prev.count += e.count;
      if (!Number.isSafeInteger(prev.count)) throw new BaselineError('S2-BASELINE-INVALID', `count for ${e.fingerprint} exceeds the safe integer range`);
    }
    else map.set(e.fingerprint, { fingerprint: e.fingerprint, rule_id: e.rule_id, path: e.path, subject: e.subject, count: e.count });
  }
  const list = [...map.values()].filter((e) => e.count > 0).sort((a, b) => compareStrings(a.fingerprint, b.fingerprint));
  return { schema_version: BASELINE_SCHEMA_VERSION, entries: list };
}

/** @returns {Baseline} */
export function emptyBaseline() {
  return normalizeBaseline([]);
}

/**
 * @param {import('./violation.mjs').Violation[]} violations
 * @returns {Baseline}
 */
export function baselineFromViolations(violations) {
  return normalizeBaseline(violations.map((v) => ({ fingerprint: v.fingerprint, rule_id: v.rule_id, path: v.path, subject: v.subject, count: 1 })));
}

/**
 * @param {Baseline} baseline
 * @returns {string}
 */
export function serializeBaseline(baseline) {
  const b = normalizeBaseline(baseline.entries);
  return canonicalDocument(b);
}

/**
 * @param {string} text
 * @returns {Baseline}
 */
export function parseBaseline(text) {
  try {
    return parseBaselineStrict(text);
  } catch (err) {
    if (err instanceof BaselineError) throw err;
    throw new BaselineError('S2-BASELINE-INVALID', `baseline is unreadable: ${errorMessage(err)}`);
  }
}

/**
 * @param {string} text
 * @returns {Baseline}
 */
function parseBaselineStrict(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    throw new BaselineError('S2-BASELINE-INVALID', `baseline is not valid JSON: ${errorMessage(err)}`);
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) throw new BaselineError('S2-BASELINE-INVALID', 'baseline must be an object');
  if (doc.schema_version !== BASELINE_SCHEMA_VERSION) throw new BaselineError('S2-BASELINE-INVALID', `unsupported schema_version ${JSON.stringify(doc.schema_version)}`);
  if (!Array.isArray(doc.entries)) throw new BaselineError('S2-BASELINE-INVALID', 'entries must be a list');
  for (const key of Object.keys(doc)) {
    if (key !== 'schema_version' && key !== 'entries') throw new BaselineError('S2-BASELINE-INVALID', `unknown key ${key}`);
  }
  /** @type {BaselineEntry[]} */
  const entries = doc.entries.map((/** @type {unknown} */ raw, /** @type {number} */ i) => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new BaselineError('S2-BASELINE-INVALID', `entry ${i} must be an object`);
    const e = /** @type {Record<string, unknown>} */ (raw);
    for (const k of Object.keys(e)) {
      if (!['fingerprint', 'rule_id', 'path', 'subject', 'count'].includes(k)) throw new BaselineError('S2-BASELINE-INVALID', `entry ${i} has unknown field ${k}`);
    }
    for (const k of ['fingerprint', 'rule_id', 'path', 'subject']) {
      if (typeof e[k] !== 'string') throw new BaselineError('S2-BASELINE-INVALID', `entry ${i} ${k} must be a string`);
    }
    if (typeof e.count !== 'number' || !Number.isSafeInteger(e.count) || e.count < 1) {
      throw new BaselineError('S2-BASELINE-INVALID', `entry ${i} count must be a positive integer`);
    }
    const entry = {
      fingerprint: /** @type {string} */ (e.fingerprint),
      rule_id: /** @type {string} */ (e.rule_id),
      path: /** @type {string} */ (e.path),
      subject: /** @type {string} */ (e.subject),
      count: e.count,
    };
    if (!RULE_ID_PATTERN.test(entry.rule_id)) throw new BaselineError('S2-BASELINE-INVALID', `entry ${i} rule_id is invalid`);
    if (hasControlChar(entry.subject)) throw new BaselineError('S2-BASELINE-INVALID', `entry ${i} subject contains a control character`);
    let posix;
    try {
      posix = toPosixPath(entry.path);
    } catch (err) {
      if (err instanceof PathError) throw new BaselineError('S2-BASELINE-INVALID', `entry ${i} ${err.message}`);
      throw err;
    }
    if (entry.path !== posix) throw new BaselineError('S2-BASELINE-INVALID', `entry ${i} path is not a normalized POSIX path`);
    if (entry.subject !== normalizeSubject(entry.subject)) throw new BaselineError('S2-BASELINE-INVALID', `entry ${i} subject is not normalized`);
    if (fingerprint(entry.rule_id, entry.path, entry.subject) !== entry.fingerprint) {
      throw new BaselineError('S2-BASELINE-INVALID', `entry ${i} fingerprint does not match its rule_id, path and subject`);
    }
    return entry;
  });
  return normalizeBaseline(entries);
}

/**
 * @param {Baseline} baseline
 * @returns {Map<string, number>}
 */
export function baselineCounts(baseline) {
  /** @type {Map<string, number>} */
  const m = new Map();
  for (const e of baseline.entries) m.set(e.fingerprint, (m.get(e.fingerprint) ?? 0) + e.count);
  return m;
}

/**
 * @param {Baseline} baseline
 * @returns {number}
 */
export function baselineSize(baseline) {
  return baseline.entries.reduce((n, e) => n + e.count, 0);
}

/**
 * Split violations into baselined and new by multiset count: per
 * fingerprint, the first `count` occurrences in position order are
 * baselined and the rest are new. Occurrence values need not be contiguous.
 * @param {Baseline} baseline
 * @param {import('./violation.mjs').Violation[]} violations
 * @returns {{ baselined: import('./violation.mjs').Violation[], fresh: import('./violation.mjs').Violation[] }}
 */
export function diffBaseline(baseline, violations) {
  const counts = baselineCounts(baseline);
  const ordered = violations.slice().sort((a, b) => compareStrings(a.fingerprint, b.fingerprint) || a.occurrence - b.occurrence);
  /** @type {Map<string, number>} */
  const used = new Map();
  /** @type {Set<import('./violation.mjs').Violation>} */
  const inBaseline = new Set();
  for (const v of ordered) {
    const n = used.get(v.fingerprint) ?? 0;
    if (n < (counts.get(v.fingerprint) ?? 0)) {
      inBaseline.add(v);
      used.set(v.fingerprint, n + 1);
    }
  }
  return {
    baselined: violations.filter((v) => inBaseline.has(v)),
    fresh: violations.filter((v) => !inBaseline.has(v)),
  };
}

/**
 * Remove entries that are no longer observed; counts never increase.
 * @param {Baseline} baseline
 * @param {import('./violation.mjs').Violation[]} violations
 * @returns {Baseline}
 */
export function shrink(baseline, violations) {
  const observed = baselineCounts(baselineFromViolations(violations));
  return normalizeBaseline(
    baseline.entries.map((e) => ({ ...e, count: Math.min(e.count, observed.get(e.fingerprint) ?? 0) })),
  );
}

/**
 * @param {unknown} raw
 * @param {string[]} approvers
 * @returns {string | null} a reason the approval is invalid, or null
 */
export function approvalProblem(raw, approvers) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return 'approval must be a mapping';
  const a = /** @type {Record<string, unknown>} */ (raw);
  for (const k of ['id', 'approver', 'date', 'reason', 'adr']) {
    if (typeof a[k] !== 'string' || /** @type {string} */ (a[k]).trim() === '') return `approval missing ${k}`;
  }
  if (!isIsoDate(a.date)) return 'approval date must be YYYY-MM-DD';
  if (!approvers.includes(/** @type {string} */ (a.approver))) return `approver ${a.approver} is not listed in config approvers`;
  return null;
}

/**
 * Add every observed violation to the baseline. Always requires a valid approval.
 * @param {Baseline} baseline
 * @param {import('./violation.mjs').Violation[]} violations
 * @param {{ approval?: Approval | null, approvers: string[] }} opts
 * @returns {Baseline}
 */
export function grow(baseline, violations, opts) {
  if (!opts.approval) throw new BaselineError('S2-BASELINE-GREW', 'baseline grow requires an approval record');
  const problem = approvalProblem(opts.approval, opts.approvers);
  if (problem) throw new BaselineError('S2-BASELINE-GREW', problem);
  const observed = baselineFromViolations(violations);
  const counts = baselineCounts(baseline);
  /** @type {BaselineEntry[]} */
  const merged = baseline.entries.map((e) => ({ ...e }));
  for (const e of observed.entries) {
    const have = counts.get(e.fingerprint) ?? 0;
    if (e.count > have) merged.push({ ...e, count: e.count - have });
  }
  return normalizeBaseline(merged);
}

/**
 * Parse `.square2/approvals.yaml` (`approvals:` list; empty file means none).
 * @param {string | null} text
 * @returns {unknown[]}
 */
export function parseApprovals(text) {
  if (text === null) return [];
  let doc;
  try {
    doc = parseYaml(text);
  } catch (err) {
    throw new BaselineError('S2-APPROVALS-INVALID', `approvals.yaml: ${errorMessage(err)}`);
  }
  if (doc === null) return [];
  if (typeof doc !== 'object' || Array.isArray(doc) || Object.keys(doc).length !== 1 || !('approvals' in doc) ||
      !(doc.approvals === null || Array.isArray(doc.approvals))) {
    throw new BaselineError('S2-APPROVALS-INVALID', 'approvals.yaml must contain only an `approvals:` list');
  }
  return doc.approvals ?? [];
}

/**
 * Approvals added in this change (ids absent from the previous list) that are valid.
 * @param {unknown[]} previous
 * @param {unknown[]} current
 * @param {string[]} approvers
 * @returns {Approval[]}
 */
export function freshApprovals(previous, current, approvers) {
  /** @param {unknown} a @returns {string | null} */
  const idOf = (a) => (a && typeof a === 'object' && 'id' in a && typeof a.id === 'string' ? a.id : null);
  const prevIds = new Set(previous.map(idOf).filter((x) => x !== null));
  return /** @type {Approval[]} */ (current.filter((a) => {
    const id = idOf(a);
    return id !== null && !prevIds.has(id) && approvalProblem(a, approvers) === null;
  }));
}

/**
 * The previous commit's baseline: `no-commit` (all-zero or missing `before`),
 * `absent` (the commit exists but has no baseline file), or the blob text.
 * @typedef {{ kind: 'no-commit' } | { kind: 'absent' } | { kind: 'blob', text: string }} PreviousBaseline
 */

/**
 * @typedef {object} RatchetResult
 * @property {'skipped' | 'ok' | 'grew' | 'approved'} status
 * @property {number} added multiset entries in current that are not in previous
 * @property {string[]} diagnostics failing lines (`[S2-BASELINE-GREW] …`)
 * @property {string[]} notes informational lines
 */

/**
 * CI ratchet (design D7): compare the current baseline with the previous
 * commit's. Skipped only when there is no previous commit; an absent file is
 * an empty baseline; an unparseable blob fails. Growth is any fingerprint
 * whose count increased; it needs at least one fresh valid approval.
 * @param {{
 *   previousBaseline: PreviousBaseline,
 *   currentBaseline: Baseline,
 *   previousApprovalsText: string | null,
 *   currentApprovalsText: string | null,
 *   approvers: string[],
 *   baselinePath?: string,
 * }} input
 * @returns {RatchetResult}
 */
export function checkRatchet(input) {
  const path = input.baselinePath ?? '.square2/baseline.json';
  const instead = 'fix the new violations, or run `square2 baseline grow` with an approval in .square2/approvals.yaml';
  /** @param {number} added @param {string} why @returns {RatchetResult} */
  const grew = (added, why) => ({ status: 'grew', added, diagnostics: [formatDiagnostic('S2-BASELINE-GREW', `${path} ${why}`, instead)], notes: [] });
  const prev = input.previousBaseline;
  if (prev.kind === 'no-commit') {
    return { status: 'skipped', added: 0, diagnostics: [], notes: [`${path}: no previous commit, baseline ratchet skipped`] };
  }
  let previous = emptyBaseline();
  /** @type {string[]} */
  const notes = [];
  if (prev.kind === 'blob') {
    try {
      previous = parseBaseline(prev.text);
    } catch (err) {
      if (!(err instanceof BaselineError)) throw err;
      notes.push(`${path}: previous baseline is unreadable (${err.message}); compared against an empty baseline`);
    }
  }
  const before = baselineCounts(previous);
  let added = 0;
  for (const [fp, n] of baselineCounts(input.currentBaseline)) added += Math.max(0, n - (before.get(fp) ?? 0));
  if (added === 0) return { status: 'ok', added, diagnostics: [], notes };

  let prevApprovals;
  let curApprovals;
  try {
    prevApprovals = parseApprovals(input.previousApprovalsText);
  } catch (err) {
    if (!(err instanceof BaselineError)) throw err;
    return grew(added, `+${added} entries; previous ${err.message}`);
  }
  try {
    curApprovals = parseApprovals(input.currentApprovalsText);
  } catch (err) {
    if (!(err instanceof BaselineError)) throw err;
    return grew(added, `+${added} entries; ${err.message}`);
  }
  if (freshApprovals(prevApprovals, curApprovals, input.approvers).length > 0) {
    return { status: 'approved', added, diagnostics: [], notes: [...notes, `${path}: +${added} entries approved`] };
  }
  return { ...grew(added, `+${added} entries without an approval`), notes };
}
