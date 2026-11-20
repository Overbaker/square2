import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTemps, copyMiniRepo, git, runBin, runMain, tempDir } from './cli-helpers.mjs';

after(cleanupTemps);

const LINE = /^\[[A-Z0-9-]+\] [^\n]+ — Instead: [^\n]+$/;
const REAL_RULES = 'S2-SUPPRESS-*,S2-ROUTE-*';

test('golden: check on the mini repo passes and the report is exact and repeatable', async () => {
  const dir = copyMiniRepo();
  const report = join(dir, 'out', 'r.json');
  const first = await runMain(['check', '--report', report], { cwd: dir });
  assert.equal(first.code, 0, first.stdout + first.stderr);
  assert.match(first.stdout, /square2: ok \(6 rules, 8 violations all baselined or excepted\)/);
  const bytes = readFileSync(report, 'utf8');
  const doc = JSON.parse(bytes);
  assert.deepEqual(doc.rules, {
    'S2-DEP-NO-VENDOR': { baselined: 1, excepted: 0, expired: 0, hits: 1, new: 0 },
    'S2-LINT-NO-CONSOLE': { baselined: 0, excepted: 0, expired: 0, hits: 0, new: 0 },
    'S2-PY-BANNED-IMPORT': { baselined: 1, excepted: 0, expired: 0, hits: 1, new: 0 },
    'S2-ROUTE-LANES': { baselined: 0, excepted: 0, expired: 0, hits: 0, new: 0 },
    'S2-SUPPRESS-BARE': { baselined: 2, excepted: 0, expired: 0, hits: 2, new: 0 },
    'S2-SUPPRESS-UNREGISTERED': { baselined: 3, excepted: 1, expired: 0, hits: 4, new: 0 },
  });
  assert.deepEqual(doc.excepted.map((/** @type {{ path: string, exception_id: string }} */ e) => [e.path, e.exception_id]), [['apps/web/legacy/old.ts', 'E-0001']]);
  assert.deepEqual(doc.observed.map((/** @type {{ path: string }} */ o) => o.path).sort(), [
    'apps/web/legacy/old.ts', 'apps/web/legacy/old.ts', 'apps/web/src/db.ts', 'apps/web/src/index.ts', 'apps/web/src/index.ts', 'apps/web/src/index.ts', 'python/pkg/mod.py', 'python/pkg/mod.py',
  ]);
  assert.equal(doc.exit_code, 0);
  assert.equal(doc.head_sha, git(dir, ['rev-parse', 'HEAD']).trim());
  assert.deepEqual(Object.keys(doc.engine_versions).sort(), ['command', 'depcruise', 'eslint', 'ruff', 'suppressions']);
  const second = await runMain(['check', '--report', report], { cwd: dir });
  assert.equal(second.code, 0);
  assert.equal(readFileSync(report, 'utf8'), bytes);
});

test('golden: the string-literal suppression and test-only vendor import are not reported', async () => {
  const dir = copyMiniRepo();
  writeFileSync(join(dir, '.square2', 'baseline.json'), '{"schema_version": 1, "entries": []}\n');
  const res = await runMain(['check', '--report', join(dir, 'r.json')], { cwd: dir });
  assert.equal(res.code, 1);
  const lines = res.stdout.trim().split('\n');
  for (const l of lines) assert.match(l, LINE);
  assert.ok(!lines.some((l) => l.includes('apps/web/src/index.ts:3')), 'string literal reported');
  assert.ok(!lines.some((l) => l.includes('apps/web/test/')), 'test-only import reported');
  assert.ok(lines.includes('[S2-DEP-NO-VENDOR] apps/web/src/db.ts imports pg — Instead: use the platform adapters instead of vendor SDKs'));
  assert.ok(!lines.some((l) => l.startsWith('[S2-SUPPRESS-BARE] python/pkg/mod.py')), 'documented noqa reported by the reason-required rule');
  assert.ok(lines.some((l) => l.startsWith('[S2-SUPPRESS-UNREGISTERED] python/pkg/mod.py:8 has suppression noqa BLE001')));
});

test('check exits 1 after adding a banned import, then 0 again once it is removed', async () => {
  const dir = copyMiniRepo();
  writeFileSync(join(dir, 'apps', 'web', 'src', 'store.ts'), "import { WebSocket } from 'ws';\nexport const s = WebSocket;\n");
  const bad = await runMain(['check', '--report', join(dir, 'r.json')], { cwd: dir });
  assert.equal(bad.code, 1);
  assert.equal(bad.stdout.trim(), '[S2-DEP-NO-VENDOR] apps/web/src/store.ts imports ws — Instead: use the platform adapters instead of vendor SDKs');
  writeFileSync(join(dir, 'apps', 'web', 'src', 'store.ts'), 'export const s = 1;\n');
  assert.equal((await runMain(['check', '--report', join(dir, 'r.json')], { cwd: dir })).code, 0);
});

