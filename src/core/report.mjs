import { canonicalDocument, compareStrings } from './canonical-json.mjs';
import { baselineCounts, diffBaseline } from './baseline.mjs';
import { applyExceptions } from './exceptions.mjs';
import { compareViolations, escapeLine, formatViolationLine } from './violation.mjs';

export const REPORT_SCHEMA_VERSION = 1;
export const EXIT_PASS = 0;
export const EXIT_FAIL = 1;
export const EXIT_FATAL = 2;
const FALLBACK_INSTEAD = 'fix the violation or register an exception in .square2/exceptions.yaml';

/** @typedef {import('./violation.mjs').Violation} Violation */
/** @typedef {import('./exceptions.mjs').Exception} Exception */

/**
 * @typedef {object} Classification
 * @property {Violation[]} fresh not baselined and not excepted
 * @property {Violation[]} baselined
 * @property {{ violation: Violation, exception_id: string }[]} excepted
 * @property {Exception[]} expired
 * @property {Map<string, number>} partial baseline count of each fresh fingerprint that is also in the baseline
 */

/**
 * @typedef {{ hits: number, new: number, baselined: number, excepted: number, expired: number }} RuleStats
 */

/**
 * One reportable finding: a single new violation, or the excess of a
 * fingerprint over its baseline count (no line, since which occurrence is
 * "new" is not meaningful).
 * @typedef {{ rule_id: string, path: string, line: number | null, message: string, fingerprint: string, count: number }} Finding
 */

/**
 * Classify every violation into exactly one of new, baselined, excepted.
 * Expired exceptions never cover a violation.
 * @param {{
 *   violations: Violation[],
 *   baseline: import('./baseline.mjs').Baseline,
 *   live: Exception[],
 *   expired: Exception[],
 * }} input
 * @returns {Classification}
 */
export function classify(input) {
  const { baselined, fresh: notBaselined } = diffBaseline(input.baseline, input.violations);
  const { excepted, remaining } = applyExceptions(notBaselined, input.live);
  const counts = baselineCounts(input.baseline);
  /** @type {Map<string, number>} */
  const partial = new Map();
  for (const v of remaining) {
    const n = counts.get(v.fingerprint) ?? 0;
    if (n > 0) partial.set(v.fingerprint, n);
  }
  return {
    fresh: remaining.slice().sort(compareViolations),
    baselined: baselined.slice().sort(compareViolations),
    excepted: excepted.slice().sort((a, b) => compareViolations(a.violation, b.violation) || compareStrings(a.exception_id, b.exception_id)),
    expired: input.expired.slice().sort((a, b) => compareStrings(a.id, b.id)),
    partial,
  };
}

/**
 * New violations as findings: fingerprints absent from the baseline yield one
 * finding per occurrence with its line; fingerprints over their baseline count
 * yield one `(+N over baseline)` finding without a line.
 * @param {Classification} c
 * @returns {Finding[]}
 */
export function findings(c) {
  /** @type {Finding[]} */
  const out = [];
  /** @type {Map<string, Finding>} */
  const grouped = new Map();
  for (const v of c.fresh) {
    if (!c.partial.has(v.fingerprint)) {
      out.push({ rule_id: v.rule_id, path: v.path, line: v.line, message: v.message, fingerprint: v.fingerprint, count: 1 });
      continue;
    }
    const g = grouped.get(v.fingerprint);
    if (g) g.count++;
    else grouped.set(v.fingerprint, { rule_id: v.rule_id, path: v.path, line: null, message: v.subject, fingerprint: v.fingerprint, count: 1 });
  }
  for (const g of grouped.values()) out.push({ ...g, message: `${g.message} (+${g.count} over baseline)` });
  return out.sort((a, b) =>
    compareStrings(a.path, b.path) ||
    (a.line ?? Number.MAX_SAFE_INTEGER) - (b.line ?? Number.MAX_SAFE_INTEGER) ||
    compareStrings(a.rule_id, b.rule_id) ||
    compareStrings(a.fingerprint, b.fingerprint) ||
    compareStrings(a.message, b.message));
}

