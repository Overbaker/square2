import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import fc from 'fast-check';
import { BaselineError, baselineFromViolations, checkRatchet, parseApprovals, serializeBaseline } from '../src/core/baseline.mjs';
import { validateCatalogue } from '../src/core/catalogue.mjs';
import { FingerprintInputError, PathError, fingerprint, toPosixPath } from '../src/core/fingerprint.mjs';
import { detectMutations, parseExceptions, validateExceptions } from '../src/core/exceptions.mjs';
import { AdapterOutputError, finalizeViolations } from '../src/core/violation.mjs';
import { YamlError, parseYaml } from '../src/core/yaml.mjs';
import { GOOD_RULE, TODAY, exceptionsYaml, ruleYaml } from './helpers.mjs';

const allFixtures = { fixtureDirExists: () => true };

// 1. leading ./ is stripped before the absolute/drive/.. checks
test('toPosixPath rejects drive paths hidden behind ./', () => {
  for (const p of ['./C:/x', '.\\C:\\x', './/C:', '././d:/y', './/x/../y']) assert.throws(() => toPosixPath(p), PathError, p);
  assert.equal(toPosixPath('.//x'), 'x');
  assert.equal(toPosixPath('a/C:/x'), 'a/C:/x');
});

test('toPosixPath is idempotent on its outputs', () => {
  const part = fc.constantFrom('.', '/', '\\', 'a', 'b', 'C:', 'z:', '..', '...', ' ', 'é', 'e\u0301', '//', './');
  fc.assert(
    fc.property(fc.array(part, { maxLength: 8 }), (parts) => {
      let out;
      try {
        out = toPosixPath(parts.join(''));
      } catch (err) {
        assert.ok(err instanceof PathError);
        return;
      }
      assert.equal(toPosixPath(out), out);
      assert.ok(!out.startsWith('/') && !/^[A-Za-z]:/.test(out) && !out.split('/').includes('..'));
    }),
    { numRuns: 1000 },
  );
});

// 2. fingerprint() itself rejects control characters
test('fingerprint rejects C0 control characters in rule id, path and subject', () => {
  assert.throws(() => fingerprint('S2-A\u0000-B', 'a.ts', 's'), FingerprintInputError);
  assert.throws(() => fingerprint('S2-A-B', 'a\u0000.ts', 's'), FingerprintInputError);
  assert.throws(() => fingerprint('S2-A-B', 'a.ts', 's\u0000'), FingerprintInputError);
  assert.throws(() => fingerprint('S2-A-B', 'a.ts', 'x\u001fy'), FingerprintInputError);
  assert.match(fingerprint('S2-A-B', 'a.ts', 'tab\tand\nnewline are whitespace'), /^[0-9a-f]{64}$/);
});

// 3. non-object adapter entries
for (const bad of [null, 1, 'x', [], true]) {
  test(`finalizeViolations rejects entry ${JSON.stringify(bad)}`, () => {
    assert.throws(() => finalizeViolations(/** @type {any} */ ([bad])), AdapterOutputError);
  });
}

// 4. depth limit, linear comment stripping, tabs as separators
const deepList = (n) => '- '.repeat(n) + 'x\n';
const deepMap = (n) => Array.from({ length: n }, (_, i) => ' '.repeat(i) + 'a:').join('\n') + ' 1\n';

test('yaml: 4000-level nesting is a YamlError, not a RangeError', () => {
  for (const text of [deepList(4000), deepMap(4000)]) {
    assert.throws(() => parseYaml(text), (err) => err instanceof YamlError && /nesting too deep/.test(err.message));
  }
  assert.doesNotThrow(() => parseYaml(deepList(60)));
  assert.doesNotThrow(() => parseYaml(deepMap(60)));
});

test('yaml: an 80 KB pathological line is processed in linear time', () => {
  const lines = ['k: ' + "x'".repeat(40_000), 'k: ' + ": '".repeat(27_000), "- " + "- '".repeat(27_000)];
  for (const line of lines) {
    const t0 = performance.now();
    try {
      parseYaml(line + '\n');
    } catch (err) {
      assert.ok(err instanceof YamlError, String(err && /** @type {Error} */ (err).name));
    }
    const ms = performance.now() - t0;
    assert.ok(ms < 200, `took ${ms} ms`);
  }
});

test('yaml: tabs separate after : and -', () => {
  assert.deepEqual(parseYaml("k:\t'v # x'\na:\tb\n"), { k: 'v # x', a: 'b' });
  assert.deepEqual(parseYaml("-\t'x # y'\n-\tz\n"), ['x # y', 'z']);
  assert.deepEqual(parseYaml('m:\n  -\tk:\tv\n'), { m: [{ k: 'v' }] });
});

