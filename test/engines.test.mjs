import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '../src/cli/config.mjs';
import { EngineError, defaultExec, globRoots, resolveNodeBin, ruleSelector } from '../src/cli/engine-util.mjs';
import { runRules } from '../src/cli/engines.mjs';
import { commandArgv, parseCommandOutput } from '../src/engines/command.mjs';
import { depcruiseRuleName, mapDepcruiseOutput } from '../src/engines/depcruise.mjs';
import { mapEslintOutput } from '../src/engines/eslint.mjs';
import { mapRuffOutput } from '../src/engines/ruff.mjs';
import { directives, hasReasonText, loadTypescript, pyComments, scanSuppressions, tsComments } from '../src/engines/suppressions.mjs';

const TS = loadTypescript(new URL('..', import.meta.url).pathname);
/** @param {string} p @param {string} src */
const scan = (p, src) => scanSuppressions(p, src, TS);

/** @param {Partial<import('../src/core/catalogue.mjs').Rule>} r @returns {import('../src/core/catalogue.mjs').Rule} */
const rule = (r) => ({ id: 'S2-X-Y', dune_rule: 2, engine: 'command', scope: ['**'], exclude: [], instead: 'fix it', owner: 'o', enabled: true, options: {}, file: 'r.yaml', ...r });

// suppressions: tokenizer
test('suppressions: text inside string literals is not reported', () => {
  const src = [
    'const a = "// eslint-disable";',
    "const b = '/* @ts-ignore */';",
    'const c = `// eslint-disable ${"// @ts-nocheck"} /* eslint-disable */`;',
    'const d = /\\/\\/ eslint-disable/g;',
    'const e = x / 2; // real comment',
  ].join('\n');
  assert.deepEqual(scan('a.ts', src), []);
  assert.deepEqual(tsComments(TS, 'a.ts', src).comments.map((c) => c.text.trim()), ['real comment']);
});

test('suppressions: nested template expressions and braces', () => {
  const src = 'const t = `a ${ {k: `inner ${1}`}.k } b`; // eslint-disable-line no-undef\n';
  assert.deepEqual(scan('a.ts', src), [{ subject: 'eslint-disable-line no-undef', line: 1, hasReason: false }]);
});

test('suppressions: every eslint-disable and @ts form', () => {
  const src = [
    '/* eslint-disable */',
    '/* eslint-disable no-alert, no-console */',
    '// eslint-disable-next-line no-console',
    'x(); // eslint-disable-line',
    '// @ts-expect-error',
    '// @ts-ignore',
    '// @ts-nocheck (after code: tsc ignores it)',
    '/**',
    ' * eslint-disable inside a doc block line is still a block-comment directive only at the start',
    ' */',
    '// TODO eslint-disable later',
  ].join('\n');
  assert.deepEqual(scan('a.mjs', src).map((s) => [s.line, s.subject]), [
    [1, 'eslint-disable'],
    [2, 'eslint-disable no-alert,no-console'],
    [3, 'eslint-disable-next-line no-console'],
    [4, 'eslint-disable-line'],
    [5, '@ts-expect-error'],
    [6, '@ts-ignore'],
  ]);
});

test('suppressions: python comments, strings and docstrings', () => {
  const src = [
    '"""Docstring with # noqa"""',
    "s = '# noqa'  # noqa: E501",
    "r = r'\\d+'  # type: ignore[attr-defined]",
    "f = f\"{x!r} # noqa\"",
    "'''",
    '# ruff: noqa inside a string',
    "'''",
    '# ruff: noqa: F401',
    'x = 1  # type: ignore  # noqa: E722',
  ].join('\n');
  assert.deepEqual(scan('m.py', src).map((s) => [s.line, s.subject]), [
    [2, 'noqa E501'],
    [3, 'type: ignore attr-defined'],
    [8, 'ruff: noqa F401'],
    [9, 'noqa E722'],
    [9, 'type: ignore'],
  ]);
  assert.equal(pyComments(src).length, 4);
});

