import { test } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { baselineFromViolations } from '../src/core/baseline.mjs';
import { addDays } from '../src/core/clock.mjs';
import { sha256Hex } from '../src/core/fingerprint.mjs';
import { splitByExpiry, validateExceptions } from '../src/core/exceptions.mjs';
import { buildReport, classify, decide, githubAnnotations, ruleStats, serializeReport } from '../src/core/report.mjs';
import { finalizeViolations, formatDiagnostic, formatViolationLine } from '../src/core/violation.mjs';
import { toPosixPath } from '../src/core/fingerprint.mjs';
import { TODAY, permute } from './helpers.mjs';

const RUNS = { numRuns: 300 };
const LINE = /^\[[A-Z0-9-]+\] [^\n]+ — Instead: [^\n]+$/;
const BREAKS = /[\n\r\u2028\u2029\u0085]/;

const nasty = fc.oneof(
  fc.string({ unit: 'binary', maxLength: 40 }),
  fc.array(fc.constantFrom('\n', '\r\n', '\u2028', ' — Instead: ', '日本', '😀', '\t', '\\', '', ' '), { maxLength: 8 }).map((a) => a.join('')),
);
const ruleId = fc.stringMatching(/^[A-Z0-9]{1,4}(-[A-Z0-9]{1,4}){1,3}$/);

test('P8: every diagnostic is one line in the prescribed format', () => {
  fc.assert(
    fc.property(ruleId, nasty, nasty, nasty, fc.option(fc.integer({ min: 1, max: 9999 }), { nil: undefined }), (id, path, message, instead, line) => {
      const outputs = [
        formatViolationLine({ rule_id: id, path, line, message }, instead),
        formatDiagnostic('S2-CATALOGUE', `${path}: rule ${message}`, instead),
        formatDiagnostic('S2-EXC-INVALID', message, instead),
      ];
      for (const out of outputs) {
        assert.match(out, LINE);
        assert.doesNotMatch(out, BREAKS);
      }
      let safePath = 'p';
      try { safePath = toPosixPath(path); } catch { /* invalid adapter paths are covered by unit tests */ }
      const vs = finalizeViolations([{ rule_id: id, path: safePath, subject: /[\u0000-\u001f]/.test(message.replace(/\s+/gu, ' ')) || message.trim() === '' ? 's' : message, message, line }]);
      for (const ann of githubAnnotations(classify({ violations: vs, baseline: baselineFromViolations([]), live: [], expired: [] }), new Map([[id, instead]]))) assert.doesNotMatch(ann, BREAKS);
      for (const l of decide({ classification: classify({ violations: vs, baseline: baselineFromViolations([]), live: [], expired: [] }), instead: { [id]: instead } }).lines) {
        assert.match(l, LINE);
      }
    }),
    RUNS,
  );
});

const RULES = ['S2-R-A', 'S2-R-B', 'S2-R-C'];
const raw = fc.record({
  rule_id: fc.constantFrom(...RULES),
  path: fc.constantFrom('a/x.ts', 'a/y.ts', 'b/z.py'),
  subject: fc.constantFrom('pg', 'ws', 'eslint-disable'),
  line: fc.integer({ min: 1, max: 30 }),
  column: fc.integer({ min: 1, max: 5 }),
});
const exc = fc.record({
  rule_id: fc.constantFrom(...RULES),
  scope: fc.constantFrom('a/**', 'a/x.ts', 'b/*.py'),
  offset: fc.integer({ min: -2, max: 2 }),
});

/**
 * @param {{ rule_id: string, scope: string, offset: number }[]} excs
 * @param {number[]} [order] readdir-like order applied after ids are assigned
 */
function exceptionsFor(excs, order = [0]) {
  const entries = permute(excs.map((e, i) => ({
    id: `E-${i}`, rule_id: e.rule_id, scope: e.scope, reason: 'r', owner: 'o', adr: 'a',
    created_at: addDays(TODAY, -5), expires_at: addDays(TODAY, e.offset),
  })), order);
  return splitByExpiry(validateExceptions(entries, { ruleIds: RULES, today: TODAY }).valid, TODAY);
}

test('P9: hits = new + baselined + excepted per rule, and the hits sum to |V|', () => {
  fc.assert(
    fc.property(fc.array(raw, { maxLength: 30 }), fc.array(raw, { maxLength: 30 }), fc.array(exc, { maxLength: 4 }), (vRaw, bRaw, excs) => {
      const violations = finalizeViolations(vRaw);
      const { live, expired } = exceptionsFor(excs);
      const c = classify({ violations, baseline: baselineFromViolations(finalizeViolations(bRaw)), live, expired });
      const stats = ruleStats(c, RULES);
      let total = 0;
      for (const s of Object.values(stats)) {
        assert.equal(s.hits, s.new + s.baselined + s.excepted);
        total += s.hits;
      }
      assert.equal(total, violations.length);
      assert.equal(Object.values(stats).reduce((n, s) => n + s.expired, 0), expired.length);
    }),
    RUNS,
  );
});

test('P10: the report is byte-identical regardless of engine and readdir order', () => {
  fc.assert(
    fc.property(
      fc.array(fc.array(raw, { maxLength: 10 }), { minLength: 1, maxLength: 4 }),
      fc.array(raw, { maxLength: 20 }),
      fc.array(exc, { maxLength: 4 }),
      fc.array(fc.nat(), { minLength: 1, maxLength: 40 }),
      fc.array(fc.nat(), { minLength: 1, maxLength: 40 }),
      (adapters, bRaw, excs, order1, order2) => {
        /**
         * @param {number[]} order
         */
        const run = (order) => {
          const engineOutputs = permute(adapters.map((a) => permute(a, order)), order);
          const violations = finalizeViolations(engineOutputs.flat());
          const { live, expired } = exceptionsFor(excs, order);
          const c = classify({
            violations,
            baseline: baselineFromViolations(finalizeViolations(permute(bRaw, order))),
            live,
            expired,
          });
          const d = decide({ classification: c, expiredExceptions: [] });
          const versions = Object.fromEntries(permute([['ruff', '0.16.6'], ['depcruise', '17.0.0'], ['eslint', '9.0.0']], order));
          return serializeReport(buildReport({
            repo: 'owner/repo', head_sha: 'f'.repeat(40), runner_version: '0.1.0', catalogue_digest: '0'.repeat(64),
            engine_versions: versions, rule_ids: permute(RULES, order), classification: c, exit_code: d.exitCode, today: TODAY,
          }));
        };
        const a = run(order1);
        const b = run(order2);
        const parsed = JSON.parse(a);
        const unique = new Set(finalizeViolations(adapters.flat()).map((v) => v.fingerprint));
        assert.equal(parsed.observed.length, unique.size);
        assert.equal(parsed.observed.reduce((/** @type {number} */ n, /** @type {{ count: number }} */ o) => n + o.count, 0), adapters.flat().length);
        assert.ok(Array.isArray(parsed.excepted));
        for (const x of parsed.excepted) assert.ok(unique.has(x.fingerprint));
        assert.equal(sha256Hex(a), sha256Hex(b));
        assert.equal(a, b);
      },
    ),
    RUNS,
  );
});
