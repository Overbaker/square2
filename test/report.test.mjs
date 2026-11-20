import { test } from 'node:test';
import assert from 'node:assert/strict';
import { baselineFromViolations } from '../src/core/baseline.mjs';
import { canonicalStringify } from '../src/core/canonical-json.mjs';
import { today } from '../src/core/clock.mjs';
import { fingerprint, sha256Hex } from '../src/core/fingerprint.mjs';
import { buildReport, classify, decide, githubAnnotations, markdownSummary, ruleStats, serializeReport } from '../src/core/report.mjs';
import { finalizeViolations, formatViolationLine } from '../src/core/violation.mjs';
import { createHash } from 'node:crypto';

test('spec error format example', () => {
  const line = formatViolationLine({ rule_id: 'S2-DEP-VENDOR', path: 'apps/x.ts', line: 3, message: 'imports pg' }, 'use the platform adapters');
  assert.equal(line, '[S2-DEP-VENDOR] apps/x.ts:3 imports pg — Instead: use the platform adapters');
  assert.equal(formatViolationLine({ rule_id: 'S2-A-B', path: 'p', message: 'm' }, 'i'), '[S2-A-B] p m — Instead: i');
});

test('sha256 matches node:crypto', () => {
  for (const s of ['', 'abc', 'x'.repeat(55), 'x'.repeat(64), 'é😀\0']) {
    assert.equal(sha256Hex(s), createHash('sha256').update(s, 'utf8').digest('hex'));
  }
  assert.equal(fingerprint('R-1', './a\\b.ts', '  x   y '), sha256Hex('R-1\0a/b.ts\0x y'));
});

test('canonical JSON sorts keys and optionally arrays', () => {
  assert.equal(canonicalStringify({ b: 1, a: [3, 1] }), '{"a":[3,1],"b":1}');
  assert.equal(canonicalStringify({ b: 1, a: [3, 1] }, { sortArrays: true }), '{"a":[1,3],"b":1}');
  assert.throws(() => canonicalStringify({ a: NaN }));
});

test('clock: SQUARE2_TODAY overrides, else UTC date', () => {
  assert.equal(today({ env: { SQUARE2_TODAY: '2026-12-02' } }), '2026-12-02');
  assert.equal(today({ env: {}, now: new Date('2026-12-01T23:30:00-05:00') }), '2026-12-02');
  assert.throws(() => today({ env: { SQUARE2_TODAY: '2026-02-30' } }));
});

test('decide exit codes', () => {
  assert.equal(decide({}).exitCode, 0);
  assert.equal(decide({ selftest: ['[S2-SELFTEST] X-Y did not fire — Instead: fix'] }).exitCode, 2);
  assert.equal(decide({ tamper: ['[S2-VENDOR-TAMPERED] x — Instead: y'], invalidExceptions: ['z'] }).exitCode, 2);
  const vs = finalizeViolations([{ rule_id: 'S2-DEP-VENDOR', path: 'a.ts', subject: 'pg', line: 2, message: 'imports pg' }]);
  const c = classify({ violations: vs, baseline: baselineFromViolations([]), live: [], expired: [] });
  const d = decide({ classification: c, instead: { 'S2-DEP-VENDOR': 'use adapters' } });
  assert.equal(d.exitCode, 1);
  assert.deepEqual(d.lines, ['[S2-DEP-VENDOR] a.ts:2 imports pg — Instead: use adapters']);
  const ok = classify({ violations: vs, baseline: baselineFromViolations(vs), live: [], expired: [] });
  assert.equal(decide({ classification: ok }).exitCode, 0);
});

test('report, annotations and summary', () => {
  const vs = finalizeViolations([{ rule_id: 'S2-DEP-VENDOR', path: 'a,b:c.ts', subject: 'pg', line: 2, message: '50% done' }]);
  const c = classify({ violations: vs, baseline: baselineFromViolations([]), live: [], expired: [] });
  const decision = decide({ classification: c });
  const report = buildReport({
    repo: 'o/r', head_sha: 'abc', runner_version: '0.1.0', catalogue_digest: '0'.repeat(64),
    engine_versions: { ruff: '1', depcruise: '2' }, rule_ids: ['S2-DEP-VENDOR', 'S2-OTHER-X'], classification: c,
    exit_code: decision.exitCode, today: '2026-11-20',
  });
  const text = serializeReport(report);
  const parsed = JSON.parse(text);
  for (const k of ['schema_version', 'repo', 'head_sha', 'runner_version', 'catalogue_digest', 'engine_versions', 'rules']) assert.ok(k in parsed, k);
  assert.deepEqual(parsed.rules['S2-OTHER-X'], { hits: 0, new: 0, baselined: 0, excepted: 0, expired: 0 });
  assert.deepEqual(Object.keys(parsed), Object.keys(parsed).sort());
  const ann = githubAnnotations(c, { 'S2-DEP-VENDOR': 'use adapters' });
  assert.equal(ann[0], '::error file=a%2Cb%3Ac.ts,line=2,title=S2-DEP-VENDOR::[S2-DEP-VENDOR] a,b:c.ts:2 50%25 done — Instead: use adapters');
  const md = markdownSummary({ decision, stats: ruleStats(c, ['S2-DEP-VENDOR']) });
  assert.match(md, /\| S2-DEP-VENDOR \| 1 \| 1 \| 0 \| 0 \| 0 \|/);
  assert.match(md, /exit 1/);
});
