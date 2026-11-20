import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  BaselineError,
  baselineFromViolations,
  baselineSize,
  checkRatchet,
  diffBaseline,
  emptyBaseline,
  freshApprovals,
  grow,
  parseBaseline,
  serializeBaseline,
} from '../src/core/baseline.mjs';
import { catalogueDigest, validateCatalogue } from '../src/core/catalogue.mjs';
import { fingerprint, sha256Hex, toPosixPath, PathError } from '../src/core/fingerprint.mjs';
import { globMatch, isOverWideScope, parseExceptions, splitByExpiry, validateExceptions } from '../src/core/exceptions.mjs';
import { buildReport, classify, decide, githubAnnotations, ruleStats, serializeReport } from '../src/core/report.mjs';
import { AdapterOutputError, finalizeViolations } from '../src/core/violation.mjs';
import { parseYaml } from '../src/core/yaml.mjs';
import { GOOD_RULE, TODAY, exceptionsYaml, ruleYaml } from './helpers.mjs';

const APPROVALS_YAML = 'approvals:\n  - id: A-0001\n    approver: alice\n    date: 2026-11-20\n    reason: introduction\n    adr: ADR-1\n';
const V = finalizeViolations([
  { rule_id: 'S2-DEP-VENDOR', path: 'apps/a.ts', subject: 'pg', line: 3 },
  { rule_id: 'S2-DEP-VENDOR', path: 'apps/b.ts', subject: 'ws', line: 1 },
]);
const allFixtures = { fixtureDirExists: () => true };

// 1. glob matcher
test('glob: pathological ** chain against a long non-matching path is fast', () => {
  const path = 'a/'.repeat(400) + 'y';
  const t0 = performance.now();
  assert.equal(globMatch('**/**/**/**/**/x', path), false);
  assert.equal(globMatch('**/a/**/a/**/a/**/a/**/x', path), false);
  assert.equal(globMatch('*a*a*a*a*a*a*a*a*b', 'a'.repeat(5000)), false);
  assert.ok(performance.now() - t0 < 50, `took ${performance.now() - t0} ms`);
});

test('glob: ** is special only as a whole segment', () => {
  assert.equal(globMatch('a**/b', 'a/x/b'), false);
  assert.equal(globMatch('a**/b', 'ax/b'), true);
  assert.equal(globMatch('src/**', 'src'), true);
  assert.equal(globMatch('**/x.ts', 'x.ts'), true);
  assert.equal(globMatch('**/x.ts', 'a/b/x.ts'), true);
  assert.equal(globMatch('a/**/b/**', 'a/c/b/d/e'), true);
  assert.equal(globMatch('a/*', 'a/b/c'), false);
});

// 2. ratchet
const grownInput = {
  currentBaseline: baselineFromViolations(V),
  previousApprovalsText: null,
  currentApprovalsText: APPROVALS_YAML,
  approvers: ['alice'],
};

test('ratchet: unparseable previous approvals fail instead of counting as none', () => {
  const r = checkRatchet({ ...grownInput, previousBaseline: { kind: 'absent' }, previousApprovalsText: 'approvals: [x, y]\n' });
  assert.equal(r.status, 'grew');
  assert.match(r.diagnostics[0], /^\[S2-BASELINE-GREW\] .*previous approvals\.yaml/);
});

test('ratchet: absent previous file is an empty baseline, not a skip', () => {
  assert.equal(checkRatchet({ ...grownInput, previousBaseline: { kind: 'absent' }, currentApprovalsText: null }).status, 'grew');
  assert.equal(checkRatchet({ ...grownInput, previousBaseline: { kind: 'absent' } }).status, 'approved');
  assert.equal(checkRatchet({ ...grownInput, previousBaseline: { kind: 'no-commit' }, currentApprovalsText: null }).status, 'skipped');
});