test('suppressions: reason text forms (require_reason)', () => {
  const cases = [
    ['x = 1  # noqa: BLE001 - boundary catch logs and re-raises', true],
    ['x = 1  # noqa: BLE001 -- why', true],
    ['x = 1  # noqa: BLE001: why', true],
    ['x = 1  # noqa: BLE001 because the API is untyped', true],
    ['x = 1  # noqa: BLE001', false],
    ['x = 1  # noqa', false],
    ['x = 1  # noqa: BLE001 -', false],
  ];
  for (const [line, expected] of cases) assert.equal(scan('m.py', String(line))[0].hasReason, expected, String(line));
  assert.equal(scan('a.ts', '// eslint-disable-next-line no-console -- startup banner')[0].hasReason, true);
  assert.equal(scan('a.ts', '// eslint-disable-next-line no-console, no-alert')[0].hasReason, false);
  assert.equal(scan('a.ts', '// @ts-expect-error: upstream types are wrong')[0].hasReason, true);
  assert.equal(scan('a.ts', '// @ts-expect-error upstream types are wrong')[0].hasReason, false);
  assert.equal(scan('a.ts', '/* eslint-disable no-console -- legacy file */')[0].hasReason, true);
  assert.equal(scan('a.ts', '// reason: generated code\n// @ts-nocheck\nexport {};\n')[0].hasReason, true);
  assert.equal(scan('m.py', '# reason: vendored\nx = 1  # type: ignore')[0].hasReason, true);
  assert.equal(scan('m.py', '# reason: vendored\n\nx = 1  # type: ignore')[0].hasReason, false);
  assert.equal(hasReasonText(' because  '), false);
  assert.deepEqual(directives(' eslint-disable-next-line a, b: why', 'js'), [{ name: 'eslint-disable-next-line', codes: ['a', 'b'], rest: ': why' }]);
});

test('suppressions: other file types are ignored', () => {
  assert.deepEqual(scan('README.md', '// eslint-disable'), []);
});

// command
test('command: output parsing with and without line numbers', () => {
  const stdout = [
    '{"path":"a/b.ts","line":3,"subject":"x y"}',
    'noise line',
    'a/b.ts:4: old text protocol is ignored',
    '{"path":"c.txt","subject":"whole file"}',
    '{"path":"d.ts","line":0,"subject":"line 0 is dropped"}',
    '{"path":"","subject":"no path"}',
    '{"path":"e.ts","line":"7","subject":"string line is dropped"}',
    '[1,2]',
    '{"path":"f.ts" broken json',
    '  {"path":"g.ts","line":2,"subject":"indented"}  ',
  ].join('\n');
  assert.deepEqual(parseCommandOutput(stdout), [
    { path: 'a/b.ts', line: 3, subject: 'x y' },
    { path: 'c.txt', subject: 'whole file' },
    { path: 'd.ts', subject: 'line 0 is dropped' },
    { path: 'e.ts', subject: 'string line is dropped' },
    { path: 'g.ts', line: 2, subject: 'indented' },
  ]);
  const argv = commandArgv(rule({ options: { argv: ['node', 'scripts/x.mjs', '{root}', '--repo={repo}'] } }), '/t', '/r');
  assert.deepEqual(argv, [process.execPath, 'scripts/x.mjs', '/t', '--repo=/r']);
  assert.throws(() => commandArgv(rule({ options: {} }), '/t', '/r'), EngineError);
});

/** @param {string} script */
const commandRule = (script) => rule({ options: { argv: ['node', '-e', script] } });
const baseInput = { mode: /** @type {const} */ ('fixture'), config: parseConfig(null).config, excludes: [] };