/**
 * @param {Map<string, string> | Record<string, string> | undefined} instead
 * @returns {Map<string, string>}
 */
function insteadMap(instead) {
  return instead instanceof Map ? instead : new Map(Object.entries(instead ?? {}));
}

/**
 * @param {Classification} c
 * @param {Iterable<string>} ruleIds every catalogue rule, reported even with zero hits
 * @returns {Record<string, RuleStats>}
 */
export function ruleStats(c, ruleIds) {
  /** @type {Record<string, RuleStats>} */
  const acc = Object.create(null);
  /** @param {string} id */
  const get = (id) => (acc[id] ??= { hits: 0, new: 0, baselined: 0, excepted: 0, expired: 0 });
  for (const id of ruleIds) get(id);
  for (const v of c.fresh) { get(v.rule_id).new++; get(v.rule_id).hits++; }
  for (const v of c.baselined) { get(v.rule_id).baselined++; get(v.rule_id).hits++; }
  for (const e of c.excepted) { get(e.violation.rule_id).excepted++; get(e.violation.rule_id).hits++; }
  for (const x of c.expired) get(x.rule_id).expired++;
  /** @type {Record<string, RuleStats>} */
  const out = {};
  for (const id of Object.keys(acc).sort(compareStrings)) Object.defineProperty(out, id, { value: acc[id], enumerable: true, writable: true, configurable: true });
  return out;
}

/**
 * @typedef {object} DecideInput
 * @property {string[]} [catalogue] `[S2-CATALOGUE]` lines
 * @property {string[]} [selftest] `[S2-SELFTEST]` lines
 * @property {string[]} [tamper] `[S2-VENDOR-TAMPERED]` and other fatal lines
 * @property {string[]} [engine] `[S2-ADAPTER-INVALID]` lines (invalid adapter output)
 * @property {Classification} [classification]
 * @property {Map<string, string> | Record<string, string>} [instead] rule id to remediation text
 * @property {string[]} [invalidExceptions] `[S2-EXC-INVALID]` lines
 * @property {string[]} [mutatedExceptions] `[S2-EXC-MUTATED]` lines
 * @property {string[]} [expiredExceptions] `[S2-EXC-EXPIRED]` lines
 * @property {{ diagnostics: string[], notes?: string[] }} [ratchet]
 */

/**
 * @typedef {object} Decision
 * @property {0 | 1 | 2} exitCode
 * @property {string[]} lines diagnostics to print, in order
 * @property {string[]} notes informational lines
 */

/**
 * 2: catalogue, selftest, tamper or adapter-output failure. 1: new
 * violations, expired, invalid or mutated exceptions, or a grown baseline.
 * Otherwise 0.
 * @param {DecideInput} input
 * @returns {Decision}
 */
export function decide(input) {
  const fatal = [...(input.catalogue ?? []), ...(input.selftest ?? []), ...(input.tamper ?? []), ...(input.engine ?? [])];
  const notes = [...(input.ratchet?.notes ?? [])];
  if (fatal.length > 0) return { exitCode: EXIT_FATAL, lines: fatal, notes };
  const instead = insteadMap(input.instead);
  const violationLines = input.classification
    ? findings(input.classification).map((f) => formatViolationLine(f, instead.get(f.rule_id) ?? FALLBACK_INSTEAD))
    : [];
  const lines = [
    ...(input.invalidExceptions ?? []),
    ...(input.mutatedExceptions ?? []),
    ...(input.expiredExceptions ?? []),
    ...(input.ratchet?.diagnostics ?? []),
    ...violationLines,
  ];
  return { exitCode: lines.length > 0 ? EXIT_FAIL : EXIT_PASS, lines, notes };
}

/**
 * @typedef {object} ReportInput
 * @property {string} repo
 * @property {string} head_sha
 * @property {string} runner_version
 * @property {string} catalogue_digest
 * @property {Record<string, string>} engine_versions
 * @property {string[]} rule_ids
 * @property {Classification} classification
 * @property {number} exit_code
 * @property {string} today
 */

/**
 * @param {ReportInput} input
 * @returns {Record<string, unknown>}
 */
