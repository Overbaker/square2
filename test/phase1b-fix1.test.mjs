import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { main } from '../src/cli/main.mjs';
import { defaultExec, engineEnv, relativeToRoot, resolveNodeBin, walkFiles } from '../src/cli/engine-util.mjs';
import { MARKER, TreeError, treeSha256, verifyVendor } from '../src/cli/vendor.mjs';
import { validateCatalogue } from '../src/core/catalogue.mjs';
import { parseConfig } from '../src/cli/config.mjs';
import { runGit } from '../src/git/exec.mjs';
import { loadTypescript, scanSuppressions } from '../src/engines/suppressions.mjs';
import { mapDepcruiseOutput } from '../src/engines/depcruise.mjs';
import { BIN, REPO, cleanupTemps, copyMiniRepo, git, runBin, runMain, tempDir } from './cli-helpers.mjs';
import { fakeExec, fakeResolveBin } from './engine-fakes.mjs';

const TS = loadTypescript(new URL('..', import.meta.url).pathname);
/** @param {string} p @param {string} src */
const scan = (p, src) => scanSuppressions(p, src, TS);

after(cleanupTemps);

/** A repository with dependency-cruiser and eslint installed and a ruff venv at python/.venv; real-tool tests skip without it. */
const CONSUMER_TOOLS = process.env.SQUARE2_TOOLS_REPO ?? '';
const HAVE_NODE_TOOLS = CONSUMER_TOOLS !== '' && existsSync(join(CONSUMER_TOOLS, 'node_modules', 'dependency-cruiser', 'package.json')) && existsSync(join(CONSUMER_TOOLS, 'node_modules', 'eslint', 'package.json'));
const RUFF = join(CONSUMER_TOOLS, 'python', '.venv', 'bin', 'ruff');
const HAVE_RUFF = CONSUMER_TOOLS !== '' && existsSync(RUFF);

/**
 * A repository whose dependency-cruiser config uses a relative tsConfig and
 * whose fixtures have no tsconfig; real tools come from CONSUMER_TOOLS.
 */
function realToolRepo() {
  const dir = join(tempDir('square2-real-'), 'repo');
  const files = {
    '.dependency-cruiser.cjs': "module.exports = {\n  forbidden: [{ name: 'no-vendor', severity: 'error', from: { path: '^apps/' }, to: { path: '(^|node_modules/)(pg|ws)(/|$)' } }],\n  options: { tsConfig: { fileName: 'tsconfig.json' }, doNotFollow: { path: 'node_modules' } },\n};\n",
    'tsconfig.json': '{ "compilerOptions": { "strict": true, "module": "esnext", "moduleResolution": "bundler" }, "include": ["apps"] }\n',
    'eslint.config.mjs': "export default [{ files: ['**/*.ts'], rules: { 'no-console': 'error' } }];\n",
    'node_modules/pg/package.json': '{ "name": "pg", "version": "1.0.0", "main": "lib/index.js" }\n',
    'node_modules/pg/lib/index.js': 'module.exports = {};\n',
    'apps/a/src/x.ts': "import pg from 'pg';\nconsole.log(pg);\n",
    'python/a.py': 'import requests\n',
    '.square2/fixtures/S2-DEP-NO-VENDOR/bad/apps/x/src/a.ts': "import pg from 'pg';\nexport const p = pg;\n",
    '.square2/fixtures/S2-LINT-NO-CONSOLE/bad/apps/x/a.ts': 'console.log(1);\n',
    '.square2/fixtures/S2-LINT-NO-CONSOLE/good/apps/x/a.ts': 'export const ok = 1;\n',
    '.square2/fixtures/S2-PY-BANNED-IMPORT/bad/python/a.py': 'import requests\n',
    '.square2/config.yaml': `engines:\n  ruff:\n    command:\n      - ${RUFF}\n`,
    '.square2/rules/r.yaml': `rules:
  - id: S2-DEP-NO-VENDOR
    dune_rule: 2
    engine: depcruise
    scope: apps/**
    instead: use adapters
    owner: o
  - id: S2-LINT-NO-CONSOLE
    dune_rule: 2
    engine: eslint
    scope: apps/**
    instead: use the logger
    owner: o
    options:
      rule: no-console
  - id: S2-PY-BANNED-IMPORT
    dune_rule: 2
    engine: ruff
    scope: python/**
    instead: use the client
    owner: o
    options:
      select: TID251
      args:
        - --config
        - "lint.flake8-tidy-imports.banned-api.requests.msg = 'use the client'"
`,
    '.gitignore': 'node_modules/\n',
  };
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(join(dir, p, '..'), { recursive: true });
    writeFileSync(join(dir, p), text);
  }
  git(dir, ['init', '--quiet']);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '--quiet', '-m', 'init']);
  return dir;
}

/**
 * @param {string} dir
 * @param {string[]} args
 */
