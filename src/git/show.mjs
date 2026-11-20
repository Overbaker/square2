import { runGit } from './exec.mjs';

/**
 * A file as of a base commit, mapped to the ratchet's union kinds.
 * @typedef {{ kind: 'no-commit' } | { kind: 'absent' } | { kind: 'blob', text: string }} BlobAt
 */

/**
 * @param {string | null | undefined} base
 * @returns {boolean} true for a missing, empty or all-zero base (no previous commit)
 */
export function isNoCommit(base) {
  return base === null || base === undefined || base.trim() === '' || /^0+$/.test(base.trim());
}

/**
 * Resolve a base for the ratchet: `no-commit`, the full sha, or null when it
 * does not name a commit in this repository (not fetched, typo).
 * @param {string} dir any directory inside the repository
 * @param {string | null | undefined} base
 * @returns {Promise<{ kind: 'no-commit' } | { kind: 'commit', sha: string } | null>}
 */
export async function resolveBase(dir, base) {
  if (isNoCommit(base)) return { kind: 'no-commit' };
  const rev = /** @type {string} */ (base).trim();
  if (rev.startsWith('-')) return null;
  const res = await runGit(dir, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]);
  return res.code === 0 ? { kind: 'commit', sha: res.stdout.trim() } : null;
}

/**
 * Path of `path` (relative to `dir`) as git names it from the top level.
 * @param {string} dir
 * @param {string} path
 * @returns {Promise<string>}
 */
export async function topLevelPath(dir, path) {
  const res = await runGit(dir, ['rev-parse', '--show-prefix']);
  const prefix = res.code === 0 ? res.stdout.trim() : '';
  return `${prefix}${path}`;
}

/**
 * Read `<base>:<path>` via `git show`, with `path` relative to `dir` (which
 * may be below the git top level). An unresolvable base is `no-commit`; use
 * resolveBase first to reject it.
 * @param {string} dir
 * @param {string | null | undefined} base
 * @param {string} path
 * @returns {Promise<BlobAt>}
 */
export async function blobAt(dir, base, path) {
  const resolved = await resolveBase(dir, base);
  if (resolved === null || resolved.kind === 'no-commit') return { kind: 'no-commit' };
  const full = await topLevelPath(dir, path);
  const exists = await runGit(dir, ['cat-file', '-e', `${resolved.sha}:${full}`]);
  if (exists.code !== 0) return { kind: 'absent' };
  const shown = await runGit(dir, ['show', `${resolved.sha}:${full}`]);
  if (shown.code !== 0) return { kind: 'absent' };
  return { kind: 'blob', text: shown.stdout };
}

/**
 * @param {BlobAt} blob
 * @returns {string | null} the text, or null when there is none
 */
export function blobText(blob) {
  return blob.kind === 'blob' ? blob.text : null;
}
