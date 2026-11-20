import { test } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import {
  BaselineError,
  baselineCounts,
  baselineFromViolations,
  baselineSize,
  checkRatchet,
  grow,
  serializeBaseline,
  shrink,
} from '../src/core/baseline.mjs';
import { addDays } from '../src/core/clock.mjs';
import { detectMutations, parseExceptions, splitByExpiry, validateExceptions } from '../src/core/exceptions.mjs';
import { classify, decide } from '../src/core/report.mjs';
import { finalizeViolations } from '../src/core/violation.mjs';
import { TODAY, exceptionsYaml } from './helpers.mjs';

const RUNS = { numRuns: 300 };
const RULES = ['S2-R-A', 'S2-R-B'];
const PATHS = ['a/x.ts', 'b/y.ts', 'b/z/w.py'];
const SUBJECTS = ['pg', 'ws'];
const COMBOS = RULES.flatMap((rule_id) => PATHS.flatMap((path) => SUBJECTS.map((subject) => ({ rule_id, path, subject }))));
const combo = fc.integer({ min: 0, max: COMBOS.length - 1 });
const comboKey = (/** @type {number} */ i) => `${COMBOS[i].rule_id}|${COMBOS[i].path}|${COMBOS[i].subject}`;

/** @param {number[]} idx */
function toViolations(idx) {
  return finalizeViolations(idx.map((i, n) => ({ ...COMBOS[i], line: n + 1 })));
}

/** @param {number[]} idx */
function multiset(idx) {
  /** @type {Map<string, number>} */
  const m = new Map();
  for (const i of idx) m.set(comboKey(i), (m.get(comboKey(i)) ?? 0) + 1);
  return m;
}

test('P3: shrink yields a sub-multiset with count <= the original; grow without approval errors', () => {
  fc.assert(
    fc.property(fc.array(combo, { maxLength: 20 }), fc.array(combo, { maxLength: 20 }), (bIdx, vIdx) => {
      const b = baselineFromViolations(toViolations(bIdx));
      const v = toViolations(vIdx);
      const s = shrink(b, v);
      const before = baselineCounts(b);
      const observed = baselineCounts(baselineFromViolations(v));
      for (const e of s.entries) {
        assert.ok(e.count <= (before.get(e.fingerprint) ?? 0));
        assert.ok(e.count <= (observed.get(e.fingerprint) ?? 0));
      }
      assert.ok(baselineSize(s) <= baselineSize(b));
      assert.deepEqual(shrink(s, v), s);
      assert.throws(() => grow(b, v, { approvers: ['alice'] }), BaselineError);
      assert.throws(() => grow(b, v, { approval: null, approvers: ['alice'] }), BaselineError);
    }),
    RUNS,
  );
});

const exceptionGen = fc.record({
  rule: fc.integer({ min: 0, max: RULES.length - 1 }),
  scope: fc.constantFrom('a/x.ts', 'b/**', 'b/*.ts', 'a/*', 'b/z/*.py'),
  offset: fc.integer({ min: -3, max: 3 }),
  defect: fc.constantFrom('none', 'none', 'none', 'wide', 'future'),
  mutated: fc.boolean(),
});

/** @param {string} approver */
const approvalsYaml = (approver) => `approvals:\n  - id: A-1\n    approver: ${approver}\n    date: ${TODAY}\n    reason: r\n    adr: x\n`;

/** @param {string} glob @param {string} path */
function refGlob(glob, path) {
  if (glob.endsWith('/**')) return path.startsWith(glob.slice(0, -2));
  if (glob.includes('*')) {
    const [dir, ext] = glob.split('*');
    return path.startsWith(dir) && path.endsWith(ext) && !path.slice(dir.length).includes('/');
  }
  return glob === path;
}

