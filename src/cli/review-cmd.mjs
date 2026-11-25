import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { canonicalDocument, canonicalStringify } from '../core/canonical-json.mjs';
import { sha256Hex } from '../core/fingerprint.mjs';
import { formatDiagnostic } from '../core/violation.mjs';
import { GitError } from '../git/exec.mjs';
import { checkBudget, budgetConfig } from '../issues/budget.mjs';
import { contextEscapes, publishEscapes } from '../issues/escape.mjs';
import { GitHubError } from '../issues/github.mjs';
import { CANDIDATE_LABEL, LABEL, REVIEW_LABEL, TEST_LABEL, gateKey, parseKey, publish, reviewItems } from '../issues/publish.mjs';
import { StateIssue, advanceState } from '../issues/state.mjs';
import { evaluateCandidate, parseCandidate, replayVia } from '../review/candidate.mjs';
import { familyOf } from '../review/family.mjs';
import { inputId } from '../review/input-id.mjs';
import { DEFAULT_MAX_FINDINGS, MAX_QUESTIONS } from '../review/validate.mjs';
import { runGit } from '../git/exec.mjs';
import { PrepareError, reviewConfig } from '../review/prepare.mjs';
import { estimateCost, parseTarget, renderCandidateComment, renderOverflow, renderStepSummary } from '../review/render.mjs';
import { resolutionActions } from '../review/resolution.mjs';
import { RunError, readAnalysis, runReview, writeAnalysis } from '../review/run.mjs';
import { CommandError, apiGitOps, configuredBranch, github, openRepo, parse, printResult, publishSettings, readJson, stepSummary } from './publish-cmd.mjs';

/** @typedef {import('./publish-cmd.mjs').Io} Io */
/** @typedef {import('./publish-cmd.mjs').GitOps} GitOps */

export const CREDENTIAL_VARS = Object.freeze(['GITHUB_TOKEN', 'GH_TOKEN', 'ACTIONS_RUNTIME_TOKEN']);

/**
 * Env canary for the model step: the names of GitHub credentials present.
 * @param {Record<string, string | undefined>} env
 * @returns {string[]}
 */
export function credentialsInEnv(env) {
  return CREDENTIAL_VARS.filter((k) => env[k] !== undefined);
}

/**
 * @param {string} rel module path relative to this file
 * @returns {Promise<any>}
 */
async function load(rel) {
  try {
    return await import(new URL(rel, import.meta.url).href);
  } catch (e) {
    throw new CommandError(formatDiagnostic('S2-REVIEW', `cannot load ${rel.replace(/^\.\.\//, 'src/')}: ${e instanceof Error ? e.message.split('\n')[0] : 'error'}`, 'install a complete square² (re-run `square2 vendor`)'));
  }
}

/** @type {Required<import('./publish-cmd.mjs').ReviewImpl>} */
const DEFAULT_REVIEW = {
  async prepare(opts) {
    const mod = await load('../review/prepare.mjs');
    return mod.prepare(opts);
  },
  async validate(opts) {
    const v = await load('../review/validate.mjs');
    const cl = await load('../git/changed-lines.mjs');
    const context = /** @type {any} */ (opts.context);
    const commitLines = context?.commit_lines && typeof context.commit_lines === 'object'
      ? new Map(Object.entries(context.commit_lines).map(([sha, lines]) => [sha, cl.changedLinesFromJSON(/** @type {any} */ (lines))]))
      : undefined;
    return v.validateReview(opts.output, {
      groups: Array.isArray(context?.groups) ? context.groups : [],
      changedLines: cl.changedLinesFromJSON(context?.changed_lines ?? {}),
      commitLines,
      commits: Array.isArray(context?.call_commits) ? context.call_commits : undefined,
      maxFindings: typeof context?.caps?.max_findings === 'number' ? context.caps.max_findings : undefined,
    });
  },
};

/**
 * `--out` / `--context` name either a context directory or its context.json.
 * @param {string} p
 * @returns {{ dir: string, file: string }}
 */
export function contextPaths(p) {
  return p.endsWith('.json') ? { dir: dirname(p), file: p } : { dir: p, file: join(p, 'context.json') };
}

/**
 * Review issues with anchors: open ones (targets and the resolution pass)
 * and closed-as-completed mechanizable ones without a candidate yet.
 * @param {import('../issues/github.mjs').GitHub} gh
 */
export async function reviewTargets(gh) {
  /** @type {import('../review/resolution.mjs').OpenFinding[]} */
  const open = [];
  /** @type {import('../review/candidate.mjs').ConfirmedFinding[]} */
  const confirmed = [];
  /** @type {{ issue: number, reason: string }[]} mechanizable confirmed issues without a born_from: no candidate */
  const unborn = [];
  for (const issue of await gh.listIssues(LABEL)) {
    if (!issue.labels.includes(REVIEW_LABEL)) continue;
    const key = parseKey(issue.body);
    const t = parseTarget(issue.body);
    if (!key || !t) continue;
    const base = { number: issue.number, key, path: t.path, line: t.line, title: t.title, failure_case: t.failure_case, enclosing_symbol: t.enclosing_symbol };
    if (issue.state === 'open') open.push(base);
    else if (issue.state_reason === 'completed' && t.mechanizable === true && !issue.labels.includes(CANDIDATE_LABEL)) {
      if (typeof t.commit === 'string' && /^[0-9a-f]{7,64}$/.test(t.commit)) confirmed.push({ ...base, born_from: t.commit });
      else unborn.push({ issue: issue.number, reason: 'born_from unknown (blame failed)' });
    }
  }
  return { open: open.sort((a, b) => a.number - b.number), confirmed: confirmed.sort((a, b) => a.number - b.number), unborn: unborn.sort((a, b) => a.issue - b.issue) };
}

/**
 * Price table from config `review_price: {input, cached, output, currency}` (per million tokens).
 * @param {Record<string, unknown>} raw
 * @returns {{ input: number, cached: number, output: number, currency: string } | null}
 */
