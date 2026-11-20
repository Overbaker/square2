import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRepo } from '../cli/load.mjs';
import { archiveTree } from '../git/archive.mjs';
import { changedLines, changedLinesFromJSON, changedLinesToJSON, shownLines } from '../git/changed-lines.mjs';
import { globMatch } from '../core/exceptions.mjs';
import { blobSizes, commitPatch, commitPaths, commitsInRange, diffSections, isAncestor, nameStatus, rangeDiff, resolveCommit } from '../git/diff.mjs';
import { git, runGit } from '../git/exec.mjs';
import { parseTrailers } from '../git/trailers.mjs';
import { VERSION } from '../cli/version.mjs';
import { authorFamilies, selectReviewer } from './family.mjs';
import { groupCommits } from './group.mjs';
import { inputId } from './input-id.mjs';
import { policyDigest } from './policy-digest.mjs';
import { buildCallPrompt, buildPrompt, promptPrefix } from './prompt.mjs';
import { buildResolutionPrompts } from './resolution.mjs';
import { buildCandidatePrompt } from './candidate.mjs';
import { DEFAULT_MAX_FINDINGS } from './validate.mjs';

export const DEFAULT_MAX_INPUT_TOKENS = 200_000;
export const DEFAULT_MAX_CALLS_PER_RUN = 6;

/**
 * One model call of a heavy range (see buildCallPrompt).
 * @typedef {object} CallPlan
 * @property {string} id `call-<n>`
 * @property {string} group the group it reviews
 * @property {string[]} commits the group's commits, in order
 * @property {string} suffix its prompt suffix
 * @property {Record<string, Record<string, import('../git/changed-lines.mjs').SideRanges>>} commit_lines per commit sha: exactly the added/removed lines it shows
 * @property {string[]} shown_files files whose diff it shows (both sides of a rename)
 * @property {import('./prompt.mjs').FileStat[]} listed files listed without (or with only part of) their diff
 * @property {boolean} trimmed
 * @property {boolean} partial a single file shown hunk by hunk because no whole file fit
 * @property {number} tokens estimated tokens of prefix + suffix
 */

/** Never reviewed: generated, minified and lock files. */
export const DEFAULT_REVIEW_EXCLUDES = Object.freeze([
  '**/*.min.*', '**/*.map', 'docs/**/*.html',
  '**/package-lock.json', '**/pnpm-lock.yaml', '**/yarn.lock', '**/bun.lockb', '**/npm-shrinkwrap.json',
  '**/uv.lock', '**/poetry.lock', '**/Pipfile.lock', '**/Cargo.lock', '**/go.sum', '**/composer.lock', '**/Gemfile.lock',
]);
/** Rule candidates may only use the built-in, non-executing pattern engine. */
export const CANDIDATE_ENGINES = Object.freeze(['pattern']);
export const STATE_FALLBACK_HOURS = 24;

/**
 * @typedef {object} ReviewConfig
 * @property {import('./family.mjs').Reviewer[]} reviewers primary first
 * @property {string[]} risk_paths
 * @property {number} max_findings
 * @property {number} max_input_tokens estimated input token budget (characters / 4)
 * @property {number} max_calls_per_run model calls per heavy range (one per group)
 * @property {string[]} review_exclude globs left out of the review (plus the defaults and `generated`)
 * @property {'en' | 'zh' | 'auto'} language
 * @property {string[]} triage_patterns
 */

/**
 * Review settings from `.square2/config.yaml` (keys `reviewers` or
 * `reviewer: family/provider/model`, `risk_paths`, `max_findings`,
 * `max_input_tokens`, `review_exclude`, `generated`, `language`, `triage_patterns`).
 * @param {Record<string, unknown>} raw
 * @returns {{ config: ReviewConfig, errors: string[] }}
 */
