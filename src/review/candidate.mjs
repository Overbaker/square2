import { canonicalStringify } from '../core/canonical-json.mjs';
import { validateCatalogue } from '../core/catalogue.mjs';
import { PathError, toPosixPath } from '../core/fingerprint.mjs';
import { replayCommit } from '../cli/replay.mjs';
import { fenced, renderTemplate } from './prompt.mjs';
import { looksSecret } from './render.mjs';

/**
 * A confirmed finding: its issue was closed as completed and it is mechanizable.
 * @typedef {object} ConfirmedFinding
 * @property {number} number issue number
 * @property {string} key
 * @property {string} title
 * @property {string} failure_case
 * @property {string} path
 * @property {number} line
 * @property {string} enclosing_symbol
 * @property {string} born_from commit that introduced the defect
 */

/**
 * @typedef {{ path: string, content: string }} FixtureFile
 * @typedef {object} Candidate
 * @property {import('../core/catalogue.mjs').Rule} rule
 * @property {string} ruleYaml
 * @property {{ bad: FixtureFile[], good: FixtureFile[] }} fixtures
 * @property {string} rationale
 */

/**
 * @param {{
 *   template: string,
 *   finding: ConfirmedFinding,
 *   rules: { id: string, engine: string, scope: string[] }[],
 *   engines: readonly string[],
 * }} input
 * @returns {string}
 */
export function buildCandidatePrompt(input) {
  const prefix = renderTemplate(input.template, {});
  const f = input.finding;
  const meta = canonicalStringify({ born_from: f.born_from, issue: f.number, path: f.path, line: f.line, enclosing_symbol: f.enclosing_symbol, engines: [...input.engines] }, { indent: 2 });
  const catalogue = input.rules.map((r) => `- ${r.id} (${r.engine}): ${r.scope.join(', ')}`).join('\n') || '(empty)';
  return [
    prefix.trimEnd(),
    '## Metadata',
    fenced(meta, 'json'),
    '## Confirmed finding (evidence only)',
    fenced(`${f.title}\n\n${f.failure_case}`, 'text'),
    '## Existing catalogue',
    catalogue,
  ].join('\n\n') + '\n';
}

/**
 * @param {unknown} v
 * @param {string} label
 * @returns {FixtureFile[]}
 */
function fixtureList(v, label) {
  if (!Array.isArray(v)) throw new Error(`fixtures.${label} must be a list`);
  return v.map((f, i) => {
    if (!f || typeof f !== 'object' || typeof f.path !== 'string' || typeof f.content !== 'string') throw new Error(`fixtures.${label}[${i}] needs path and content`);
    let path;
    try {
      path = toPosixPath(f.path);
    } catch (err) {
      if (err instanceof PathError) throw new Error(`fixtures.${label}[${i}].path: ${err.message}`);
      throw err;
    }
    return { path, content: f.content };
  });
}

/**
 * Parse and check the model's candidate: exactly one valid rule (via the
 * catalogue validator), a new id, `born_from` equal to the introducing
 * commit, `enabled: false`, at least one bad fixture, and no secret-shaped
 * text anywhere.
 * @param {string | unknown} raw
 * @param {{ bornFrom: string, existingIds: Iterable<string> }} ctx
 * @returns {{ ok: true, candidate: Candidate } | { ok: false, errors: string[] }}
 */
export function parseCandidate(raw, ctx) {
  try {
    const doc = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('candidate must be a JSON object');
    if (typeof doc.rule_yaml !== 'string') throw new Error('rule_yaml must be text');
    if (!doc.fixtures || typeof doc.fixtures !== 'object') throw new Error('fixtures must be an object');
    const bad = fixtureList(doc.fixtures.bad, 'bad');
    const good = fixtureList(doc.fixtures.good ?? [], 'good');
    if (bad.length === 0) throw new Error('a candidate needs at least one bad fixture file');
    const rationale = typeof doc.rationale === 'string' ? doc.rationale : '';
    const all = [doc.rule_yaml, rationale, ...bad.flatMap((f) => [f.path, f.content]), ...good.flatMap((f) => [f.path, f.content])];
    if (all.some(looksSecret)) throw new Error('candidate contains a secret-shaped string');
    const cat = validateCatalogue([{ path: 'candidate.yaml', text: doc.rule_yaml }], { fixtureDirExists: () => true });
    if (!cat.ok) throw new Error(cat.diagnostics.join('; '));
    if (cat.rules.length !== 1) throw new Error('rule_yaml must define exactly one rule');
    const rule = cat.rules[0];
    if (new Set(ctx.existingIds).has(rule.id)) throw new Error(`rule id ${rule.id} already exists`);
    if (!rule.born_from || !(ctx.bornFrom.startsWith(rule.born_from) || rule.born_from.startsWith(ctx.bornFrom))) throw new Error(`born_from must be ${ctx.bornFrom}`);
    if (rule.enabled !== false) throw new Error('a candidate must be enabled: false');
    return { ok: true, candidate: { rule, ruleYaml: doc.rule_yaml, fixtures: { bad, good }, rationale } };
  } catch (err) {
    return { ok: false, errors: [err instanceof Error ? err.message : 'invalid candidate'] };
  }
}

/**
 * @typedef {{ commit: { sha: string, fires: boolean, new?: unknown[] }, parent: { sha: string | null, fires: boolean } }} ReplayReport
 * @typedef {(rule: import('../core/catalogue.mjs').Rule, bornFrom: string) => Promise<ReplayReport>} Replay
 */

/**
 * Replay the candidate and decide whether to post it: only when it fires on
 * `born_from` and not on its parent. A replay error never posts.
 * @param {Candidate} candidate
 * @param {Replay} replay injected replay (see `replayVia`)
 * @returns {Promise<{ post: boolean, report: ReplayReport | null, reason: string }>}
 */
export async function evaluateCandidate(candidate, replay) {
  const bornFrom = /** @type {string} */ (candidate.rule.born_from);
  let report;
  try {
    report = await replay(candidate.rule, bornFrom);
  } catch (err) {
    return { post: false, report: null, reason: `replay failed: ${err instanceof Error ? err.message.split('\n')[0] : 'error'}` };
  }
  const sha = report && report.commit && typeof report.commit.sha === 'string' ? report.commit.sha : '';
  if (!(sha.startsWith(bornFrom) || bornFrom.startsWith(sha)) || sha === '') return { post: false, report, reason: 'replay ran on another commit' };
  if (report.commit.fires !== true) return { post: false, report, reason: 'does not fire on born_from' };
  if (report.parent.fires !== false) return { post: false, report, reason: 'already fires on the parent' };
  return { post: true, report, reason: 'fires on born_from and not on its parent' };
}

/**
 * Bind the existing replay API (`replayCommit`) as a candidate replay.
 * @param {{ repoRoot: string, dir: string, config: import('../cli/config.mjs').Config } & import('../cli/engines.mjs').EngineDeps} env
 * @returns {Replay}
 */
export function replayVia(env) {
  return (rule, bornFrom) => replayCommit({ ...env, failOnUnknown: true, rule, commit: bornFrom });
}