test('ratchet: unparseable previous blob counts as empty; a fresh approval repairs it', () => {
  const unapproved = checkRatchet({ ...grownInput, currentApprovalsText: null, previousBaseline: { kind: 'blob', text: '{not json' } });
  assert.equal(unapproved.status, 'grew');
  assert.equal(unapproved.added, 2);
  assert.ok(unapproved.notes.some((n) => n.includes('previous baseline is unreadable')));
  assert.equal(decide({ ratchet: unapproved }).exitCode, 1);
  const repaired = checkRatchet({ ...grownInput, previousBaseline: { kind: 'blob', text: '{not json' } });
  assert.equal(repaired.status, 'approved');
  assert.equal(decide({ ratchet: repaired }).exitCode, 0);
});

test('freshApprovals: only new, valid ids', () => {
  const ok = { id: 'A-2', approver: 'alice', date: '2026-11-20', reason: 'r', adr: 'x' };
  const out = freshApprovals([{ id: 'A-1' }], [{ id: 'A-1', approver: 'alice', date: '2026-11-20', reason: 'r', adr: 'x' }, ok, { ...ok, id: 'A-3', approver: 'bob' }], ['alice']);
  assert.deepEqual(out, [ok]);
});

// 3. paths and subjects
test('NFC normalization of paths and subjects', () => {
  assert.equal(fingerprint('S2-A-B', 'caf\u00e9.ts', 'x\u00e9'), fingerprint('S2-A-B', 'cafe\u0301.ts', 'xe\u0301'));
  const [v] = finalizeViolations([{ rule_id: 'S2-A-B', path: './dir//cafe\u0301.ts', subject: 'e\u0301' }]);
  assert.equal(v.path, 'dir/caf\u00e9.ts');
  assert.equal(v.subject, '\u00e9');
});

for (const bad of ['/etc/passwd', 'C:\\x\\y.ts', 'c:/y.ts', 'a/../b.ts', '..', '\\\\server\\share', '']) {
  test(`adapter path ${JSON.stringify(bad)} is rejected with a typed error (exit 2)`, () => {
    assert.throws(() => toPosixPath(bad), PathError);
    let err;
    try {
      finalizeViolations([{ rule_id: 'S2-A-B', path: bad, subject: 's' }]);
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof AdapterOutputError);
    assert.equal(decide({ engine: [err.diagnostic] }).exitCode, 2);
    assert.match(err.diagnostic, /^\[S2-ADAPTER-INVALID\] [^\n]+ — Instead: [^\n]+$/);
  });
}

test('adapter rule ids must match the id pattern', () => {
  assert.throws(() => finalizeViolations([{ rule_id: 'bad id', path: 'a.ts', subject: 's' }]), AdapterOutputError);
});

test('catalogue scope and exclude are normalized and must be repo-relative', () => {
  const res = validateCatalogue([{ path: 'r.yaml', text: ruleYaml({ ...GOOD_RULE, scope: './apps//cafe\u0301/**' }) }], allFixtures);
  assert.deepEqual(res.rules[0].scope, ['apps/caf\u00e9/**']);
  for (const scope of ['../x/**', '/abs/**']) {
    const r = validateCatalogue([{ path: 'r.yaml', text: ruleYaml({ ...GOOD_RULE, scope }) }], allFixtures);
    assert.ok(r.diagnostics.some((d) => d.includes('invalid scope')), scope);
  }
  const r = validateCatalogue([{ path: 'r.yaml', text: ruleYaml({ ...GOOD_RULE, exclude: 'a/../b' }) }], allFixtures);
  assert.ok(r.diagnostics.some((d) => d.includes('invalid exclude')));
});

