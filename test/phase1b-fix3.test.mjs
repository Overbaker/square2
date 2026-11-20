import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { main } from '../src/cli/main.mjs';
import { resolveNodeBin } from '../src/cli/engine-util.mjs';
import { mirrorNodeModules } from '../src/cli/replay.mjs';
import { verifyVendor } from '../src/cli/vendor.mjs';
import { fixtureVirtualPath } from '../src/engines/eslint.mjs';
import { selectorCovers, selection } from '../src/engines/ruff.mjs';
import { loadTypescript, scanSuppressions } from '../src/engines/suppressions.mjs';
import { REPO, cleanupTemps, copyMiniRepo, git, runBin, runMain, tempDir } from './cli-helpers.mjs';
import { fakeExec, fakeResolveBin } from './engine-fakes.mjs';

after(cleanupTemps);

const TS = loadTypescript(REPO);
const TSC = join(REPO, 'node_modules', 'typescript', 'bin', 'tsc');
const TOOLS = process.env.SQUARE2_TOOLS_REPO ?? '';
const RUFF = TOOLS && join(TOOLS, 'python', '.venv', 'bin', 'ruff');
const HAVE_RUFF = Boolean(RUFF) && existsSync(RUFF);
const HAVE_NODE_TOOLS = TOOLS !== '' && existsSync(join(TOOLS, 'node_modules', 'eslint', 'package.json')) && existsSync(join(TOOLS, 'node_modules', 'dependency-cruiser', 'package.json'));

/**
 * @param {string} dir
 * @param {Record<string, string>} files
 */
function write(dir, files) {
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(join(dir, p, '..'), { recursive: true });
    writeFileSync(join(dir, p), text);
  }
}

// 1. JS/TS comments come from the repository's TypeScript
const LEXING_CASES = [
  ['arrow regex with a backtick', 'const f = (a: string) => /`/.test(a); // @ts-ignore'],
  ['regex after if header', 'declare const s: string;\nif (s) /\\/\\/ x/.test(s); // @ts-ignore'],
  ['regex after while header', 'declare let s: string;\nwhile (s) /a/.exec(s); // @ts-ignore'],
  ['regex after block', '{ }\n/ab/.test("x"); // @ts-ignore'],
  ['export default regex', 'export default /`/; // @ts-ignore'],
  ['division after call', 'declare function g(): number;\nconst d = g() / 2 / 3; // @ts-ignore'],
  ['template with nested template', 'const t = `a ${`b ${1}`} c`; // @ts-ignore'],
  ['comment marker in a string', 'const s = "// @ts-ignore";'],
  ['comment marker in a template', 'const s = `/* @ts-ignore */`;'],
  ['comment marker in a regex', 'const r = /\\/\\/ @ts-ignore/;'],
];
const JSX_CASES = [
  ['JSX apostrophe', "declare const React: any;\nconst j = <p>don't // @ts-ignore</p>;"],
  ['JSX text marker then real comment', "declare const React: any;\nconst j = <p>it's /* x */</p>; // @ts-ignore"],
];

test('TS directives after tricky lexing contexts agree with tsc', { skip: !existsSync(TSC) && 'typescript not installed' }, () => {
  const dir = tempDir('square2-lex-');
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'tsconfig.json'), '{ "compilerOptions": { "strict": true, "noEmit": true, "target": "es2022", "module": "esnext", "jsx": "preserve", "skipLibCheck": true, "types": [] }, "include": ["src/*"] }');
  /** @type {[string, string, string][]} */
  const files = [];
  LEXING_CASES.forEach(([name, src], i) => files.push([name, `l${i}.ts`, `${src}\nconst bad${i}: number = "s";\nexport {};\n`]));
  JSX_CASES.forEach(([name, src], i) => files.push([name, `j${i}.tsx`, `${src}\nconst bad${i}: number = "s";\nexport {};\n`]));
  for (const [, f, text] of files) writeFileSync(join(dir, 'src', f), text);
  const res = spawnSync(process.execPath, [TSC, '-p', dir], { encoding: 'utf8' });
  /** @type {Map<string, Set<number>>} */
  const errorLines = new Map();
  for (const m of res.stdout.matchAll(/src\/([a-z0-9]+\.tsx?)\((\d+),\d+\): error TS2322/g)) {
    const set = errorLines.get(m[1]) ?? new Set();
    set.add(Number(m[2]));
    errorLines.set(m[1], set);
  }
  for (const [name, f, text] of files) {
    const badLine = text.split('\n').findIndex((l) => l.startsWith('const bad')) + 1;
    const honoured = !(errorLines.get(f) ?? new Set()).has(badLine);
    const reported = scanSuppressions(f, text, TS).some((s) => s.subject === '@ts-ignore' && s.line === badLine - 1);
    assert.equal(reported, honoured, `${name}: tsc honours=${honoured}`);
  }
});

