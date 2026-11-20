import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyExceptions,
  detectMutations,
  globMatch,
  isExpired,
  parseExceptions,
  splitByExpiry,
  ttlCapFromConfig,
  validateExceptions,
} from '../src/core/exceptions.mjs';
import { decide } from '../src/core/report.mjs';
import { finalizeViolations } from '../src/core/violation.mjs';
import { TODAY, exceptionsYaml } from './helpers.mjs';

const RULES = ['S2-DEP-VENDOR', 'S2-SUPPRESS-UNREGISTERED'];
const BASE = Object.freeze({
  id: 'E-0001',
  rule_id: 'S2-DEP-VENDOR',
  scope: 'apps/legacy/**',
  reason: 'migration in progress',
  owner: 'team-core',
  adr: 'ADR-12',
  created_at: '2026-11-01',
  expires_at: '2026-12-01',
});

/**
 * @param {Record<string, unknown>[]} entries
 * @param {number} [maxTtlDays]
 */
function check(entries, maxTtlDays) {
  const parsed = parseExceptions(exceptionsYaml(entries));
  assert.deepEqual(parsed.diagnostics, []);
  return validateExceptions(parsed.entries, { ruleIds: RULES, maxTtlDays, today: TODAY });
}

/**
 * @param {ReturnType<typeof check>} res
 * @param {string} needle
 */
function assertInvalid(res, needle) {
  assert.equal(res.valid.length, 0);
  assert.equal(res.diagnostics.length, 1);
  assert.ok(res.diagnostics[0].startsWith('[S2-EXC-INVALID] '), res.diagnostics[0]);
  assert.ok(res.diagnostics[0].includes(needle), res.diagnostics[0]);
  assert.equal(decide({ invalidExceptions: res.diagnostics }).exitCode, 1);
}

test('valid exception', () => {
  const res = check([BASE]);
  assert.deepEqual(res.diagnostics, []);
  assert.equal(res.valid.length, 1);
});

test('empty file and empty list mean no exceptions', () => {
  assert.deepEqual(parseExceptions(''), { entries: [], diagnostics: [] });
  assert.deepEqual(parseExceptions('exceptions: []\n'), { entries: [], diagnostics: [] });
});

for (const scope of ['**', '*', '**/*', './**', '*/**', '/**']) {
  test(`over-wide scope ${scope}`, () => assertInvalid(check([{ ...BASE, scope }]), 'is too wide'));
}

test('TTL of 120 days over the default cap of 90', () => {
  assertInvalid(check([{ ...BASE, created_at: '2026-11-01', expires_at: '2027-03-01' }]), 'TTL 120 days exceeds the cap of 90');
});

test('TTL exactly at the cap is allowed', () => {
  assert.equal(check([{ ...BASE, created_at: '2026-11-01', expires_at: '2027-01-30' }]).valid.length, 1);
});

test('TTL cap from config', () => {
  assert.equal(ttlCapFromConfig({}), 90);
  assert.equal(ttlCapFromConfig(null), 90);
  assert.equal(ttlCapFromConfig({ max_exception_ttl_days: 30 }), 30);
  assert.throws(() => ttlCapFromConfig({ max_exception_ttl_days: 0 }));
  assertInvalid(check([BASE], 20), 'exceeds the cap of 20');
});

for (const field of ['id', 'rule_id', 'scope', 'reason', 'owner', 'adr', 'created_at', 'expires_at']) {
  test(`missing ${field}`, () => {
    const e = /** @type {Record<string, unknown>} */ ({ ...BASE });
    delete e[field];
    assertInvalid(check([e]), `missing ${field}`);
  });
}

test('unknown rule_id', () => assertInvalid(check([{ ...BASE, rule_id: 'S2-NOPE-X' }]), 'unknown rule_id'));
test('non-ISO date', () => assertInvalid(check([{ ...BASE, expires_at: '2026-13-01' }]), 'expires_at must be YYYY-MM-DD'));
test('expires before created', () => assertInvalid(check([{ ...BASE, expires_at: '2026-10-01' }]), 'before created_at'));
test('unknown field', () => assertInvalid(check([{ ...BASE, colour: 'red' }]), 'unknown field colour'));
test('bad fingerprint', () => assertInvalid(check([{ ...BASE, fingerprint: 'abc' }]), 'fingerprint'));
test('renews itself', () => assertInvalid(check([{ ...BASE, renews: 'E-0001' }]), 'renews'));
test('integer id is not a string', () => assertInvalid(check([{ ...BASE, id: 7 }]), 'missing id'));

