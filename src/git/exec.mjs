import { execFile } from 'node:child_process';

export class GitError extends Error {
  /**
   * @param {string} message
   * @param {{ code: number | null, stderr: string }} detail
   */
  constructor(message, detail) {
    super(message);
    this.name = 'GitError';
    this.exitCode = detail.code;
    this.stderr = detail.stderr;
  }
}

/** Variables that would redirect git away from the directory we name with `-C`. */
export const GIT_REDIRECT_VARS = Object.freeze(['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR', 'GIT_NAMESPACE', 'GIT_CEILING_DIRECTORIES', 'GIT_PREFIX']);

/** `core.hooksPath` value that disables hooks on this platform. */
export const NO_HOOKS = process.platform === 'win32' ? 'NUL' : '/dev/null';

/**
 * Environment for git: the caller's, minus every variable that redirects the repository.
 * @param {Record<string, string | undefined>} [base]
 * @returns {Record<string, string | undefined>}
 */
export function gitEnv(base = process.env) {
  /** @type {Record<string, string | undefined>} */
  const env = {};
  for (const [k, v] of Object.entries(base)) if (!GIT_REDIRECT_VARS.includes(k.toUpperCase())) env[k] = v;
  env.GIT_TERMINAL_PROMPT = '0';
  env.LC_ALL = 'C';
  return env;
}

/**
 * @typedef {{ code: number, stdout: string, stderr: string }} GitResult
 */

/**
 * Run `git -C <dir> <args>` without a shell. Resolves with the exit code;
 * rejects only when git itself cannot be started.
 * @param {string} dir
 * @param {string[]} args
 * @param {{ input?: string, maxBuffer?: number, config?: string[] }} [opts] `config` adds `-c` pairs
 * @returns {Promise<GitResult>}
 */
export function runGit(dir, args, opts = {}) {
  const pre = (opts.config ?? []).flatMap((c) => ['-c', c]);
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      [...pre, '-C', dir, ...args],
      { cwd: dir, encoding: 'utf8', maxBuffer: opts.maxBuffer ?? 256 * 1024 * 1024, env: gitEnv() },
      (err, stdout, stderr) => {
        const e = /** @type {any} */ (err);
        if (e && typeof e.code !== 'number') {
          reject(new GitError(`cannot run git: ${e.message}`, { code: null, stderr: typeof stderr === 'string' ? stderr : '' }));
          return;
        }
        resolve({ code: e ? e.code : 0, stdout, stderr });
      },
    );
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });
}

/**
 * Like runGit, but a non-zero exit throws GitError. Returns stdout.
 * @param {string} dir
 * @param {string[]} args
 * @param {{ input?: string, config?: string[] }} [opts]
 * @returns {Promise<string>}
 */
export async function git(dir, args, opts = {}) {
  const res = await runGit(dir, args, opts);
  if (res.code !== 0) throw new GitError(`git ${args.join(' ')} failed (${res.code}): ${res.stderr.trim()}`, { code: res.code, stderr: res.stderr });
  return res.stdout;
}

/**
 * @param {string} dir
 * @returns {Promise<string | null>} the work tree top level, or null outside git
 */
export async function topLevel(dir) {
  try {
    const res = await runGit(dir, ['rev-parse', '--show-toplevel']);
    return res.code === 0 ? res.stdout.trim() : null;
  } catch {
    return null;
  }
}
