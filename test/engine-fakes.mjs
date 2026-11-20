import { readdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { defaultExec } from '../src/cli/engine-util.mjs';

const BANNED = ['pg', 'ws', 'jose', 'node:sqlite'];

/** @param {string} dir @returns {string[]} */
function walk(dir) {
  /** @type {string[]} */
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

/**
 * Emulates dependency-cruiser, eslint (no-console) and ruff (TID251 on `requests`)
 * well enough to drive the real adapter mapping code. Everything else runs for real.
 * @type {import('../src/cli/engine-util.mjs').Exec}
 */
export const fakeExec = async (argv, opts) => {
  const [tool, ...args] = argv;
  if (args.includes('--version')) return { code: 0, stdout: `${tool} 0.0.0-fake\n`, stderr: '' };
  if (tool === 'fake-depcruise') {
    const roots = args.slice(args.indexOf('--') + 1);
    const violations = [];
    for (const r of roots) {
      for (const file of walk(join(opts.cwd, r))) {
        const rel = relative(opts.cwd, file).replace(/\\/g, '/');
        if (!/\.(ts|js|mjs)$/.test(rel) || /\/test\//.test(`/${rel}`)) continue;
        for (const m of readFileSync(file, 'utf8').matchAll(/from '([^']+)'/g)) {
          if (BANNED.includes(m[1])) violations.push({ from: rel, to: `node_modules/.pnpm/${m[1]}@1.0.0/node_modules/${m[1]}/lib/index.js`, unresolvedTo: m[1], rule: { name: 'no-vendor', severity: 'error' } });
        }
      }
    }
    return { code: violations.length, stdout: JSON.stringify({ summary: { violations } }), stderr: '' };
  }
  if (tool === 'fake-eslint') {
    const stdin = args.includes('--stdin');
    const files = stdin ? [args[args.indexOf('--stdin-filename') + 1]] : args.slice(args.indexOf('--') + 1);
    const results = files.map((f) => {
      const lines = (stdin ? opts.input ?? '' : readFileSync(isAbsolute(f) ? f : join(opts.cwd, f), 'utf8')).split('\n');
      const messages = [];
      lines.forEach((l, i) => {
        const c = l.indexOf('console.');
        if (c >= 0 && !(lines[i - 1] ?? '').includes('eslint-disable-next-line')) messages.push({ ruleId: 'no-console', line: i + 1, column: c + 1, message: 'Unexpected console statement.', severity: 2 });
      });
      return { filePath: isAbsolute(f) ? f : join(opts.cwd, f), messages };
    });
    return { code: results.some((r) => r.messages.length) ? 1 : 0, stdout: JSON.stringify(results), stderr: '' };
  }
  if (tool === 'ruff') {
    const files = args.slice(args.indexOf('--') + 1);
    const out = [];
    for (const f of files) {
      readFileSync(isAbsolute(f) ? f : join(opts.cwd, f), 'utf8').split('\n').forEach((l, i) => {
        if (/^\s*import requests\b/.test(l)) out.push({ code: 'TID251', filename: isAbsolute(f) ? f : join(opts.cwd, f), location: { row: i + 1, column: 1 }, message: '`requests` is banned: use the shared client' });
      });
    }
    return { code: 0, stdout: JSON.stringify(out), stderr: '' };
  }
  return defaultExec(argv, opts);
};

/** @type {(repoRoot: string, name: string, pkg: string) => string[]} */
export const fakeResolveBin = (_repoRoot, name) => [`fake-${name}`];

export const FAKE_DEPS = Object.freeze({ exec: fakeExec, resolveBin: fakeResolveBin });
