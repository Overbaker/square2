import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BaselineError,
  baselineFromViolations,
  baselineSize,
  checkRatchet,
  diffBaseline,
  emptyBaseline,
  grow,
  parseBaseline,
  serializeBaseline,
  shrink,
} from '../src/core/baseline.mjs';
import { decide } from '../src/core/report.mjs';
import { finalizeViolations } from '../src/core/violation.mjs';

const V = finalizeViolations([
  { rule_id: 'S2-DEP-VENDOR', path: 'apps/a.ts', subject: 'pg', line: 3 },
  { rule_id: 'S2-DEP-VENDOR', path: 'apps/a.ts', subject: 'pg', line: 9 },
  { rule_id: 'S2-DEP-VENDOR', path: 'apps/b.ts', subject: 'ws', line: 1 },
]);
const APPROVAL = { id: 'A-0001', approver: 'alice', date: '2026-11-20', reason: 'introduction', adr: 'ADR-1' };
const APPROVALS_YAML = 'approvals:\n  - id: A-0001\n    approver: alice\n    date: 2026-11-20\n    reason: introduction\n    adr: ADR-1\n';

test('diff: occurrences beyond the baseline count are new', () => {
  const b = baselineFromViolations(V.slice(0, 1));
  const { baselined, fresh } = diffBaseline(b, V);
  assert.equal(baselined.length, 1);
  assert.equal(baselined[0].line, 3);
  assert.deepEqual(fresh.map((v) => v.line), [9, 1]);
});

test('serialize/parse round trip and tamper detection', () => {
  const b = baselineFromViolations(V);
  const text = serializeBaseline(b);
  assert.deepEqual(parseBaseline(text), b);
  assert.ok(text.endsWith('\n'));
  const tampered = text.replace('"ws"', '"jose"');
  assert.throws(() => parseBaseline(tampered), BaselineError);
  assert.throws(() => parseBaseline('{'), BaselineError);
  assert.throws(() => parseBaseline('{"schema_version":2,"entries":[]}'), BaselineError);
});

test('shrink drops unobserved entries only', () => {
  const b = baselineFromViolations(V);
  const s = shrink(b, V.slice(2));
  assert.equal(baselineSize(s), 1);
  assert.equal(s.entries[0].subject, 'ws');
});

test('grow requires a valid approval with a listed approver', () => {
  assert.throws(() => grow(emptyBaseline(), V, { approvers: ['alice'] }), BaselineError);
  assert.throws(() => grow(emptyBaseline(), V, { approval: { ...APPROVAL, approver: 'mallory' }, approvers: ['alice'] }), /not listed/);
  assert.throws(() => grow(emptyBaseline(), V, { approval: { ...APPROVAL, adr: '' }, approvers: ['alice'] }), /missing adr/);
  const g = grow(emptyBaseline(), V, { approval: APPROVAL, approvers: ['alice'] });
  assert.equal(baselineSize(g), 3);
});

test('ratchet: skipped without a previous commit', () => {
  const r = checkRatchet({ previousBaseline: { kind: 'no-commit' }, currentBaseline: baselineFromViolations(V), previousApprovalsText: null, currentApprovalsText: null, approvers: [] });
  assert.equal(r.status, 'skipped');
  assert.equal(r.notes.length, 1);
  assert.equal(decide({ ratchet: r }).exitCode, 0);
});

test('ratchet: silent growth fails with S2-BASELINE-GREW', () => {
  const r = checkRatchet({
    previousBaseline: { kind: 'blob', text: serializeBaseline(baselineFromViolations(V.slice(0, 1))) },
    currentBaseline: baselineFromViolations(V),
    previousApprovalsText: null,
    currentApprovalsText: null,
    approvers: ['alice'],
  });
  assert.equal(r.status, 'grew');
  assert.equal(r.added, 2);
  assert.ok(r.diagnostics[0].startsWith('[S2-BASELINE-GREW] '));
  assert.equal(decide({ ratchet: r }).exitCode, 1);
});

test('ratchet: growth with a new approval passes; a pre-existing approval does not count', () => {
  const input = {
    previousBaseline: { kind: 'blob', text: serializeBaseline(emptyBaseline()) },
    currentBaseline: baselineFromViolations(V),
    previousApprovalsText: null,
    currentApprovalsText: APPROVALS_YAML,
    approvers: ['alice'],
  };
  assert.equal(checkRatchet(input).status, 'approved');
  assert.equal(checkRatchet({ ...input, previousApprovalsText: APPROVALS_YAML }).status, 'grew');
  assert.equal(checkRatchet({ ...input, approvers: ['bob'] }).status, 'grew');
});

test('ratchet: swapping one entry for another counts as growth', () => {
  const r = checkRatchet({
    previousBaseline: { kind: 'blob', text: serializeBaseline(baselineFromViolations(V.slice(0, 1))) },
    currentBaseline: baselineFromViolations(V.slice(2)),
    previousApprovalsText: null,
    currentApprovalsText: null,
    approvers: [],
  });
  assert.equal(r.status, 'grew');
});

test('ratchet: shrinking is ok', () => {
  const r = checkRatchet({
    previousBaseline: { kind: 'blob', text: serializeBaseline(baselineFromViolations(V)) },
    currentBaseline: baselineFromViolations(V.slice(1)),
    previousApprovalsText: null,
    currentApprovalsText: null,
    approvers: [],
  });
  assert.equal(r.status, 'ok');
});