function priceTable(raw) {
  const p = /** @type {any} */ (raw.review_price);
  if (!p || typeof p !== 'object') return null;
  /** @param {unknown} x the YAML subset has no floats, so `0.5` arrives as text */
  const num = (x) => (typeof x === 'number' ? x : typeof x === 'string' && /^\d+(?:\.\d+)?$/.test(x.trim()) ? Number(x) : NaN);
  const [input, cached, output] = [num(p.input), num(p.cached), num(p.output)];
  if (![input, cached, output].every(Number.isFinite)) return null;
  return { input, cached, output, currency: typeof p.currency === 'string' ? p.currency : 'USD' };
}

/**
 * Family of a deployment: a configured reviewer with that model, else the name map.
 * @param {string} model
 * @param {{ family: string, model: string }[]} reviewers
 * @returns {string | null}
 */
export function modelFamily(model, reviewers) {
  return reviewers.find((r) => r.model === model)?.family ?? familyOf(model);
}

/**
 * The model a run may use: an override stays within the selected reviewer's
 * family unless `allowSameFamily` (an unknown family counts as a change).
 * @param {{ reviewer: { family: string, model: string }, reviewers?: { family: string, model: string }[] }} context
 * @param {string} model
 * @param {boolean} allowSameFamily
 * @returns {string | null} a refusal reason, or null
 */
export function modelProblem(context, model, allowSameFamily) {
  if (model === context.reviewer.model || allowSameFamily) return null;
  const fam = modelFamily(model, context.reviewers ?? [context.reviewer]);
  if (fam === context.reviewer.family) return null;
  return `model ${model} is ${fam ? `in family ${fam}` : 'of unknown family'}, not the selected reviewer family ${context.reviewer.family}`;
}

export const RUN_USAGE = `Usage: square2 review run [--context <dir>] [--out <dir>] [--model <deployment>] [--fallback-model <deployment>] [--allow-same-family]

The analysis step. Extracts the tree archive of the review context read-only
into a temporary directory and runs \`codex exec\` there (read-only sandbox,
--ignore-user-config, --ignore-rules, --ephemeral, a fresh CODEX_HOME)
against the Azure OpenAI Responses endpoint (SQ2_AZURE_OPENAI_ENDPOINT, key in
SQ2_AZURE_OPENAI_API_KEY). Retries once with the fallback model. Writes the
analysis artifact: result.json, resolutions.json, candidates.json, usage.json.
A heavy range (context with calls) runs one call per group in order, each
with its own fallback, and writes result.<call>.json per call instead of
result.json; usage is summed.
Refuses to run with GitHub credentials in the environment, and refuses a
model outside the selected reviewer's family unless --allow-same-family.

  --context <dir>          context directory from \`square2 review prepare\` (default square2-review)
  --out <dir>              analysis directory (default square2-analysis)
  --model <deployment>     default: SQ2_REVIEW_MODEL, else the reviewer in the context
  --fallback-model <name>  default: SQ2_REVIEW_FALLBACK_MODEL
  codex binary: SQUARE2_CODEX_BIN, else \`codex\` on PATH
`;

/**
 * @param {string} path
 * @param {unknown} doc
 */
function writeJson(path, doc) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, canonicalDocument(doc));
}

/**
 * The publish step's view of a run, re-derived from the prepare context and
 * the analysis artifact only. Of the analysis it trusts nothing but the
 * result JSON (per call), the model that answered (per call) and the token
 * counts; same_family and the family check come from the context, the
 * configured reviewers and the publish step's own `--allow-same-family`.
 * Each published finding's commit is `git blame` of its line (this step has
 * the checkout); when blame fails the finding has no born_from.
 * @param {{ context: any, analysis: import('../review/run.mjs').Analysis, validate: (o: Record<string, unknown>) => Promise<any>, repo: import('./load.mjs').Repo, allowSameFamily?: boolean, reviewers?: { family: string, model: string }[] }} a
 */
async function rederive(a) {
  const { context, analysis } = a;
  for (const k of ['range', 'policy_digest', 'reviewer', 'groups', 'changed_lines']) {
    if (!context || typeof context !== 'object' || context[k] === undefined) throw new CommandError(formatDiagnostic('S2-PUBLISH', `review context lacks ${k}`, 'pass the context directory written by `square2 review prepare`'));
  }
  const reviewers = [...(a.reviewers ?? []), ...(Array.isArray(context.reviewers) ? context.reviewers : [context.reviewer])];
  const allow = a.allowSameFamily === true;
  const calls = Array.isArray(context.calls) ? context.calls : [];
  /** @type {any} */
  let res;
  /** @type {string} */
  let id;
  /** @type {string | null} */
  let model;
  if (calls.length === 0) {
    model = analysis.usage.model_used;
    if (model === null || analysis.result === null) return { ok: false, errors: ['the analysis produced no result'] };
    const refusal = modelProblem({ ...context, reviewers }, model, allow);
    if (refusal) return { ok: false, errors: [refusal] };
    const family = modelFamily(model, reviewers) ?? context.reviewer.family;
    id = inputId({ ...context.range, policy_digest: context.policy_digest, reviewer_family: family, model });
    res = await a.validate({ repoRoot: a.repo.root, dir: a.repo.dir, config: a.repo.config, context, output: analysis.result });
    if (!res || res.ok !== true) return { ok: false, errors: Array.isArray(res?.errors) ? res.errors.map(String) : ['validation failed'] };
    for (const k of ['published', 'demoted', 'questions', 'suggestions']) if (!Array.isArray(res[k])) res[k] = [];
    res.notes = [];
  } else {
    const merged = await mergeCalls({ ...a, calls, reviewers, allowSameFamily: allow });
    if (!merged.ok) return merged;
    res = merged.res;
    id = merged.id;
    model = merged.model;
  }
  /** @type {{ call: string | null, model: string, family: string | null }[]} */
  const families = calls.length === 0
    ? [{ call: null, model: /** @type {string} */ (model), family: modelFamily(/** @type {string} */ (model), reviewers) }]
    : res.call_families;
  const authors = Array.isArray(context.author_families) ? context.author_families : [];
  // same family when ANY model that answered is outside the selected family or shares an author family
  const sameFamily = context.same_family === true || families.some((f) => f.family === null || f.family !== context.reviewer.family || authors.includes(f.family));
  const byNumber = new Map((Array.isArray(context.resolution_prompts) ? context.resolution_prompts : []).map((/** @type {any} */ rp) => [rp.issue.number, rp.issue]));
  const answers = analysis.resolutions.filter((r) => byNumber.has(r.issue)).map((r) => ({ issue: byNumber.get(r.issue), raw: r.answer }));
  const shas = Array.isArray(context.commits) ? context.commits.map((/** @type {any} */ c) => c.sha) : [];
  const resolutions = resolutionActions(answers, shas).filter((x) => x.action === 'close').map((x) => ({ key: x.issue.key, commit: /** @type {string} */ (x.sha), evidence: x.evidence }));
  /** @type {any[]} */
  const published = [];
  for (const f of res.published) {
    const rev = calls.length > 0 ? f.commit : context.range.to_sha;
    const born = f.side === 'LEFT' ? (calls.length > 0 ? f.commit ?? null : null) : await blameCommit(a.repo.root, rev, f.path, f.line);
    published.push({ ...f, commit: born ?? f.commit ?? context.range.to_sha, born_from: born });
  }
  res.published = published;
  return {
    ok: true,
    review: { ...res, input_id: id, model, range: context.range, branch: context.branch, same_family: sameFamily, call_families: families, language: res.language, usage: analysis.usage.usage },
    resolutions,
  };
}