test('every directive in a comment is reported; eslint codes stop at @ts-', () => {
  const src = ['/*', ' eslint-disable no-console', ' @ts-ignore */', 'const x: number = 1;', '/* eslint-disable-line a -- why */ export {};'].join('\n');
  assert.deepEqual(scanSuppressions('a.ts', src, TS).map((s) => [s.line, s.subject, s.hasReason]), [
    [1, 'eslint-disable no-console', false],
    [3, '@ts-ignore', false],
    [5, 'eslint-disable-line a', true],
  ]);
});

test('a repository with JS/TS files in scope and no typescript exits 2', () => {
  const dir = copyMiniRepo();
  const env = { SQUARE2_TYPESCRIPT: '' };
  const res = runBin(['check', '--only', 'S2-SUPPRESS-*', '--report', join(dir, 'r.json')], { cwd: dir, env });
  assert.equal(res.code, 2);
  assert.match(res.stdout, /^\[S2-ENGINE-MISSING\] suppressions needs typescript — Instead: add typescript to the repo's devDependencies$/m);
  const py = copyMiniRepo();
  const rules = join(py, '.square2', 'rules', 'suppressions.yaml');
  writeFileSync(rules, readFileSync(rules, 'utf8').replaceAll('      - apps/**\n', ''));
  for (const id of ['S2-SUPPRESS-UNREGISTERED']) {
    mkdirSync(join(py, '.square2', 'fixtures', id, 'bad', 'python'), { recursive: true });
    writeFileSync(join(py, '.square2', 'fixtures', id, 'bad', 'python', 'a.py'), 'x = 1  # noqa\n');
  }
  const ok = runBin(['selftest', '--only', 'S2-SUPPRESS-*'], { cwd: py, env });
  assert.equal(ok.code, 0, 'Python-only scopes need no typescript: ' + ok.stdout);
});

test('the repository\'s own typescript wins over the test override', () => {
  const dir = tempDir('square2-tsown-');
  write(dir, { 'package.json': '{}', 'node_modules/typescript/package.json': '{ "name": "typescript", "version": "0.0.0-fake", "main": "index.js" }', 'node_modules/typescript/index.js': 'module.exports = { version: "0.0.0-fake" };' });
  assert.equal(loadTypescript(dir, { SQUARE2_TYPESCRIPT: join(REPO, 'node_modules', 'typescript') })?.version, TS.version, 'a package without the JS API is not usable, so the override applies');
  assert.equal(loadTypescript(dir, {}), null);
});

// 2. Python: file-level noqa, line counting, agreement with ruff
const L = 'a'.repeat(30);
const PY_CORPUS = /** @type {[string, string, number[]][]} */ ([
  ['p01', `x = "${L}"  # noqa: E501\n`, []],
  ['p02', `x = "${L} # noqa: E501"\n`, [1]],
  ['p03', `"""${L} # noqa"""\n`, [1]],
  ['p04', `x = r'\\\\'  # ${L}\ny = "${L}"  # noqa\n`, [1]],
  ['p05', `# flake8: noqa\nx = "${L}"\n`, []],
  ['p06', `# ruff: noqa\nx = "${L}"\n`, []],
  ['p07', `# ruff: noqa: E501\nx = "${L}"\n`, []],
  ['p08', `s = r"""a\\\nb ${L}\n"""\ny = "${L}"  # noqa: E501\n`, [2]],
  ['p09', `x = 'a' \\\n    "${L}"  # noqa: E501\n`, []],
  ['p10', `x = "${L}"  # noqa : E501\n`, []],
  ['p11', `x = f"{1!r} ${L} # noqa"\n`, [1]],
  ['p12', `x = "${L}"  #noqa\n`, []],
  ['p13', `x = "${L}"  # NOQA\n`, []],
  ['p14', `x = "${L}"  # type: ignore\n`, [1]],
  ['p15', `x = "${L}"  # some text # noqa: E501\n`, []],
  ['p16', `def f():\n    """Doc \\\n    # noqa ${L}\n    """\n    return "${L}"  # noqa: E501\n`, [3]],
  ['p17', `x = '${L}'  # flake8: noqa\n`, [1]],
]);

/**
 * Long lines (> 20 chars) the scanner says are NOT suppressed for E501.
 * @param {string} f
 * @param {string} src
 */
function unsuppressed(f, src) {
  const sup = scanSuppressions(`${f}.py`, src, null);
  const fileWide = sup.some((s) => /^(?:ruff|flake8): noqa(?: E501)?$/.test(s.subject));
  const lines = new Set(sup.filter((s) => /^noqa(?: |$)/.test(s.subject)).map((s) => s.line));
  return src.split('\n').map((l, i) => [l.length, i + 1]).filter(([n, i]) => n > 20 && !fileWide && !lines.has(i)).map(([, i]) => i);
}

test('Python suppressions: file-level noqa, raw/triple strings, backslash-newlines (recorded ruff 0.16.6 results)', () => {
  for (const [f, src, expected] of PY_CORPUS) assert.deepEqual(unsuppressed(f, src), expected, f);
  assert.deepEqual(scanSuppressions('m.py', '# flake8: noqa\nx = 1\n', null).map((s) => s.subject), ['flake8: noqa']);
  assert.deepEqual(scanSuppressions('m.py', 'x = 1  # flake8: noqa\n', null), [], 'trailing file-level directives suppress nothing');
});

test('Python suppressions agree with the real ruff', { skip: !HAVE_RUFF && 'set SQUARE2_TOOLS_REPO to a repository with python/.venv/bin/ruff' }, () => {
  const dir = tempDir('square2-pyc-');
  for (const [f, src] of PY_CORPUS) writeFileSync(join(dir, `${f}.py`), src);
  const res = spawnSync(RUFF, ['check', '--isolated', '--select', 'E501', '--line-length', '20', '--output-format', 'json', '--no-cache', '--exit-zero', '.'], { cwd: dir, encoding: 'utf8' });
  /** @type {Map<string, number[]>} */
  const byFile = new Map();
  for (const d of JSON.parse(res.stdout)) {
    const f = d.filename.split('/').at(-1).replace(/\.py$/, '');
    byFile.set(f, [...(byFile.get(f) ?? []), d.location.row].sort((a, b) => a - b));
  }
  for (const [f, src] of PY_CORPUS) assert.deepEqual(unsuppressed(f, src), byFile.get(f) ?? [], f);
});

// 3. mandatory vendor verification
test('vendor verification is mandatory with vendored_path, a lock, or the marker; invalid lock paths are tampering', () => {
  const dir = copyMiniRepo();
  const repo = { root: dir, dir: join(dir, '.square2') };
  const tool = join(REPO);
  assert.equal(verifyVendor(repo, tool).status, 'not-vendored');
  writeFileSync(join(dir, '.square2', 'config.yaml'), readFileSync(join(dir, '.square2', 'config.yaml'), 'utf8') + 'vendored_path: tools/square2\n');
  const declared = verifyVendor(repo, tool);
  assert.equal(declared.status, 'tampered');
  assert.match(/** @type {{ line: string }} */ (declared).line, /config declares vendored_path tools\/square2 but \.square2\/lock\.json is missing/);
  mkdirSync(join(dir, 'tools', 'square2'), { recursive: true });
  for (const bad of ['../outside', '/abs/square2', 'tools/./square2', 'tools/square2/']) {
    writeFileSync(join(dir, '.square2', 'lock.json'), JSON.stringify({ version: 'v', commit_sha: 'c', tree_sha256: 'x', path: bad }));
    const res = verifyVendor(repo, tool);
    assert.equal(res.status, 'tampered', bad);
    assert.match(/** @type {{ line: string }} */ (res).line, /is not a normalized repo-relative path/, bad);
  }
  writeFileSync(join(dir, '.square2', 'lock.json'), JSON.stringify({ version: 'v', commit_sha: 'c', tree_sha256: 'x', path: 'tools/other' }));
  assert.match(/** @type {{ line: string }} */ (verifyVendor(repo, tool)).line, /names tools\/other, but config vendored_path is tools\/square2/);
  const readme = readFileSync(join(REPO, 'README.md'), 'utf8');
  assert.ok(readme.includes('Threat model: detects accidental edits of the vendored copy; a committer can always change policy, which review of the commit must catch.'));
});

// 4. ESLint fixtures through stdin under a virtual path
test('eslint fixtures use a virtual path inside the rule scope', () => {
  const rule = { id: 'S2-L-X', dune_rule: 2, engine: 'eslint', scope: ['apps/**', 'libs/**'], exclude: [], instead: 'x', owner: 'o', enabled: true, options: { rule: 'no-console' }, file: 'r' };
  assert.equal(fixtureVirtualPath(rule, 'apps/x/a.ts'), 'apps/__square2_fixture__/apps/x/a.ts');
  assert.equal(fixtureVirtualPath({ ...rule, scope: ['**/*.ts'] }, 'a.ts'), '__square2_fixture__/a.ts');
});

test('real eslint: scoped config globs apply to fixtures kept in an external SQUARE2_DIR', { skip: !HAVE_NODE_TOOLS && 'set SQUARE2_TOOLS_REPO' }, async () => {
  const dir = join(tempDir('square2-eslint-'), 'repo');
  write(dir, {
    'eslint.config.mjs': "export default [{ files: ['apps/**/*.ts'], rules: { 'no-console': 'error' } }];\n",
    'apps/a/x.ts': 'console.log(1);\n',
  });
  git(dir, ['init', '--quiet']);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '--quiet', '-m', 'init']);
  const ext = tempDir('square2-ext-');
  write(ext, {
    'rules/r.yaml': 'rules:\n  - id: S2-LINT-NO-CONSOLE\n    dune_rule: 2\n    engine: eslint\n    scope: apps/**\n    instead: use the logger\n    owner: o\n    options:\n      rule: no-console\n',
    'fixtures/S2-LINT-NO-CONSOLE/bad/x.ts': 'console.log(1);\n',
  });
  let out = '';
  const code = await main(['--root', dir, '--square2-dir', ext, 'check', '--report', join(ext, 'r.json')], {
    cwd: dir, env: { SQUARE2_TODAY: '2026-11-20' }, stdout: (t) => { out += t; }, stderr: () => {}, resolveBin: (_r, n, p) => resolveNodeBin(TOOLS, n, p),
  });
  assert.equal(code, 1, out);
  assert.equal(out.trim(), '[S2-LINT-NO-CONSOLE] apps/a/x.ts:1 Unexpected console statement. — Instead: use the logger');
});