async function runReal(dir, args) {
  let stdout = '';
  let stderr = '';
  const code = await main(['--root', dir, ...args], {
    cwd: dir,
    env: { SQUARE2_TODAY: '2026-11-20' },
    stdout: (t) => { stdout += t; },
    stderr: (t) => { stderr += t; },
    resolveBin: (_r, name, pkg) => resolveNodeBin(CONSUMER_TOOLS, name, pkg),
  });
  return { code, stdout, stderr };
}

// 1-3. real depcruise / eslint / ruff
test('real tools: relative tsConfig works on fixtures; subjects are module specifiers', { skip: !(HAVE_NODE_TOOLS && HAVE_RUFF) && 'set SQUARE2_TOOLS_REPO to a repository with the real tools installed' }, async () => {
  const dir = realToolRepo();
  const res = await runReal(dir, ['check', '--report', join(dir, 'r.json')]);
  assert.equal(res.code, 1, res.stdout + res.stderr);
  assert.deepEqual(res.stdout.trim().split('\n').sort(), [
    '[S2-DEP-NO-VENDOR] apps/a/src/x.ts imports pg — Instead: use adapters',
    '[S2-LINT-NO-CONSOLE] apps/a/src/x.ts:2 Unexpected console statement. — Instead: use the logger',
    "[S2-PY-BANNED-IMPORT] python/a.py:1 TID251 `requests` is banned: use the client — Instead: use the client",
  ]);
  const st = await runReal(dir, ['selftest']);
  assert.equal(st.code, 0, st.stdout + st.stderr);
});

test('depcruise subject is unresolvedTo, never the resolved file', () => {
  const rule = { id: 'S2-DEP-NO-VENDOR', dune_rule: 2, engine: 'depcruise', scope: ['apps/**'], exclude: [], instead: 'x', owner: 'o', enabled: true, options: {}, file: 'r' };
  const out = JSON.stringify({ summary: { violations: [{ from: 'apps/a.ts', to: 'node_modules/.pnpm/pg@8.11.0/node_modules/pg/lib/index.js', unresolvedTo: 'pg', rule: { name: 'no-vendor' } }] } });
  assert.deepEqual(mapDepcruiseOutput('/r', out, [rule], []).map((r) => r.subject), ['pg']);
});

test('eslint is always given the root config explicitly and files after --', async () => {
  const dir = copyMiniRepo();
  /** @type {string[][]} */
  const calls = [];
  /** @type {import('../src/cli/engine-util.mjs').Exec} */
  const spy = (argv, opts) => { calls.push([...argv, `cwd=${opts.cwd}`]); return fakeExec(argv, opts); };
  let out = '';
  const code = await main(['--root', dir, 'check', '--only', 'S2-LINT-*', '--report', join(dir, 'r.json')], { cwd: dir, env: { SQUARE2_TODAY: '2026-11-20' }, stdout: (t) => { out += t; }, stderr: () => {}, exec: spy, resolveBin: fakeResolveBin });
  assert.equal(code, 0, out);
  const lint = calls.filter((c) => c[0] === 'fake-eslint' && !c.includes('--version'));
  assert.equal(lint.length, 2, 'one stdin call for the single fixture file, one batched call for the repository');
  for (const c of lint) assert.equal(c[c.indexOf('--config') + 1], join(dir, 'eslint.config.mjs'));
  const [fixture, repo] = lint;
  assert.ok(fixture.includes('--no-ignore') && fixture.includes('--stdin') && fixture.at(-1) === `cwd=${dir}`, 'fixtures: stdin, --no-ignore, cwd = repository root');
  assert.equal(fixture[fixture.indexOf('--stdin-filename') + 1], join(dir, 'apps', '__square2_fixture__', 'apps', 'x', 'a.ts'));
  assert.ok(!repo.includes('--no-ignore') && repo.indexOf('--') > repo.indexOf('--config'), 'repository run: files after --, ignores respected');
});

test('ruff: relative command path resolves against the repository root; cwd = repository root', async () => {
  const dir = copyMiniRepo();
  writeFileSync(join(dir, '.square2', 'config.yaml'), 'engines:\n  ruff:\n    command:\n      - python/.venv/bin/ruff\n');
  /** @type {string[][]} */
  const calls = [];
  /** @type {import('../src/cli/engine-util.mjs').Exec} */
  const spy = (argv, opts) => {
    calls.push([...argv, `cwd=${opts.cwd}`]);
    return fakeExec(['ruff', ...argv.slice(1)], opts);
  };
  const code = await main(['--root', dir, 'check', '--only', 'S2-PY-*', '--report', join(dir, 'r.json')], { cwd: dir, env: { SQUARE2_TODAY: '2026-11-20' }, stdout: () => {}, stderr: () => {}, exec: spy, resolveBin: fakeResolveBin });
  assert.equal(code, 0);
  const checks = calls.filter((c) => c.includes('check'));
  assert.equal(checks.length, 2);
  for (const c of checks) {
    assert.equal(c[0], join(dir, 'python', '.venv', 'bin', 'ruff'));
    assert.equal(c.at(-1)?.startsWith('cwd='), true);
    assert.equal(c.at(-1), `cwd=${dir}`);
    const files = c.slice(c.indexOf('--') + 1, -1);
    assert.ok(files.length > 0 && files.every((f) => f.startsWith('/') && f.endsWith('.py')));
  }
  assert.deepEqual(parseConfig('engines:\n  ruff:\n    command:\n      - uv\n      - run\n      - --project\n      - python\n      - ruff\n').config.engines.ruff?.command, ['uv', 'run', '--project', 'python', 'ruff']);
});