// 4. report observed / excepted
test('report lists observed and excepted fingerprints', () => {
  const vs = finalizeViolations([
    { rule_id: 'S2-DEP-VENDOR', path: 'apps/legacy/a.ts', subject: 'pg', line: 1 },
    { rule_id: 'S2-DEP-VENDOR', path: 'apps/b.ts', subject: 'pg', line: 1 },
    { rule_id: 'S2-DEP-VENDOR', path: 'apps/c.ts', subject: 'pg', line: 1 },
  ]);
  const ex = validateExceptions(parseExceptions(exceptionsYaml([{
    id: 'E-1', rule_id: 'S2-DEP-VENDOR', scope: 'apps/legacy/**', reason: 'r', owner: 'o', adr: 'a', created_at: '2026-11-01', expires_at: '2026-12-01',
  }])).entries, { ruleIds: ['S2-DEP-VENDOR'], today: TODAY });
  const c = classify({ violations: vs, baseline: baselineFromViolations(vs.filter((v) => v.path === 'apps/b.ts')), live: ex.valid, expired: [] });
  const report = JSON.parse(serializeReport(buildReport({
    repo: 'o/r', head_sha: 'h', runner_version: '0', catalogue_digest: '0'.repeat(64), engine_versions: {},
    rule_ids: ['S2-DEP-VENDOR'], classification: c, exit_code: 1, today: TODAY,
  })));
  assert.deepEqual(report.observed.map((/** @type {{ path: string }} */ o) => o.path).sort(), ['apps/b.ts', 'apps/c.ts', 'apps/legacy/a.ts']);
  assert.deepEqual(report.excepted, [{ count: 1, exception_id: 'E-1', fingerprint: vs.find((v) => v.path === 'apps/legacy/a.ts')?.fingerprint, path: 'apps/legacy/a.ts', rule_id: 'S2-DEP-VENDOR' }]);
  const schema = JSON.parse(readFileSync(new URL('../schemas/report.v1.json', import.meta.url), 'utf8'));
  for (const k of Object.keys(report)) assert.ok(k in schema.properties, k);
  for (const k of schema.required) assert.ok(k in report, k);
});

// 5. future created_at
test('exception created in the future is invalid', () => {
  const res = validateExceptions([{
    id: 'E-9', rule_id: 'S2-DEP-VENDOR', scope: 'a/**', reason: 'r', owner: 'o', adr: 'a', created_at: '2026-11-21', expires_at: '2026-12-01',
  }], { ruleIds: ['S2-DEP-VENDOR'], today: TODAY });
  assert.equal(res.valid.length, 0);
  assert.match(res.diagnostics[0], /^\[S2-EXC-INVALID\] E-9 created_at is in the future/);
});

// 6. over-wide scope
test('over-wide scopes include ? mixed with *', () => {
  for (const s of ['**/?*', '*?', '?*/**', '**', '*', './**']) assert.equal(isOverWideScope(s), true, s);
  for (const s of ['src/?', '?', 'a/*', '**/x.ts', 'src/**']) assert.equal(isOverWideScope(s), false, s);
});

// 7. duplicate-occurrence display and multiset diff
test('excess over the baseline count is reported once, without a line', () => {
  const vs = finalizeViolations([3, 9, 20].map((line) => ({ rule_id: 'S2-DEP-VENDOR', path: 'apps/a.ts', subject: 'pg', line, message: 'imports pg' })));
  const c = classify({ violations: vs, baseline: baselineFromViolations(vs.slice(0, 1)), live: [], expired: [] });
  assert.equal(c.fresh.length, 2);
  const d = decide({ classification: c, instead: { 'S2-DEP-VENDOR': 'use adapters' } });
  assert.deepEqual(d.lines, ['[S2-DEP-VENDOR] apps/a.ts pg (+2 over baseline) — Instead: use adapters']);
  assert.deepEqual(githubAnnotations(c, { 'S2-DEP-VENDOR': 'use adapters' }), [
    '::error file=apps/a.ts,title=S2-DEP-VENDOR::[S2-DEP-VENDOR] apps/a.ts pg (+2 over baseline) — Instead: use adapters',
  ]);
  const fresh = classify({ violations: vs, baseline: emptyBaseline(), live: [], expired: [] });
  assert.equal(decide({ classification: fresh }).lines.length, 3);
});

test('diffBaseline counts by multiset, not by occurrence index values', () => {
  const [v] = finalizeViolations([{ rule_id: 'S2-DEP-VENDOR', path: 'apps/a.ts', subject: 'pg', line: 3 }]);
  const gappy = [{ ...v, occurrence: 5 }, { ...v, occurrence: 7, line: 9 }];
  const { baselined, fresh } = diffBaseline(baselineFromViolations([v]), gappy);
  assert.equal(baselined.length, 1);
  assert.equal(fresh.length, 1);
});