export function buildReport(input) {
  const c = input.classification;
  /** @type {Map<string, { fingerprint: string, rule_id: string, path: string, count: number }>} */
  const observed = new Map();
  for (const v of [...c.fresh, ...c.baselined, ...c.excepted.map((e) => e.violation)]) {
    const o = observed.get(v.fingerprint);
    if (o) o.count++;
    else observed.set(v.fingerprint, { fingerprint: v.fingerprint, rule_id: v.rule_id, path: v.path, count: 1 });
  }
  /** @type {Map<string, { fingerprint: string, rule_id: string, path: string, exception_id: string, count: number }>} */
  const excepted = new Map();
  for (const e of c.excepted) {
    const key = `${e.violation.fingerprint}\0${e.exception_id}`;
    const x = excepted.get(key);
    if (x) x.count++;
    else excepted.set(key, { fingerprint: e.violation.fingerprint, rule_id: e.violation.rule_id, path: e.violation.path, exception_id: e.exception_id, count: 1 });
  }
  return {
    schema_version: REPORT_SCHEMA_VERSION,
    repo: input.repo,
    head_sha: input.head_sha,
    runner_version: input.runner_version,
    catalogue_digest: input.catalogue_digest,
    engine_versions: { ...input.engine_versions },
    today: input.today,
    exit_code: input.exit_code,
    rules: ruleStats(c, input.rule_ids),
    new_violations: findings(c),
    observed: [...observed.values()],
    excepted: [...excepted.values()],
    expired_exceptions: c.expired.map((x) => x.id),
  };
}

/**
 * Canonical `square2-report.json` bytes: sorted keys, sorted arrays.
 * @param {Record<string, unknown>} report
 * @returns {string}
 */
export function serializeReport(report) {
  return canonicalDocument(report, { sortArrays: true });
}

/**
 * @param {string} s
 * @returns {string}
 */
function ghData(s) {
  return s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

/**
 * @param {string} s
 * @returns {string}
 */
function ghProp(s) {
  return ghData(s).replace(/:/g, '%3A').replace(/,/g, '%2C');
}

/**
 * `::error file=…,line=…,title=…::<diagnostic line>` for each new finding.
 * @param {Classification} c
 * @param {Map<string, string> | Record<string, string>} [instead]
 * @returns {string[]}
 */
export function githubAnnotations(c, instead) {
  const map = insteadMap(instead);
  return findings(c).map((f) => {
    const props = [`file=${ghProp(escapeLine(f.path))}`];
    if (f.line) props.push(`line=${f.line}`);
    props.push(`title=${ghProp(escapeLine(f.rule_id))}`);
    return `::error ${props.join(',')}::${ghData(formatViolationLine(f, map.get(f.rule_id) ?? FALLBACK_INSTEAD))}`;
  });
}

/**
 * @param {string} s
 * @returns {string}
 */
function mdCell(s) {
  return escapeLine(s).replace(/\|/g, '\\|');
}

/**
 * Markdown step summary.
 * @param {{ decision: Decision, stats: Record<string, RuleStats> }} input
 * @returns {string}
 */
export function markdownSummary(input) {
  const { decision, stats } = input;
  const status = decision.exitCode === 0 ? 'passed' : decision.exitCode === 1 ? 'failed' : 'could not run';
  const out = [`## square² gate: ${status} (exit ${decision.exitCode})`, ''];
  const ids = Object.keys(stats).sort(compareStrings);
  if (ids.length > 0) {
    out.push('| Rule | Hits | New | Baselined | Excepted | Expired |', '|---|---:|---:|---:|---:|---:|');
    for (const id of ids) {
      const s = stats[id];
      out.push(`| ${mdCell(id)} | ${s.hits} | ${s.new} | ${s.baselined} | ${s.excepted} | ${s.expired} |`);
    }
    out.push('');
  }
  if (decision.lines.length > 0) {
    out.push('```text', ...decision.lines.map((l) => l.replace(/```/g, '`\u200b``')), '```', '');
  }
  for (const n of decision.notes) out.push(`> ${escapeLine(n)}`);
  return out.join('\n').trimEnd() + '\n';
}
