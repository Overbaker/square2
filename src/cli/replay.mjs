import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { baselineFromViolations, diffBaseline } from '../core/baseline.mjs';
import { compareViolations, formatViolationLine } from '../core/violation.mjs';
import { NO_HOOKS, git, gitEnv, runGit } from '../git/exec.mjs';
import { runRules } from './engines.mjs';
import { globalExcludes } from './load.mjs';

const HOOKS_OFF = [`core.hooksPath=${NO_HOOKS}`];

export class ReplayError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'ReplayError';
  }
}

/**
 * @typedef {{ path: string, line: number | null, subject: string, message: string, fingerprint: string, diagnostic: string }} Firing
 */

/**
 * Mirror one `node_modules` directory of the main checkout into the worktree:
 * relative symlinks (workspace links such as `@scope/pkg -> ../../packages/pkg`)
 * are recreated as-is so they resolve inside the worktree; everything else
 * (installed packages, `.pnpm`, `.bin`) becomes an absolute symlink to the
 * main checkout. Scope directories (`@scope`) are mirrored one level down.
 * @param {string} from main checkout `node_modules`
 * @param {string} to worktree `node_modules`
 * @param {number} [depth]
 */
function mirrorDir(from, to, depth = 0) {
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(from)) {
    const src = join(from, name);
    const dst = join(to, name);
    if (existsSync(dst) || isLinkAt(dst)) continue;
    const st = lstatSync(src);
    if (st.isSymbolicLink()) {
      const target = readlinkSync(src);
      symlinkSync(target, dst);
    } else if (st.isDirectory() && name.startsWith('@') && depth === 0) {
      mirrorDir(src, dst, depth + 1);
    } else {
      symlinkSync(src, dst);
    }
  }
}

/**
 * @param {string} p
 * @returns {boolean}
 */
function isLinkAt(p) {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Make the main checkout's dependency resolution visible in a replay
 * worktree: for every workspace package directory of the worktree (the root
 * and each directory with a tracked package.json) whose counterpart in the
 * main checkout has a `node_modules`, mirror it. The links are untracked and
 * removed by the next `git clean -fdx`; file listing already excludes
 * `node_modules`. The shared `info/exclude` of the caller's repository is not
 * modified.
 * @param {string} mainRoot
 * @param {string} tree
 * @returns {Promise<number>} number of node_modules directories mirrored
 */
export async function mirrorNodeModules(mainRoot, tree) {
  const listed = await git(tree, ['ls-files', '-z']);
  const dirs = new Set(['.']);
  for (const p of listed.split('\0')) {
    if (p === 'package.json' || p.endsWith('/package.json')) {
      if (p.split('/').includes('node_modules')) continue;
      dirs.add(p === 'package.json' ? '.' : dirname(p));
    }
  }
  let n = 0;
  for (const d of [...dirs].sort()) {
    const from = join(mainRoot, d, 'node_modules');
    const to = join(tree, d, 'node_modules');
    if (!existsSync(from) || !existsSync(join(tree, d)) || existsSync(to)) continue;
    mirrorDir(from, to);
    n++;
  }
  return n;
}

/**
 * @param {string} repoRoot
 * @param {string} rev
 * @returns {Promise<string | null>}
 */
async function resolveCommit(repoRoot, rev) {
  if (rev.startsWith('-')) return null;
  const res = await runGit(repoRoot, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]);
  return res.code === 0 ? res.stdout.trim() : null;
}

/**
 * Evaluate one rule on historical trees through a single temporary worktree.
 * The caller's working tree and index are never touched; the worktree is
 * removed in `finally`.
 * @template T
 * @param {{
 *   repoRoot: string,
 *   dir: string,
 *   rule: import('../core/catalogue.mjs').Rule,
 *   config: import('./config.mjs').Config,
 * } & import('./engines.mjs').EngineDeps} input
 * @param {string} first commit to check out first
 * @param {(evaluate: (sha: string | null) => Promise<import('../core/violation.mjs').Violation[]>) => Promise<T>} body
 * @returns {Promise<T>}
 */
async function withWorktree(input, first, body) {
  const tmp = mkdtempSync(join(tmpdir(), 'square2-replay-'));
  const tree = join(tmp, 'tree');
  let added = false;
  let cleaned = false;
  const cleanupSync = () => {
    if (cleaned) return;
    cleaned = true;
    if (added) spawnSync('git', ['-C', input.repoRoot, 'worktree', 'remove', '--force', tree], { env: gitEnv(), stdio: 'ignore' });
    rmSync(tmp, { recursive: true, force: true });
    spawnSync('git', ['-C', input.repoRoot, 'worktree', 'prune'], { env: gitEnv(), stdio: 'ignore' });
  };
  /** @param {NodeJS.Signals} signal */
  const onSignal = (signal) => {
    cleanupSync();
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    process.kill(process.pid, signal);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    await git(input.repoRoot, ['worktree', 'add', '--detach', '--quiet', tree, first], { config: HOOKS_OFF });
    added = true;
    const rule = { ...input.rule, enabled: true };
    const excludes = globalExcludes({ root: input.repoRoot, dir: input.dir, config: input.config });
    /** @param {string | null} sha */
    const evaluate = async (sha) => {
      if (sha === null) return [];
      await git(tree, ['checkout', '--quiet', '--detach', '--force', sha], { config: HOOKS_OFF });
      await git(tree, ['clean', '-fdxq'], { config: HOOKS_OFF });
      await mirrorNodeModules(input.repoRoot, tree);
      const res = await runRules({ ...input, root: tree, mode: 'repo', rules: [rule], excludes });
      if (res.errors.length > 0) throw new ReplayError(res.errors.join('\n'));
      return res.violations;
    };
    return await body(evaluate);
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    if (!cleaned) {
      cleaned = true;
      if (added) await runGit(input.repoRoot, ['worktree', 'remove', '--force', tree]).catch(() => undefined);
      rmSync(tmp, { recursive: true, force: true });
      await runGit(input.repoRoot, ['worktree', 'prune']).catch(() => undefined);
    }
  }
}