/**
 * The commit that last changed `path:line` at `rev` (`git blame --porcelain`), or null.
 * @param {string} root
 * @param {string | undefined} rev
 * @param {string} path
 * @param {number} line
 * @returns {Promise<string | null>}
 */
export async function blameCommit(root, rev, path, line) {
  if (typeof rev !== 'string' || !/^[0-9a-f]{7,64}$/.test(rev) || !Number.isSafeInteger(line) || line < 1) return null;
  try {
    const r = await runGit(root, ['blame', '--porcelain', '-L', `${line},${line}`, rev, '--', path]);
    const m = r.code === 0 ? /^([0-9a-f]{40,64}) /.exec(r.stdout) : null;
    return m && !/^0+$/.test(m[1]) ? m[1] : null;
  } catch {
    return null;
  }
}

/**
 * Heavy range: validate each call's result against its own view (its group
 * shown, the others not; its own per-commit shown lines), then merge.
 * Findings off the shown lines of a file the call showed are demoted;
 * findings on a file the call did not show are unanchored notes for the
 * digest. Run caps: at most max_findings × 2 findings (most severe kept) and
 * MAX_QUESTIONS questions. The run's input_id is the hash of the sorted
 * per-call input_ids, each binding the range, policy digest, family, the
 * model that answered and the group.
 * @param {{ context: any, analysis: import('../review/run.mjs').Analysis, validate: (o: Record<string, unknown>) => Promise<any>, repo: import('./load.mjs').Repo, calls: any[], reviewers?: { family: string, model: string }[], allowSameFamily?: boolean }} a
 * @returns {Promise<{ ok: true, res: any, id: string, model: string } | { ok: false, errors: string[] }>}
 */