// 8. YAML
test('yaml: colons inside plain scalars and keys', () => {
  assert.deepEqual(parseYaml('url: http://x.y/z:8080\na:b: 1\nc: a:b\nd:e:\n  f: 1\n- \n'.replace('- \n', '')), {
    url: 'http://x.y/z:8080', 'a:b': 1, c: 'a:b', 'd:e': { f: 1 },
  });
  assert.deepEqual(parseYaml('- http://x\n- a:b\n'), ['http://x', 'a:b']);
});

test('yaml: multi-space nested list indentation', () => {
  assert.deepEqual(parseYaml('a:\n    -   x\n    -   y\nb:\n  -    k: 1\n       j: 2\n'), { a: ['x', 'y'], b: [{ k: 1, j: 2 }] });
  assert.deepEqual(parseYaml('-  - c\n   - d\n'), [['c', 'd']]);
});

test('yaml: CRLF, BOM, quoted keys, block maps under -', () => {
  assert.deepEqual(parseYaml('\uFEFFa: 1\r\nb:\r\n  - x\r\n'), { a: 1, b: ['x'] });
  assert.deepEqual(parseYaml('"a b": 1\n\'c:d\': 2\n"e\\"f": 3\n'), { 'a b': 1, 'c:d': 2, 'e"f': 3 });
  assert.deepEqual(parseYaml('- a: 1\n  b:\n    c: 2\n- d: 3\n'), [{ a: 1, b: { c: 2 } }, { d: 3 }]);
});

test('yaml source has no invisible literal BOM', () => {
  const src = readFileSync(new URL('../src/core/yaml.mjs', import.meta.url), 'utf8');
  assert.equal(src.includes('\uFEFF'), false);
});

// 9. sha256
test('sha256Hex: known vectors, strings and bytes', () => {
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(sha256Hex(new Uint8Array([0x61, 0x62, 0x63])), sha256Hex('abc'));
  for (const s of ['x'.repeat(55), 'x'.repeat(56), 'x'.repeat(64), 'x'.repeat(200), 'héllo 😀 \0 z', '\ud800']) {
    assert.equal(sha256Hex(s), createHash('sha256').update(s, 'utf8').digest('hex'));
  }
});

// 10. digest
test('catalogue digest ignores which file a rule lives in', () => {
  const a = validateCatalogue([{ path: 'a.yaml', text: ruleYaml(GOOD_RULE) }], allFixtures);
  const b = validateCatalogue([{ path: 'moved/b.yaml', text: ruleYaml(GOOD_RULE) }], allFixtures);
  assert.equal(a.digest, b.digest);
  assert.equal(catalogueDigest(a.rules), catalogueDigest(b.rules));
});

// 11. catalogue and baseline coverage
test('catalogue: enabled false, exclude, options, multi-scope', () => {
  const text = `rules:
  - id: S2-PY-BANNED
    dune_rule: 5
    engine: ruff
    scope:
      - python/**
      - tools/*.py
    exclude: python/generated/**
    enabled: false
    description: banned imports
    instead: use the adapter
    owner: team
    options:
      select: TID251
      args:
        - --preview
`;
  const res = validateCatalogue([{ path: 'r.yaml', text }], allFixtures);
  assert.deepEqual(res.diagnostics, []);
  const r = res.rules[0];
  assert.equal(r.enabled, false);
  assert.deepEqual(r.scope, ['python/**', 'tools/*.py']);
  assert.deepEqual(r.exclude, ['python/generated/**']);
  assert.deepEqual(r.options, { select: 'TID251', args: ['--preview'] });
  assert.equal(r.description, 'banned imports');
});