export function reviewConfig(raw) {
  /** @type {string[]} */
  const errors = [];
  /** @param {unknown} v */
  const strings = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string' && x.trim() !== '');
  /** @type {import('./family.mjs').Reviewer[]} */
  let reviewers = [];
  if (Array.isArray(raw.reviewers)) {
    for (const [i, r] of raw.reviewers.entries()) {
      if (r && typeof r === 'object' && typeof r.family === 'string' && typeof r.model === 'string') reviewers.push({ family: r.family, provider: typeof r.provider === 'string' ? r.provider : undefined, model: r.model });
      else errors.push(`reviewers[${i}] needs family and model`);
    }
  } else if (typeof raw.reviewer === 'string') {
    const parts = raw.reviewer.split('/');
    if (parts.length === 3 && parts.every((p) => p !== '')) reviewers = [{ family: parts[0], provider: parts[1], model: parts[2] }];
    else errors.push('reviewer must be family/provider/model');
  }
  if (reviewers.length === 0 && errors.length === 0) errors.push('no reviewer configured (reviewers or reviewer)');
  /** @param {string} key @param {number} def */
  const posInt = (key, def) => {
    const v = raw[key];
    if (v === undefined || v === null) return def;
    if (typeof v === 'number' && Number.isInteger(v) && v > 0) return v;
    errors.push(`${key} must be a positive integer`);
    return def;
  };
  const language = raw.language === undefined || raw.language === null ? 'auto' : raw.language;
  if (language !== 'en' && language !== 'zh' && language !== 'auto') errors.push('language must be en, zh or auto');
  for (const key of ['risk_paths', 'triage_patterns', 'review_exclude', 'generated']) {
    if (raw[key] !== undefined && raw[key] !== null && !strings(raw[key])) errors.push(`${key} must be a list of strings`);
  }
  return {
    config: {
      reviewers,
      risk_paths: strings(raw.risk_paths) ? /** @type {string[]} */ (raw.risk_paths) : [],
      max_findings: posInt('max_findings', DEFAULT_MAX_FINDINGS),
      max_input_tokens: posInt('max_input_tokens', DEFAULT_MAX_INPUT_TOKENS),
      max_calls_per_run: posInt('max_calls_per_run', DEFAULT_MAX_CALLS_PER_RUN),
      review_exclude: [...(strings(raw.generated) ? /** @type {string[]} */ (raw.generated) : []), ...(strings(raw.review_exclude) ? /** @type {string[]} */ (raw.review_exclude) : [])],
      language: /** @type {'en' | 'zh' | 'auto'} */ (language === 'en' || language === 'zh' ? language : 'auto'),
      triage_patterns: strings(raw.triage_patterns) ? /** @type {string[]} */ (raw.triage_patterns) : [],
    },
    errors,
  };
}

/**
 * The review policy from square²'s own prompt and schema files plus the
 * repository's review context and enforced rules.
 * @param {{ toolRoot: string, square2Dir: string, rules: { id: string, instead: string, enabled: boolean }[], triagePatterns: string[] }} input
 * @returns {import('./policy-digest.mjs').Policy}
 */
export function loadPolicy(input) {
  /** @param {string} p */
  const read = (p) => readFileSync(p, 'utf8');
  /** @param {string} p */
  const optional = (p) => {
    try {
      return read(p);
    } catch {
      return '';
    }
  };
  return {
    template: read(join(input.toolRoot, 'prompts', 'review.staged.md')),
    schema: read(join(input.toolRoot, 'schemas', 'review.v1.json')),
    reviewContext: optional(join(input.square2Dir, 'review-context.md')),
    enforcedRules: input.rules.filter((r) => r.enabled).map((r) => ({ id: r.id, instead: r.instead })),
    triagePatterns: input.triagePatterns,
    version: VERSION,
    extraPrompts: {
      resolution: read(join(input.toolRoot, 'prompts', 'review.resolution.md')),
      candidate: read(join(input.toolRoot, 'prompts', 'rule.candidate.md')),
    },
  };
}

/** A prepare input that cannot be used (bad range, config); the CLI maps it to exit 2. */
export class PrepareError extends Error {}

/**
 * `from_sha` for a branch review: the state's last reviewed sha when it is
 * still an ancestor of `to`; after a force-push, its merge base with `to`;
 * without state, the newest first-parent commit older than 24 hours (null
 * when the whole history is younger).
 * @param {string} dir
 * @param {string} to
 * @param {{ last_reviewed_sha?: string | null } | null} state
 * @param {Date} now
 * @returns {Promise<string | null>}
 */
export async function rangeStart(dir, to, state, now) {
  const last = state && typeof state.last_reviewed_sha === 'string' ? await resolveCommit(dir, state.last_reviewed_sha) : null;
  if (last) {
    if (await isAncestor(dir, last, to)) return last;
    const mb = await runGit(dir, ['merge-base', last, to]);
    if (mb.code === 0 && mb.stdout.trim() !== '') return mb.stdout.trim();
  }
  const before = new Date(now.getTime() - STATE_FALLBACK_HOURS * 3_600_000).toISOString();
  const out = (await git(dir, ['rev-list', '-1', '--first-parent', `--before=${before}`, to])).trim();
  return out === '' ? null : out;
}

/**
 * True when the state names a last reviewed commit that is gone or no
 * longer an ancestor of `to` (a force-push rewrote the history).
 * @param {string} dir
 * @param {string} to
 * @param {{ last_reviewed_sha?: string | null } | null} state
 * @returns {Promise<boolean>}
 */