test('command: non-zero exit without violation lines is an engine error (exit 2)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'square2-cmd-'));
  try {
    const res = await runRules({ ...baseInput, root: dir, repoRoot: dir, rules: [commandRule('console.error("boom"); process.exit(3)')] });
    assert.equal(res.errors.length, 1);
    assert.match(res.errors[0], /^\[S2-ENGINE-FAILED\] rule S2-X-Y: command exited 3 without violation lines: boom — Instead: /);
    const tailed = await runRules({ ...baseInput, root: dir, repoRoot: dir, rules: [commandRule('for (const l of ["a","b","c","d"]) console.error(l); process.exit(1)')] });
    assert.match(tailed.errors[0], /without violation lines: b \| c \| d — Instead: /);
    const textOnly = await runRules({ ...baseInput, root: dir, repoRoot: dir, rules: [commandRule('console.log("x.ts:2: bad thing"); process.exit(1)')] });
    assert.match(textOnly.errors[0], /^\[S2-ENGINE-FAILED\] /, 'non-JSON lines do not count as violations');
    const ok = await runRules({ ...baseInput, root: dir, repoRoot: dir, rules: [commandRule('console.log(JSON.stringify({ path: "x.ts", line: 2, subject: "bad thing" })); process.exit(1)')] });
    assert.deepEqual(ok.errors, []);
    assert.deepEqual(ok.violations.map((v) => [v.path, v.line, v.subject]), [['x.ts', 2, 'bad thing']]);
    const bad = await runRules({ ...baseInput, root: dir, repoRoot: dir, rules: [commandRule('console.log(JSON.stringify({ path: "/etc/passwd", line: 1, subject: "outside" }))')] });
    assert.match(bad.errors[0], /^\[S2-ADAPTER-INVALID\] /);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// depcruise / eslint / ruff output mapping
test('depcruise: maps rule names, relativizes paths and applies scope/exclude', () => {
  const r = rule({ id: 'S2-DEP-NO-VENDOR', engine: 'depcruise', scope: ['apps/**'], exclude: ['**/test/**'] });
  assert.equal(depcruiseRuleName(r), 'no-vendor');
  assert.equal(depcruiseRuleName({ ...r, options: { rule: 'custom-name' } }), 'custom-name');
  const out = JSON.stringify({ summary: { violations: [
    { from: 'apps/a/src/x.ts', to: 'pg', rule: { name: 'no-vendor' } },
    { from: 'apps/a/test/x.ts', to: 'pg', rule: { name: 'no-vendor' } },
    { from: 'apps/a/src/y.ts', to: 'ws', rule: { name: 'other-rule' } },
    { from: 'libs/z.ts', to: 'pg', rule: { name: 'no-vendor' } },
  ] } });
  assert.deepEqual(mapDepcruiseOutput('/r', out, [r], []), [{ rule_id: 'S2-DEP-NO-VENDOR', path: 'apps/a/src/x.ts', subject: 'pg', message: 'imports pg' }]);
  assert.throws(() => mapDepcruiseOutput('/r', 'not json', [r], []), EngineError);
});

test('eslint: maps messages of the configured rule', () => {
  const r = rule({ id: 'S2-LINT-NO-CONSOLE', engine: 'eslint', options: { rule: 'no-console' } });
  const out = JSON.stringify([{ filePath: '/r/a.ts', messages: [
    { ruleId: 'no-console', line: 3, column: 5, message: 'Unexpected console statement.' },
    { ruleId: 'no-undef', line: 4, column: 1, message: 'x is not defined' },
    { ruleId: null, fatal: true, message: 'Parsing error' },
  ] }]);
  assert.deepEqual(mapEslintOutput('/r', out, [r], []), [{ rule_id: 'S2-LINT-NO-CONSOLE', path: 'a.ts', line: 3, column: 5, subject: 'Unexpected console statement.', message: 'Unexpected console statement.' }]);
});

test('ruff: filters by selected codes and maps locations', () => {
  const r = rule({ id: 'S2-PY-BANNED-IMPORT', engine: 'ruff', scope: ['python/**'], exclude: ['python/gen/**'], options: { select: 'TID251' } });
  const out = JSON.stringify([
    { code: 'TID251', filename: '/r/python/a.py', location: { row: 2, column: 1 }, message: '`requests` is banned' },
    { code: 'E501', filename: '/r/python/a.py', location: { row: 3, column: 1 }, message: 'too long' },
    { code: 'TID251', filename: '/r/python/gen/b.py', location: { row: 1, column: 1 }, message: '`requests` is banned' },
  ]);
  assert.deepEqual(mapRuffOutput('/r', out, r, []), [{ rule_id: 'S2-PY-BANNED-IMPORT', path: 'python/a.py', line: 2, column: 1, subject: 'TID251 `requests` is banned', message: 'TID251 `requests` is banned' }]);
});

// missing tools
test('missing tools are typed engine errors with an Instead hint', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'square2-missing-'));
  try {
    assert.throws(() => resolveNodeBin(dir, 'depcruise', 'dependency-cruiser'), (e) => e instanceof EngineError && e.code === 'S2-ENGINE-MISSING' && /Instead: install dependency-cruiser/.test(e.diagnostic));
    await assert.rejects(defaultExec(['square2-no-such-tool-xyz'], { cwd: dir }), (e) => e instanceof EngineError && e.code === 'S2-ENGINE-MISSING');
    const config = parseConfig('engines:\n  ruff:\n    command:\n      - square2-no-such-ruff\n').config;
    const res = await runRules({ mode: 'fixture', config, excludes: [], root: dir, repoRoot: dir, rules: [rule({ id: 'S2-PY-X', engine: 'ruff' })] });
    assert.match(res.errors[0], /^\[S2-ENGINE-MISSING\] cannot run square2-no-such-ruff — Instead: install ruff on PATH or set engines\.ruff\.command/);
    const dc = await runRules({ mode: 'fixture', config, excludes: [], root: dir, repoRoot: dir, rules: [rule({ id: 'S2-DEP-X', engine: 'depcruise' })] });
    assert.match(dc.errors[0], /^\[S2-ENGINE-MISSING\] dependency-cruiser is not installed in the repository/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('helpers: glob roots and rule selection', () => {
  assert.deepEqual(globRoots(['apps/**', 'apps/web/src/**', 'libs/*.ts', 'python/**']), ['apps', 'libs', 'python']);
  assert.deepEqual(globRoots(['**/x.ts', 'apps/**']), ['.']);
  const select = ruleSelector({ scope: ['apps/**'], exclude: ['**/test/**'] }, ['apps/gen/**']);
  assert.equal(select('apps/a/x.ts'), true);
  assert.equal(select('apps/a/test/x.ts'), false);
  assert.equal(select('apps/gen/x.ts'), false);
  assert.equal(select('libs/x.ts'), false);
});

test('config: defaults, known keys validated, unknown keys kept', () => {
  assert.deepEqual(parseConfig(null).diagnostics, []);
  const ok = parseConfig('approvers:\n  - alice\nrequire_provenance: true\ngenerated:\n  - gen/**\nlanguage: zh\n');
  assert.deepEqual(ok.diagnostics, []);
  assert.equal(ok.config.require_provenance, true);
  assert.deepEqual(ok.config.generated, ['gen/**']);
  assert.equal(ok.config.raw.language, 'zh');
  for (const bad of ['approvers: alice\n', 'require_provenance: yes\n', 'generated:\n  - ../x\n', 'engines:\n  ruff:\n    command: []\n', 'engines:\n  black: {}\n', 'max_exception_ttl_days: 0\n', '- x\n']) {
    const res = parseConfig(bad);
    assert.ok(res.diagnostics.length > 0 && res.diagnostics.every((d) => d.startsWith('[S2-CONFIG] ')), bad);
  }
});
