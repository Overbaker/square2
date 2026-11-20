import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from '../src/cli/main.mjs';
import { FAKE_DEPS } from './engine-fakes.mjs';

export const REPO = fileURLToPath(new URL('..', import.meta.url));
export const BIN = join(REPO, 'bin', 'square2.mjs');
export const MINI = join(REPO, 'test', 'fixtures', 'mini-repo');
export const TODAY = '2026-11-20';
/** square²'s own TypeScript, used only because test repositories have none installed. */
export const OWN_TYPESCRIPT = join(REPO, 'node_modules', 'typescript');
process.env.SQUARE2_TYPESCRIPT ??= OWN_TYPESCRIPT;

/** @type {string[]} */
const temps = [];

/** @param {string} prefix @returns {string} */
export function tempDir(prefix) {
  const d = mkdtempSync(join(tmpdir(), prefix));
  temps.push(d);
  return d;
}

export function cleanupTemps() {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
}

/**
 * @param {string} cwd
 * @param {string[]} args
 * @returns {string}
 */
export function git(cwd, args) {
  const res = spawnSync('git', ['-c', 'user.name=square2-test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`git ${args.join(' ')}: ${res.stderr}`);
  return res.stdout;
}

/**
 * A temporary copy of the mini repo, optionally as its own git repository with one commit.
 * @param {{ git?: boolean }} [opts]
 * @returns {string}
 */
export function copyMiniRepo(opts = {}) {
  const dir = join(tempDir('square2-mini-'), 'repo');
  cpSync(MINI, dir, { recursive: true });
  if (opts.git !== false) {
    git(dir, ['init', '--quiet']);
    git(dir, ['add', '-A']);
    git(dir, ['commit', '--quiet', '-m', 'initial']);
  }
  return dir;
}

/**
 * Run the real CLI as a subprocess.
 * @param {string[]} args
 * @param {{ cwd: string, env?: Record<string, string> }} opts
 */
export function runBin(args, opts) {
  const res = spawnSync(process.execPath, [BIN, ...args], { cwd: opts.cwd, encoding: 'utf8', env: { ...process.env, SQUARE2_TODAY: TODAY, ...(opts.env ?? {}) } });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

/**
 * Run the CLI in-process with the fake depcruise/eslint/ruff tools.
 * @param {string[]} args
 * @param {{ cwd: string, env?: Record<string, string>, adapters?: Record<string, import('../src/cli/engine-util.mjs').EngineAdapter>, toolRoot?: string }} opts
 */
export async function runMain(args, opts) {
  let stdout = '';
  let stderr = '';
  const code = await main(['--root', opts.cwd, ...args], {
    cwd: opts.cwd,
    env: { SQUARE2_TODAY: TODAY, ...(opts.env ?? {}) },
    stdout: (t) => { stdout += t; },
    stderr: (t) => { stderr += t; },
    adapters: opts.adapters,
    toolRoot: opts.toolRoot,
    ...FAKE_DEPS,
  });
  return { code, stdout, stderr };
}