// 4. realpath-aware relative paths, win32 paths
test('relativeToRoot compares real paths and handles win32 drive paths', () => {
  const base = tempDir('square2-real-path-');
  const real = join(base, 'real');
  mkdirSync(join(real, 'src'), { recursive: true });
  writeFileSync(join(real, 'src', 'a.ts'), '');
  symlinkSync(real, join(base, 'alias'));
  assert.equal(relativeToRoot(join(base, 'alias'), join(realpathSync(real), 'src', 'a.ts')), 'src/a.ts');
  assert.equal(relativeToRoot(real, join(base, 'alias', 'src', 'a.ts')), 'src/a.ts');
  assert.equal(relativeToRoot('C:\\work\\repo', 'C:\\work\\repo\\apps\\x.ts', 'win32'), 'apps/x.ts');
  assert.equal(relativeToRoot('C:\\work\\repo', 'apps\\x.ts', 'win32'), 'apps/x.ts');
});

// 5. node tools via package.json bin + process.execPath
test('resolveNodeBin reads the package bin field and runs it with the current node', () => {
  const dir = tempDir('square2-bin-');
  mkdirSync(join(dir, 'node_modules', 'tool-a', 'bin'), { recursive: true });
  writeFileSync(join(dir, 'node_modules', 'tool-a', 'package.json'), '{ "name": "tool-a", "bin": { "toola": "bin/cli.mjs", "other": "x.js" } }');
  writeFileSync(join(dir, 'node_modules', 'tool-a', 'bin', 'cli.mjs'), '');
  mkdirSync(join(dir, 'node_modules', '@s', 'tool-b'), { recursive: true });
  writeFileSync(join(dir, 'node_modules', '@s', 'tool-b', 'package.json'), '{ "name": "@s/tool-b", "bin": "main.js" }');
  writeFileSync(join(dir, 'node_modules', '@s', 'tool-b', 'main.js'), '');
  assert.deepEqual(resolveNodeBin(dir, 'toola', 'tool-a'), [process.execPath, join(dir, 'node_modules', 'tool-a', 'bin', 'cli.mjs')]);
  assert.deepEqual(resolveNodeBin(dir, 'b', '@s/tool-b'), [process.execPath, join(dir, 'node_modules', '@s', 'tool-b', 'main.js')]);
  assert.throws(() => resolveNodeBin(dir, 'other', 'tool-a'), /not installed/);
  assert.throws(() => resolveNodeBin(dir, 'x', 'missing'), /not installed/);
});

// 6. vendor marker, lock path, CRLF, symlinks
function vendored() {
  const src = join(tempDir('square2-vsrc-'), 'square2');
  spawnSync('cp', ['-r', join(REPO, 'bin'), join(REPO, 'src'), join(REPO, 'schemas'), join(REPO, 'LICENSE'), src], { stdio: 'ignore' });
  mkdirSync(src, { recursive: true });
  for (const n of ['bin', 'src', 'schemas', 'LICENSE']) spawnSync('cp', ['-r', join(REPO, n), join(src, n)]);
  git(src, ['init', '--quiet']);
  git(src, ['add', '-A']);
  git(src, ['commit', '--quiet', '-m', 'r']);
  const consumer = copyMiniRepo();
  const res = runBin(['vendor', '--from', src, '--ref', 'HEAD'], { cwd: consumer });
  assert.equal(res.code, 0, res.stdout + res.stderr);
  return { src, consumer, tool: join(consumer, 'tools', 'square2') };
}

/** @param {string} cwd @param {string[]} args */
const runVendored = (cwd, args) => spawnSync(process.execPath, [join(cwd, 'tools', 'square2', 'bin', 'square2.mjs'), ...args], { cwd, encoding: 'utf8', env: { ...process.env, SQUARE2_TODAY: '2026-11-20' } });

