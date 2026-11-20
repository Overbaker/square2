import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTemps, git, runBin, tempDir } from './cli-helpers.mjs';

after(cleanupTemps);

const RULE = `rules:
  - id: S2-SUPPRESS-UNREGISTERED
    dune_rule: 5
    engine: suppressions
    scope: src/**
    instead: fix the cause, or register an exception
    owner: platform
`;

/** A repo with three commits: clean, adds a suppression, unrelated change. */
function historyRepo() {
  const dir = join(tempDir('square2-replay-'), 'repo');
  mkdirSync(join(dir, '.square2', 'rules'), { recursive: true });
  mkdirSync(join(dir, '.square2', 'fixtures', 'S2-SUPPRESS-UNREGISTERED', 'bad', 'src'), { recursive: true });
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, '.square2', 'rules', 'suppressions.yaml'), RULE);
  writeFileSync(join(dir, '.square2', 'fixtures', 'S2-SUPPRESS-UNREGISTERED', 'bad', 'src', 'a.ts'), '// @ts-ignore\n');
  writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 1;\n');
  git(dir, ['init', '--quiet']);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '--quiet', '-m', 'clean']);
  writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 1;\n// eslint-disable-next-line no-console\nconsole.log(a);\n');
  git(dir, ['commit', '--quiet', '-am', 'add a suppression']);
  const defect = git(dir, ['rev-parse', 'HEAD']).trim();
  writeFileSync(join(dir, 'src', 'b.ts'), 'export const b = 2;\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '--quiet', '-m', 'unrelated']);
  return { dir, defect, parent: git(dir, ['rev-parse', `${defect}^`]).trim() };
}

/** @param {string} dir */
function snapshot(dir) {
  return {
    head: git(dir, ['rev-parse', 'HEAD']),
    status: git(dir, ['status', '--porcelain', '--untracked-files=all']),
    worktrees: git(dir, ['worktree', 'list', '--porcelain']),
    dirty: readFileSync(join(dir, 'src', 'b.ts'), 'utf8'),
  };
}

test('replay --commit: fires on the defect commit, not on its parent; working tree untouched', () => {
  const { dir, defect, parent } = historyRepo();
  writeFileSync(join(dir, 'src', 'b.ts'), 'export const b = 3; // uncommitted edit\n');
  writeFileSync(join(dir, 'scratch.txt'), 'untracked\n');
  const before = snapshot(dir);
  const res = runBin(['replay', '--rule', 'S2-SUPPRESS-UNREGISTERED', '--commit', defect], { cwd: dir });
  assert.equal(res.code, 0, res.stdout + res.stderr);
  const report = JSON.parse(res.stdout);
  assert.equal(report.rule_id, 'S2-SUPPRESS-UNREGISTERED');
  assert.equal(report.commit.sha, defect);
  assert.equal(report.commit.fires, true);
  assert.deepEqual(report.commit.new.map((/** @type {{ diagnostic: string }} */ f) => f.diagnostic), [
    '[S2-SUPPRESS-UNREGISTERED] src/a.ts:2 has suppression eslint-disable-next-line no-console — Instead: fix the cause, or register an exception',
  ]);
  assert.equal(report.parent.sha, parent);
  assert.equal(report.parent.fires, false);
  assert.deepEqual(snapshot(dir), before);

  const later = JSON.parse(runBin(['replay', '--rule', 'S2-SUPPRESS-UNREGISTERED', '--commit', 'HEAD'], { cwd: dir }).stdout);
  assert.equal(later.commit.fires, false, 'an existing violation does not fire newly');
  assert.equal(later.parent.fires, false);
});

test('replay --since: lists commits with new firings, sorted, with grade null', () => {
  const { dir, defect } = historyRepo();
  const before = snapshot(dir);
  const out = join(dir, '.square2', 'replay', 'since.json');
  const res = runBin(['replay', '--rule', 'S2-SUPPRESS-UNREGISTERED', '--since', '30', '--out', out], { cwd: dir });
  assert.equal(res.code, 0, res.stdout + res.stderr);
  const report = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(report.commits_scanned, 3);
  assert.equal(report.firings.length, 1);
  const [f] = report.firings;
  assert.equal(f.sha, defect);
  assert.equal(f.grade, null);
  assert.equal(f.summary, 'add a suppression');
  assert.equal(f.path, 'src/a.ts');
  assert.equal(f.line, 2);
  const { status, ...rest } = snapshot(dir);
  const { status: statusBefore, ...restBefore } = before;
  assert.deepEqual(rest, restBefore);
  assert.equal(status, '?? .square2/replay/since.json\n');
  assert.equal(statusBefore, '');
});

test('require_provenance: born_from plus a replay report admits the rule; missing ones exit 2', () => {
  const { dir, defect } = historyRepo();
  writeFileSync(join(dir, '.square2', 'config.yaml'), 'require_provenance: true\n');
  const missing = runBin(['selftest'], { cwd: dir });
  assert.equal(missing.code, 2);
  assert.match(missing.stdout, /^\[S2-CATALOGUE\] S2-SUPPRESS-UNREGISTERED missing born_from replay \(\.square2\/rules\/suppressions\.yaml\) — Instead: /);

  writeFileSync(join(dir, '.square2', 'rules', 'suppressions.yaml'), RULE + `    born_from: ${defect}\n`);
  assert.match(runBin(['selftest'], { cwd: dir }).stdout, /S2-SUPPRESS-UNREGISTERED missing born_from replay/);
  const replay = runBin(['replay', '--rule', 'S2-SUPPRESS-UNREGISTERED', '--commit', defect, '--out', '.square2/replay/S2-SUPPRESS-UNREGISTERED.json'], { cwd: dir });
  assert.equal(replay.code, 0, 'replay produces the report, so it does not require it: ' + replay.stdout);
  const ok = runBin(['selftest'], { cwd: dir });
  assert.equal(ok.code, 0, ok.stdout);

  const head = git(dir, ['rev-parse', 'HEAD']).trim();
  writeFileSync(join(dir, '.square2', 'rules', 'suppressions.yaml'), RULE + `    born_from: ${head}\n`);
  assert.match(runBin(['selftest'], { cwd: dir }).stdout, /^\[S2-CATALOGUE\] S2-SUPPRESS-UNREGISTERED replay does not show firing on born_from and not on its parent/);
});

test('replay errors: unknown rule, bad commit, both modes', () => {
  const { dir } = historyRepo();
  assert.equal(runBin(['replay', '--rule', 'S2-NOPE-X', '--commit', 'HEAD'], { cwd: dir }).code, 2);
  assert.equal(runBin(['replay', '--rule', 'S2-SUPPRESS-UNREGISTERED', '--commit', 'deadbeef'], { cwd: dir }).code, 2);
  assert.equal(runBin(['replay', '--rule', 'S2-SUPPRESS-UNREGISTERED', '--commit', 'HEAD', '--since', '3'], { cwd: dir }).code, 2);
  assert.equal(git(dir, ['worktree', 'list']).trim().split('\n').length, 1);
});