test('P4: exit != 0 iff new violations remain, an exception expired/invalid/mutated, selftest failed or the baseline grew without approval', () => {
  fc.assert(
    fc.property(
      fc.array(combo, { maxLength: 15 }),
      fc.array(combo, { maxLength: 15 }),
      fc.array(combo, { maxLength: 15 }),
      fc.array(exceptionGen, { maxLength: 4 }),
      fc.boolean(),
      fc.constantFrom('none', 'valid', 'unlisted', 'preexisting'),
      (vIdx, bIdx, prevIdx, excs, selftestFails, approvalKind) => {
        const violations = toViolations(vIdx);
        const baseline = baselineFromViolations(toViolations(bIdx));
        const entries = excs.map((e, n) => ({
          id: `E-${n}`,
          rule_id: RULES[e.rule],
          scope: e.defect === 'wide' ? '**' : e.scope,
          reason: 'r',
          owner: 'o',
          adr: 'a',
          created_at: e.defect === 'future' ? addDays(TODAY, 1) : addDays(TODAY, -10),
          expires_at: addDays(TODAY, e.defect === 'future' ? 5 : e.offset),
        }));
        const previousExceptions = exceptionsYaml(entries.map((x, n) => (excs[n].mutated ? { ...x, expires_at: addDays(x.expires_at, 1) } : x)));
        const validated = validateExceptions(entries, { ruleIds: RULES, today: TODAY });
        const mutated = detectMutations(previousExceptions, parseExceptions(exceptionsYaml(entries)).entries);
        const expiry = splitByExpiry(validated.valid, TODAY);
        const ratchet = checkRatchet({
          previousBaseline: { kind: 'blob', text: serializeBaseline(baselineFromViolations(toViolations(prevIdx))) },
          currentBaseline: baseline,
          previousApprovalsText: approvalKind === 'preexisting' ? approvalsYaml('alice') : null,
          currentApprovalsText: approvalKind === 'none' ? null : approvalsYaml(approvalKind === 'unlisted' ? 'bob' : 'alice'),
          approvers: ['alice'],
        });
        const classification = classify({ violations, baseline, live: expiry.live, expired: expiry.expired });
        const d = decide({
          selftest: selftestFails ? ['[S2-SELFTEST] S2-R-A did not fire — Instead: fix the engine'] : [],
          classification,
          expiredExceptions: expiry.diagnostics,
          invalidExceptions: validated.diagnostics,
          mutatedExceptions: mutated,
          ratchet,
        });

        const v = multiset(vIdx);
        const b = multiset(bIdx);
        const prev = multiset(prevIdx);
        /** @type {string[]} */
        const remainder = [];
        for (const [k, n] of v) for (let i = 0; i < n - (b.get(k) ?? 0); i++) remainder.push(k);
        const validRef = excs.filter((e) => e.defect === 'none');
        const liveRef = validRef.filter((e) => e.offset >= 0);
        const uncovered = remainder.filter((k) => {
          const [rule, path] = k.split('|');
          return !liveRef.some((e) => RULES[e.rule] === rule && refGlob(e.scope, path));
        });
        const anyExpired = validRef.some((e) => e.offset < 0);
        const anyInvalid = validRef.length !== excs.length;
        const anyMutated = excs.some((e) => e.mutated);
        const grew = [...b].some(([k, n]) => n > (prev.get(k) ?? 0)) && approvalKind !== 'valid';
        const expectFail = uncovered.length > 0 || anyExpired || anyInvalid || anyMutated || selftestFails || grew;

        assert.equal(d.exitCode !== 0, expectFail);
        if (selftestFails) assert.equal(d.exitCode, 2);
        assert.equal(classification.fresh.length, uncovered.length);
        assert.equal(validated.diagnostics.length, excs.length - validRef.length);
        assert.equal(mutated.length, excs.filter((e) => e.mutated).length);
      },
    ),
    RUNS,
  );
});

test('P5: V is a sub-multiset of B and nothing expired => exit 0', () => {
  fc.assert(
    fc.property(fc.array(combo, { maxLength: 20 }), fc.array(fc.nat(), { maxLength: 20 }), (bIdx, take) => {
      const baseline = baselineFromViolations(toViolations(bIdx));
      const sub = baseline.entries.flatMap((e, i) => {
        const k = (take[i] ?? 0) % (e.count + 1);
        return Array.from({ length: k }, (_, n) => ({ rule_id: e.rule_id, path: e.path, subject: e.subject, line: 100 - n }));
      });
      const classification = classify({ violations: finalizeViolations(sub), baseline, live: [], expired: [] });
      const ratchet = checkRatchet({
        previousBaseline: { kind: 'blob', text: serializeBaseline(baseline) },
        currentBaseline: baseline,
        previousApprovalsText: null,
        currentApprovalsText: null,
        approvers: [],
      });
      const d = decide({ classification, ratchet });
      assert.equal(d.exitCode, 0);
      assert.deepEqual(d.lines, []);
      assert.equal(classification.baselined.length, sub.length);
    }),
    RUNS,
  );
});
