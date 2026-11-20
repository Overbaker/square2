import { execFile } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { isAbsolute, join, posix, relative, win32 } from 'node:path';
import { globMatch } from '../core/exceptions.mjs';
import { toPosixPath } from '../core/fingerprint.mjs';
import { formatDiagnostic } from '../core/violation.mjs';
import { runGit } from '../git/exec.mjs';

/** Engine failure (missing tool, unparseable output); callers map it to exit 2. */
export class EngineError extends Error {
  /**
   * @param {'S2-ENGINE-MISSING' | 'S2-ENGINE-FAILED'} code
   * @param {string} message
   * @param {string} instead
   */
  constructor(code, message, instead) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
    this.instead = instead;
  }

  /** @returns {string} */
  get diagnostic() {
    return formatDiagnostic(this.code, this.message, this.instead);
  }
}

const ENV_ALLOW = new Set(['PATH', 'PATHEXT', 'HOME', 'USERPROFILE', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'APPDATA', 'LOCALAPPDATA', 'VIRTUAL_ENV', 'PYTHONHOME', 'PYTHONPATH', 'PYTHONUTF8', 'CI']);
const ENV_ALLOW_PREFIX = ['UV_', 'RUFF_', 'PIPX_'];
const ENV_DENY = /(?:TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|_API_KEY|_KEY$)|^(?:GITHUB_|GH_|ACTIONS_|SQ2_|NODE_OPTIONS$)/i;

/**
 * Environment for engine subprocesses: an allowlist of the caller's variables
 * (never tokens, keys, `ACTIONS_*`, `SQ2_*` or `NODE_OPTIONS`) plus `extra`.
 * @param {Record<string, string | undefined>} base
 * @param {Record<string, string | undefined>} [extra]
 * @returns {Record<string, string>}
 */
export function engineEnv(base, extra = {}) {
  /** @type {Record<string, string>} */
  const env = {};
  for (const [k, v] of Object.entries({ ...base, ...extra })) {
    if (v === undefined) continue;
    const upper = k.toUpperCase();
    const allowed = ENV_ALLOW.has(upper) || ENV_ALLOW_PREFIX.some((p) => upper.startsWith(p)) || Object.prototype.hasOwnProperty.call(extra, k);
    if (allowed && !ENV_DENY.test(upper)) env[k] = v;
  }
  return env;
}

/**
 * @typedef {{ code: number, stdout: string, stderr: string }} ExecResult
 * @typedef {(argv: string[], opts: { cwd: string, env?: Record<string, string | undefined>, timeoutMs?: number, input?: string }) => Promise<ExecResult>} Exec
 */

/**
 * Run argv without a shell, with the allowlisted environment. A missing
 * executable throws EngineError.
 * @type {Exec}
 */
export function defaultExec(argv, opts) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      argv[0],
      argv.slice(1),
      { cwd: opts.cwd, env: engineEnv(process.env, opts.env ?? {}), encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, timeout: opts.timeoutMs ?? 300_000, windowsHide: true },
      (err, stdout, stderr) => {
        const e = /** @type {any} */ (err);
        if (e && e.code === 'ENOENT') {
          reject(new EngineError('S2-ENGINE-MISSING', `cannot run ${argv[0]}: not found`, `install ${argv[0]} or configure its command in .square2/config.yaml`));
          return;
        }
        if (e && typeof e.code !== 'number') {
          reject(new EngineError('S2-ENGINE-FAILED', `${argv[0]} failed: ${e.message}`, 'check the tool runs on its own from the repository root'));
          return;
        }
        resolve({ code: e ? e.code : 0, stdout: typeof stdout === 'string' ? stdout : '', stderr: typeof stderr === 'string' ? stderr : '' });
      },
    );
    child.stdin?.on('error', () => {});
    if (opts.input !== undefined) child.stdin?.end(opts.input);
    else child.stdin?.end();
  });
}

/**
 * Resolve a Node tool from the repository's own `node_modules/<pkg>`: read the
 * package's `bin` field and run that script with the current Node (no `.bin`
 * shims, so the same on every platform).
 * @param {string} repoRoot
 * @param {string} name bin name
 * @param {string} pkg npm package that provides it
 * @returns {string[]} argv prefix
 */