// 5. ruff selection and attribution
test('ruff selectors match exact code families; ALL covers everything', () => {
  assert.equal(selectorCovers('B', 'B006'), true);
  assert.equal(selectorCovers('B', 'BLE001'), false);
  assert.equal(selectorCovers('E5', 'E501'), true);
  assert.equal(selectorCovers('E5', 'E711'), false);
  assert.equal(selectorCovers('TID251', 'TID251'), true);
  assert.equal(selectorCovers('TID', 'TID251'), true);
  assert.equal(selectorCovers('ALL', 'PLR0913'), true);
});

test('ruff merges only identical effective selections', async () => {
  const dir = copyMiniRepo();
  const rule = (/** @type {string} */ id, /** @type {string} */ opts) => `  - id: ${id}\n    dune_rule: 2\n    engine: ruff\n    scope: python/**\n    instead: x\n    owner: o\n${opts}`;
  const rules = [
    rule('S2-PY-DEFAULT', ''),
    rule('S2-PY-TID-A', '    options:\n      select: TID251\n'),
    rule('S2-PY-TID-B', '    options:\n      select:\n        - TID251\n'),
    rule('S2-PY-ALL', '    options:\n      select: ALL\n'),
    rule('S2-PY-TID-IGN', '    options:\n      select: TID251\n      ignore: E501\n'),
  ];
  writeFileSync(join(dir, '.square2', 'rules', 'python.yaml'), 'rules:\n' + rules.join(''));
  for (const id of ['S2-PY-DEFAULT', 'S2-PY-TID-A', 'S2-PY-TID-B', 'S2-PY-ALL', 'S2-PY-TID-IGN']) {
    mkdirSync(join(dir, '.square2', 'fixtures', id, 'bad', 'python'), { recursive: true });
    writeFileSync(join(dir, '.square2', 'fixtures', id, 'bad', 'python', 'a.py'), 'import requests\n');
  }
  /** @type {string[][]} */
  const checks = [];
  /** @type {import('../src/cli/engine-util.mjs').Exec} */
  const spy = (argv, opts) => { if (argv.includes('check')) checks.push(argv); return fakeExec(argv, opts); };
  const code = await main(['--root', dir, 'selftest', '--only', 'S2-PY-*'], { cwd: dir, env: { SQUARE2_TODAY: '2026-11-20' }, stdout: () => {}, stderr: () => {}, exec: spy, resolveBin: fakeResolveBin });
  assert.equal(code, 0);
  const shapes = checks.map((c) => JSON.stringify([c.includes('--select') ? c[c.indexOf('--select') + 1] : null, c.includes('--ignore') ? c[c.indexOf('--ignore') + 1] : null])).sort();
  assert.deepEqual(shapes, ['["ALL",null]', '["TID251","E501"]', '["TID251",null]', '[null,null]'].sort(), 'TID-A and TID-B share one call; the others each get their own');
  assert.deepEqual(selection(/** @type {any} */ ({ options: { select: 'TID251, E5', ignore: ['E501'] } })), { select: ['E5', 'TID251'], ignore: ['E501'], args: [] });
});

