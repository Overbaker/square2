import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { treeSha256, verifyVendor } from '../src/cli/vendor.mjs';
import { BIN, REPO, cleanupTemps, copyMiniRepo, git, runBin, tempDir } from './cli-helpers.mjs';
import { spawnSync } from 'node:child_process';

after(cleanupTemps);

/** A square² release repository built from this working tree, tagged v9.9.9-test. */
function sourceRepo() {
  const src = join(tempDir('square2-src-'), 'square2');
  for (const name of ['bin', 'src', 'schemas', 'LICENSE', 'package.json']) cpSync(join(REPO, name), join(src, name), { recursive: true });
  git(src, ['init', '--quiet']);
  git(src, ['add', '-A']);
  git(src, ['commit', '--quiet', '-m', 'release']);
  git(src, ['tag', 'v9.9.9-test']);
  return { src, sha: git(src, ['rev-parse', 'HEAD']).trim() };
}

/** @param {string} cwd @param {string[]} args */
const runVendored = (cwd, args) => {
  const res = spawnSync(process.execPath, [join(cwd, 'tools', 'square2', 'bin', 'square2.mjs'), ...args], { cwd, encoding: 'utf8', env: { ...process.env, SQUARE2_TODAY: '2026-11-20' } });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
};

test('vendor writes tools/square2 and a hash lock; the vendored runner verifies it first', () => {
  const { src, sha } = sourceRepo();
  const consumer = copyMiniRepo();
  const res = runBin(['vendor', '--from', src, '--ref', 'v9.9.9-test'], { cwd: consumer });
  assert.equal(res.code, 0, res.stdout + res.stderr);
  const lock = JSON.parse(readFileSync(join(consumer, '.square2', 'lock.json'), 'utf8'));
  assert.deepEqual(Object.keys(lock).sort(), ['commit_sha', 'path', 'tree_sha256', 'version']);
  assert.equal(lock.commit_sha, sha);
  assert.equal(lock.version, 'v9.9.9-test');
  assert.equal(lock.tree_sha256, treeSha256(join(consumer, 'tools', 'square2')));
  assert.ok(existsSync(join(consumer, 'tools', 'square2', 'LICENSE')));
  assert.ok(!existsSync(join(consumer, 'tools', 'square2', 'package.json')), 'only bin/ src/ prompts/ schemas/ LICENSE are vendored');
  assert.deepEqual(verifyVendor({ root: consumer, dir: join(consumer, '.square2') }, join(consumer, 'tools', 'square2')), { status: 'ok' });

  const ok = runVendored(consumer, ['check', '--only', 'S2-SUPPRESS-*,S2-ROUTE-*', '--report', join(consumer, 'r.json')]);
  assert.equal(ok.code, 0, ok.stdout + ok.stderr);

  appendFileSync(join(consumer, 'tools', 'square2', 'src', 'core', 'clock.mjs'), '\n// local tweak\n');
  for (const cmd of [['selftest'], ['check'], ['baseline', 'show'], ['exceptions', 'lint']]) {
    const tampered = runVendored(consumer, cmd);
    assert.equal(tampered.code, 2, cmd.join(' '));
    assert.match(tampered.stdout, /^\[S2-VENDOR-TAMPERED\] tools\/square2 tree_sha256 [0-9a-f]{64} does not match \.square2\/lock\.json [0-9a-f]{64} — Instead: /);
  }
  const outside = runBin(['selftest', '--only', 'S2-SUPPRESS-*'], { cwd: consumer });
  assert.equal(outside.code, 2, 'a lock makes verification mandatory, whichever runner runs');
  assert.match(outside.stdout, /^\[S2-VENDOR-TAMPERED\] tools\/square2 tree_sha256 /);

  const again = runBin(['vendor', '--from', src, '--ref', 'v9.9.9-test'], { cwd: consumer });
  assert.equal(again.code, 0);
  assert.equal(runVendored(consumer, ['selftest', '--only', 'S2-SUPPRESS-*']).code, 0, 're-vendoring repairs the copy');
});

test('vendor: added files and a corrupt lock count as tampering; bad inputs exit 2', () => {
  const { src } = sourceRepo();
  const consumer = copyMiniRepo();
  assert.equal(runBin(['vendor', '--from', src, '--ref', 'v9.9.9-test'], { cwd: consumer }).code, 0);
  writeFileSync(join(consumer, 'tools', 'square2', 'src', 'extra.mjs'), 'export {};\n');
  assert.equal(runVendored(consumer, ['selftest']).code, 2);
  assert.equal(runBin(['vendor', '--from', src, '--ref', 'v9.9.9-test'], { cwd: consumer }).code, 0);
  writeFileSync(join(consumer, '.square2', 'lock.json'), '{not json');
  assert.match(runVendored(consumer, ['selftest']).stdout, /^\[S2-VENDOR-TAMPERED\] \.square2\/lock\.json is unreadable/);
  assert.equal(runBin(['vendor', '--from', src, '--ref', 'no-such-tag'], { cwd: consumer }).code, 2);
  assert.equal(runBin(['vendor', '--from', src, '--ref', 'v9.9.9-test', '--into', '../outside'], { cwd: consumer }).code, 2);
  assert.equal(runBin(['vendor', '--from', src], { cwd: consumer }).code, 2);
  assert.ok(BIN);
});