/**
 * Violations on `current` that are not on `previous` (multiset by fingerprint).
 * @param {import('../core/violation.mjs').Violation[]} current
 * @param {import('../core/violation.mjs').Violation[]} previous
 * @param {string} instead
 * @returns {Firing[]}
 */
function newFirings(current, previous, instead) {
  return diffBaseline(baselineFromViolations(previous), current)
    .fresh.sort(compareViolations)
    .map((v) => ({ path: v.path, line: v.line, subject: v.subject, message: v.message, fingerprint: v.fingerprint, diagnostic: formatViolationLine(v, instead) }));
}

/**
 * `replay --commit`: the rule fires on `<sha>` when it reports violations
 * there that `<sha>^` does not have (multiset by fingerprint). `parent.fires`
 * tells whether the parent's violation set already contained any of those
 * fingerprints (a rule born from a defect has `fires: true`, `parent.fires: false`).
 * @param {{
 *   repoRoot: string,
 *   dir: string,
 *   rule: import('../core/catalogue.mjs').Rule,
 *   config: import('./config.mjs').Config,
 *   commit: string,
 * } & import('./engines.mjs').EngineDeps} input
 */
export async function replayCommit(input) {
  const sha = await resolveCommit(input.repoRoot, input.commit);
  if (sha === null) throw new ReplayError(`${input.commit} is not a commit`);
  const parent = await resolveCommit(input.repoRoot, `${sha}^`);
  return withWorktree(input, sha, async (evaluate) => {
    const vp = await evaluate(parent);
    const vc = await evaluate(sha);
    const onCommit = newFirings(vc, vp, input.rule.instead);
    const parentPrints = new Set(vp.map((v) => v.fingerprint));
    const already = onCommit.filter((f) => parentPrints.has(f.fingerprint)).map((f) => f.fingerprint);
    return {
      schema_version: 1,
      rule_id: input.rule.id,
      commit: { sha, fires: onCommit.length > 0, new: onCommit },
      parent: { sha: parent, fires: already.length > 0, fingerprints: [...new Set(already)].sort() },
    };
  });
}

/**
 * `replay --since <days>`: every first-parent commit of HEAD in the window on
 * which the rule fires newly, one entry per new violation, with `grade: null`.
 * @param {{
 *   repoRoot: string,
 *   dir: string,
 *   rule: import('../core/catalogue.mjs').Rule,
 *   config: import('./config.mjs').Config,
 *   sinceDays: number,
 *   now?: Date,
 * } & import('./engines.mjs').EngineDeps} input
 */
export async function replaySince(input) {
  const head = await resolveCommit(input.repoRoot, 'HEAD');
  if (head === null) throw new ReplayError('HEAD is not a commit');
  const now = input.now ?? new Date();
  const since = new Date(now.getTime() - input.sinceDays * 86_400_000).toISOString();
  const listed = await git(input.repoRoot, ['rev-list', '--first-parent', '--reverse', `--since=${since}`, head]);
  const commits = listed.split('\n').filter((l) => l !== '');
  /** @type {Array<Firing & { sha: string, committed_at: string, summary: string, grade: null }>} */
  const firings = [];
  if (commits.length > 0) {
    const before = await resolveCommit(input.repoRoot, `${commits[0]}^`);
    await withWorktree(input, commits[0], async (evaluate) => {
      let previous = await evaluate(before);
      for (const sha of commits) {
        const current = await evaluate(sha);
        const fresh = newFirings(current, previous, input.rule.instead);
        if (fresh.length > 0) {
          const meta = (await git(input.repoRoot, ['log', '-1', '--format=%cI%x00%s', sha])).replace(/\n$/, '');
          const [committedAt, summary] = meta.split('\0');
          for (const f of fresh) firings.push({ sha, committed_at: committedAt ?? '', summary: summary ?? '', ...f, grade: null });
        }
        previous = current;
      }
    });
  }
  return {
    schema_version: 1,
    rule_id: input.rule.id,
    head,
    since_days: input.sinceDays,
    commits_scanned: commits.length,
    firings,
  };
}