export async function historyRewritten(dir, to, state) {
  if (!state || typeof state.last_reviewed_sha !== 'string' || state.last_reviewed_sha === '') return false;
  const last = await resolveCommit(dir, state.last_reviewed_sha);
  return last === null || !(await isAncestor(dir, last, to));
}

/**
 * @param {string[]} texts
 * @returns {'en' | 'zh'}
 */
export function detectLanguage(texts) {
  const all = texts.join('\n');
  const cjk = (all.match(/[㐀-鿿豈-﫿]/g) ?? []).length;
  const latin = (all.match(/[A-Za-z]/g) ?? []).length;
  return cjk > 0 && cjk * 3 >= latin ? 'zh' : 'en';
}

/**
 * @typedef {object} PreparedReview
 * @property {false} skip
 * @property {Record<string, any>} context everything the analysis and publish steps need (written to context.json)
 * @property {{ prefix: string, suffix: string }} prompt the single-call prompt (calls mode: unused)
 * @property {CallPlan[]} calls heavy-range calls (empty in single-call mode)
 */

/**
 * Prepare one review run. Returns `{ skip: true }` (no model call) when the
 * range is empty.
 * @param {{
 *   repoRoot: string,
 *   branch?: string,
 *   pr?: { number: number, base: string, head: string },
 *   explicit?: { from: string | null, to: string },
 *   state: { last_reviewed_sha?: string | null } | null,
 *   now: Date,
 *   config: ReviewConfig,
 *   policy: import('./policy-digest.mjs').Policy,
 *   outDir?: string,
 *   treeDir?: string,
 *   openIssues?: import('./resolution.mjs').OpenFinding[],
 *   candidateTargets?: import('./candidate.mjs').ConfirmedFinding[],
 *   rules?: { id: string, engine: string, scope: string[] }[],
 * }} input
 * @returns {Promise<PreparedReview | { skip: true, reason: string, range: { from_sha: string | null, to_sha: string, branch_or_pr: string }, skip_kind?: 'budget', not_reviewed?: { group: string, reason: string }[] }>}
 */
