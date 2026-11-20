import { sha256Hex } from '../core/fingerprint.mjs';
import { isChangedLine } from '../git/changed-lines.mjs';

export const SEVERITIES = Object.freeze(['Blocker', 'Major', 'Minor', 'Nit']);
export const STATUSES = Object.freeze(['pass', 'needs_changes', 'needs_clarification', 'not_reviewed']);
export const DEFAULT_MAX_FINDINGS = 10;
export const MAX_QUESTIONS = 4;

/**
 * @typedef {object} Finding
 * @property {'Blocker' | 'Major' | 'Minor' | 'Nit'} severity
 * @property {string} path
 * @property {number} line
 * @property {'LEFT' | 'RIGHT'} side
 * @property {string} title
 * @property {string} failure_case
 * @property {string} suggestion
 * @property {string} enclosing_symbol
 * @property {boolean} mechanizable
 * @property {string[]} [evidence]
 * @property {string} [commit] per-commit anchoring (calls mode): the commit whose patch shows the line
 */

/**
 * @typedef {Finding & { group: string, key: string }} KeyedFinding
 */

/**
 * @typedef {object} Validated
 * @property {true} ok
 * @property {'en' | 'zh'} language
 * @property {any[]} groups the model's groups, in prepared order
 * @property {KeyedFinding[]} published anchored, deduplicated findings
 * @property {KeyedFinding[]} demoted findings outside the changed lines (summary only)
 * @property {number} duplicates findings dropped as duplicates of a more severe one
 * @property {string[]} questions
 * @property {string[]} suggestions
 */

/**
 * Title normalisation for the finding key: NFC, whitespace collapsed, trimmed, lowercase.
 * @param {string} title
 * @returns {string}
 */
export function normalizeTitle(title) {
  return title.normalize('NFC').replace(/\s+/gu, ' ').trim().toLowerCase();
}

/**
 * `sha256("review\0" + path + "\0" + enclosing_symbol + "\0" + sha256(normalized title))`;
 * a missing or blank symbol counts as `<file>`.
 * @param {{ path: string, enclosing_symbol?: string | null, title: string }} f
 * @returns {string}
 */
export function findingKey(f) {
  const symbol = typeof f.enclosing_symbol === 'string' && f.enclosing_symbol.trim() !== '' ? f.enclosing_symbol.trim() : '<file>';
  return sha256Hex(`review\0${f.path}\0${symbol}\0${sha256Hex(normalizeTitle(f.title))}`);
}

class Invalid extends Error {}

/**
 * @param {unknown} v
 * @param {string} label
 * @returns {Record<string, any>}
 */
function obj(v, label) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Invalid(`${label} must be an object`);
  return /** @type {Record<string, any>} */ (v);
}

/**
 * @param {unknown} v
 * @param {string} label
 * @returns {string}
 */
function text(v, label) {
  if (typeof v !== 'string' || v.trim() === '') throw new Invalid(`${label} must be non-empty text`);
  return v;
}

/**
 * @param {unknown} v
 * @param {string} label
 * @returns {string[]}
 */
function texts(v, label) {
  if (!Array.isArray(v)) throw new Invalid(`${label} must be an array`);
  v.forEach((x, i) => text(x, `${label}[${i}]`));
  return /** @type {string[]} */ (v);
}

/**
 * @param {Record<string, any>} o
 * @param {string[]} allowed
 * @param {string} label
 */
function only(o, allowed, label) {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) throw new Invalid(`${label}.${k} is not allowed`);
}

/**
 * @param {unknown} v
 * @param {string} label
 * @returns {{ status: string, summary: string, evidence: string[] }}
 */
function stage(v, label) {
  const s = obj(v, label);
  only(s, ['status', 'summary', 'evidence'], label);
  if (!STATUSES.includes(s.status)) throw new Invalid(`${label}.status is invalid`);
  text(s.summary, `${label}.summary`);
  texts(s.evidence, `${label}.evidence`);
  return /** @type {any} */ (s);
}

/**
 * @param {unknown} v
 * @param {string} label
 * @returns {Finding}
 */
