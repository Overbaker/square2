// Task 2.5 fix pass: check --rev + pre-push hook, no default report, config get,
// gate never writes the state body, vendor lock independent of SQUARE2_DIR, budget default.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createGitHub } from '../src/issues/github.mjs';
import { DEFAULT_JOBS, budgetConfig } from '../src/issues/budget.mjs';
import { gateItems, publish } from '../src/issues/publish.mjs';
import { StateIssue } from '../src/issues/state.mjs';
import { BIN, REPO, cleanupTemps, git, runBin, tempDir } from './cli-helpers.mjs';
import { FakeGitHub } from './issues/fake-github.mjs';

after(cleanupTemps);

const HOOK = join(REPO, 'templates', 'consumer', '.githooks', 'pre-push');
const ZERO = '0'.repeat(40);
const RULE = 'rules:\n  - id: S2-NO-FOO\n    dune_rule: 2\n    engine: pattern\n    scope: src/**\n    instead: remove FOO\n    owner: o\n    options:\n      pattern: FOO\n';

/** A repository with one pattern rule; `main` is clean, branch `bad` adds a violation. */
function gateRepo() {
  const dir = join(tempDir('square2-rev-'), 'repo');
  mkdirSync(join(dir, '.square2', 'rules'), { recursive: true });
  mkdirSync(join(dir, '.square2', 'fixtures', 'S2-NO-FOO', 'bad', 'src'), { recursive: true });
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, '.square2', 'config.yaml'), 'branch: main\nnotify:\n  - alice\n');
  writeFileSync(join(dir, '.square2', 'rules', 'foo.yaml'), RULE);
  writeFileSync(join(dir, '.square2', 'fixtures', 'S2-NO-FOO', 'bad', 'src', 'a.ts'), 'export const x = "FOO";\n');
  writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 1;\n');
  git(dir, ['init', '--quiet', '-b', 'main']);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '--quiet', '-m', 'good']);
  const good = git(dir, ['rev-parse', 'HEAD']).trim();
  git(dir, ['checkout', '--quiet', '-b', 'bad']);
  writeFileSync(join(dir, 'src', 'b.ts'), 'export const b = "FOO";\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '--quiet', '-m', 'bad']);
  const bad = git(dir, ['rev-parse', 'HEAD']).trim();
  git(dir, ['checkout', '--quiet', 'main']);
  return { dir, good, bad };
}

/** @param {string} dir */
const status = (dir) => git(dir, ['status', '--porcelain', '--untracked-files=all']).trim();
/** @param {string} dir */
const worktrees = (dir) => git(dir, ['worktree', 'list', '--porcelain']).split('\n').filter((l) => l.startsWith('worktree ')).length;

test('1: check --rev gates that commit\'s tree in a temporary worktree, not the working tree', () => {
  const { dir, good, bad } = gateRepo();
  writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = "FOO";\n');
  assert.equal(runBin(['check'], { cwd: dir }).code, 1, 'the dirty working tree has a violation');
  const clean = runBin(['check', '--rev', good], { cwd: dir });
  assert.equal(clean.code, 0, clean.stdout + clean.stderr);
  const red = runBin(['check', `--rev=${bad}`, '--base', good], { cwd: dir });
  assert.equal(red.code, 1, red.stdout);
  assert.match(red.stdout, /\[S2-NO-FOO\] src\/b\.ts:1 .* — Instead: remove FOO/);
  assert.equal(runBin(['check', '--rev', 'no-such-rev'], { cwd: dir }).code, 2);
  const rep = join(tempDir('square2-rev-rep-'), 'r.json');
  assert.equal(runBin(['check', '--rev', bad, '--report', rep], { cwd: dir }).code, 1);
  assert.equal(JSON.parse(readFileSync(rep, 'utf8')).new_violations.length, 1, '--report is written where the caller said');
  assert.equal(worktrees(dir), 1, 'the temporary worktree is gone');
  writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 1;\n');
  assert.equal(status(dir), '', 'nothing written into the repository');
});

test('2: check writes no report unless --report is given', () => {
  const { dir } = gateRepo();
  assert.equal(runBin(['check'], { cwd: dir }).code, 0);
  assert.equal(existsSync(join(dir, 'square2-report.json')), false);
  assert.equal(status(dir), '');
  assert.equal(runBin(['check', '--report', 'square2-report.json'], { cwd: dir }).code, 0);
  assert.ok(existsSync(join(dir, 'square2-report.json')));
});

test('1: the pre-push hook checks each pushed commit, skips deletions, writes nothing, aborts on failure', () => {
  const { dir, good, bad } = gateRepo();
  mkdirSync(join(dir, 'tools'));
  symlinkSync(REPO, join(dir, 'tools', 'square2'));
  writeFileSync(join(dir, '.git', 'info', 'exclude'), 'tools/\n');
  /** @param {string} input */
  const push = (input) => spawnSync('sh', [HOOK, 'origin', 'https://example.invalid/r.git'], { cwd: dir, input, encoding: 'utf8', env: { ...process.env, SQUARE2_TODAY: '2026-11-20' } });
  const ok = push(`refs/heads/main ${good} refs/heads/main ${ZERO}\n`);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  const red = push(`refs/heads/bad ${bad} refs/heads/bad ${ZERO}\n`);
  assert.equal(red.status, 1, red.stdout + red.stderr);
  assert.match(red.stdout, /Instead: remove FOO/);
  assert.match(red.stderr, /push aborted/);
  const both = push(`refs/heads/main ${good} refs/heads/main ${ZERO}\nrefs/heads/bad ${bad} refs/heads/bad ${good}\n`);
  assert.equal(both.status, 1, 'one failing ref aborts the push');
  assert.match(both.stderr, new RegExp(`checking refs/heads/bad \\(${bad.slice(0, 12)}\\)`));
  const del = push(`(delete) ${ZERO} refs/heads/old ${bad}\n`);
  assert.equal(del.status, 0, 'a deletion is not checked');
  assert.doesNotMatch(del.stderr, /checking/);
  assert.equal(status(dir), '', 'the hook wrote nothing into the repository');
  assert.equal(worktrees(dir), 1);
});