test('catalogue: unknown top-level keys and invalid field types', () => {
  const extra = validateCatalogue([{ path: 'r.yaml', text: ruleYaml(GOOD_RULE) + 'version: 1\n' }], allFixtures);
  assert.ok(extra.diagnostics.some((d) => d.includes('unknown top-level key version')));
  for (const [field, value, needle] of [
    ['enabled', '"yes"', 'invalid enabled'],
    ['exclude', '3', 'invalid exclude'],
    ['options', '\n      - a', 'invalid options'],
    ['description', '1', 'invalid description'],
    ['owner', '5', 'invalid owner'],
    ['scope', '\n      - ""', 'invalid scope'],
    ['engine', 'true', 'unknown engine'],
  ]) {
    const fields = /** @type {Record<string, unknown>} */ ({ ...GOOD_RULE });
    delete fields[field];
    const text = ruleYaml(fields) + `    ${field}: ${value}\n`;
    const res = validateCatalogue([{ path: 'r.yaml', text }], allFixtures);
    assert.equal(res.exitCode, 2, field);
    assert.ok(res.diagnostics.some((d) => d.includes(needle)), `${field}: ${res.diagnostics.join(' | ')}`);
  }
});

test('baseline: grow into a non-empty baseline keeps old entries and adds the excess', () => {
  const approval = { id: 'A-1', approver: 'alice', date: '2026-11-20', reason: 'r', adr: 'x' };
  const start = baselineFromViolations(V.slice(0, 1));
  const more = finalizeViolations([
    { rule_id: 'S2-DEP-VENDOR', path: 'apps/a.ts', subject: 'pg', line: 3 },
    { rule_id: 'S2-DEP-VENDOR', path: 'apps/a.ts', subject: 'pg', line: 4 },
    { rule_id: 'S2-DEP-VENDOR', path: 'apps/b.ts', subject: 'ws', line: 1 },
  ]);
  const g = grow(start, more, { approval, approvers: ['alice'] });
  assert.equal(baselineSize(g), 3);
  const g2 = grow(baselineFromViolations(V), V.slice(0, 1), { approval, approvers: ['alice'] });
  assert.equal(baselineSize(g2), 2);
});

test('baseline: parse rejects non-POSIX path, unnormalized subject, count < 1, unknown entry fields', () => {
  const good = JSON.parse(serializeBaseline(baselineFromViolations(V.slice(0, 1))));
  const e = good.entries[0];
  /** @param {Record<string, unknown>} patch */
  const withEntry = (patch) => JSON.stringify({ schema_version: 1, entries: [{ ...e, ...patch }] });
  assert.throws(() => parseBaseline(withEntry({ path: 'apps\\a.ts', fingerprint: fingerprint('S2-DEP-VENDOR', 'apps/a.ts', 'pg') })), /normalized POSIX/);
  assert.throws(() => parseBaseline(withEntry({ path: '/apps/a.ts' })), BaselineError);
  assert.throws(() => parseBaseline(withEntry({ subject: 'p  g', fingerprint: fingerprint('S2-DEP-VENDOR', 'apps/a.ts', 'p g') })), /subject is not normalized/);
  assert.throws(() => parseBaseline(withEntry({ count: 0 })), /positive integer/);
  assert.throws(() => parseBaseline(withEntry({ note: 'x' })), /unknown field note/);
});

// 12. ruleStats prototype safety
test('ruleStats has no prototype collisions', () => {
  const c = classify({ violations: [], baseline: emptyBaseline(), live: [], expired: [] });
  const stats = ruleStats(c, ['toString', 'S2-A-B']);
  assert.deepEqual(Object.keys(stats), ['S2-A-B', 'toString']);
  assert.deepEqual(stats.toString, { hits: 0, new: 0, baselined: 0, excepted: 0, expired: 0 });
});

// 14. duplicate check uses the real id
test('an entry without id is not flagged duplicate because of a real id equal to its label', () => {
  const base = { rule_id: 'S2-DEP-VENDOR', scope: 'a/**', reason: 'r', owner: 'o', adr: 'a', created_at: '2026-11-01', expires_at: '2026-12-01' };
  const res = validateExceptions([{ ...base }, { ...base, id: '#1' }, { ...base, id: '#1' }], { ruleIds: ['S2-DEP-VENDOR'], today: TODAY });
  const first = res.diagnostics.find((d) => d.includes('missing id'));
  assert.ok(first);
  assert.equal(first.includes('duplicate id'), false, first);
  assert.equal(res.diagnostics.filter((d) => d.includes('duplicate id')).length, 2);
  assert.equal(splitByExpiry(res.valid, TODAY).live.length, 0);
});
