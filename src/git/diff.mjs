import { git, runGit } from './exec.mjs';
import { unquoteGitPath } from './changed-lines.mjs';

/** Config that a repository or user could set to change diff output. */
const DIFF_CONFIG = ['-c', 'core.quotePath=false', '-c', 'diff.noprefix=false', '-c', 'diff.mnemonicPrefix=false', '-c', 'diff.external=', '-c', 'color.diff=false'];
/** Flags every diff passes, whatever the repository configures. */
export const DIFF_FLAGS = Object.freeze(['--no-ext-diff', '--no-textconv', '--no-color', '--src-prefix=a/', '--dst-prefix=b/']);

/**
 * Pathspecs: `--` then literal paths, then `:(exclude,glob)` for excludes.
 * @param {{ paths?: string[], exclude?: string[] }} opts
 * @returns {string[]}
 */
function pathspecs(opts) {
  const include = (opts.paths ?? []).map((p) => `:(literal)${p}`);
  const exclude = (opts.exclude ?? []).map((g) => `:(exclude,glob)${g}`);
  if (include.length === 0 && exclude.length > 0) include.push(':(glob)**');
  return ['--', ...include, ...exclude];
}

/**
 * @typedef {object} Commit
 * @property {string} sha
 * @property {string[]} parents
 * @property {string} author
 * @property {string} date ISO committer date
 * @property {string} message full commit message
 */

/**
 * `git diff` between two commits (the range diff: an add-then-revert inside
 * the range cancels out). `from === null` diffs against the empty tree.
 * `paths` restricts it to those files; `exclude` globs drop files.
 * @param {string} dir
 * @param {string | null} from
 * @param {string} to
 * @param {{ unified?: number, paths?: string[], exclude?: string[] }} [opts]
 * @returns {Promise<string>}
 */
export async function rangeDiff(dir, from, to, opts = {}) {
  const base = from ?? (await emptyTree(dir));
  const unified = opts.unified ?? 3;
  const extra = unified === 0 ? ['--inter-hunk-context=0'] : [];
  return git(dir, [...DIFF_CONFIG, 'diff', ...DIFF_FLAGS, `--unified=${unified}`, ...extra, '--find-renames', base, to, ...pathspecs(opts)]);
}

/**
 * Per-path change status between two commits, rename-aware: new path to
 * `{status, old}` (old path for renames and copies).
 * @param {string} dir
 * @param {string | null} from
 * @param {string} to
 * @returns {Promise<Map<string, { status: string, old: string | null }>>}
 */
export async function nameStatus(dir, from, to) {
  const base = from ?? (await emptyTree(dir));
  const out = await git(dir, [...DIFF_CONFIG, 'diff', '--name-status', '-z', '--find-renames', base, to, '--']);
  const parts = out.split('\0').filter((x) => x !== '');
  /** @type {Map<string, { status: string, old: string | null }>} */
  const map = new Map();
  for (let i = 0; i < parts.length;) {
    const st = parts[i];
    if (st.startsWith('R') || st.startsWith('C')) {
      map.set(parts[i + 2], { status: st[0], old: parts[i + 1] });
      i += 3;
    } else {
      map.set(parts[i + 1], { status: st[0], old: null });
      i += 2;
    }
  }
  return map;
}

/**
 * Size in bytes of each blob at `rev` for the given paths (missing paths are 0).
 * @param {string} dir
 * @param {string} rev
 * @param {string[]} paths
 * @returns {Promise<Map<string, number>>}
 */
export async function blobSizes(dir, rev, paths) {
  /** @type {Map<string, number>} */
  const out = new Map();
  if (paths.length === 0) return out;
  const res = await runGit(dir, ['cat-file', '--batch-check=%(objectsize)'], { input: paths.map((p) => `${rev}:${p}`).join('\n') + '\n' });
  const lines = res.stdout.split('\n');
  paths.forEach((p, i) => {
    const n = Number(lines[i]);
    out.set(p, Number.isFinite(n) ? n : 0);
  });
  return out;
}

/**
 * @param {string} dir
 * @returns {Promise<string>}
 */
export async function emptyTree(dir) {
  return (await git(dir, ['hash-object', '-t', 'tree', '--stdin'], { input: '' })).trim();
}

/**
 * Diff of one commit against its first parent (or the empty tree for a root commit).
 * @param {string} dir
 * @param {Commit} commit
 * @param {{ unified?: number }} [opts]
 * @returns {Promise<string>}
 */
export function commitDiff(dir, commit, opts = {}) {
  return rangeDiff(dir, commit.parents[0] ?? null, commit.sha, opts);
}

/**
 * Commits in `(from, to]`, oldest first. `from === null` means all ancestors of `to`.
 * @param {string} dir
 * @param {string | null} from
 * @param {string} to
 * @param {{ firstParent?: boolean }} [opts]
 * @returns {Promise<Commit[]>}
 */