test('4: config get prints one scalar of the config; unset exits 1; a list exits 2', () => {
  const { dir } = gateRepo();
  const r = runBin(['config', 'get', 'branch'], { cwd: dir });
  assert.deepEqual([r.code, r.stdout], [0, 'main\n']);
  assert.equal(runBin(['config', 'get', 'nope'], { cwd: dir }).code, 1);
  assert.equal(runBin(['config', 'get', 'notify'], { cwd: dir }).code, 2);
  assert.equal(runBin(['config', 'get'], { cwd: dir }).code, 2);
});

test('3: gate publishing never writes the state issue body; first runs adopt the lowest state issue', async () => {
  const fake = new FakeGitHub();
  const gh = createGitHub({ token: 't', repo: fake.repo, fetch: fake.fetch });
  const report = { head_sha: 'a'.repeat(40), new_violations: [1, 2, 3].map((i) => ({ rule_id: 'S2-X', path: `src/${i}.ts`, line: 1, message: 'm', fingerprint: String(i).repeat(64), count: 1 })) };
  const state = new StateIssue(gh, { bodyWriter: false });
  await publish({ gh, state, run: { kind: 'gate', inputId: 'gate-1', branch: 'main', sha: report.head_sha }, items: gateItems(report), cap: 1, notify: ['alice'] });
  const st = /** @type {any} */ (fake.issues.find((i) => i.labels.includes('square2-state')));
  assert.ok(st.comments.some((/** @type {any} */ c) => c.body.includes('square2:overflow:gate-1')), 'overflow list is a comment');
  assert.ok(st.comments.some((/** @type {any} */ c) => c.body.includes('square2:digest:gate-1')));
  assert.deepEqual(fake.log.filter((l) => l.startsWith(`update #${st.number}`)), [], 'no PATCH of the state issue');
  await assert.rejects(state.write({ last_reviewed_sha: 'b'.repeat(40), published_input_ids: [] }), /may not write the state issue body/);

  const race = new FakeGitHub();
  const rgh = createGitHub({ token: 't', repo: race.repo, fetch: race.fetch });
  const create = rgh.createIssue;
  let first = 0;
  rgh.createIssue = async (i) => {
    if (i.labels.includes('square2-state') && first === 0) first = race.seed({ title: i.title, body: i.body, labels: [...i.labels] }).number;
    return create(i);
  };
  const adopted = await new StateIssue(rgh, { bodyWriter: false }).ensure();
  assert.equal(adopted.number, first, 'the lower-numbered state issue (created concurrently) is adopted');
});

test('8: the vendor lock is <root>/.square2/lock.json even when SQUARE2_DIR points elsewhere', () => {
  const src = join(tempDir('square2-src8-'), 'square2');
  for (const name of ['bin', 'src', 'schemas', 'prompts', 'LICENSE', 'package.json']) cpSync(join(REPO, name), join(src, name), { recursive: true });
  git(src, ['init', '--quiet']);
  git(src, ['add', '-A']);
  git(src, ['commit', '--quiet', '-m', 'release']);
  git(src, ['tag', 'v9.9.8-test']);
  const { dir } = gateRepo();
  assert.equal(runBin(['vendor', '--from', src, '--ref', 'v9.9.8-test'], { cwd: dir }).code, 0);
  const external = join(tempDir('square2-ext-'), 'sq2');
  cpSync(join(dir, '.square2'), external, { recursive: true });
  spawnSync('rm', ['-f', join(external, 'lock.json')]);
  const vendored = (/** @type {string[]} */ args, /** @type {Record<string, string>} */ env = {}) => spawnSync(process.execPath, [join(dir, 'tools', 'square2', 'bin', 'square2.mjs'), ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, SQUARE2_TODAY: '2026-11-20', ...env } });
  const pilot = vendored(['selftest'], { SQUARE2_DIR: external });
  assert.equal(pilot.status, 0, pilot.stdout + pilot.stderr);
  const ext = runBin(['selftest', '--square2-dir', external], { cwd: dir });
  assert.equal(ext.code, 0, ext.stdout);
  writeFileSync(join(dir, 'tools', 'square2', 'src', 'extra.mjs'), '// tweak\n');
  const tampered = vendored(['selftest'], { SQUARE2_DIR: external });
  assert.equal(tampered.status, 2, 'the real lock is still enforced');
  assert.match(tampered.stdout, /^\[S2-VENDOR-TAMPERED\]/);
  assert.ok(BIN);
});

test('9: budget counts one job per run unless the config says otherwise', () => {
  assert.deepEqual(DEFAULT_JOBS, {});
  assert.deepEqual(budgetConfig({}).jobs, {});
  assert.deepEqual(budgetConfig({ budget: { jobs: { 'x.yml': 3 } } }).jobs, { 'x.yml': 3 });
});