export async function prepareReview(input) {
  const dir = input.repoRoot;
  if (!input.pr && !input.branch && !input.explicit) throw new PrepareError('prepare needs a branch, a pull request or --from/--to');
  const toRev = input.pr ? input.pr.head : input.explicit ? input.explicit.to : /** @type {string} */ (input.branch);
  const to = await resolveCommit(dir, toRev);
  if (!to) throw new PrepareError(`${toRev} is not a commit in this repository`);
  /** @type {string | null} */
  let from;
  if (input.explicit) {
    from = input.explicit.from === null ? null : await resolveCommit(dir, input.explicit.from);
    if (input.explicit.from !== null && !from) throw new PrepareError(`${input.explicit.from} is not a commit in this repository`);
    if (from && !(await isAncestor(dir, from, to))) throw new PrepareError(`--from ${input.explicit.from} is not an ancestor of --to ${input.explicit.to}`);
  } else if (input.pr) {
    const base = await resolveCommit(dir, input.pr.base);
    if (!base) throw new PrepareError(`${input.pr.base} is not a commit in this repository`);
    from = (await git(dir, ['merge-base', base, to])).trim();
  } else {
    from = await rangeStart(dir, to, input.state, input.now);
  }
  const rewritten = !input.explicit && !input.pr && (await historyRewritten(dir, to, input.state));
  const branch_or_pr = input.pr ? `pr:${input.pr.number}` : `branch:${input.branch ?? 'HEAD'}`;
  const range = { from_sha: from, to_sha: to, branch_or_pr };
  if (from === to) return { skip: true, reason: 'no new commits since the last review', range };
  const commits = await commitsInRange(dir, from, to);
  if (commits.length === 0) return { skip: true, reason: 'no commits in the range', range };

  const firstParent = await commitsInRange(dir, from, to, { firstParent: true });
  /** @type {Map<string, string[]>} */
  const merges = new Map();
  for (const c of firstParent) {
    if (c.parents.length < 2) continue;
    const members = await commitsInRange(dir, c.parents[0], c.sha);
    merges.set(c.sha, members.map((m) => m.sha).filter((s) => s !== c.sha));
  }
  const withPaths = [];
  for (const c of commits) withPaths.push({ ...c, paths: await commitPaths(dir, c) });
  const groups = groupCommits({ commits: withPaths, merges, riskPaths: input.config.risk_paths });

  const excludes = [...DEFAULT_REVIEW_EXCLUDES, ...input.config.review_exclude];
  const status = await nameStatus(dir, from, to);
  const excludedPaths = [...status.keys()].filter((p) => excludes.some((g) => globMatch(g, p))).sort();
  const sizes = await blobSizes(dir, to, excludedPaths.filter((p) => status.get(p)?.status !== 'D'));
  const excluded = excludedPaths.map((p) => ({ path: p, bytes: sizes.get(p) ?? 0 }));
  const family = authorFamilies(commits);
  const { reviewer, sameFamily } = selectReviewer(input.config.reviewers, family);
  const policy_digest = policyDigest(input.policy);
  const input_id = inputId({ ...range, policy_digest, reviewer_family: reviewer.family, model: reviewer.model });
  const language = input.config.language === 'auto' ? detectLanguage(commits.map((c) => c.message)) : input.config.language;
  const treeDir = '.';
  /** @type {Map<string, string>} */
  const renamedTo = new Map([...status].filter(([, v]) => v.old !== null).map(([p, v]) => [/** @type {string} */ (v.old), p]));
  const openIssues = (input.openIssues ?? [])
    .map((o) => (renamedTo.has(o.path) ? { ...o, path: /** @type {string} */ (renamedTo.get(o.path)), renamed_from: o.path } : o))
    .filter((o) => status.has(o.path) && !excludes.some((g) => globMatch(g, o.path)))
    .sort((a, b) => a.number - b.number);

  const shaOf = new Map(commits.map((c) => [c.sha, c]));
  const fullDiff = await rangeDiff(dir, from, to, { unified: 3, exclude: excludes });
  const promptFor = (/** @type {string} */ diff, /** @type {'range' | 'groups'} */ mode, /** @type {{ group: string, reason: string }[]} */ omitted, /** @type {Set<string>} */ shown) =>
    buildPrompt({ policy: input.policy, range, treeDir, groups: groups.map((g) => ({ ...g, shown: shown.has(g.id) })), commits, diff, diffMode: mode, notReviewed: omitted, openIssues });
  const allIds = new Set(groups.map((g) => g.id));
  let diffMode = /** @type {'range' | 'calls'} */ ('range');
  /** @type {{ group: string, reason: string }[]} */
  let notReviewed = [];
  let shownIds = allIds;
  let prompt = promptFor(fullDiff, 'range', [], allIds);
  /** @type {(string | Record<string, import('../git/changed-lines.mjs').SideRanges>)[]} */
  let zeroDiffs = [await rangeDiff(dir, from, to, { unified: 0, exclude: excludes })];
  /** @type {CallPlan[]} */
  const calls = [];
  /** @type {Map<string, import('./prompt.mjs').FileStat[]>} */
  const planStats = new Map();
  if (estimateTokens(prompt.prefix + prompt.suffix) > input.config.max_input_tokens) {
    diffMode = 'calls';
    const planned = await planCalls({ dir, groups, shaOf, excludes, config: input.config, stats: planStats, render: (focus, diff, listed, omitted) =>
      buildCallPrompt({ policy: input.policy, range, treeDir, groups, commits, stats: planStats, focus, diff, listed, notReviewed: omitted, openIssues }).suffix, prefixTokens: estimateTokens(promptPrefix(input.policy)) });
    if (planned.calls.length === 0) {
      return { skip: true, reason: 'no group fits the input budget, even with a trimmed diff (raise max_input_tokens or narrow the range)', range, skip_kind: 'budget', not_reviewed: planned.notReviewed };
    }
    calls.push(...planned.calls);
    notReviewed = planned.notReviewed;
    shownIds = new Set(calls.map((c) => c.group));
    zeroDiffs = [];
    for (const c of calls) for (const lines of Object.values(c.commit_lines)) zeroDiffs.push(lines);
  }
  /** @type {import('../git/changed-lines.mjs').ChangedLines} */
  const lines = new Map();
  for (const z of zeroDiffs) {
    for (const [p, r] of typeof z === 'string' ? changedLines(z) : changedLinesFromJSON(z)) {
      const prev = lines.get(p) ?? { LEFT: [], RIGHT: [] };
      lines.set(p, { LEFT: [...prev.LEFT, ...r.LEFT], RIGHT: [...prev.RIGHT, ...r.RIGHT] });
    }
  }
  const tokens = diffMode === 'calls'
    ? { prefix: estimateTokens(prompt.prefix), suffix: null, total: calls.reduce((n, c) => n + c.tokens, 0), budget: input.config.max_input_tokens, calls: calls.map((c) => ({ id: c.id, tokens: c.tokens })) }
    : { prefix: estimateTokens(prompt.prefix), suffix: estimateTokens(prompt.suffix), total: estimateTokens(prompt.prefix + prompt.suffix), budget: input.config.max_input_tokens };
  const resolutionPrompts = input.policy.extraPrompts?.resolution
    ? buildResolutionPrompts({ template: input.policy.extraPrompts.resolution, openIssues, changedFiles: openIssues.map((o) => o.path), fileDiffs: splitDiffByFile(fullDiff), range, commits: commits.map((c) => c.sha), treeDir })
    : [];
  const candidatePrompts = input.policy.extraPrompts?.candidate
    ? (input.candidateTargets ?? []).map((t) => ({ issue: t, prompt: buildCandidatePrompt({ template: /** @type {string} */ (input.policy.extraPrompts?.candidate), finding: t, rules: input.rules ?? [], engines: CANDIDATE_ENGINES }) }))
    : [];

  /** @type {Record<string, any>} */
  const context = {
    schema_version: 2,
    range,
    explicit_range: Boolean(input.explicit),
    history_rewritten: rewritten,
    input_id,
    policy_digest,
    reviewer,
    same_family: sameFamily,
    author_families: family,
    language,
    groups: groups.map((g) => ({ ...g, shown: shownIds.has(g.id) })),
    commits: withPaths.map((c) => ({ sha: c.sha, parents: c.parents, subject: c.message.split('\n')[0], message: c.message, trailers: parseTrailers(c.message), paths: c.paths })),
    reviewers: input.config.reviewers,
    diff_mode: diffMode,
    not_reviewed: notReviewed,
    excluded,
    excluded_bytes: excluded.reduce((n, e) => n + e.bytes, 0),
    estimated_tokens: tokens,
    changed_lines: changedLinesToJSON(lines),
    open_issues: openIssues,
    caps: { max_findings: input.config.max_findings, max_input_tokens: input.config.max_input_tokens, max_calls_per_run: input.config.max_calls_per_run },
    calls: calls.map((c) => ({ id: c.id, group: c.group, commits: c.commits, trimmed: c.trimmed, partial: c.partial, tokens: c.tokens, shown_files: c.shown_files, listed: c.listed, changed_lines: c.commit_lines, prompt_suffix_file: null })),
    tree_dir: treeDir,
    archive: null,
    archive_file: null,
    prompt_prefix_file: null,
    prompt_suffix_file: null,
    resolution_prompts: [],
    candidate_prompts: [],
  };
  if (input.outDir) {
    const outDir = input.outDir;
    mkdirSync(outDir, { recursive: true });
    const archive = await archiveTree(dir, to, join(outDir, 'tree.tar'));
    context.archive = { sha256: archive.sha256, bytes: archive.bytes };
    context.archive_file = 'tree.tar';
    writeFileSync(join(outDir, 'prompt.prefix.md'), prompt.prefix);
    context.prompt_prefix_file = 'prompt.prefix.md';
    if (diffMode === 'calls') {
      context.calls = context.calls.map((/** @type {any} */ c, /** @type {number} */ i) => {
        const file = `prompt.${c.id}.suffix.md`;
        writeFileSync(join(outDir, file), calls[i].suffix);
        return { ...c, prompt_suffix_file: file };
      });
    } else {
      writeFileSync(join(outDir, 'prompt.suffix.md'), prompt.suffix);
      context.prompt_suffix_file = 'prompt.suffix.md';
    }
    context.resolution_prompts = resolutionPrompts.map((rp) => {
      const file = `resolution-${rp.issue.number}.md`;
      writeFileSync(join(outDir, file), rp.prompt);
      return { issue: rp.issue, file };
    });
    context.candidate_prompts = candidatePrompts.map((cp) => {
      const file = `candidate-${cp.issue.number}.md`;
      writeFileSync(join(outDir, file), cp.prompt);
      return { issue: cp.issue, file };
    });
  }
  return { skip: false, context, prompt, calls };
}