test('vendor marker: deleting or redirecting the lock is tampering', () => {
  const { consumer, tool } = vendored();
  assert.ok(existsSync(join(tool, MARKER)));
  assert.equal(runVendored(consumer, ['selftest', '--only', 'S2-SUPPRESS-*']).status, 0);
  const lockPath = join(consumer, '.square2', 'lock.json');
  const lock = readFileSync(lockPath, 'utf8');
  writeFileSync(lockPath, lock.replace('"path": "tools/square2"', '"path": "tools/elsewhere"'));
  const redirected = runVendored(consumer, ['selftest']);
  assert.equal(redirected.status, 2);
  assert.match(redirected.stdout, /^\[S2-VENDOR-TAMPERED\] \.square2\/lock\.json names tools\/elsewhere, but this runner is tools\/square2/);
  spawnSync('rm', [lockPath]);
  const missing = runVendored(consumer, ['check']);
  assert.equal(missing.status, 2);
  assert.match(missing.stdout, /^\[S2-VENDOR-TAMPERED\] this runner is a vendored copy but \.square2\/lock\.json is missing/);
});

test('tree hash: CRLF text equals LF text, binary bytes are untouched, symlinks are refused', () => {
  const a = tempDir('square2-tree-a-');
  const b = tempDir('square2-tree-b-');
  writeFileSync(join(a, 'x.mjs'), 'line1\nline2\n');
  writeFileSync(join(b, 'x.mjs'), 'line1\r\nline2\r\n');
  assert.equal(treeSha256(a), treeSha256(b));
  writeFileSync(join(a, 'bin.dat'), Buffer.from([0, 13, 10, 1]));
  writeFileSync(join(b, 'bin.dat'), Buffer.from([0, 10, 1]));
  assert.notEqual(treeSha256(a), treeSha256(b));
  symlinkSync(join(a, 'x.mjs'), join(a, 'link.mjs'));
  assert.throws(() => treeSha256(a), TreeError);

  const { consumer, tool } = vendored();
  symlinkSync(join(tool, 'LICENSE'), join(tool, 'src', 'link'));
  assert.equal(verifyVendor({ root: consumer, dir: join(consumer, '.square2') }, tool).status, 'tampered');
});

test('vendor dereferences symlinks in the source and fails on dangling ones', () => {
  const src = join(tempDir('square2-vlink-'), 'square2');
  for (const n of ['bin', 'src', 'schemas', 'LICENSE']) {
    mkdirSync(src, { recursive: true });
    spawnSync('cp', ['-r', join(REPO, n), join(src, n)]);
  }
  symlinkSync('../LICENSE', join(src, 'src', 'LICENSE-link'));
  git(src, ['init', '--quiet']);
  git(src, ['add', '-A']);
  git(src, ['commit', '--quiet', '-m', 'r']);
  const consumer = copyMiniRepo();
  assert.equal(runBin(['vendor', '--from', src, '--ref', 'HEAD'], { cwd: consumer }).code, 0);
  assert.equal(readFileSync(join(consumer, 'tools', 'square2', 'src', 'LICENSE-link'), 'utf8'), readFileSync(join(REPO, 'LICENSE'), 'utf8'));
  symlinkSync('../nowhere', join(src, 'src', 'dangling'));
  git(src, ['add', '-A']);
  git(src, ['commit', '--quiet', '-m', 'dangling']);
  const res = runBin(['vendor', '--from', src, '--ref', 'HEAD'], { cwd: consumer });
  assert.equal(res.code, 2);
  assert.match(res.stdout, /^\[S2-VENDOR\] cannot copy/);
});

// 7. git env isolation, hooks off, signal cleanup
test('git subprocesses ignore GIT_DIR / GIT_WORK_TREE from the environment', async () => {
  const dir = copyMiniRepo();
  const other = copyMiniRepo();
  const saved = { GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE, GIT_INDEX_FILE: process.env.GIT_INDEX_FILE };
  process.env.GIT_DIR = join(other, '.git');
  process.env.GIT_WORK_TREE = other;
  process.env.GIT_INDEX_FILE = join(other, '.git', 'index');
  try {
    const res = await runGit(dir, ['rev-parse', '--show-toplevel']);
    assert.equal(res.stdout.trim(), realpathSync(dir));
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
  const viaBin = spawnSync(process.execPath, [BIN, 'check', '--only', 'S2-SUPPRESS-*', '--report', join(dir, 'r.json')], { cwd: dir, encoding: 'utf8', env: { ...process.env, SQUARE2_TODAY: '2026-11-20', GIT_DIR: join(other, '.git'), GIT_WORK_TREE: other } });
  assert.equal(viaBin.status, 0, viaBin.stdout + viaBin.stderr);
  assert.equal(JSON.parse(readFileSync(join(dir, 'r.json'), 'utf8')).head_sha, git(dir, ['rev-parse', 'HEAD']).trim());
});

const SUP_RULE = 'rules:\n  - id: S2-SUP-X\n    dune_rule: 5\n    engine: suppressions\n    scope: src/**\n    instead: fix it\n    owner: o\n';

/** @param {string} [extraRules] */
function smallHistory(extraRules = '') {
  const dir = join(tempDir('square2-hist-'), 'repo');
  mkdirSync(join(dir, '.square2', 'rules'), { recursive: true });
  mkdirSync(join(dir, '.square2', 'fixtures', 'S2-SUP-X', 'bad', 'src'), { recursive: true });
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, '.square2', 'rules', 'r.yaml'), SUP_RULE + extraRules);
  writeFileSync(join(dir, '.square2', 'fixtures', 'S2-SUP-X', 'bad', 'src', 'a.ts'), '// @ts-ignore\n');
  writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 1;\n');
  git(dir, ['init', '--quiet']);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '--quiet', '-m', 'c0 clean']);
  return dir;
}