export function resolveNodeBin(repoRoot, name, pkg) {
  const missing = () => new EngineError('S2-ENGINE-MISSING', `${pkg} is not installed in the repository (node_modules/${pkg})`, `install ${pkg} as a dev dependency of the repository (for example \`pnpm add -D ${pkg}\`) and run the install step first`);
  const dir = join(repoRoot, 'node_modules', ...pkg.split('/'));
  let meta;
  try {
    meta = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  } catch {
    throw missing();
  }
  const bin = meta && typeof meta === 'object' ? meta.bin : undefined;
  const rel = typeof bin === 'string' ? bin : bin && typeof bin === 'object' && typeof bin[name] === 'string' ? bin[name] : undefined;
  if (rel === undefined) throw missing();
  const script = join(dir, rel);
  if (!existsSync(script)) throw missing();
  return [process.execPath, script];
}

/** @type {Map<string, Promise<string>>} */
const versionCache = new Map();

/**
 * `<argv> --version`, first line, cached per process.
 * @param {Exec} exec
 * @param {string[]} argv
 * @param {string} cwd
 * @returns {Promise<string>}
 */
export function toolVersion(exec, argv, cwd) {
  const key = JSON.stringify(argv);
  let p = versionCache.get(key);
  if (!p) {
    p = exec([...argv, '--version'], { cwd }).then((r) => r.stdout.trim().split('\n')[0] || 'unknown');
    versionCache.set(key, p);
    p.catch(() => versionCache.delete(key));
  }
  return p;
}

/**
 * Walk a directory (fixture mode), skipping `.git` and `node_modules`.
 * Broken and cyclic symlinks are skipped with a warning.
 * @param {string} root
 * @param {(message: string) => void} [warn]
 * @returns {string[]} sorted repo-relative POSIX paths
 */
export function walkFiles(root, warn = () => {}) {
  /** @type {string[]} */
  const out = [];
  /** @type {Set<string>} */
  const seen = new Set();
  /** @param {string} dir */
  const walk = (dir) => {
    let real;
    try {
      real = realpathSync(dir);
    } catch {
      return;
    }
    if (seen.has(real)) {
      warn(`skipped symlink cycle at ${toPosixPath(relative(root, dir) || '.')}`);
      return;
    }
    seen.add(real);
    for (const name of readdirSync(dir).sort()) {
      if (name === '.git' || name === 'node_modules') continue;
      const full = join(dir, name);
      let st;
      try {
        st = lstatSync(full);
        if (st.isSymbolicLink()) st = statSync(full);
      } catch {
        warn(`skipped broken symlink ${toPosixPath(relative(root, full))}`);
        continue;
      }
      if (st.isDirectory()) walk(full);
      else if (st.isFile()) out.push(toPosixPath(relative(root, full)));
    }
  };
  if (existsSync(root)) walk(root);
  return out.sort();
}

/**
 * Files to scan. Repo mode: tracked plus untracked-not-ignored files from git
 * (falls back to a walk outside git). Fixture mode: always a walk.
 * @param {string} root
 * @param {'repo' | 'fixture'} mode
 * @param {(message: string) => void} [warn]
 * @returns {Promise<string[]>}
 */