/**
 * Rough token estimate: characters / 4.
 * @param {string} text
 * @returns {number}
 */
export function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

/**
 * @typedef {object} GroupPatch
 * @property {import('./group.mjs').Group} group
 * @property {{ sha: string, subject: string, sections: import('../git/diff.mjs').DiffSection[] }[]} commits the members' own patches, in order
 * @property {{ paths: string[], size: number, risk: boolean }[]} units files tied together by renames (shown or listed as one)
 * @property {number} lines added plus removed lines
 */

/**
 * The patches of one group: each member commit's own `git show` (merges:
 * `--remerge-diff`), split into file sections and grouped into units so the
 * two sides of a rename are never separated.
 * @param {string} dir
 * @param {import('./group.mjs').Group} g
 * @param {Map<string, import('../git/diff.mjs').Commit>} shaOf
 * @param {string[]} excludes
 * @param {string[]} riskPaths
 * @returns {Promise<GroupPatch>}
 */
export async function groupPatches(dir, g, shaOf, excludes, riskPaths) {
  /** @type {GroupPatch['commits']} */
  const commits = [];
  /** @type {Map<string, string>} */
  const parent = new Map();
  /** @param {string} p @returns {string} */
  const find = (p) => {
    let r = p;
    while (parent.get(r) !== r) r = /** @type {string} */ (parent.get(r));
    parent.set(p, r);
    return r;
  };
  /** @param {string} p */
  const touch = (p) => { if (!parent.has(p)) parent.set(p, p); };
  let lines = 0;
  for (const sha of g.commits) {
    const c = shaOf.get(sha);
    if (!c) continue;
    const sections = diffSections(await commitPatch(dir, c, { unified: 3, exclude: excludes }));
    for (const s of sections) {
      touch(s.path);
      if (s.old !== null) {
        touch(s.old);
        const [a, b] = [find(s.path), find(s.old)];
        if (a !== b) parent.set(a, b);
      }
      for (const l of s.text.split('\n')) if (/^[+-](?![+-]{2} )/.test(l)) lines++;
    }
    if (sections.length > 0) commits.push({ sha, subject: c.message.split('\n')[0], sections });
  }
  /** @type {Map<string, { paths: string[], size: number, risk: boolean }>} */
  const units = new Map();
  for (const p of [...parent.keys()].sort()) {
    const root = find(p);
    const u = units.get(root) ?? { paths: [], size: 0, risk: false };
    u.paths.push(p);
    u.risk ||= riskPaths.some((r) => globMatch(r, p));
    units.set(root, u);
  }
  const unitOf = (/** @type {string} */ p) => /** @type {{ size: number }} */ (units.get(find(p)));
  for (const c of commits) for (const s of c.sections) unitOf(s.path).size += s.text.length;
  return { group: g, commits, units: [...units.values()], lines };
}