test('real engines via the binary: suppressions and command rules gate the repo', () => {
  const dir = copyMiniRepo();
  const ok = runBin(['check', '--only', REAL_RULES, '--report', join(dir, 'r.json')], { cwd: dir });
  assert.equal(ok.code, 0, ok.stdout + ok.stderr);

  appendFileSync(join(dir, 'apps', 'web', 'src', 'render.ts'), '// eslint-disable-next-line no-console\nconsole.log(1);\n');
  const sup = runBin(['check', '--only', REAL_RULES, '--report', join(dir, 'r.json')], { cwd: dir });
  assert.equal(sup.code, 1);
  assert.deepEqual(sup.stdout.trim().split('\n').sort(), [
    '[S2-SUPPRESS-BARE] apps/web/src/render.ts:4 has suppression eslint-disable-next-line no-console without a reason — Instead: add the reason after the codes (-- why), or fix the cause',
    '[S2-SUPPRESS-UNREGISTERED] apps/web/src/render.ts:4 has suppression eslint-disable-next-line no-console — Instead: fix the cause, or register an exception in .square2/exceptions.yaml',
  ]);

  const dir2 = copyMiniRepo();
  appendFileSync(join(dir2, 'routes', 'published.txt'), 'orders.refunded fast\n');
  const route = runBin(['check', '--only', REAL_RULES, '--report', join(dir2, 'r.json')], { cwd: dir2 });
  assert.equal(route.code, 1);
  assert.equal(route.stdout.trim(), '[S2-ROUTE-LANES] routes/published.txt:3 orders.refunded fast has no router entry — Instead: add a router entry for the published (message, lane) pair');
});

test('a missing tool exits 2 with an Instead hint', () => {
  const dir = copyMiniRepo();
  const res = runBin(['check', '--report', join(dir, 'r.json')], { cwd: dir });
  assert.equal(res.code, 2);
  assert.match(res.stdout, /^\[S2-ENGINE-MISSING\] dependency-cruiser is not installed in the repository \(node_modules\/dependency-cruiser\) — Instead: install dependency-cruiser/m);
});

test('exit 2: invalid catalogue, failing selftest; exit 1: expired exception', async () => {
  const dir = copyMiniRepo();
  const rules = join(dir, '.square2', 'rules', 'lint.yaml');
  const original = readFileSync(rules, 'utf8');
  writeFileSync(rules, original.replace('instead: use the logger', 'instead: ""'));
  const cat = await runMain(['check'], { cwd: dir });
  assert.equal(cat.code, 2);
  assert.match(cat.stdout, /^\[S2-CATALOGUE\] \.square2\/rules\/lint\.yaml: rule S2-LINT-NO-CONSOLE missing instead — Instead: /m);
  writeFileSync(rules, original);

  writeFileSync(join(dir, '.square2', 'fixtures', 'S2-ROUTE-LANES', 'bad', 'routes', 'router.txt'), 'orders.created fast\n');
  const st = await runMain(['check'], { cwd: dir });
  assert.equal(st.code, 2);
  assert.match(st.stdout, /^\[S2-SELFTEST\] S2-ROUTE-LANES did not fire on \.square2\/fixtures\/S2-ROUTE-LANES\/bad\/ — Instead: /m);

  const dir2 = copyMiniRepo();
  const exp = await runMain(['check', '--report', join(dir2, 'r.json')], { cwd: dir2, env: { SQUARE2_TODAY: '2027-01-16' } });
  assert.equal(exp.code, 1);
  const lines = exp.stdout.trim().split('\n');
  assert.ok(lines[0].startsWith('[S2-EXC-EXPIRED] E-0001 expired on 2027-01-15'));
  assert.ok(lines.includes('[S2-SUPPRESS-UNREGISTERED] apps/web/legacy/old.ts:1 has suppression eslint-disable — Instead: fix the cause, or register an exception in .square2/exceptions.yaml'));
  const onDay = await runMain(['check', '--report', join(dir2, 'r.json')], { cwd: dir2, env: { SQUARE2_TODAY: '2027-01-15' } });
  assert.equal(onDay.code, 0);
});