// 6. replay sees the main checkout's dependency resolution
function workspaceRepo() {
  const dir = join(tempDir('square2-ws-'), 'repo');
  write(dir, {
    '.gitignore': 'node_modules/\n',
    'package.json': '{ "name": "root", "private": true }\n',
    'packages/lib/package.json': '{ "name": "@w/lib", "version": "1.0.0", "main": "index.js" }\n',
    'packages/lib/index.js': 'module.exports = 1;\n',
    'apps/a/package.json': '{ "name": "a", "private": true }\n',
    'apps/a/src/x.js': 'module.exports = 0;\n',
    '.dependency-cruiser.cjs': "module.exports = { forbidden: [{ name: 'no-lib', severity: 'error', from: { path: '^apps/' }, to: { path: '^packages/lib/' } }], options: { doNotFollow: { path: 'node_modules' } } };\n",
    '.square2/rules/r.yaml': 'rules:\n  - id: S2-DEP-NO-LIB\n    dune_rule: 2\n    engine: depcruise\n    scope: apps/**\n    instead: do not use lib\n    owner: o\n',
    '.square2/fixtures/S2-DEP-NO-LIB/bad/apps/x.js': 'module.exports = 0;\n',
  });
  mkdirSync(join(dir, 'apps', 'a', 'node_modules', '@w'), { recursive: true });
  symlinkSync('../../../../packages/lib', join(dir, 'apps', 'a', 'node_modules', '@w', 'lib'));
  mkdirSync(join(dir, 'node_modules', '.pnpm', 'pkg@1'), { recursive: true });
  writeFileSync(join(dir, 'node_modules', '.pnpm', 'pkg@1', 'index.js'), '');
  git(dir, ['init', '--quiet']);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '--quiet', '-m', 'c0']);
  writeFileSync(join(dir, 'apps', 'a', 'src', 'x.js'), "module.exports = require('@w/lib');\n");
  git(dir, ['commit', '--quiet', '-am', 'c1 uses lib']);
  return dir;
}