test('replay worktrees run with hooks disabled', () => {
  const dir = smallHistory();
  writeFileSync(join(dir, 'src', 'b.ts'), '// @ts-ignore\nexport const b = 1;\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '--quiet', '-m', 'c1']);
  const hooks = join(dir, '.git', 'hooks');
  const marker = join(tempDir('square2-hook-'), 'ran');
  writeFileSync(join(hooks, 'post-checkout'), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
  const res = runBin(['replay', '--rule', 'S2-SUP-X', '--commit', 'HEAD'], { cwd: dir });
  assert.equal(res.code, 0, res.stdout + res.stderr);
  assert.equal(JSON.parse(res.stdout).commit.fires, true);
  assert.equal(existsSync(marker), false, 'post-checkout hook ran inside the replay worktree');
});

test('SIGINT during replay removes the temporary worktree', async () => {
  const slow = '  - id: S2-SLOW-X\n    dune_rule: 2\n    engine: command\n    scope: "**"\n    instead: wait\n    owner: o\n    options:\n      argv:\n        - node\n        - -e\n        - "setTimeout(() => {}, 20000)"\n';
  const dir = smallHistory(slow);
  mkdirSync(join(dir, '.square2', 'fixtures', 'S2-SLOW-X', 'bad'), { recursive: true });
  writeFileSync(join(dir, '.square2', 'fixtures', 'S2-SLOW-X', 'bad', 'x'), 'x');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '--quiet', '-m', 'fixture']);
  const child = spawn(process.execPath, [BIN, 'replay', '--rule', 'S2-SLOW-X', '--commit', 'HEAD'], { cwd: dir, stdio: 'ignore' });
  const deadline = Date.now() + 15000;
  while (git(dir, ['worktree', 'list']).trim().split('\n').length < 2) {
    if (Date.now() > deadline) throw new Error('worktree never appeared');
    await new Promise((r) => setTimeout(r, 50));
  }
  const tmpTree = git(dir, ['worktree', 'list', '--porcelain']).split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice(9))[1];
  child.kill('SIGINT');
  const signal = await new Promise((resolve) => child.on('exit', (_c, s) => resolve(s)));
  assert.equal(signal, 'SIGINT');
  assert.equal(git(dir, ['worktree', 'list']).trim().split('\n').length, 1);
  assert.equal(existsSync(tmpTree), false);
});

