import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  BaselineError,
  baselineFromViolations,
  checkRatchet,
  normalizeBaseline,
  parseApprovals,
  parseBaseline,
  serializeBaseline,
} from '../src/core/baseline.mjs';
import { validateCatalogue } from '../src/core/catalogue.mjs';
import { sha256Hex } from '../src/core/fingerprint.mjs';
import { detectMutations, parseExceptions, validateExceptions } from '../src/core/exceptions.mjs';
import { decide } from '../src/core/report.mjs';
import { AdapterOutputError, finalizeViolations } from '../src/core/violation.mjs';
import { parseYaml } from '../src/core/yaml.mjs';
import { GOOD_RULE, TODAY, exceptionsYaml, ruleYaml } from './helpers.mjs';

const RULES = ['S2-DEP-VENDOR'];
const BASE = Object.freeze({
  id: 'E-0003', rule_id: 'S2-DEP-VENDOR', scope: 'apps/legacy/**', reason: 'r', owner: 'o', adr: 'a',
  created_at: '2026-11-01', expires_at: '2026-12-01',
});
const CURRENT = parseExceptions(exceptionsYaml([BASE])).entries;
const MUTATED_LINE = /^\[S2-EXC-MUTATED\] previous exceptions file unreadable: [^\n]+ — Instead: [^\n]+$/;

// 1. detectMutations fails closed on an unreadable previous file
for (const [name, prev] of [
  ['YAML error', 'exceptions: [ {id: x} ]\n'],
  ['extra top-level key', exceptionsYaml([BASE]) + 'other: 1\n'],
  ['missing top-level key', 'items: []\n'],
  ['entry not a mapping', 'exceptions:\n  - just-text\n'],
  ['entry without id', 'exceptions:\n  - expires_at: 2026-12-01\n'],
  ['entry with non-date expires_at', 'exceptions:\n  - id: E-0003\n    expires_at: soon\n'],
  ['duplicate previous ids', exceptionsYaml([BASE, BASE])],
]) {
  test(`detectMutations fails closed: previous ${name}`, () => {
    const out = detectMutations(prev, CURRENT);
    assert.equal(out.length, 1, out.join('\n'));
    assert.match(out[0], MUTATED_LINE);
    assert.equal(decide({ mutatedExceptions: out }).exitCode, 1);
  });
}

test('detectMutations: readable previous file still compares normally', () => {
  assert.deepEqual(detectMutations(exceptionsYaml([BASE]), CURRENT), []);
  assert.deepEqual(detectMutations('', CURRENT), []);
  assert.deepEqual(detectMutations('exceptions:\n', CURRENT), []);
  const out = detectMutations(exceptionsYaml([{ ...BASE, expires_at: '2026-11-25' }]), CURRENT);
  assert.equal(out.length, 1);
  assert.match(out[0], /^\[S2-EXC-MUTATED\] E-0003 expires_at changed from 2026-11-25 to 2026-12-01/);
});

// 2. hostile expires_at values never throw
test('expires_at as a block map with a toString key is invalid, not a crash', () => {
  const text = 'exceptions:\n  - id: E-0003\n    rule_id: S2-DEP-VENDOR\n    scope: apps/legacy/**\n    reason: r\n    owner: o\n    adr: a\n    created_at: 2026-11-01\n    expires_at:\n      toString: x\n      valueOf: y\n';
  const parsed = parseExceptions(text);
  assert.deepEqual(parsed.diagnostics, []);
  const res = validateExceptions(parsed.entries, { ruleIds: RULES, today: TODAY });
  assert.equal(res.valid.length, 0);
  assert.match(res.diagnostics[0], /^\[S2-EXC-INVALID\] E-0003 missing expires_at/);
  assert.deepEqual(detectMutations(exceptionsYaml([BASE]), parsed.entries), []);
  const prevHostile = detectMutations(text, CURRENT);
  assert.match(prevHostile[0], MUTATED_LINE);
});