/**
 * Per-path added/removed counts over a group's patches.
 * @param {GroupPatch} gp
 * @returns {import('./prompt.mjs').FileStat[]}
 */
function patchStats(gp) {
  /** @type {Map<string, import('./prompt.mjs').FileStat>} */
  const out = new Map();
  for (const c of gp.commits) {
    for (const s of c.sections) {
      const st = out.get(s.path) ?? { path: s.path, added: 0, removed: 0 };
      let inHunk = false;
      for (const l of s.text.split('\n')) {
        if (l.startsWith('@@')) inHunk = true;
        else if (inHunk && l.startsWith('+')) st.added++;
        else if (inHunk && l.startsWith('-')) st.removed++;
      }
      out.set(s.path, st);
    }
  }
  return [...out.values()].sort((a, b) => (a.path < b.path ? -1 : 1));
}

/**
 * The diff text a call shows: per commit with something shown, a
 * `### commit <sha> <subject>` heading and its shown sections; plus the
 * per-commit anchoring of exactly those lines.
 * @param {GroupPatch} gp
 * @param {(s: import('../git/diff.mjs').DiffSection) => string | null} pick the text to show of a section, or null
 * @returns {{ diff: string, lines: Record<string, Record<string, import('../git/changed-lines.mjs').SideRanges>> }}
 */
function renderPatches(gp, pick) {
  /** @type {string[]} */
  const parts = [];
  /** @type {Record<string, Record<string, import('../git/changed-lines.mjs').SideRanges>>} */
  const lines = {};
  for (const c of gp.commits) {
    const shown = c.sections.map(pick).filter((t) => t !== null);
    if (shown.length === 0) continue;
    const text = shown.join('');
    parts.push(`### commit ${c.sha} ${c.subject.replace(/[\r\n]+/g, ' ')}\n${text}`);
    const sl = shownLines(text);
    if (sl.size > 0) lines[c.sha] = changedLinesToJSON(sl);
  }
  return { diff: parts.join(''), lines };
}

/**
 * The order a trimmed call tries to show files in: risk_paths units largest
 * first, then the other units largest first (a unit is the files a rename
 * ties together, shown or listed as one).
 * @template {{ paths: string[], size: number, risk: boolean }} U
 * @param {U[]} units
 * @returns {U[]}
 */
export function trimOrder(units) {
  return [...units].sort((a, b) => Number(b.risk) - Number(a.risk) || b.size - a.size || (a.paths[0] < b.paths[0] ? -1 : a.paths[0] > b.paths[0] ? 1 : 0));
}

/**
 * Hunks of a section: the header, then one entry per `@@` hunk.
 * @param {string} text
 * @returns {{ header: string, hunks: string[] }}
 */
function hunksOf(text) {
  const [header, ...hunks] = text.split(/^(?=@@ )/m);
  return { header, hunks };
}