function finding(v, label) {
  const f = obj(v, label);
  only(f, ['severity', 'path', 'line', 'side', 'title', 'failure_case', 'suggestion', 'enclosing_symbol', 'mechanizable', 'evidence', 'commit'], label);
  if (f.commit !== undefined && !(typeof f.commit === 'string' && /^[0-9a-f]{7,40}$/.test(f.commit))) throw new Invalid(`${label}.commit must be a commit sha`);
  if (!SEVERITIES.includes(f.severity)) throw new Invalid(`${label}.severity is invalid`);
  for (const k of ['path', 'title', 'failure_case', 'suggestion', 'enclosing_symbol']) text(f[k], `${label}.${k}`);
  if (!Number.isSafeInteger(f.line) || f.line < 1) throw new Invalid(`${label}.line is invalid`);
  if (f.side !== 'LEFT' && f.side !== 'RIGHT') throw new Invalid(`${label}.side is invalid`);
  if (typeof f.mechanizable !== 'boolean') throw new Invalid(`${label}.mechanizable must be a boolean`);
  if (f.evidence !== undefined) texts(f.evidence, `${label}.evidence`);
  return /** @type {Finding} */ (f);
}

/**
 * Stage consistency of one group (P13). Returns an error message or null.
 * Approach is reviewed iff requirement passed; code is reviewed iff both
 * passed; a skipped stage has no evidence and a skipped code stage no
 * findings; a pass/needs_changes decision on requirement or approach needs
 * evidence; code `needs_changes` needs a finding and code `pass` has no
 * Blocker/Major finding.
 * @param {{ requirement: { status: string, evidence: string[] }, approach: { status: string, evidence: string[] }, code: { status: string, findings: { severity: string }[] } }} g
 * @returns {string | null}
 */
export function stageProblem(g) {
  const req = g.requirement.status;
  const app = g.approach.status;
  const code = g.code.status;
  if (req === 'not_reviewed') return 'requirement must be reviewed';
  if ((req === 'pass') === (app === 'not_reviewed')) return 'approach must be reviewed if and only if requirement passes';
  if ((req === 'pass' && app === 'pass') === (code === 'not_reviewed')) return 'code must be reviewed if and only if requirement and approach pass';
  for (const [name, s] of /** @type {const} */ ([['requirement', g.requirement], ['approach', g.approach]])) {
    if (s.status === 'not_reviewed' && s.evidence.length > 0) return `a skipped ${name} stage cannot carry evidence`;
    if ((s.status === 'pass' || s.status === 'needs_changes') && s.evidence.length === 0) return `${name} ${s.status} requires evidence`;
  }
  if (code === 'not_reviewed' && g.code.findings.length > 0) return 'a skipped code stage cannot contain findings';
  if (code === 'needs_changes' && g.code.findings.length === 0) return 'code needs_changes requires a finding';
  if (code === 'pass' && g.code.findings.some((f) => f.severity === 'Blocker' || f.severity === 'Major')) return 'code pass cannot contain Blocker or Major findings';
  return null;
}

const RANK = /** @type {Record<string, number>} */ ({ Blocker: 0, Major: 1, Minor: 2, Nit: 3 });

/**
 * Validate the model's raw output against the schema, the prepared groups,
 * stage consistency, the caps, and anchor findings to the changed lines.
 * Any problem invalidates the whole output (`review-error`, publish
 * nothing). A group that fails its requirement or approach only skips its
 * own code stage; other groups' findings are kept (P22).
 * @param {string | unknown} raw model output (JSON text or parsed)
 * Groups whose diff was not shown (`shown: false`, over the input budget)
 * may be omitted, or present with every stage `not_reviewed` and no
 * findings; shown groups must be present and stage-consistent.
 * @param {{
 *   groups: { id: string, shown?: boolean }[],
 *   changedLines: import('../git/changed-lines.mjs').ChangedLines,
 *   maxFindings?: number,
 *   commitLines?: Map<string, import('../git/changed-lines.mjs').ChangedLines>,
 *   commits?: string[],
 * }} ctx
 * With `commitLines` (calls mode: per-commit patches) every finding must
 * carry `commit`; a unique prefix of one of `commits` is expanded, and the
 * finding is anchored against that commit's shown lines only.
 * @returns {Validated | { ok: false, errors: string[] }}
 */