export async function mergeCalls(a) {
  const { context, analysis } = a;
  const reviewers = a.reviewers ?? (Array.isArray(context.reviewers) ? context.reviewers : [context.reviewer]);
  const answers = new Map(analysis.results.map((r) => [r.call, r.result]));
  const models = new Map((analysis.usage.calls ?? []).map((c) => [c.call, c.model_used]));
  const RANK = /** @type {Record<string, number>} */ ({ Blocker: 0, Major: 1, Minor: 2, Nit: 3 });
  /** @type {string[]} */
  const ids = [];
  /** @type {any[]} */
  const groups = [];
  /** @type {Map<string, any>} */
  const byKey = new Map();
  /** @type {any[]} */
  const demoted = [];
  /** @type {any[]} */
  const notes = [];
  /** @type {string[]} */
  const questions = [];
  /** @type {string[]} */
  const suggestions = [];
  let duplicates = 0;
  let language = null;
  /** @type {string | null} */
  let first = null;
  /** @type {{ call: string, model: string, family: string | null }[]} */
  const callFamilies = [];
  for (const call of a.calls) {
    const output = answers.get(call.id);
    const model = models.get(call.id);
    if (typeof output !== 'string' || typeof model !== 'string') return { ok: false, errors: [`call ${call.id} (group ${call.group}) produced no result`] };
    const refusal = modelProblem({ ...context, reviewers }, model, a.allowSameFamily === true);
    if (refusal) return { ok: false, errors: [`call ${call.id}: ${refusal}`] };
    first ??= model;
    callFamilies.push({ call: call.id, model, family: modelFamily(model, reviewers) });
    const family = modelFamily(model, reviewers) ?? context.reviewer.family;
    const base = inputId({ ...context.range, policy_digest: context.policy_digest, reviewer_family: family, model });
    ids.push(sha256Hex(canonicalStringify(['call', base, call.group])));
    const view = {
      ...context,
      groups: context.groups.map((/** @type {any} */ g) => ({ ...g, shown: g.id === call.group })),
      changed_lines: {},
      commit_lines: call.changed_lines ?? {},
      call_commits: Array.isArray(call.commits) ? call.commits : Object.keys(call.changed_lines ?? {}),
    };
    const r = await a.validate({ repoRoot: a.repo.root, dir: a.repo.dir, config: a.repo.config, context: view, output });
    if (!r || r.ok !== true) return { ok: false, errors: (Array.isArray(r?.errors) ? r.errors.map(String) : ['validation failed']).map((/** @type {string} */ e) => `call ${call.id} (group ${call.group}): ${e}`) };
    language ??= r.language;
    groups.push(...(Array.isArray(r.groups) ? r.groups.filter((/** @type {any} */ g) => g && g.id === call.group) : []));
    duplicates += Number(r.duplicates ?? 0);
    questions.push(...(Array.isArray(r.questions) ? r.questions : []));
    suggestions.push(...(Array.isArray(r.suggestions) ? r.suggestions : []));
    const shown = new Set(Array.isArray(call.shown_files) ? call.shown_files : []);
    for (const f of Array.isArray(r.demoted) ? r.demoted : []) (shown.has(f.path) ? demoted : notes).push(f);
    for (const f of Array.isArray(r.published) ? r.published : []) {
      const prev = byKey.get(f.key);
      if (!prev) byKey.set(f.key, f);
      else {
        duplicates++;
        if (RANK[f.severity] < RANK[prev.severity]) byKey.set(f.key, f);
      }
    }
  }
  const max = (typeof context?.caps?.max_findings === 'number' ? context.caps.max_findings : DEFAULT_MAX_FINDINGS) * 2;
  const ranked = [...byKey.values()].sort((x, y) => RANK[x.severity] - RANK[y.severity] || (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
  const id = sha256Hex(canonicalStringify(['calls', ...[...ids].sort()]));
  return {
    ok: true,
    id,
    model: /** @type {string} */ (first),
    res: { ok: true, language, groups, published: ranked.slice(0, max), capped: Math.max(0, ranked.length - max), demoted, duplicates, questions: questions.slice(0, MAX_QUESTIONS), suggestions, notes, calls: a.calls.map((c) => c.id), call_families: callFamilies },
  };
}

export const MAX_CANDIDATE_REPLAYS = 3;

/**
 * Candidates: only well-formed `pattern` rules for a confirmed issue the
 * context named, deduplicated by pattern and scope, at most
 * MAX_CANDIDATE_REPLAYS replayed (checkout with history). Every candidate
 * not posted is counted under its reason.
 * @param {{ context: any, analysis: import('../review/run.mjs').Analysis, repo: import('./load.mjs').Repo, replay?: import('../review/candidate.mjs').Replay }} a
 * @returns {Promise<{ posted: { key: string, rule_id: string, body: string, fires_born_from: boolean, fires_parent: boolean }[], dropped: Record<string, number> }>}
 */
export async function candidatesFrom(a) {
  const targets = new Map((Array.isArray(a.context.candidate_prompts) ? a.context.candidate_prompts : []).map((/** @type {any} */ cp) => [cp.issue.number, cp.issue]));
  const ids = a.repo.catalogue.rules.map((r) => r.id);
  const replay = a.replay ?? replayVia({ repoRoot: a.repo.root, dir: a.repo.dir, config: a.repo.config });
  /** @type {{ key: string, rule_id: string, body: string, fires_born_from: boolean, fires_parent: boolean }[]} */
  const posted = [];
  /** @type {Record<string, number>} */
  const dropped = {};
  const drop = (/** @type {string} */ reason) => { dropped[reason] = (dropped[reason] ?? 0) + 1; };
  for (const sk of Array.isArray(a.context.candidate_skipped) ? a.context.candidate_skipped : []) drop(String(sk?.reason ?? 'born_from unknown'));
  const seen = new Set();
  let replays = 0;
  for (const c of a.analysis.candidates) {
    const issue = targets.get(c.issue);
    if (!issue) {
      drop('not a prepared target');
      continue;
    }
    if (c.answer === null) {
      drop('no answer');
      continue;
    }
    if (typeof issue.born_from !== 'string' || issue.born_from === '') {
      drop('born_from unknown (blame failed)');
      continue;
    }
    const parsed = parseCandidate(c.answer, { bornFrom: issue.born_from, existingIds: ids });
    if (!parsed.ok) {
      drop('invalid candidate');
      continue;
    }
    if (parsed.candidate.rule.engine !== 'pattern') {
      drop('not a pattern rule');
      continue;
    }
    const opts = /** @type {any} */ (parsed.candidate.rule.options ?? {});
    const dedupe = canonicalStringify([opts.pattern ?? null, opts.flags ?? null, opts.require_absent ?? null, [...parsed.candidate.rule.scope].sort()]);
    if (seen.has(dedupe)) {
      drop('duplicate pattern and scope');
      continue;
    }
    seen.add(dedupe);
    if (replays >= MAX_CANDIDATE_REPLAYS) {
      drop('replay limit reached');
      continue;
    }
    replays++;
    const verdict = await evaluateCandidate(parsed.candidate, replay);
    if (!verdict.post || !verdict.report) {
      drop(verdict.reason.includes('S2-PATTERN-TIMEOUT') ? 'pattern timeout' : verdict.reason.startsWith('replay failed') ? 'replay failed' : verdict.reason);
      continue;
    }
    posted.push({ key: issue.key, rule_id: parsed.candidate.rule.id, body: renderCandidateComment({ candidate: parsed.candidate, report: verdict.report, issue: issue.number, language: a.context.language }), fires_born_from: true, fires_parent: false });
  }
  return { posted, dropped };
}

/**
 * The trailer keys escape records may show: the configured author, change-id and provenance trailers.
 * @param {Record<string, unknown>} raw
 * @returns {string[]}
 */
export function reviewTrailers(raw) {
  const c = reviewConfig(raw).config;
  return [...(c.author_trailers ?? []), ...(c.change_id_trailers ?? []), ...(c.provenance_trailers ?? [])];
}

/**
 * Escape records are experimental: only with `escapes.enabled: true`.
 * @param {Record<string, unknown>} raw
 * @returns {boolean}
 */
export function escapesEnabled(raw) {
  return reviewConfig(raw).config.escapes_enabled === true;
}

/**
 * The nonce of a test publication: --nonce, else the workflow run id, else the time.
 * @param {Record<string, any>} values
 * @param {Io} io
 * @returns {string}
 */
function testNonce(values, io) {
  return typeof values.nonce === 'string' && values.nonce !== '' ? values.nonce : io.env.GITHUB_RUN_ID ?? `${(io.now ?? new Date()).getTime()}`;
}

/**
 * Escapes of a range prepare skipped for the input budget: still published
 * (configured branch only, head still containing the range), with the
 * overflow note on the state issue. Null when not applicable.
 * @param {{ context: any, repo: any, io: Io, values: Record<string, any> }} a
 */
async function skippedEscapes(a) {
  const { context, repo, io, values } = a;
  const range = context.range;
  if (!range || typeof range.branch_or_pr !== 'string' || !range.branch_or_pr.startsWith('branch:') || context.explicit_range === true) return null;
  const escapes = contextEscapes(context, reviewTrailers(repo.config.raw));
  if (escapes.length === 0) return null;
  const gh = github(io, values);
  const settings = publishSettings(repo.config.raw);
  const wanted = await configuredBranch(gh, settings.branch);
  const branch = typeof context.branch === 'string' && context.branch !== '' ? context.branch : values.branch ?? wanted;
  if (branch !== wanted) return null;
  const git = io.gitOps ?? apiGitOps(gh);
  const toSha = String(range.to_sha ?? '').replace(/[^0-9a-f]/g, '');
  const head = await git.liveHead(repo.root, branch);
  if (head === null || !(await git.isAncestor(repo.root, toSha, head))) return null;
  const inputId = `skip-${toSha}`;
  const esc = await publishEscapes({ gh, escapes, inputId, cap: settings.cap, trailers: reviewTrailers(repo.config.raw), language: settings.language === 'zh' ? 'zh' : 'en' });
  if (esc.overflow.length > 0) await new StateIssue(gh).commentOnce(`<!-- square2:overflow:${inputId} -->`, renderOverflow({ inputId, overflow: esc.overflow, cap: settings.cap, remaining: Math.max(0, settings.cap - esc.escapesCounted), language: settings.language === 'zh' ? 'zh' : 'en' }));
  return esc;
}

/**
 * `square2 review prepare|run|validate|publish|guard-env`
 * @param {string[]} argv
 * @param {Io} io
 * @returns {Promise<0 | 1 | 2>}
 */
export async function reviewCommand(argv, io) {
  /** @param {string[]} lines */
  const out = (lines) => { for (const l of lines) io.stdout(l + '\n'); };
  /** @param {string[]} lines */
  const err = (lines) => { for (const l of lines) io.stderr(l + '\n'); };
  try {
    const { values, positionals } = parse(argv, {
      out: { type: 'string' },
      context: { type: 'string' },
      analysis: { type: 'string' },
      model: { type: 'string' },
      'fallback-model': { type: 'string' },
      'allow-same-family': { type: 'boolean' },
      test: { type: 'boolean' },
      pr: { type: 'string' },
      base: { type: 'string' },
      head: { type: 'string' },
      from: { type: 'string' },
      to: { type: 'string' },
      nonce: { type: 'string' },
    });
    const sub = positionals[1];
    if (sub === 'run' && values.help) {
      io.stdout(RUN_USAGE);
      return 0;
    }
    if (sub === 'guard-env' || sub === 'run') {
      const found = credentialsInEnv(io.env);
      if (found.length > 0) {
        out([formatDiagnostic('S2-REVIEW-CREDENTIALS', `the model step has GitHub credentials in its environment: ${found.join(', ')}`, 'remove them from this job (permissions: {}, no checkout, no env token)')]);
        return 1;
      }
      if (sub === 'guard-env') {
        out(['guard-env: no GitHub credentials in the environment']);
        return 0;
      }
      return await runCommand(values, io, out);
    }
    if (sub !== 'prepare' && sub !== 'validate' && sub !== 'publish') {
      throw new CommandError(formatDiagnostic('S2-USAGE', 'usage: square2 review prepare|run|validate|publish|guard-env', 'run `square2 --help`'));
    }
    const repo = await openRepo(values, io);
    const impl = { ...DEFAULT_REVIEW, ...(io.review ?? {}) };

    if (sub === 'prepare') {
      let lastReviewedSha = null;
      /** @type {Awaited<ReturnType<typeof reviewTargets>>} */
      let targets = { open: [], confirmed: [], unborn: [] };
      if (io.env.GITHUB_TOKEN) {
        const gh = github(io, values);
        lastReviewedSha = (await new StateIssue(gh).read()).last_reviewed_sha;
        targets = await reviewTargets(gh);
      } else if (values.to === undefined && values.pr === undefined) err(['note: GITHUB_TOKEN not set; no state issue read, the range starts 24 hours back']);
      else err(['note: GITHUB_TOKEN not set; no open issues read (no targets, no resolution pass, no rule candidates)']);
      /** @type {{ number: number, base: string, head: string } | undefined} */
      let pr;
      if (values.pr !== undefined) {
        if (!/^\d+$/.test(values.pr) || !values.base || !values.head) throw new CommandError(formatDiagnostic('S2-USAGE', '--pr needs a number plus --base <sha> and --head <sha>', 'pass the pull request number, its base and head commits'));
        pr = { number: Number(values.pr), base: values.base, head: values.head };
      }
      if (values.from !== undefined && values.to === undefined) throw new CommandError(formatDiagnostic('S2-USAGE', '--from needs --to', 'pass both ends of the range'));
      if (pr && (values.from !== undefined || values.to !== undefined)) throw new CommandError(formatDiagnostic('S2-USAGE', '--pr cannot be combined with --from/--to', 'review either a pull request or an explicit range'));
      const paths = contextPaths(resolve(io.cwd, values.out ?? 'square2-review'));
      const context = await impl.prepare({
        repoRoot: repo.root, dir: repo.dir, config: repo.config, branch: values.branch ?? io.env.GITHUB_REF_NAME, lastReviewedSha, env: io.env, now: io.now ?? new Date(),
        outDir: paths.dir, openIssues: targets.open, candidateTargets: targets.confirmed, pr, from: values.from, to: values.to,
      });
      if (context && typeof context === 'object' && context.skip !== true && targets.unborn.length > 0) context.candidate_skipped = targets.unborn;
      writeJson(paths.file, context);
      const empty = context && typeof context === 'object' && (context.skip === true || (context.range && context.range.from_sha === context.range.to_sha));
      out([empty ? 'review prepare: nothing new since the last review; no model call needed' : `review prepare: context written to ${paths.file}`]);
      return 0;
    }

    const paths = contextPaths(resolve(io.cwd, values.context ?? 'square2-review'));
    const context = readJson(paths.file, 'review context');
    if (context && typeof context === 'object' && context.skip === true) {
      // prepare decided there is nothing to review (empty range, or no group fits the budget): no model findings;
      // a budget skip still publishes the range's escapes
      const esc = sub === 'publish' && escapesEnabled(repo.config.raw) && context.skip_kind === 'budget' && io.env.GITHUB_TOKEN && values.test !== true ? await skippedEscapes({ context, repo, io, values }) : null;
      const reason = String(context.reason ?? 'nothing to review');
      const escText = esc && (esc.created.length > 0 || esc.credited.length > 0 || esc.overflow.length > 0)
        ? `escapes: ${esc.created.length} recorded, ${esc.credited.length} credited, ${esc.overflow.length} over the cap`
        : null;
      out([escText
        ? `review ${sub}: skipped by prepare (${reason}); no findings reviewed; ${escText}; state unchanged`
        : `review ${sub}: skipped by prepare (${reason}); nothing published, state unchanged`]);
      if (sub === 'publish' && context.skip_kind === 'budget' && repo.config.raw.skip_note === true && io.env.GITHUB_TOKEN) {
        const to = String(context.range?.to_sha ?? '');
        const scope = values.test === true ? `:test-${sha256Hex(`skip\0${testNonce(values, io)}`).slice(0, 16)}` : '';
        const marker = `<!-- square2:skip:${to.replace(/[^0-9a-f]/g, '')}${scope} -->`;
        await new StateIssue(github(io, values)).commentOnce(marker, `${marker}\nsquare² review skipped at \`${to.slice(0, 12).replace(/[^0-9a-f]/g, '')}\`: no group fits the input budget, even with a trimmed diff.\n`);
      }
      stepSummary(io, renderStepSummary({ status: 'skipped', reason: escText ? `${reason}; ${escText}` : reason }));
      return 0;
    }
    const analysis = readAnalysis(resolve(io.cwd, values.analysis ?? 'square2-analysis'), context);
    const configured = reviewConfig(repo.config.raw).config.reviewers;
    const derived = await rederive({ context, analysis, validate: impl.validate, repo, allowSameFamily: values['allow-same-family'] === true, reviewers: configured });

    if (sub === 'validate') {
      if (!derived.ok) {
        out(derived.errors.map((/** @type {string} */ e) => formatDiagnostic('S2-REVIEW-INVALID', e, 'nothing is published; fix the prompt or re-run the analysis')));
        stepSummary(io, renderStepSummary({ status: 'review-error', errors: derived.errors, usage: analysis.usage.usage }));
        return 1;
      }
      const review = /** @type {any} */ (derived.review);
      writeJson(resolve(io.cwd, values.out ?? join(paths.dir, 'review.json')), { ...review, resolutions: derived.resolutions });
      out([`review validate: ok, ${review.published.length} finding(s), demoted: ${review.demoted.length}${review.notes.length > 0 ? `, notes: ${review.notes.length}` : ''}`]);
      return 0;
    }

    if (!derived.ok) {
      out(derived.errors.map((/** @type {string} */ e) => formatDiagnostic('S2-REVIEW-INVALID', e, 'nothing is published; fix the prompt or re-run the analysis')));
      out(['review publish: the review did not validate (review-error); nothing published']);
      stepSummary(io, renderStepSummary({ status: 'review-error', errors: derived.errors, usage: analysis.usage.usage }));
      return 1;
    }
    const review = /** @type {any} */ (derived.review);
    const gh = github(io, values);
    const settings = publishSettings(repo.config.raw);
    const branch = typeof review.branch === 'string' && review.branch !== '' ? review.branch : values.branch ?? (await configuredBranch(gh, settings.branch));
    const prRun = typeof review.range.branch_or_pr === 'string' && review.range.branch_or_pr.startsWith('pr:');
    const testRun = values.test === true;
    if (!prRun && !testRun) {
      const wanted = await configuredBranch(gh, settings.branch);
      if (branch !== wanted) throw new CommandError(formatDiagnostic('S2-PUBLISH-BRANCH', `the review is of branch ${branch}, not the configured branch ${wanted}`, 'publish only reviews of the configured branch (or a pull request, or pass --test)'));
    }
    const toSha = String(review.range.to_sha);
    const state = new StateIssue(gh);
    const git = io.gitOps ?? apiGitOps(gh);
    // a test publication is scoped to its nonce: its own run id and issue keys, never the production state or escapes
    const nonce = testRun ? testNonce(values, io) : undefined;
    const runId = testRun ? sha256Hex(canonicalStringify({ kind: 'review-test', input_id: review.input_id, nonce })) : String(review.input_id);
    let published = false;
    if (!testRun && (await state.read()).published_input_ids.includes(review.input_id)) {
      out([`review publish: input ${review.input_id.slice(0, 12)} already published; nothing to do`]);
      // escapes are deduplicated by their per-fix markers only: an input id recorded by an earlier
      // run that did not publish them (a v0.1.0 test run, a crash) never suppresses them
      if (!prRun && escapesEnabled(repo.config.raw)) {
        const head = await git.liveHead(repo.root, branch);
        if (head !== null && (await git.isAncestor(repo.root, toSha, head))) {
          const trailers = reviewTrailers(repo.config.raw);
          const esc = await publishEscapes({ gh, escapes: contextEscapes(context, trailers), inputId: runId, cap: settings.cap, trailers, language: review.language === 'zh' ? 'zh' : 'en' });
          if (esc.overflow.length > 0) await state.commentOnce(`<!-- square2:overflow:${runId} -->`, renderOverflow({ inputId: runId, overflow: esc.overflow, cap: settings.cap, remaining: Math.max(0, settings.cap - esc.escapesCounted), language: settings.language }));
          if (esc && (esc.created.length > 0 || esc.credited.length > 0 || esc.overflow.length > 0)) out([`escapes: ${esc.created.length} recorded, ${esc.credited.length} credited, ${esc.overflow.length} over the cap`]);
        }
      }
    } else {
      const isPr = typeof review.range.branch_or_pr === 'string' && review.range.branch_or_pr.startsWith('pr:');
      /** @type {string | null} */
      let head;
      let current;
      if (isPr) {
        const n = Number(review.range.branch_or_pr.slice(3));
        head = git.pullHead ? await git.pullHead(repo.root, n) : await gh.pullHead(n);
        current = head === toSha;
      } else {
        head = await git.liveHead(repo.root, branch);
        current = head !== null && (await git.isAncestor(repo.root, toSha, head));
      }
      if (!current) {
        out([isPr
          ? `review publish: pull request ${review.range.branch_or_pr.slice(3)} moved to ${head ? head.slice(0, 12) : 'an unknown head'} since ${toSha.slice(0, 12)}; skipped, state not advanced`
          : `review publish: ${toSha.slice(0, 12)} is no longer an ancestor of ${branch} (${head ? head.slice(0, 12) : 'unknown head'}); skipped, state not advanced`]);
      } else {
        const trailers = reviewTrailers(repo.config.raw);
        // escape records are experimental and off by default: then nothing is listed, created or credited
        const esc = escapesEnabled(repo.config.raw)
          ? await publishEscapes({ gh, escapes: !isPr && !testRun ? contextEscapes(context, trailers) : [], inputId: runId, cap: settings.cap, trailers, language: review.language === 'zh' ? 'zh' : 'en' })
          : null;
        const cands = await candidatesFrom({ context, analysis, repo, replay: io.replay });
        const found = reviewItems(review);
        const items = testRun ? Object.assign(found.map((i) => ({ ...i, key: gateKey(i.key, nonce), labels: [...i.labels, TEST_LABEL] })), { rejected: found.rejected }) : found;
        const usage = review.usage && typeof review.usage === 'object' ? review.usage : null;
        const price = priceTable(repo.config.raw);
        const cost = usage && price ? { amount: estimateCost(usage, price), currency: price.currency } : null;
        const res = await publish({
          gh,
          state,
          run: { kind: 'review', inputId: runId, branch, sha: toSha, language: review.language === 'zh' ? 'zh' : 'en', test: testRun },
          items,
          cap: Math.max(0, settings.cap - (esc?.escapesCounted ?? 0)),
          configuredCap: settings.cap,
          overflowFirst: esc?.overflow ?? [],
          notify: settings.notify,
          resolved: derived.resolutions,
          retarget: (Array.isArray(context.open_issues) ? context.open_issues : []).filter((/** @type {any} */ o) => typeof o.renamed_from === 'string' && typeof o.path === 'string' && typeof o.key === 'string').map((/** @type {any} */ o) => ({ key: o.key, path: o.path })),
          candidates: cands.posted,
          extras: {
            notes: Array.isArray(review.notes) ? review.notes.map((/** @type {any} */ n) => ({ severity: n.severity, path: n.path, line: n.line, title: n.title })) : [],
            demoted: review.demoted.length,
            rejected: items.rejected ?? 0,
            candidatesDropped: cands.dropped,
            capped: Number(review.capped ?? 0),
            questions: review.questions,
            suggestions: review.suggestions,
            sameFamily: review.same_family === true,
            usage,
            cost,
            ...(esc ? { escapes: esc.unclassified.map((i) => ({ number: i.number, url: i.html_url, title: i.title })) } : {}),
          },
        });
        const explicit = context.explicit_range === true;
        const rewritten = context.history_rewritten === true;
        /** @param {string | null} last @returns {Promise<boolean>} may the state move from `last` to to_sha */
        const mayMove = async (last) => {
          if (isPr || explicit || testRun || last === null || last === toSha) return true;
          if (!rewritten) return git.isAncestor(repo.root, last, toSha);
          // even after a force-push, never move back: a state already past to_sha stays (a gone sha is no descendant)
          try {
            return !(await git.isAncestor(repo.root, toSha, last));
          } catch (e) {
            if (e instanceof GitHubError && e.status === 404) return true;
            throw e;
          }
        };
        let fresh = await state.reread();
        let forward = testRun || (await mayMove(fresh.last_reviewed_sha));
        // re-read right before writing; when another run moved the state meanwhile, decide again
        for (let i = 0; i < 3 && !testRun; i++) {
          const again = await state.reread();
          if (again.last_reviewed_sha === fresh.last_reviewed_sha) {
            fresh = again;
            break;
          }
          fresh = again;
          forward = await mayMove(fresh.last_reviewed_sha);
        }
        const move = !isPr && !explicit && !testRun && forward;
        if (testRun) err(['note: test publication; the review state is not written']);
        else await state.write(advanceState(fresh, { input_id: review.input_id, last_reviewed_sha: move ? toSha : undefined }));
        if (!forward) err([`note: state already at ${String(fresh.last_reviewed_sha).slice(0, 12)}, which is not an ancestor of ${toSha.slice(0, 12)}; last_reviewed_sha not moved back`]);
        if (rewritten && move) err([`note: history was rewritten; last_reviewed_sha set to ${toSha.slice(0, 12)}`]);
        if (explicit) err(['note: explicit --from/--to range; last_reviewed_sha not moved']);
        printResult(out, res);
        if (esc && (esc.created.length > 0 || esc.credited.length > 0 || esc.overflow.length > 0)) out([`escapes: ${esc.created.length} recorded, ${esc.credited.length} credited, ${esc.overflow.length} over the cap, ${esc.unclassified.length} awaiting classification`]);
        for (const [reason, n] of Object.entries(cands.dropped)) out([`candidates dropped (${reason}): ${n}`]);
        stepSummary(io, renderStepSummary({ status: 'ok', published: res.created, demoted: review.demoted.length, duplicates: Number(review.duplicates ?? 0), rejected: items.rejected ?? 0, usage, cost, sameFamily: review.same_family === true }));
        published = true;
      }
    }
    if (repo.config.raw.budget !== false) {
      try {
        const b = budgetConfig(repo.config.raw);
        const r = await checkBudget({ gh, state, now: io.now ?? new Date(), monthly: b.monthly, workflows: b.workflows, jobs: b.jobs });
        out([`budget: ${r.minutes} minutes month-to-date, threshold ${Math.round(r.threshold * 10) / 10}${r.warned ? ' (warning posted)' : ''}`]);
      } catch (e) {
        if (!(e instanceof GitHubError)) throw e;
        err([`note: budget check skipped: ${e.message}`]);
      }
    }
    if (!published) stepSummary(io, 'square² review publish: nothing published');
    return 0;
  } catch (e) {
    if (e instanceof CommandError) {
      out([e.diagnostic]);
      return e.code;
    }
    if (e instanceof RunError) {
      out([formatDiagnostic('S2-REVIEW-MODEL', e.message, e.instead)]);
      return 2;
    }
    if (e instanceof PrepareError) {
      out([formatDiagnostic('S2-REVIEW-PREPARE', e.message, 'fix the range or the review settings in .square2/config.yaml')]);
      return 2;
    }
    if (e instanceof GitError) {
      out([formatDiagnostic('S2-GIT', e.message.split('\n')[0], 'run inside the repository with the commits fetched (fetch-depth: 0)')]);
      return 2;
    }
    if (e instanceof GitHubError) {
      out([formatDiagnostic('S2-PUBLISH', e.message, 're-run the publish step; it is idempotent and the state was not advanced')]);
      return 2;
    }
    throw e;
  }
}

/**
 * A deployment from the environment (SQ2_REVIEW_MODEL, SQ2_REVIEW_FALLBACK_MODEL)
 * only when it belongs to the selected reviewer's family: when the author
 * trailers moved the selection to an alternate reviewer, a variable naming
 * the primary's deployment is ignored (with a note), never forced.
 * @param {any} context
 * @param {'SQ2_REVIEW_MODEL' | 'SQ2_REVIEW_FALLBACK_MODEL'} name
 * @param {Io} io
 * @returns {string | undefined}
 */
export function ownFamilyEnv(context, name, io) {
  const v = io.env[name];
  if (typeof v !== 'string' || v === '') return undefined;
  const family = context?.reviewer?.family;
  if (typeof family !== 'string' || modelFamily(v, context.reviewers ?? [context.reviewer]) === family) return v;
  io.stderr(`note: ${name}=${v} is not a ${family} deployment (the selected reviewer); ignored\n`);
  return undefined;
}

/**
 * `square2 review run`: the analysis step (no repository, no GitHub credentials).
 * @param {Record<string, string | boolean | undefined>} values
 * @param {Io} io
 * @param {(lines: string[]) => void} out
 * @returns {Promise<0 | 1 | 2>}
 */
async function runCommand(values, io, out) {
  const paths = contextPaths(resolve(io.cwd, typeof values.context === 'string' ? values.context : 'square2-review'));
  const outDir = resolve(io.cwd, typeof values.out === 'string' ? values.out : 'square2-analysis');
  const context = readJson(paths.file, 'review context');
  if (context?.skip === true || !context?.range || context.range.from_sha === context.range.to_sha) {
    out([context?.skip_kind === 'budget' ? `review run: skipped (${String(context.reason)}); no model call` : 'review run: nothing new to review; no model call']);
    return 0;
  }
  if (Array.isArray(context.groups) && context.groups.length > 0 && context.groups.every((/** @type {any} */ g) => g.shown === false)) {
    out(['review run: no group fits the input budget; no model call (raise max_input_tokens or narrow the range)']);
    return 0;
  }
  const endpoint = io.env.SQ2_AZURE_OPENAI_ENDPOINT;
  const key = io.env.SQ2_AZURE_OPENAI_API_KEY;
  if (!endpoint || !key) throw new CommandError(formatDiagnostic('S2-REVIEW-MODEL', 'SQ2_AZURE_OPENAI_ENDPOINT and SQ2_AZURE_OPENAI_API_KEY must be set', 'pass the endpoint variable and the key secret to this step only'));
  const envModel = ownFamilyEnv(context, 'SQ2_REVIEW_MODEL', io);
  const model = (typeof values.model === 'string' && values.model) || envModel || context.reviewer?.model;
  if (typeof model !== 'string' || model === '') throw new CommandError(formatDiagnostic('S2-REVIEW-MODEL', 'no model deployment', 'pass --model <deployment> or set SQ2_REVIEW_MODEL'));
  const fallback = (typeof values['fallback-model'] === 'string' && values['fallback-model']) || ownFamilyEnv(context, 'SQ2_REVIEW_FALLBACK_MODEL', io) || undefined;
  const allow = values['allow-same-family'] === true;
  for (const m of [model, fallback]) {
    const problem = m ? modelProblem(context, m, allow) : null;
    if (problem) throw new CommandError(formatDiagnostic('S2-REVIEW-FAMILY', problem, 'use a deployment of the selected reviewer family, or pass --allow-same-family to accept a same-family review'));
  }
  const res = await runReview({ contextDir: paths.dir, context, model, fallback, endpoint, key, bin: io.env.SQUARE2_CODEX_BIN || 'codex', env: io.env, allowSameFamily: allow });
  if (res.usage.model_used === null) {
    out([formatDiagnostic('S2-REVIEW-MODEL', `the model step failed (${res.usage.attempts.map((a) => `${a.model}: exit ${a.exit_code}`).join(', ')})`, 'check the deployment names and the endpoint; nothing is published')]);
    stepSummary(io, renderStepSummary({ status: 'review-error', errors: ['model step failed'] }));
    return 2;
  }
  writeAnalysis(outDir, res);
  out([`review run: ${res.usage.model_used} answered after ${res.usage.attempts.length} attempt(s); analysis written to ${outDir}`]);
  return 0;
}
