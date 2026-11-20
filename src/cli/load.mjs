import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { validateCatalogue } from '../core/catalogue.mjs';
import { matchSegment } from '../core/exceptions.mjs';
import { PathError, toPosixPath } from '../core/fingerprint.mjs';
import { parseConfig } from './config.mjs';
import { DEFAULT_EXCLUDES } from './engine-util.mjs';

/**
 * @param {string} path
 * @returns {string | null}
 */
export function readOptional(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    if (/** @type {any} */ (err).code === 'ENOENT' || /** @type {any} */ (err).code === 'EISDIR') return null;
    throw err;
  }
}

/**
 * @param {string} path
 * @returns {boolean}
 */
function isDir(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * @typedef {object} Repo
 * @property {string} root repository root (the tree that is gated)
 * @property {string} dir the square² directory (`<root>/.square2` unless overridden)
 * @property {string | null} dirInRepo `dir` relative to `root` when inside it (for `git show`), else null
 * @property {import('./config.mjs').Config} config
 * @property {string[]} configDiagnostics
 * @property {import('../core/catalogue.mjs').CatalogueResult} catalogue
 */

/**
 * A `.square2/...` path of the repository, honouring an overridden square² directory.
 * @param {Repo | { root: string, dir: string }} repo
 * @param {string} path repo-relative path, typically under `.square2/`
 * @returns {string}
 */
export function repoPath(repo, path) {
  if (path === '.square2' || path.startsWith('.square2/')) return join(repo.dir, path.slice('.square2'.length));
  return join(repo.root, path);
}

/**
 * Load the config and every rule file. `dir` overrides `<root>/.square2`
 * (env `SQUARE2_DIR` or `--square2-dir`), for running a catalogue kept
 * outside the repository. `provenance: false` skips the require_provenance
 * check (replay produces the reports it checks).
 * @param {string} root
 * @param {{ provenance?: boolean, dir?: string }} [opts]
 * @returns {Repo}
 */
export function loadRepo(root, opts = {}) {
  const dir = opts.dir ?? join(root, '.square2');
  const rel = relative(root, dir);
  const dirInRepo = rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) ? toPosixPath(rel) : null;
  const { config, diagnostics } = parseConfig(readOptional(join(dir, 'config.yaml')));
  const rulesDir = join(dir, 'rules');
  const names = isDir(rulesDir) ? readdirSync(rulesDir).filter((n) => /\.ya?ml$/.test(n)).sort() : [];
  const files = names.map((n) => ({ path: `.square2/rules/${n}`, text: readFileSync(join(rulesDir, n), 'utf8') }));
  const base = { root, dir };
  const catalogue = validateCatalogue(files, {
    fixtureDirExists: (id) => isDir(join(dir, 'fixtures', id, 'bad')),
    requireProvenance: config.require_provenance && opts.provenance !== false,
    readReplay: (path) => readOptional(repoPath(base, path)),
  });
  return { root, dir, dirInRepo, config, configDiagnostics: diagnostics, catalogue };
}

/**
 * Rules whose id matches any of the comma-separated globs (`*`, `?`).
 * @param {import('../core/catalogue.mjs').Rule[]} rules
 * @param {string | undefined} only
 * @returns {import('../core/catalogue.mjs').Rule[]}
 */
export function selectRules(rules, only) {
  if (only === undefined || only.trim() === '') return rules;
  const globs = only.split(',').map((g) => g.trim()).filter((g) => g !== '');
  return rules.filter((r) => globs.some((g) => matchSegment(g, r.id)));
}

/**
 * Lock file contents, null when absent, or 'invalid'.
 * @param {string} dir the square² directory
 * @returns {Record<string, unknown> | null | 'invalid'}
 */
export function readLock(dir) {
  const text = readOptional(join(dir, 'lock.json'));
  if (text === null) return null;
  try {
    const doc = JSON.parse(text);
    return doc && typeof doc === 'object' && !Array.isArray(doc) ? doc : 'invalid';
  } catch {
    return 'invalid';
  }
}

/**
 * The lock's `path` when it is a valid, already-normalized repo-relative
 * path; null otherwise (never a fallback).
 * @param {unknown} lock
 * @returns {string | null}
 */
export function vendorPath(lock) {
  if (lock && typeof lock === 'object' && 'path' in lock && typeof lock.path === 'string') {
    try {
      const p = toPosixPath(lock.path);
      return p === lock.path ? p : null;
    } catch (err) {
      if (!(err instanceof PathError)) throw err;
    }
  }
  return null;
}

/**
 * Global excludes for repository runs: defaults, generated paths and the vendored copy.
 * @param {{ root: string, dir: string, config: import('./config.mjs').Config }} repo
 * @returns {string[]}
 */
export function globalExcludes(repo) {
  const path = vendorPath(readLock(repo.dir)) ?? repo.config.vendored_path;
  const vendored = path !== null && existsSync(join(repo.root, path)) ? [`${path}/**`] : [];
  return [...DEFAULT_EXCLUDES, ...repo.config.generated, ...vendored];
}