export function validateReview(raw, ctx) {
  try {
    let doc = raw;
    if (typeof raw === 'string') {
      try {
        doc = JSON.parse(raw);
      } catch {
        throw new Invalid('output is not JSON');
      }
    }
    const r = obj(doc, 'result');
    only(r, ['language', 'groups', 'questions', 'suggestions'], 'result');
    if (r.language !== 'en' && r.language !== 'zh') throw new Invalid('language must be en or zh');
    const questions = texts(r.questions, 'questions');
    const suggestions = texts(r.suggestions, 'suggestions');
    if (questions.length > MAX_QUESTIONS) throw new Invalid(`at most ${MAX_QUESTIONS} questions are allowed`);
    if (!Array.isArray(r.groups)) throw new Invalid('groups must be an array');
    const expected = ctx.groups.map((g) => g.id);
    const unshown = new Set(ctx.groups.filter((g) => g.shown === false).map((g) => g.id));
    /** @type {Map<string, any>} */
    const seen = new Map();
    r.groups.forEach((/** @type {unknown} */ gv, /** @type {number} */ i) => {
      const label = `groups[${i}]`;
      const g = obj(gv, label);
      only(g, ['id', 'requirement', 'approach', 'code'], label);
      const id = text(g.id, `${label}.id`);
      if (!expected.includes(id)) throw new Invalid(`${label}.id ${id} is not a prepared group`);
      if (seen.has(id)) throw new Invalid(`group ${id} appears twice`);
      stage(g.requirement, `${label}.requirement`);
      stage(g.approach, `${label}.approach`);
      const code = obj(g.code, `${label}.code`);
      only(code, ['status', 'summary', 'findings'], `${label}.code`);
      if (!STATUSES.includes(code.status)) throw new Invalid(`${label}.code.status is invalid`);
      text(code.summary, `${label}.code.summary`);
      if (!Array.isArray(code.findings)) throw new Invalid(`${label}.code.findings must be an array`);
      code.findings.forEach((/** @type {unknown} */ f, /** @type {number} */ j) => {
        const ok = finding(f, `${label}.code.findings[${j}]`);
        if (ctx.commitLines && ok.commit === undefined) throw new Invalid(`${label}.code.findings[${j}].commit is required for per-commit patches`);
      });
      if (unshown.has(id)) {
        if ([g.requirement, g.approach, g.code].some((st) => st.status !== 'not_reviewed') || code.findings.length > 0 || g.requirement.evidence.length > 0 || g.approach.evidence.length > 0) {
          throw new Invalid(`group ${id} was not shown to the model and must be not_reviewed`);
        }
      } else {
        const problem = stageProblem(/** @type {any} */ (g));
        if (problem) throw new Invalid(`group ${id}: ${problem}`);
      }
      seen.set(id, g);
    });
    for (const id of expected) if (!seen.has(id) && !unshown.has(id)) throw new Invalid(`group ${id} is missing`);
    const clarify = [...seen.values()].some((g) => [g.requirement, g.approach, g.code].some((s) => s.status === 'needs_clarification'));
    if (clarify && questions.length === 0) throw new Invalid('needs_clarification requires a concrete question');
    const present = expected.filter((id) => seen.has(id));
    const expand = (/** @type {string | undefined} */ c) => {
      if (c === undefined) return undefined;
      const hits = (ctx.commits ?? []).filter((s) => s.startsWith(c));
      return hits.length === 1 ? hits[0] : c;
    };
    const all = present.flatMap((id) => seen.get(id).code.findings.map((/** @type {Finding} */ f) => {
      const commit = expand(f.commit);
      return { ...f, ...(commit === undefined ? {} : { commit }), group: id, key: findingKey(f) };
    }));
    const max = ctx.maxFindings ?? DEFAULT_MAX_FINDINGS;
    if (all.length > max) throw new Invalid(`at most ${max} findings are allowed`);
    /** @type {Map<string, KeyedFinding>} */
    const byKey = new Map();
    let duplicates = 0;
    for (const f of all) {
      const prev = byKey.get(f.key);
      if (prev) {
        duplicates++;
        if (RANK[f.severity] < RANK[prev.severity]) byKey.set(f.key, f);
      } else byKey.set(f.key, f);
    }
    const unique = [...byKey.values()];
    const anchored = (/** @type {KeyedFinding} */ f) => (ctx.commitLines
      ? isChangedLine(ctx.commitLines.get(f.commit ?? '') ?? new Map(), f.path, f.side, f.line)
      : isChangedLine(ctx.changedLines, f.path, f.side, f.line));
    const published = unique.filter(anchored);
    const demoted = unique.filter((f) => !anchored(f));
    return { ok: true, language: r.language, groups: present.map((id) => seen.get(id)), published, demoted, duplicates, questions, suggestions };
  } catch (err) {
    if (err instanceof Invalid) return { ok: false, errors: [err.message] };
    throw err;
  }
}