test('mirrorNodeModules recreates workspace links inside the worktree and links the rest to the main checkout', async () => {
  const dir = workspaceRepo();
  const tree = join(tempDir('square2-wt-'), 'tree');
  git(dir, ['worktree', 'add', '--detach', '--quiet', tree, 'HEAD']);
  try {
    assert.equal(await mirrorNodeModules(dir, tree), 2);
    assert.equal(realpathSync(join(tree, 'apps', 'a', 'node_modules', '@w', 'lib')), realpathSync(join(tree, 'packages', 'lib')));
    assert.equal(realpathSync(join(tree, 'node_modules', '.pnpm')), realpathSync(join(dir, 'node_modules', '.pnpm')));
    assert.equal(git(tree, ['status', '--porcelain']), '', 'mirrored links are ignored, the worktree stays clean');
    assert.equal(readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf8').includes('node_modules'), false, 'the shared exclude file is untouched');
  } finally {
    git(dir, ['worktree', 'remove', '--force', tree]);
  }
});

test('real depcruise replay resolves a workspace package dependency', { skip: !HAVE_NODE_TOOLS && 'set SQUARE2_TOOLS_REPO' }, async () => {
  const dir = workspaceRepo();
  writeFileSync(join(dir, '.square2', 'fixtures', 'S2-DEP-NO-LIB', 'bad', 'apps', 'x.js'), "require('../packages/lib/index.js');\n");
  write(join(dir, '.square2', 'fixtures', 'S2-DEP-NO-LIB', 'bad'), { 'packages/lib/index.js': '' });
  let out = '';
  const code = await main(['--root', dir, 'replay', '--rule', 'S2-DEP-NO-LIB', '--commit', 'HEAD'], {
    cwd: dir, env: {}, stdout: (t) => { out += t; }, stderr: () => {}, resolveBin: (_r, n, p) => resolveNodeBin(TOOLS, n, p),
  });
  assert.equal(code, 0, out);
  const report = JSON.parse(out);
  assert.equal(report.commit.fires, true, out);
  assert.equal(report.commit.new[0].subject, '@w/lib');
  assert.equal(report.parent.fires, false);
});

// 7. realpath-resolved --root / --square2-dir
test('--root through a symlink and a real --square2-dir still enforce the ratchet', async () => {
  const dir = copyMiniRepo();
  const alias = join(tempDir('square2-alias-'), 'alias');
  symlinkSync(dir, alias);
  const base = git(dir, ['rev-parse', 'HEAD']).trim();
  writeFileSync(join(dir, 'apps', 'web', 'src', 'more.ts'), '// @ts-ignore -- generated\nexport const m = 1;\n');
  assert.equal((await runMain(['baseline', 'grow', '--approval', 'A-0001'], { cwd: dir })).code, 0);
  let out = '';
  const code = await main(['--root', alias, '--square2-dir', realpathSync(join(dir, '.square2')), 'check', '--base', base, '--report', join(dir, 'r.json')], {
    cwd: alias, env: { SQUARE2_TODAY: '2026-11-20' }, stdout: (t) => { out += t; }, stderr: () => {}, exec: fakeExec, resolveBin: fakeResolveBin,
  });
  assert.equal(code, 1, out);
  assert.match(out, /^\[S2-BASELINE-GREW\] \.square2\/baseline\.json \+1 entries without an approval/m);
});

// 8. empty --only, selftest before baseline changes
test("--only '' or whitespace exits 2; baseline shrink/grow refuse a failing selftest", async () => {
  const dir = copyMiniRepo();
  for (const only of ['', '   ', ' , ']) {
    const res = await runMain(['check', `--only=${only}`], { cwd: dir });
    assert.equal(res.code, 2, JSON.stringify(only));
    assert.match(res.stdout, /^\[S2-ONLY-EMPTY\] /);
  }
  writeFileSync(join(dir, '.square2', 'fixtures', 'S2-ROUTE-LANES', 'bad', 'routes', 'router.txt'), 'orders.created fast\n');
  const before = readFileSync(join(dir, '.square2', 'baseline.json'), 'utf8');
  for (const cmd of [['baseline', 'shrink'], ['baseline', 'grow', '--approval', 'A-0001']]) {
    const res = await runMain(cmd, { cwd: dir });
    assert.equal(res.code, 2, cmd.join(' '));
    assert.match(res.stdout, /\[S2-SELFTEST\] S2-ROUTE-LANES did not fire/);
    assert.match(res.stdout, /\[S2-BASELINE-REFUSED\] baseline (shrink|grow) refused while the self-test fails/);
  }
  assert.equal(readFileSync(join(dir, '.square2', 'baseline.json'), 'utf8'), before);
});