test('duplicate ids', () => {
  const res = check([BASE, { ...BASE }]);
  assert.equal(res.valid.length, 0);
  assert.equal(res.diagnostics.length, 2);
  assert.ok(res.diagnostics.every((d) => d.startsWith('[S2-EXC-INVALID] E-0001 ') && d.includes('duplicate id')));
});

test('YAML outside the subset', () => {
  const parsed = parseExceptions('exceptions: [{id: x}]\n');
  assert.equal(parsed.diagnostics.length, 1);
  assert.ok(parsed.diagnostics[0].startsWith('[S2-EXC-INVALID] '));
});

test('wrong top-level shape', () => {
  assert.ok(parseExceptions('- a\n').diagnostics[0].startsWith('[S2-EXC-INVALID] '));
  assert.ok(parseExceptions('exceptions: []\nother: 1\n').diagnostics[0].startsWith('[S2-EXC-INVALID] '));
});

test('renewal as a new id with renews is accepted', () => {
  const res = check([BASE, { ...BASE, id: 'E-0002', renews: 'E-0001', created_at: '2026-11-15', expires_at: '2027-01-15' }]);
  assert.deepEqual(res.diagnostics, []);
  assert.equal(res.valid[1].renews, 'E-0001');
});

test('expiry scenarios from the spec', () => {
  assert.equal(isExpired({ expires_at: '2026-12-01' }, '2026-12-02'), true);
  assert.equal(isExpired({ expires_at: '2026-12-01' }, '2026-12-01'), false);
  const { expired, diagnostics } = splitByExpiry(check([BASE]).valid, '2026-12-02');
  assert.equal(expired.length, 1);
  assert.ok(diagnostics[0].startsWith('[S2-EXC-EXPIRED] E-0001 '));
  assert.equal(decide({ expiredExceptions: diagnostics }).exitCode, 1);
});

test('mutated expires_at against the previous text', () => {
  const prev = exceptionsYaml([{ ...BASE, id: 'E-0003' }]);
  const cur = parseExceptions(exceptionsYaml([{ ...BASE, id: 'E-0003', expires_at: '2026-12-20' }])).entries;
  const out = detectMutations(prev, cur);
  assert.equal(out.length, 1);
  assert.ok(out[0].startsWith('[S2-EXC-MUTATED] E-0003 '));
  assert.equal(decide({ mutatedExceptions: out }).exitCode, 1);
  assert.deepEqual(detectMutations(prev, parseExceptions(prev).entries), []);
  assert.deepEqual(detectMutations(null, cur), []);
  assert.deepEqual(detectMutations('', cur), []);
});

test('glob matching', () => {
  assert.equal(globMatch('apps/**', 'apps/a/b.ts'), true);
  assert.equal(globMatch('apps/**/x.ts', 'apps/x.ts'), true);
  assert.equal(globMatch('apps/*.ts', 'apps/a/b.ts'), false);
  assert.equal(globMatch('apps/?.ts', 'apps/a.ts'), true);
  assert.equal(globMatch('a.b/c', 'aXb/c'), false);
});

test('exceptions cover matching rule and scope, optionally a fingerprint', () => {
  const vs = finalizeViolations([
    { rule_id: 'S2-DEP-VENDOR', path: 'apps/legacy/a.ts', subject: 'pg', line: 1 },
    { rule_id: 'S2-DEP-VENDOR', path: 'apps/new/a.ts', subject: 'pg', line: 1 },
    { rule_id: 'S2-SUPPRESS-UNREGISTERED', path: 'apps/legacy/a.ts', subject: 'eslint-disable', line: 2 },
  ]);
  const live = check([BASE]).valid;
  const { excepted, remaining } = applyExceptions(vs, live);
  assert.deepEqual(excepted.map((e) => e.violation.path), ['apps/legacy/a.ts']);
  assert.equal(remaining.length, 2);
  const pinned = check([{ ...BASE, fingerprint: 'f'.repeat(64) }]).valid;
  assert.equal(applyExceptions(vs, pinned).excepted.length, 0);
});
