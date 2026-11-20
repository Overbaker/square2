import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { replayPath, validateCatalogue } from '../src/core/catalogue.mjs';
import { blobAt, blobText, isNoCommit } from '../src/git/show.mjs';
import { cleanupTemps, git, tempDir } from './cli-helpers.mjs';

after(cleanupTemps);

const SHA = 'a'.repeat(40);
const RULE = `rules:
  - id: S2-SUP-BARE
    dune_rule: 5
    engine: suppressions
    scope: src/**
    instead: add a reason
    owner: o
`;
const report = (/** @type {Record<string, unknown>} */ over = {}) =>
  JSON.stringify({ rule_id: 'S2-SUP-BARE', commit: { sha: SHA, fires: true, new: [] }, parent: { sha: 'b'.repeat(40), fires: false, new: [] }, ...over });

/**
 * @param {string} text
 * @param {{ requireProvenance?: boolean, replay?: string | null }} [o]
 */
function run(text, o = {}) {
  /** @type {string[]} */
  const asked = [];
  const res = validateCatalogue([{ path: '.square2/rules/r.yaml', text }], {
    fixtureDirExists: () => true,
    requireProvenance: o.requireProvenance,
    readReplay: (p) => { asked.push(p); return o.replay === undefined ? report() : o.replay; },
  });
  return { ...res, asked };
}

test('born_from, replay and require_reason are accepted and kept', () => {
  const res = run(RULE + `    born_from: ${SHA.slice(0, 12)}\n    replay: .square2/replay/custom.json\n    require_reason: true\n`, { requireProvenance: true });
  assert.deepEqual(res.diagnostics, []);
  assert.equal(res.rules[0].born_from, SHA.slice(0, 12));
  assert.equal(res.rules[0].replay, '.square2/replay/custom.json');
  assert.equal(res.rules[0].require_reason, true);
  assert.deepEqual(res.asked, ['.square2/replay/custom.json']);
  assert.equal(replayPath({ id: 'S2-A-B' }), '.square2/replay/S2-A-B.json');
});

test('invalid provenance fields are [S2-CATALOGUE] errors', () => {
  for (const [extra, needle] of [
    ['    born_from: HEAD\n', 'invalid born_from'],
    ['    born_from: abc\n', 'invalid born_from'],
    ['    replay: ../x.json\n', 'invalid replay'],
    ['    replay: .square2/replay/*.json\n', 'invalid replay'],
    ['    require_reason: yes\n', 'invalid require_reason'],
  ]) {
    const res = run(RULE + extra);
    assert.equal(res.exitCode, 2, extra);
    assert.ok(res.diagnostics.some((d) => d.startsWith('[S2-CATALOGUE] ') && d.includes(needle)), `${extra}: ${res.diagnostics}`);
  }
  const wrongEngine = run(RULE.replace('engine: suppressions', 'engine: command') + '    require_reason: true\n');
  assert.ok(wrongEngine.diagnostics.some((d) => d.includes('require_reason is only valid for the suppressions engine')));
});

test('require_provenance: missing born_from or report is [S2-CATALOGUE] <id> missing born_from replay', () => {
  assert.deepEqual(run(RULE).diagnostics, [], 'off by default');
  for (const [text, replay] of [[RULE, undefined], [RULE + `    born_from: ${SHA}\n`, null]]) {
    const res = run(/** @type {string} */ (text), { requireProvenance: true, replay: /** @type {string | null | undefined} */ (replay) });
    assert.equal(res.exitCode, 2);
    assert.match(res.diagnostics[0], /^\[S2-CATALOGUE\] S2-SUP-BARE missing born_from replay \(\.square2\/rules\/r\.yaml\) — Instead: /);
  }
  const disabled = run(RULE + '    enabled: false\n', { requireProvenance: true, replay: null });
  assert.deepEqual(disabled.diagnostics, [], 'a disabled rule needs no provenance');
});

test('require_provenance: the report must show firing on born_from and not on its parent', () => {
  const withSha = RULE + `    born_from: ${SHA.slice(0, 7)}\n`;
  assert.deepEqual(run(withSha, { requireProvenance: true }).diagnostics, []);
  for (const bad of [
    report({ rule_id: 'S2-OTHER-X' }),
    report({ commit: { sha: 'c'.repeat(40), fires: true } }),
    report({ commit: { sha: SHA, fires: false } }),
    report({ parent: { sha: 'b'.repeat(40), fires: true } }),
    report({ parent: null }),
    '{not json',
  ]) {
    const res = run(withSha, { requireProvenance: true, replay: bad });
    assert.equal(res.exitCode, 2, bad);
    assert.match(res.diagnostics[0], /^\[S2-CATALOGUE\] S2-SUP-BARE (replay does not show firing|replay report is not valid JSON)/);
  }
});

test('rule schema lists the new fields', () => {
  const schema = JSON.parse(readFileSync(new URL('../schemas/rule.v1.json', import.meta.url), 'utf8'));
  for (const k of ['born_from', 'replay', 'require_reason']) assert.ok(k in schema.$defs.rule.properties, k);
  assert.match(SHA, new RegExp(schema.$defs.rule.properties.born_from.pattern));
});

test('git show: base commits map to no-commit / absent / blob', async () => {
  const dir = join(tempDir('square2-show-'), 'repo');
  git(tempDir('square2-x-'), ['init', '--quiet', dir]);
  writeFileSync(join(dir, 'a.txt'), 'hello\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '--quiet', '-m', 'a']);
  const sha = git(dir, ['rev-parse', 'HEAD']).trim();
  for (const base of [undefined, null, '', '0'.repeat(40), 'f'.repeat(40), '--output=x']) {
    assert.deepEqual(await blobAt(dir, base, 'a.txt'), { kind: 'no-commit' }, String(base));
  }
  assert.ok(isNoCommit('000000'));
  assert.deepEqual(await blobAt(dir, sha, 'missing.txt'), { kind: 'absent' });
  assert.deepEqual(await blobAt(dir, sha, 'a.txt'), { kind: 'blob', text: 'hello\n' });
  assert.equal(blobText({ kind: 'absent' }), null);
});