// 5. callers turn parser failures into diagnostics (deep enough to overflow a recursive parser)
const HUGE = deepList(30_000);
test('callers of the parser never crash on hostile committed files', () => {
  const ex = parseExceptions(HUGE);
  assert.equal(ex.entries.length, 0);
  assert.match(ex.diagnostics[0], /^\[S2-EXC-INVALID\] /);
  const cur = parseExceptions(exceptionsYaml([{ id: 'E-1', rule_id: 'S2-A-B', scope: 'a/**', reason: 'r', owner: 'o', adr: 'a', created_at: '2026-11-01', expires_at: '2026-12-01' }])).entries;
  assert.match(detectMutations(HUGE, cur)[0], /^\[S2-EXC-MUTATED\] previous exceptions file unreadable: /);
  assert.throws(() => parseApprovals(HUGE), BaselineError);
  const cat = validateCatalogue([{ path: 'r.yaml', text: HUGE }], allFixtures);
  assert.equal(cat.exitCode, 2);
  assert.match(cat.diagnostics[0], /^\[S2-CATALOGUE\] r\.yaml: /);
  const r = checkRatchet({
    previousBaseline: { kind: 'absent' },
    currentBaseline: baselineFromViolations(finalizeViolations([{ rule_id: 'S2-A-B', path: 'a.ts', subject: 's' }])),
    previousApprovalsText: HUGE,
    currentApprovalsText: null,
    approvers: [],
  });
  assert.equal(r.status, 'grew');
});

// 6. schema parity
/**
 * @param {{ minLength?: number, pattern?: string, allOf?: { not: { pattern: string } }[] }} schema
 * @param {string} s
 */
function schemaStringAccepts(schema, s) {
  return (
    s.length >= (schema.minLength ?? 0) &&
    (schema.pattern === undefined || new RegExp(schema.pattern, 'u').test(s)) &&
    (schema.allOf ?? []).every((c) => !new RegExp(c.not.pattern, 'u').test(s))
  );
}

const GLOB_CORPUS = [
  'src/**', '**', '*', 'a/*.ts', './src/**', './/src', './C:/x', '.\\C:\\x', 'C:/x', 'c:\\x', '/abs', '\\abs',
  'a/../b', '../x', 'a/..', '..', '...', 'a..b', '.', './', '', '   ', ' src/** ', 'a\u0000b', 'a/b\u001f', 'a\\b/**', 'x/C:/y',
];

test('rule schema globs agree with the catalogue code; exclude: [] is allowed', () => {
  const schema = JSON.parse(readFileSync(new URL('../schemas/rule.v1.json', import.meta.url), 'utf8'));
  const glob = schema.$defs.glob;
  for (const s of GLOB_CORPUS) {
    const code = validateCatalogue([{ path: 'r.yaml', text: ruleYaml({ ...GOOD_RULE, scope: s }) }], allFixtures).ok;
    assert.equal(schemaStringAccepts(glob, s), code, JSON.stringify(s));
  }
  const exclude = schema.$defs.rule.properties.exclude.oneOf.find((/** @type {{ type?: string }} */ o) => o.type === 'array');
  assert.equal(exclude.minItems ?? 0, 0);
});

test('exceptions schema agrees with the code on scopes and required strings', () => {
  const schema = JSON.parse(readFileSync(new URL('../schemas/exceptions.v1.json', import.meta.url), 'utf8'));
  const props = schema.properties.exceptions.items.properties;
  const base = { id: 'E-1', rule_id: 'S2-A-B', scope: 'a/**', reason: 'r', owner: 'o', adr: 'a', created_at: '2026-11-01', expires_at: '2026-12-01' };
  /** @param {Record<string, unknown>} e */
  const code = (e) => validateExceptions([e], { ruleIds: ['S2-A-B'], today: TODAY }).valid.length === 1;
  for (const s of [...GLOB_CORPUS, '**/?*', '*?', './**', './/**', 'a/**/x']) {
    assert.equal(schemaStringAccepts(props.scope, s), code({ ...base, scope: s }), `scope ${JSON.stringify(s)}`);
  }
  for (const field of ['id', 'reason', 'owner', 'adr', 'renews']) {
    for (const v of ['x', ' ', '\t', '', ' y ']) {
      const entry = { ...base, [field]: field === 'renews' && v === 'x' ? 'E-0' : v };
      const value = /** @type {string} */ (entry[field]);
      assert.equal(schemaStringAccepts(props[field], value), code(entry), `${field} ${JSON.stringify(value)}`);
    }
  }
});

// 7. ratchet counts by fingerprint even for an unnormalized current baseline
test('checkRatchet sums duplicate entries of the current baseline', () => {
  const b = baselineFromViolations(finalizeViolations([{ rule_id: 'S2-A-B', path: 'a.ts', subject: 's' }]));
  const dup = { schema_version: 1, entries: [b.entries[0], { ...b.entries[0] }] };
  const r = checkRatchet({ previousBaseline: { kind: 'blob', text: serializeBaseline(b) }, currentBaseline: dup, previousApprovalsText: null, currentApprovalsText: null, approvers: [] });
  assert.equal(r.status, 'grew');
  assert.equal(r.added, 1);
});