// 8. engine environment allowlist
test('engine subprocesses get an allowlisted environment without credentials', async () => {
  const env = engineEnv({ PATH: '/bin', HOME: '/h', GITHUB_TOKEN: 't', GH_TOKEN: 't', ACTIONS_RUNTIME_TOKEN: 't', ACTIONS_ID_TOKEN_REQUEST_URL: 'u', SQ2_AZURE_OPENAI_API_KEY: 'k', OPENAI_API_KEY: 'k', NODE_OPTIONS: '--require x', UV_CACHE_DIR: '/c', UV_PUBLISH_TOKEN: 't', VIRTUAL_ENV: '/v', RANDOM_VAR: 'x', LANG: 'C' }, { SQUARE2_ROOT: '/r' });
  assert.deepEqual(Object.keys(env).sort(), ['HOME', 'LANG', 'PATH', 'SQUARE2_ROOT', 'UV_CACHE_DIR', 'VIRTUAL_ENV']);
  const saved = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = 'secret-value';
  try {
    const res = await defaultExec([process.execPath, '-e', 'process.stdout.write(JSON.stringify(Object.keys(process.env)))'], { cwd: REPO });
    const keys = JSON.parse(res.stdout);
    assert.ok(!keys.includes('GITHUB_TOKEN') && !keys.includes('NODE_OPTIONS'));
  } finally {
    if (saved === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = saved;
  }
});

// 9. suppressions tokenizer vs tsc
const TS_CASES = [
  '// @ts-ignore', '/// @ts-ignore', '//// @ts-ignore', '//@ts-ignore', '// @ts-ignore: reason', '/* @ts-ignore */', '/** @ts-ignore */',
  '/*\n * @ts-ignore\n */', '/*\n@ts-ignore */', '/**\n * text\n @ts-ignore */', '// text @ts-ignore', '/* text @ts-ignore */', '// @ts-ignored',
  '// @ts-expect-error', '/// @ts-expect-error', '/** @ts-expect-error */', '/*\n * @ts-expect-error */',
];
const NOCHECK_CASES = [
  '// @ts-nocheck\n', '/// @ts-nocheck\n', '/* @ts-nocheck */\n', '/** @ts-nocheck */\n', 'const pre = 1;\n// @ts-nocheck\n', '// text @ts-nocheck\n', '//@ts-nocheck\n', '//// @ts-nocheck\n',
];
const TSC = join(REPO, 'node_modules', 'typescript', 'bin', 'tsc');

test('TS directives agree with the installed tsc', { skip: !existsSync(TSC) && 'typescript not installed' }, () => {
  const dir = tempDir('square2-tsc-');
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'tsconfig.json'), '{ "compilerOptions": { "strict": true, "noEmit": true, "target": "es2022", "module": "esnext", "skipLibCheck": true, "types": [] }, "include": ["src/*.ts"] }');
  /** @type {Map<string, string>} */
  const sources = new Map();
  TS_CASES.forEach((c, i) => sources.set(`c${i}.ts`, `${c}\nconst x${i}: number = "s";\nexport {};\n`));
  NOCHECK_CASES.forEach((c, i) => sources.set(`n${i}.ts`, `${c}const n${i}: number = "s";\nexport {};\n`));
  for (const [f, text] of sources) writeFileSync(join(dir, 'src', f), text);
  const res = spawnSync(process.execPath, [TSC, '-p', dir], { encoding: 'utf8' });
  const withErrors = new Set([...res.stdout.matchAll(/src\/([a-z0-9]+\.ts)/g)].map((m) => m[1]));
  for (const [f, text] of sources) {
    const honoured = !withErrors.has(f);
    const reported = scan(f, text).some((s) => s.subject.startsWith('@ts-'));
    assert.equal(reported, honoured, `${f}: ${JSON.stringify(text.split('\n')[0])} tsc honours=${honoured}`);
  }
  assert.ok(readdirSync(join(dir, 'src')).length === sources.size);
});

test('tokenizer: division vs regex by previous token, JSX closers, string line continuations', () => {
  const cases = /** @type {[string, string[]][]} */ ([
    ['let i = 0; i++ / 2; // eslint-disable-line no-a', ['eslint-disable-line no-a']],
    ['const r = (a) / 2 // eslint-disable-line no-b', ['eslint-disable-line no-b']],
    ['const r = arr[0] / 2; // eslint-disable-line no-c', ['eslint-disable-line no-c']],
    ['const r = x / y / z; // eslint-disable-line no-d', ['eslint-disable-line no-d']],
    ['const o = {}/2; // eslint-disable-line no-e', ['eslint-disable-line no-e']],
    ['const g = f<T>(a) / 2; // eslint-disable-line no-f', ['eslint-disable-line no-f']],
    ['const j = <a href="x">link</a>; // eslint-disable-line no-g', ['eslint-disable-line no-g']],
    ['const k = 3 / 4 / 5; // @ts-ignore', ['@ts-ignore']],
    ['const re = /\\/\\/ eslint-disable/; // eslint-disable-line no-h', ['eslint-disable-line no-h']],
    ['if (x) /\\/\\/ eslint-disable-line/.test(s);', []],
  ]);
  for (const [src, expected] of cases) assert.deepEqual(scan('a.tsx', src).map((s) => s.subject), expected, src);
  const cont = 'const s = "a\\\nb";\n// eslint-disable-next-line no-x\n';
  assert.equal(scan('a.ts', cont)[0].line, 3);
  assert.deepEqual(scan('m.py', 'x = 1  # noqa : E501, F401 - long line\n'), [{ subject: 'noqa E501,F401', line: 1, hasReason: true }]);
  assert.deepEqual(scan('m.py', 'x = 1  # noqa :E501\n'), [{ subject: 'noqa E501', line: 1, hasReason: false }]);
});

// 10. --base unresolved; base blobs read relative to the git top level
test('--base that does not resolve exits 2 with S2-BASE-UNRESOLVED', async () => {
  const dir = copyMiniRepo();
  for (const base of ['f'.repeat(40), 'no-such-branch', '--exec=x']) {
    const res = await runMain(['check', `--base=${base}`, '--report', join(dir, 'r.json')], { cwd: dir });
    assert.equal(res.code, 2, base);
    assert.match(res.stdout, /^\[S2-BASE-UNRESOLVED\] --base .* is not a commit in this repository — Instead: fetch the base commit \(actions\/checkout with fetch-depth: 0\)/);
  }
  assert.equal((await runMain(['exceptions', 'lint', '--base', 'f'.repeat(40)], { cwd: dir })).code, 2);
});