test('core sources never call String() on values', () => {
  for (const f of ['baseline', 'catalogue', 'exceptions', 'report', 'violation', 'yaml', 'clock', 'fingerprint', 'canonical-json']) {
    const src = readFileSync(new URL(`../src/core/${f}.mjs`, import.meta.url), 'utf8');
    assert.doesNotMatch(src, /\bString\(/, f);
  }
});

// 3. U+2028 / U+2029 inside lines
test('yaml: line and paragraph separators inside values keep indentation', () => {
  assert.deepEqual(parseYaml('a:\n  b: "x\u2028y"\n  c: p\u2029q\n'), { a: { b: 'x\u2028y', c: 'p\u2029q' } });
  const entry = { ...BASE, reason: 'line\u2028sep', owner: 'para\u2029sep' };
  const parsed = parseExceptions(exceptionsYaml([entry]));
  assert.deepEqual(parsed.diagnostics, []);
  assert.equal(validateExceptions(parsed.entries, { ruleIds: RULES, today: TODAY }).valid.length, 1);
});

// 4. key with a null value is an empty list
test('approvals: and exceptions: with only comments under them are empty lists', () => {
  assert.deepEqual(parseApprovals('approvals:\n  # none yet\n'), []);
  assert.deepEqual(parseExceptions('exceptions:\n  # none yet\n'), { entries: [], diagnostics: [] });
  const grown = {
    previousBaseline: /** @type {const} */ ({ kind: 'absent' }),
    currentBaseline: baselineFromViolations(finalizeViolations([{ rule_id: 'S2-DEP-VENDOR', path: 'a.ts', subject: 'pg' }])),
    approvers: ['alice'],
  };
  const approvals = 'approvals:\n  - id: A-1\n    approver: alice\n    date: 2026-11-20\n    reason: r\n    adr: x\n';
  assert.equal(checkRatchet({ ...grown, previousApprovalsText: 'approvals:\n', currentApprovalsText: approvals }).status, 'approved');
  assert.equal(checkRatchet({ ...grown, previousApprovalsText: null, currentApprovalsText: 'approvals:\n' }).status, 'grew');
  assert.deepEqual(detectMutations('exceptions:\n# c\n', CURRENT), []);
});

// 5. where a quote may open a quoted scalar
test('yaml: quotes after a colon inside a plain scalar are literal', () => {
  assert.deepEqual(parseYaml("k: a:'b\nj: a:\"b # comment\nm: it's\n"), { k: "a:'b", j: 'a:"b', m: "it's" });
  assert.deepEqual(parseYaml("k: 'a # b' # c\n"), { k: 'a # b' });
});

test('yaml: multiple spaces after list dashes', () => {
  assert.deepEqual(parseYaml("-   'x # y'\n-   - \"z\"\n    -  'w'\n"), ['x # y', ['z', 'w']]);
  assert.deepEqual(parseYaml("a:\n  -    'q'   # c\n"), { a: ['q'] });
  assert.deepEqual(parseYaml("-   -   'a # b'\n"), [['a # b']]);
});

// 6. control characters
for (const [field, raw] of [
  ['path', { rule_id: 'S2-DEP-VENDOR', path: 'a\u0000b.ts', subject: 'pg' }],
  ['subject', { rule_id: 'S2-DEP-VENDOR', path: 'a.ts', subject: 'p\u0000g' }],
  ['subject (bell)', { rule_id: 'S2-DEP-VENDOR', path: 'a.ts', subject: 'p\u0007g' }],
  ['rule_id', { rule_id: 'S2-DEP\u0000-X', path: 'a.ts', subject: 'pg' }],
]) {
  test(`finalizeViolations rejects a control character in ${field}`, () => {
    assert.throws(() => finalizeViolations([raw]), AdapterOutputError);
  });
}

test('parseBaseline rejects control characters and invalid rule ids', () => {
  /** @param {string} rule_id @param {string} path @param {string} subject */
  const doc = (rule_id, path, subject) => JSON.stringify({ schema_version: 1, entries: [{ fingerprint: sha256Hex(`${rule_id}\0${path}\0${subject}`), rule_id, path, subject, count: 1 }] });
  assert.throws(() => parseBaseline(doc('S2-A-B', 'a.ts', 'p\u0000g')), BaselineError);
  assert.throws(() => parseBaseline(doc('S2-A-B', 'a\u0000.ts', 'pg')), BaselineError);
  assert.throws(() => parseBaseline(doc('lower-case', 'a.ts', 'pg')), /rule_id is invalid/);
  assert.doesNotThrow(() => parseBaseline(doc('S2-A-B', 'a.ts', 'pg')));
});

// 7. covered in regressions.test.mjs ('unparseable previous blob counts as empty')

// 8. exclude: []
test('catalogue accepts exclude: [] but not scope: []', () => {
  const ok = validateCatalogue([{ path: 'r.yaml', text: ruleYaml(GOOD_RULE) + '    exclude: []\n' }], { fixtureDirExists: () => true });
  assert.deepEqual(ok.diagnostics, []);
  assert.deepEqual(ok.rules[0].exclude, []);
  const bad = validateCatalogue([{ path: 'r.yaml', text: ruleYaml(GOOD_RULE).replace('scope: "apps/**"', 'scope: []') }], { fixtureDirExists: () => true });
  assert.ok(bad.diagnostics.some((d) => d.includes('invalid scope')));
});

// 9. large lists parse in linear time
test('yaml: a 4,000-entry list of maps parses quickly', () => {
  const text = 'exceptions:\n' + Array.from({ length: 4000 }, (_, i) => `  - id: E-${i}\n    scope: a/${i}/**\n    reason: r\n`).join('');
  parseYaml(text);
  const t0 = performance.now();
  const doc = /** @type {{ exceptions: unknown[] }} */ (parseYaml(text));
  const ms = performance.now() - t0;
  assert.equal(doc.exceptions.length, 4000);
  assert.ok(ms < 100, `took ${ms} ms`);
});

// 10. safe-integer counts
test('normalizeBaseline rejects merged counts beyond MAX_SAFE_INTEGER', () => {
  const e = { fingerprint: 'f'.repeat(64), rule_id: 'S2-A-B', path: 'a.ts', subject: 's', count: Number.MAX_SAFE_INTEGER };
  assert.throws(() => normalizeBaseline([e, { ...e, count: 1 }]), BaselineError);
  assert.equal(normalizeBaseline([e]).entries[0].count, Number.MAX_SAFE_INTEGER);
  assert.ok(serializeBaseline(normalizeBaseline([{ ...e, count: 2 }])).includes('"count": 2'));
});

// 11. schema and code agree on scopes
test('exceptions schema: required key and scope patterns agree with validateExceptions', () => {
  const schema = JSON.parse(readFileSync(new URL('../schemas/exceptions.v1.json', import.meta.url), 'utf8'));
  assert.deepEqual(schema.required, ['exceptions']);
  const scopeSchema = schema.properties.exceptions.items.properties.scope;
  /** @param {string} s */
  const schemaAccepts = (s) =>
    s.length >= scopeSchema.minLength &&
    new RegExp(scopeSchema.pattern, 'u').test(s) &&
    scopeSchema.allOf.every((/** @type {{ not: { pattern: string } }} */ c) => !new RegExp(c.not.pattern, 'u').test(s));
  /** @param {string} s */
  const codeAccepts = (s) => validateExceptions([{ ...BASE, scope: s }], { ruleIds: RULES, today: TODAY }).valid.length === 1;
  const corpus = [
    '**', '*', '**/?*', '*?', '?*/**', './**', '/**', '**/**', '*/*', '.', './', '', '   ', ' ** ',
    'src/**', 'src/?', '?', 'a/*', '**/x.ts', 'apps/legacy/**', '*.', '.*', 'a\\b/**', '\\**', '.\\**',
    '/abs/x', 'C:/x', 'c:\\x', 'a/../b', '../x', 'a/..', '..', 'a/..b/c', 'a..b', 'a\u0000b', 'a/b\u001f',
  ];
  for (const s of corpus) assert.equal(schemaAccepts(s), codeAccepts(s), JSON.stringify(s));
});