export async function listFiles(root, mode, warn = () => {}) {
  if (mode === 'fixture') return walkFiles(root, warn);
  let res;
  try {
    res = await runGit(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
  } catch {
    return walkFiles(root, warn);
  }
  if (res.code !== 0) return walkFiles(root, warn);
  const files = [...new Set(res.stdout.split('\0').filter((p) => p !== ''))].filter((p) => {
    try {
      return statSync(join(root, p)).isFile();
    } catch {
      return false;
    }
  });
  return files.map((p) => toPosixPath(p)).sort();
}

export const DEFAULT_EXCLUDES = Object.freeze(['.git/**', 'node_modules/**', '**/node_modules/**', '.square2/**']);

/**
 * @param {{ scope: string[], exclude: string[] }} rule
 * @param {string[]} extraExcludes global excludes (generated paths, vendored copy)
 * @returns {(path: string) => boolean}
 */
export function ruleSelector(rule, extraExcludes) {
  const excludes = [...rule.exclude, ...extraExcludes];
  return (path) => rule.scope.some((g) => globMatch(g, path)) && !excludes.some((g) => globMatch(g, path));
}

/**
 * Static directory prefix of each glob (up to the first wildcard segment), deduplicated.
 * @param {string[]} globs
 * @returns {string[]}
 */
export function globRoots(globs) {
  const roots = new Set();
  for (const g of globs) {
    const segs = [];
    for (const s of g.split('/')) {
      if (/[*?]/.test(s)) break;
      segs.push(s);
    }
    roots.add(segs.length === 0 ? '.' : segs.join('/'));
  }
  const list = [...roots].sort();
  if (list.includes('.')) return ['.'];
  return list.filter((r) => !list.some((o) => o !== r && r.startsWith(o + '/')));
}

/**
 * @param {string} root
 * @param {string} path
 * @returns {string}
 */
export function readText(root, path) {
  return readFileSync(join(root, path), 'utf8');
}

/** @type {Map<string, string>} */
const realCache = new Map();

/**
 * @param {string} p
 * @returns {string}
 */
function real(p) {
  let r = realCache.get(p);
  if (r === undefined) {
    try {
      r = realpathSync.native(p);
    } catch {
      r = p;
    }
    realCache.set(p, r);
  }
  return r;
}

/**
 * Make an engine-reported path relative to `root`. Absolute paths (POSIX, or
 * Windows drive/UNC paths on win32) are compared after realpath on both
 * sides, so `/var` vs `/private/var` style aliases do not matter. The result
 * may start with `..` when the file is outside `root`; finalizeViolations
 * rejects that as invalid adapter output.
 * @param {string} root
 * @param {string} reported
 * @param {NodeJS.Platform} [platform]
 * @returns {string}
 */
export function relativeToRoot(root, reported, platform = process.platform) {
  const abs = platform === 'win32' ? win32.isAbsolute(reported) : isAbsolute(reported);
  if (!abs) return reported.replace(/\\/g, '/');
  if (platform === 'win32') {
    const rel = win32.relative(real(root), real(reported));
    return rel.split(win32.sep).join(posix.sep);
  }
  const rel = relative(real(root), real(reported));
  return rel.replace(/\\/g, '/');
}

/**
 * Run `fn` over items with at most `limit` in flight; results keep input order.
 * @template T, R
 * @param {T[]} items
 * @param {(item: T) => Promise<R>} fn
 * @param {number} [limit]
 * @returns {Promise<R[]>}
 */
export async function mapConcurrent(items, fn, limit = availableParallelism()) {
  /** @type {R[]} */
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

/**
 * The context every engine receives.
 * @typedef {object} EngineContext
 * @property {string} root tree to scan (repository, worktree or fixture directory)
 * @property {string} repoRoot consumer repository (main checkout): tool binaries and tool configs are resolved here
 * @property {'repo' | 'fixture'} mode
 * @property {import('../core/catalogue.mjs').Rule[]} rules enabled rules of this engine
 * @property {import('./config.mjs').Config} config
 * @property {string[]} excludes global excludes on top of each rule's own
 * @property {Exec} exec
 * @property {(name: string, pkg: string) => string[]} resolveBin
 * @property {() => Promise<string[]>} files cached file list of `root`
 * @property {(message: string) => void} warn
 */

/**
 * One tree of a batched run.
 * @typedef {{ root: string, rules: import('../core/catalogue.mjs').Rule[], files: () => Promise<string[]> }} Target
 */

/**
 * @typedef {{ violations: import('../core/violation.mjs').Violation[], version: string }} EngineResult
 * @typedef {object} EngineAdapter
 * @property {(ctx: EngineContext) => Promise<EngineResult>} run
 * @property {(ctx: Omit<EngineContext, 'root' | 'rules' | 'files'>, targets: Target[]) => Promise<EngineResult[]>} [runMany]
 *   one tool invocation for several trees (selftest fixtures), results aligned with `targets`
 */