test('--root below the git top level reads <base>:<prefix>/.square2/... for the ratchet', async () => {
  const top = join(tempDir('square2-mono-'), 'mono');
  mkdirSync(top, { recursive: true });
  spawnSync('cp', ['-r', join(REPO, 'test', 'fixtures', 'mini-repo'), join(top, 'pkg')]);
  git(top, ['init', '--quiet']);
  git(top, ['add', '-A']);
  git(top, ['commit', '--quiet', '-m', 'init']);
  const base = git(top, ['rev-parse', 'HEAD']).trim();
  const pkg = join(top, 'pkg');
  writeFileSync(join(pkg, 'apps', 'web', 'src', 'more.ts'), '// @ts-ignore -- generated\nexport const m = 1;\n');
  assert.equal((await runMain(['baseline', 'grow', '--approval', 'A-0001'], { cwd: pkg })).code, 0);
  const res = await runMain(['check', '--base', base, '--report', join(pkg, 'r.json')], { cwd: pkg });
  assert.equal(res.code, 1, res.stdout);
  assert.match(res.stdout, /^\[S2-BASELINE-GREW\] \.square2\/baseline\.json \+1 entries without an approval/m);
});

// 11. replay compares <sha> with <sha>^ only
test('replay: parent.fires does not look at the grandparent', () => {
  const dir = smallHistory();
  writeFileSync(join(dir, 'src', 'z.ts'), '// @ts-ignore\nexport const z = 1;\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '--quiet', '-m', 'c1 introduces z']);
  writeFileSync(join(dir, 'src', 'x.ts'), '// @ts-ignore\nexport const x = 1;\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '--quiet', '-m', 'c2 introduces x']);
  const c2 = JSON.parse(runBin(['replay', '--rule', 'S2-SUP-X', '--commit', 'HEAD'], { cwd: dir }).stdout);
  assert.equal(c2.commit.fires, true);
  assert.equal(c2.parent.fires, false, 'c1 firing on z must not make the parent "fire" for x');
  writeFileSync(join(dir, 'src', 'x.ts'), '// @ts-ignore\nexport const x = 1;\n// @ts-ignore\nexport const y = 2;\n');
  git(dir, ['commit', '--quiet', '-am', 'c3 duplicates the x suppression']);
  const c3 = JSON.parse(runBin(['replay', '--rule', 'S2-SUP-X', '--commit', 'HEAD'], { cwd: dir }).stdout);
  assert.equal(c3.commit.fires, true, 'a second occurrence fires newly (multiset)');
  assert.equal(c3.parent.fires, true, 'but the parent already had that fingerprint');
});

// 13. batching
test('selftest lints each eslint fixture file once via stdin; check stays fast on the mini repo', async () => {
  const dir = copyMiniRepo();
  const extra = ['S2-LINT-B', 'S2-LINT-C'].map((id) => `  - id: ${id}\n    dune_rule: 2\n    engine: eslint\n    scope: apps/**\n    instead: use the logger\n    owner: platform\n    options:\n      rule: no-console\n`).join('');
  writeFileSync(join(dir, '.square2', 'rules', 'lint.yaml'), readFileSync(join(dir, '.square2', 'rules', 'lint.yaml'), 'utf8') + extra);
  for (const id of ['S2-LINT-B', 'S2-LINT-C']) {
    mkdirSync(join(dir, '.square2', 'fixtures', id, 'bad', 'apps'), { recursive: true });
    writeFileSync(join(dir, '.square2', 'fixtures', id, 'bad', 'apps', 'a.ts'), 'console.log(1);\n');
  }
  let lintCalls = 0;
  /** @type {import('../src/cli/engine-util.mjs').Exec} */
  const spy = (argv, opts) => { if (argv[0] === 'fake-eslint' && !argv.includes('--version')) lintCalls++; return fakeExec(argv, opts); };
  const t0 = performance.now();
  const code = await main(['--root', dir, 'selftest'], { cwd: dir, env: { SQUARE2_TODAY: '2026-11-20' }, stdout: () => {}, stderr: () => {}, exec: spy, resolveBin: fakeResolveBin });
  assert.equal(code, 0);
  assert.equal(lintCalls, 3, 'one stdin call per fixture file (run in parallel)');
  const check = await runMain(['check', '--report', join(dir, 'r.json')], { cwd: dir });
  assert.equal(check.code, 0, check.stdout);
  assert.ok(performance.now() - t0 < 15000, `mini-repo selftest + check took ${performance.now() - t0} ms`);
});

// 14. provenance JSON shapes, engine config paths
test('replay report null / non-object is a catalogue error, not a crash', () => {
  const text = 'rules:\n  - id: S2-A-B\n    dune_rule: 2\n    engine: command\n    scope: "**"\n    instead: x\n    owner: o\n    born_from: abcdef1\n';
  for (const report of ['null', '[]', '"x"', '{"rule_id":"S2-A-B","commit":null,"parent":null}']) {
    const res = validateCatalogue([{ path: 'r.yaml', text }], { fixtureDirExists: () => true, requireProvenance: true, readReplay: () => report });
    assert.equal(res.exitCode, 2, report);
    assert.match(res.diagnostics[0], /^\[S2-CATALOGUE\] S2-A-B (replay report is not a JSON object|replay does not show firing)/);
  }
});

test('engines.*.config must be repo-relative', () => {
  for (const bad of ['../x.cjs', '/etc/x.cjs', 'C:/x.cjs', 'a/../../x']) {
    const res = parseConfig(`engines:\n  depcruise:\n    config: "${bad}"\n`);
    assert.ok(res.diagnostics.some((d) => d.startsWith('[S2-CONFIG] .square2/config.yaml: engines.depcruise.config must be a repo-relative path')), bad);
  }
  assert.equal(parseConfig('engines:\n  eslint:\n    config: ./tools/eslint.config.mjs\n').config.engines.eslint?.config, 'tools/eslint.config.mjs');
});

// 15. --only empty
test('--only matching no rule exits 2', async () => {
  const dir = copyMiniRepo();
  for (const cmd of ['check', 'selftest']) {
    const res = await runMain([cmd, '--only', 'S2-NOPE-*'], { cwd: dir });
    assert.equal(res.code, 2);
    assert.match(res.stdout, /^\[S2-ONLY-EMPTY\] --only "S2-NOPE-\*" matches no rule — Instead: /);
  }
});

// 16. baseline grow/shrink guards
test('baseline grow/shrink refuse invalid exceptions; shrink keeps disabled rules', async () => {
  const dir = copyMiniRepo();
  const ex = join(dir, '.square2', 'exceptions.yaml');
  const original = readFileSync(ex, 'utf8');
  writeFileSync(ex, original.replace('scope: apps/web/legacy/**', 'scope: "**"'));
  for (const cmd of [['baseline', 'shrink'], ['baseline', 'grow', '--approval', 'A-0001']]) {
    const res = await runMain(cmd, { cwd: dir });
    assert.equal(res.code, 1, cmd.join(' '));
    assert.match(res.stdout, /\[S2-BASELINE-REFUSED\] baseline (shrink|grow) refused while \.square2\/exceptions\.yaml is invalid/);
  }
  writeFileSync(ex, original);
  const rules = join(dir, '.square2', 'rules', 'python.yaml');
  writeFileSync(rules, readFileSync(rules, 'utf8').replace('    owner: platform\n', '    owner: platform\n    enabled: false\n'));
  writeFileSync(join(dir, 'apps', 'web', 'src', 'db.ts'), 'export const pool = null;\n');
  const shrunk = await runMain(['baseline', 'shrink'], { cwd: dir });
  assert.equal(shrunk.stdout.trim(), 'baseline: 7 -> 6 entries');
  const doc = JSON.parse(readFileSync(join(dir, '.square2', 'baseline.json'), 'utf8'));
  assert.ok(doc.entries.some((/** @type {{ rule_id: string }} */ e) => e.rule_id === 'S2-PY-BANNED-IMPORT'), 'disabled rule entry dropped');
  assert.ok(!doc.entries.some((/** @type {{ rule_id: string }} */ e) => e.rule_id === 'S2-DEP-NO-VENDOR'));
});

// 17. Instead hints never use flow lists
test('Instead hints use block-list wording (our YAML has no flow lists)', () => {
  /** @param {string} d @returns {string[]} */
  const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith('.mjs') ? [join(d, e.name)] : []));
  for (const f of walk(join(REPO, 'src'))) {
    const src = readFileSync(f, 'utf8');
    assert.doesNotMatch(src, /\[(?:uvx|uv|node|python|pipx|ruff)\s*,/, f);
  }
});

// 18. symlinks in fixture walks
test('walkFiles skips broken and cyclic symlinks with warnings', () => {
  const dir = tempDir('square2-walk-');
  mkdirSync(join(dir, 'a', 'b'), { recursive: true });
  writeFileSync(join(dir, 'a', 'b', 'x.ts'), '');
  symlinkSync(join(dir, 'missing'), join(dir, 'a', 'broken.ts'));
  symlinkSync(join(dir, 'a'), join(dir, 'a', 'b', 'loop'));
  /** @type {string[]} */
  const warnings = [];
  const files = walkFiles(dir, (w) => warnings.push(w));
  assert.deepEqual(files, ['a/b/x.ts']);
  assert.ok(warnings.some((w) => w.includes('broken symlink a/broken.ts')));
  assert.ok(warnings.some((w) => w.includes('symlink cycle at a/b/loop')));
});