export async function commitsInRange(dir, from, to, opts = {}) {
  const range = from ? `${from}..${to}` : to;
  const out = await git(dir, ['log', '--reverse', ...(opts.firstParent ? ['--first-parent'] : []), '--format=%H%x00%P%x00%an%x00%cI%x00%B%x1e', range, '--']);
  return out
    .split('\x1e')
    .map((r) => r.replace(/^\n/, ''))
    .filter((r) => r.trim() !== '')
    .map((r) => {
      const [sha, parents, author, date, ...msg] = r.split('\0');
      return { sha, parents: parents.trim() === '' ? [] : parents.trim().split(' '), author, date, message: msg.join('\0').replace(/\n+$/, '') };
    });
}

/**
 * Paths a commit touches relative to its first parent.
 * @param {string} dir
 * @param {Commit} commit
 * @returns {Promise<string[]>}
 */
export async function commitPaths(dir, commit) {
  const base = commit.parents[0] ?? (await emptyTree(dir));
  const out = await git(dir, [...DIFF_CONFIG, 'diff', '--name-only', '-z', '--no-renames', base, commit.sha, '--']);
  return out.split('\0').filter((p) => p !== '').sort();
}

/**
 * Number of added plus removed lines in a unified diff.
 * @param {string} diff
 * @returns {number}
 */
export function changedLineCount(diff) {
  let n = 0;
  let inHunks = false;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) inHunks = false;
    else if (line.startsWith('@@')) inHunks = true;
    else if (inHunks && (line.startsWith('+') || line.startsWith('-'))) n++;
  }
  return n;
}

/**
 * @param {string} dir
 * @param {string} rev
 * @returns {Promise<string | null>}
 */
export async function resolveCommit(dir, rev) {
  if (rev.startsWith('-')) return null;
  const res = await runGit(dir, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]);
  return res.code === 0 ? res.stdout.trim() : null;
}

/**
 * @param {string} dir
 * @param {string} ancestor
 * @param {string} descendant
 * @returns {Promise<boolean>}
 */
export async function isAncestor(dir, ancestor, descendant) {
  return (await runGit(dir, ['merge-base', '--is-ancestor', ancestor, descendant])).code === 0;
}

/**
 * One commit's own patch: `git show` against its first parent, or for a
 * merge its `--remerge-diff` (what the merge did beyond a clean automatic
 * merge). Restricted like rangeDiff.
 * @param {string} dir
 * @param {Commit} commit
 * @param {{ unified?: number, paths?: string[], exclude?: string[] }} [opts]
 * @returns {Promise<string>}
 */
export async function commitPatch(dir, commit, opts = {}) {
  const unified = opts.unified ?? 3;
  const merge = commit.parents.length > 1 ? ['--remerge-diff'] : [];
  return git(dir, [...DIFF_CONFIG, 'show', '--format=', ...merge, ...DIFF_FLAGS, `--unified=${unified}`, '--find-renames', commit.sha, ...pathspecs(opts)]);
}

/**
 * @typedef {object} DiffSection
 * @property {string} path new path (old path for a deletion)
 * @property {string | null} old the old path of a rename or copy, else null
 * @property {string} text the section, from `diff --git` to the next one
 */

/**
 * Split a unified diff into per-file sections, rename-aware: a pure rename
 * (no hunks) and binary changes are sections too.
 * @param {string} diff
 * @returns {DiffSection[]}
 */
export function diffSections(diff) {
  /** @type {DiffSection[]} */
  const out = [];
  for (const text of diff.split(/^(?=diff --git )/m)) {
    if (!text.startsWith('diff --git ')) continue;
    /** @type {string | null} */
    let from = null;
    /** @type {string | null} */
    let to = null;
    /** @type {string | null} */
    let renameFrom = null;
    /** @type {string | null} */
    let renameTo = null;
    for (const line of text.split('\n')) {
      if (line.startsWith('@@')) break;
      const m = /^(rename|copy) (from|to) (.*)$/.exec(line);
      if (m) {
        const p = unquoteGitPath(m[3]);
        if (m[2] === 'from') renameFrom = p;
        else renameTo = p;
      } else if (line.startsWith('--- ')) from = headerPath(line.slice(4));
      else if (line.startsWith('+++ ')) to = headerPath(line.slice(4));
    }
    let path = renameTo ?? to ?? from;
    let old = renameFrom;
    if (path === null) {
      const h = /^diff --git (?:"?a\/)(.*?)"? (?:"?b\/)(.*?)"?$/.exec(text.split('\n')[0]);
      path = h ? unquoteGitPath(h[2]) : text.split('\n')[0].slice('diff --git '.length);
    }
    out.push({ path, old: old !== null && old !== path ? old : null, text });
  }
  return out;
}

/**
 * @param {string} value
 * @returns {string | null}
 */
function headerPath(value) {
  const raw = value.startsWith('"') ? value : value.split('\t', 1)[0];
  const decoded = unquoteGitPath(raw);
  return decoded === '/dev/null' ? null : decoded.replace(/^[ab]\//, '');
}