test('--base: silent baseline growth and an edited exception date fail; an approval makes growth pass', async () => {
  const dir = copyMiniRepo();
  const base = git(dir, ['rev-parse', 'HEAD']).trim();
  appendFileSync(join(dir, 'apps', 'web', 'src', 'render.ts'), '// @ts-ignore -- generated\nexport const g = 1;\n');
  assert.equal((await runMain(['baseline', 'grow', '--approval', 'A-0001'], { cwd: dir })).code, 0);
  const grew = await runMain(['check', '--base', base, '--report', join(dir, 'r.json')], { cwd: dir });
  assert.equal(grew.code, 1);
  assert.match(grew.stdout, /^\[S2-BASELINE-GREW\] \.square2\/baseline\.json \+1 entries without an approval — Instead: /m);
  appendFileSync(join(dir, '.square2', 'approvals.yaml'), '  - id: A-0002\n    approver: alice\n    date: 2026-11-20\n    reason: generated file\n    adr: ADR-2\n');
  const approved = await runMain(['check', '--base', base, '--report', join(dir, 'r.json')], { cwd: dir });
  assert.equal(approved.code, 0, approved.stdout);

  const ex = join(dir, '.square2', 'exceptions.yaml');
  writeFileSync(ex, readFileSync(ex, 'utf8').replace('expires_at: 2027-01-15', 'expires_at: 2027-01-20'));
  const mutated = await runMain(['check', '--base', base, '--report', join(dir, 'r.json')], { cwd: dir });
  assert.equal(mutated.code, 1);
  assert.match(mutated.stdout, /^\[S2-EXC-MUTATED\] E-0001 expires_at changed from 2027-01-15 to 2027-01-20/m);

  const noCommit = await runMain(['check', '--base', '0000000000000000000000000000000000000000', '--report', join(dir, 'r.json')], { cwd: dir });
  assert.equal(noCommit.code, 0);
  assert.match(noCommit.stderr, /note: \.square2\/baseline\.json: no previous commit, baseline ratchet skipped/);
});

test('--format github: annotations and a step summary', async () => {
  const dir = copyMiniRepo();
  writeFileSync(join(dir, 'apps', 'web', 'src', 'store.ts'), "import pg from 'pg';\n");
  const summary = join(tempDir('square2-summary-'), 'summary.md');
  const res = await runMain(['check', '--format', 'github', '--report', join(dir, 'r.json')], { cwd: dir, env: { GITHUB_STEP_SUMMARY: summary } });
  assert.equal(res.code, 1);
  assert.match(res.stdout, /^::error file=apps\/web\/src\/store\.ts,title=S2-DEP-NO-VENDOR::\[S2-DEP-NO-VENDOR\] apps\/web\/src\/store\.ts imports pg — Instead: /m);
  assert.match(readFileSync(summary, 'utf8'), /## square² gate: failed \(exit 1\)/);
});

test('baseline show / shrink, exceptions lint, selftest command', async () => {
  const dir = copyMiniRepo();
  const show = await runMain(['baseline', 'show'], { cwd: dir });
  assert.equal(show.code, 0);
  assert.match(show.stdout, /S2-SUPPRESS-UNREGISTERED 3\ntotal 7\n$/);
  writeFileSync(join(dir, 'apps', 'web', 'src', 'db.ts'), 'export const pool = null;\n');
  const shrunk = await runMain(['baseline', 'shrink'], { cwd: dir });
  assert.equal(shrunk.stdout.trim(), 'baseline: 7 -> 6 entries');
  const noApproval = await runMain(['baseline', 'grow', '--approval', 'A-9999'], { cwd: dir });
  assert.equal(noApproval.code, 1);
  assert.match(noApproval.stdout, /^\[S2-BASELINE-GREW\] no approval A-9999/);
  assert.equal((await runMain(['exceptions', 'lint'], { cwd: dir })).stdout.trim(), 'exceptions: 1 valid, none expired');
  const ex = join(dir, '.square2', 'exceptions.yaml');
  writeFileSync(ex, readFileSync(ex, 'utf8').replace('scope: apps/web/legacy/**', 'scope: "**"'));
  const lint = await runMain(['exceptions', 'lint'], { cwd: dir });
  assert.equal(lint.code, 1);
  assert.match(lint.stdout, /^\[S2-EXC-INVALID\] E-0001 scope "\*\*" is too wide/);
  const st = runBin(['selftest', '--only', REAL_RULES], { cwd: dir });
  assert.equal(st.code, 0, st.stdout + st.stderr);
  assert.equal(st.stdout.trim(), 'selftest: 3 rule(s) fired on their bad fixtures');
});

test('usage errors exit 2; --help exits 0', async () => {
  const dir = copyMiniRepo({ git: false });
  assert.equal((await runMain(['frobnicate'], { cwd: dir })).code, 2);
  assert.equal((await runMain(['check', '--nope'], { cwd: dir })).code, 2);
  assert.equal((await runMain(['replay', '--rule', 'S2-ROUTE-LANES'], { cwd: dir })).code, 2);
  const help = runBin(['--help'], { cwd: dir });
  assert.equal(help.code, 0);
  assert.match(help.stdout, /^square² \(方方\)/);
});