/**
 * Plan the calls of a heavy range: groups in risk order, at most
 * `max_calls_per_run`; per call the group's full patches when they fit,
 * else trimmed (risk files largest first, then the others largest first,
 * renames kept whole), and when no whole file fits, the first file hunk by
 * hunk (never an empty diff). A call still over the budget leaves its group
 * not reviewed and the plan is redone, so the next group takes the slot
 * and every call's not_reviewed metadata is exact.
 * @param {{
 *   dir: string,
 *   groups: import('./group.mjs').Group[],
 *   shaOf: Map<string, import('../git/diff.mjs').Commit>,
 *   excludes: string[],
 *   config: ReviewConfig,
 *   stats: Map<string, import('./prompt.mjs').FileStat[]>,
 *   prefixTokens: number,
 *   render: (focus: string, diff: string, listed: import('./prompt.mjs').FileStat[], notReviewed: { group: string, reason: string }[]) => string,
 * }} o
 * @returns {Promise<{ calls: CallPlan[], notReviewed: { group: string, reason: string }[] }>}
 */
export async function planCalls(o) {
  /** @type {GroupPatch[]} */
  const parts = [];
  for (const g of o.groups) {
    const gp = await groupPatches(o.dir, g, o.shaOf, o.excludes, o.config.risk_paths);
    parts.push(gp);
    o.stats.set(g.id, patchStats(gp));
  }
  parts.sort((a, b) => Number(b.group.risk) - Number(a.group.risk) || b.lines - a.lines || (a.group.id < b.group.id ? -1 : 1));
  const budget = o.config.max_input_tokens;
  const fits = (/** @type {string} */ suffix) => o.prefixTokens + estimateTokens(suffix) <= budget;
  /** @type {Map<string, string>} */
  const dropped = new Map();
  for (;;) {
    /** @type {{ group: string, reason: string }[]} */
    const notReviewed = [];
    /** @type {GroupPatch[]} */
    const chosen = [];
    for (const gp of parts) {
      const id = gp.group.id;
      if (gp.commits.length === 0) notReviewed.push({ group: id, reason: 'no reviewable changes (excluded paths only)' });
      else if (dropped.has(id)) notReviewed.push({ group: id, reason: /** @type {string} */ (dropped.get(id)) });
      else if (chosen.length >= o.config.max_calls_per_run) notReviewed.push({ group: id, reason: 'left out: the run reached its call limit' });
      else chosen.push(gp);
    }
    notReviewed.sort((a, b) => (a.group < b.group ? -1 : 1));
    /** @type {CallPlan[]} */
    const calls = [];
    let redo = false;
    for (const gp of chosen) {
      const id = gp.group.id;
      const all = o.stats.get(id) ?? [];
      const suffixFor = (/** @type {{ diff: string }} */ r, /** @type {import('./prompt.mjs').FileStat[]} */ listed) => o.render(id, r.diff, listed, notReviewed);
      const base = { id: `call-${calls.length + 1}`, group: id, commits: gp.group.commits };
      const full = renderPatches(gp, (s) => s.text);
      let suffix = suffixFor(full, []);
      /** @type {CallPlan} */
      let call;
      if (fits(suffix)) {
        call = { ...base, suffix, commit_lines: full.lines, shown_files: all.map((f) => f.path), listed: [], trimmed: false, partial: false, tokens: 0 };
      } else {
        const order = trimOrder(gp.units);
        /** @type {Set<string>} */
        const shown = new Set();
        const listedFor = (/** @type {Set<string>} */ s) => all.filter((f) => !s.has(f.path));
        for (const u of order) {
          const trial = new Set([...shown, ...u.paths]);
          if (fits(suffixFor(renderPatches(gp, (s) => (trial.has(s.path) ? s.text : null)), listedFor(trial)))) for (const p of u.paths) shown.add(p);
        }
        let partial = false;
        /** @type {ReturnType<typeof renderPatches>} */
        let r;
        /** @type {import('./prompt.mjs').FileStat[]} */
        let listed;
        if (shown.size > 0) {
          r = renderPatches(gp, (s) => (shown.has(s.path) ? s.text : null));
          listed = listedFor(shown);
        } else {
          partial = true;
          const unit = new Set(order[0].paths);
          listed = all.map((f) => (unit.has(f.path) ? { ...f, partial: true } : f));
          const secs = gp.commits.flatMap((c) => c.sections.filter((s) => unit.has(s.path)));
          /** @type {Map<import('../git/diff.mjs').DiffSection, number>} hunks shown per section */
          const take = new Map();
          const pick = (/** @type {import('../git/diff.mjs').DiffSection} */ s) => {
            const n = take.get(s);
            if (n === undefined) return null;
            const h = hunksOf(s.text);
            return h.header + h.hunks.slice(0, n).join('');
          };
          /** @type {[import('../git/diff.mjs').DiffSection, number][]} */
          const steps = secs.flatMap((s) => {
            const n = hunksOf(s.text).hunks.length;
            return n === 0 ? [[s, 0]] : Array.from({ length: n }, (_, k) => /** @type {[import('../git/diff.mjs').DiffSection, number]} */ ([s, k + 1]));
          });
          for (const [i, [s, k]] of steps.entries()) {
            const prev = take.get(s);
            take.set(s, k);
            if (i > 0 && !fits(suffixFor(renderPatches(gp, pick), listed))) {
              if (prev === undefined) take.delete(s);
              else take.set(s, prev);
              break;
            }
          }
          r = renderPatches(gp, pick);
          for (const p of unit) shown.add(p);
        }
        suffix = suffixFor(r, listed);
        call = { ...base, suffix, commit_lines: r.lines, shown_files: [...shown].sort(), listed, trimmed: true, partial, tokens: 0 };
      }
      call.tokens = o.prefixTokens + estimateTokens(call.suffix);
      if (call.tokens > budget) {
        dropped.set(id, 'left out: over the input budget even with a trimmed diff');
        redo = true;
        break;
      }
      calls.push(call);
    }
    if (!redo) return { calls, notReviewed };
  }
}

/**
 * Split a unified diff into per-file sections keyed by the new path (old
 * path for deletions).
 * @param {string} diff
 * @returns {Map<string, string>}
 */
export function splitDiffByFile(diff) {
  /** @type {Map<string, string>} */
  const out = new Map();
  for (const section of diff.split(/^(?=diff --git )/m)) {
    if (!section.startsWith('diff --git ')) continue;
    const paths = [...changedLines(section).keys()];
    if (paths.length > 0) out.set(paths[0], section);
  }
  return out;
}

/**
 * CLI entry point (`square2 review prepare`): load the review config, the
 * catalogue and the policy, then prepare into `outDir` (the context
 * directory: tree archive, prompt prefix/suffix, resolution prompts; the CLI
 * writes context.json next to them). An empty range has
 * `from_sha === to_sha` (or `skip: true`) and needs no model call. Without
 * `outDir`, artifacts go to `$RUNNER_TEMP/square2-review` or the OS temp
 * directory — never into the repository.
 * @param {{
 *   repoRoot: string,
 *   dir: string,
 *   config: import('../cli/config.mjs').Config,
 *   branch?: string,
 *   lastReviewedSha?: string | null,
 *   env?: Record<string, string | undefined>,
 *   now?: Date,
 *   outDir?: string,
 *   openIssues?: import('./resolution.mjs').OpenFinding[],
 *   candidateTargets?: import('./candidate.mjs').ConfirmedFinding[],
 *   pr?: { number: number, base: string, head: string },
 *   from?: string | null,
 *   to?: string,
 * }} opts
 * @returns {Promise<Record<string, any>>}
 */
export async function prepare(opts) {
  const { config, errors } = reviewConfig(opts.config.raw);
  if (errors.length > 0) throw new PrepareError(`review config: ${errors.join('; ')}`);
  config.review_exclude = [...config.review_exclude, ...opts.config.generated];
  const repo = loadRepo(opts.repoRoot, { dir: opts.dir, provenance: false });
  if (!repo.catalogue.ok) throw new PrepareError(`catalogue: ${repo.catalogue.diagnostics.join('; ')}`);
  const toolRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const policy = loadPolicy({ toolRoot, square2Dir: opts.dir, rules: repo.catalogue.rules, triagePatterns: config.triage_patterns });
  const branch = opts.branch ?? (typeof opts.config.raw.branch === 'string' ? opts.config.raw.branch : 'HEAD');
  const env = opts.env ?? process.env;
  const outDir = opts.outDir ?? join(env.RUNNER_TEMP ?? tmpdir(), 'square2-review');
  const res = await prepareReview({
    repoRoot: opts.repoRoot,
    branch,
    pr: opts.pr,
    explicit: opts.to ? { from: opts.from ?? null, to: opts.to } : undefined,
    state: opts.lastReviewedSha ? { last_reviewed_sha: opts.lastReviewedSha } : null,
    now: opts.now ?? new Date(),
    config,
    policy,
    outDir,
    openIssues: opts.openIssues,
    candidateTargets: opts.candidateTargets,
    rules: repo.catalogue.rules.map((r) => ({ id: r.id, engine: r.engine, scope: r.scope })),
  });
  if (res.skip) return { schema_version: 2, skip: true, reason: res.reason, range: res.range, branch, skip_kind: 'skip_kind' in res ? res.skip_kind : 'empty', not_reviewed: 'not_reviewed' in res ? res.not_reviewed : [] };
  return { ...res.context, branch };
}
