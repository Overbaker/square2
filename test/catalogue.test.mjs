import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateCatalogue } from '../src/core/catalogue.mjs';
import { decide } from '../src/core/report.mjs';
import { GOOD_RULE, ruleYaml } from './helpers.mjs';

const FILE = '.square2/rules/deps.yaml';
const allFixtures = { fixtureDirExists: () => true };
const LINE = /^\[[A-Z0-9-]+\] [^\n]+ — Instead: [^\n]+$/;

/**
 * @param {string} text
 * @param {{ fixtureDirExists: (id: string) => boolean }} [io]
 */
function run(text, io = allFixtures) {
  return validateCatalogue([{ path: FILE, text }], io);
}

/**
 * @param {ReturnType<typeof run>} res
 * @param {string} expected
 */
function assertRejected(res, expected) {
  assert.equal(res.ok, false);
  assert.equal(res.exitCode, 2);
  assert.equal(decide({ catalogue: res.diagnostics }).exitCode, 2);
  assert.ok(res.diagnostics.length > 0);
  for (const d of res.diagnostics) {
    assert.ok(d.startsWith('[S2-CATALOGUE] '), d);
    assert.match(d, LINE);
  }
  assert.ok(res.diagnostics.some((d) => d.includes(expected)), `${expected} not in ${res.diagnostics.join('\n')}`);
}

test('valid rule passes with defaults', () => {
  const res = run(ruleYaml(GOOD_RULE));
  assert.equal(res.ok, true);
  assert.equal(res.exitCode, 0);
  assert.deepEqual(res.diagnostics, []);
  assert.equal(res.rules.length, 1);
  assert.deepEqual(res.rules[0].scope, ['apps/**']);
  assert.equal(res.rules[0].enabled, true);
  assert.match(res.digest, /^[0-9a-f]{64}$/);
});

test('rule with empty instead: exact spec text', () => {
  const res = run(ruleYaml({ ...GOOD_RULE, instead: '' }));
  assertRejected(res, `[S2-CATALOGUE] ${FILE}: rule S2-DEP-VENDOR missing instead`);
});

test('rule with whitespace-only instead', () => {
  assertRejected(run(ruleYaml({ ...GOOD_RULE, instead: '   ' })), 'rule S2-DEP-VENDOR missing instead');
});

for (const field of ['id', 'dune_rule', 'engine', 'scope', 'instead', 'owner']) {
  test(`rule missing ${field}`, () => {
    const fields = /** @type {Record<string, unknown>} */ ({ ...GOOD_RULE });
    delete fields[field];
    assertRejected(run(ruleYaml(fields)), `missing ${field}`);
  });
}

for (const id of ['lowercase-id', 'S2', 'S2-', '-S2-X', 'S2--X', 'S2_X-Y', 'S2-X Y']) {
  test(`invalid id ${JSON.stringify(id)}`, () => {
    assertRejected(run(ruleYaml({ ...GOOD_RULE, id })), 'invalid id');
  });
}

for (const dune of [0, 6, -1, '"2"']) {
  test(`invalid dune_rule ${dune}`, () => {
    const text = ruleYaml({ ...GOOD_RULE, dune_rule: 1 }).replace('dune_rule: 1', `dune_rule: ${dune}`);
    assertRejected(run(text), 'invalid dune_rule');
  });
}

test('unknown engine', () => {
  assertRejected(run(ruleYaml({ ...GOOD_RULE, engine: 'nope' })), 'unknown engine');
});

test('empty scope list', () => {
  assertRejected(run(ruleYaml(GOOD_RULE).replace('scope: "apps/**"', 'scope: []')), 'invalid scope');
});

test('unknown field', () => {
  assertRejected(run(ruleYaml({ ...GOOD_RULE, colour: 'red' })), 'unknown field colour');
});

test('missing negative fixture directory', () => {
  /** @type {string[]} */
  const asked = [];
  const res = run(ruleYaml(GOOD_RULE), { fixtureDirExists: (id) => { asked.push(id); return false; } });
  assertRejected(res, 'missing fixture .square2/fixtures/S2-DEP-VENDOR/bad/');
  assert.deepEqual(asked, ['S2-DEP-VENDOR']);
});

test('duplicate ids across files', () => {
  const res = validateCatalogue(
    [
      { path: '.square2/rules/b.yaml', text: ruleYaml(GOOD_RULE) },
      { path: '.square2/rules/a.yaml', text: ruleYaml(GOOD_RULE) },
    ],
    allFixtures,
  );
  assertRejected(res, '.square2/rules/b.yaml: rule S2-DEP-VENDOR duplicate id (also in .square2/rules/a.yaml)');
});

test('duplicate ids within one file', () => {
  const text = ruleYaml(GOOD_RULE) + ruleYaml(GOOD_RULE).replace('rules:\n', '');
  assertRejected(run(text), 'duplicate id');
});

test('YAML outside the subset', () => {
  assertRejected(run('rules: [ {id: X} ]\n'), 'invalid YAML');
});

test('missing top-level rules list', () => {
  assertRejected(run('- id: S2-A-B\n'), 'expected a top-level "rules" list');
});

test('rule entry that is not a map', () => {
  assertRejected(run('rules:\n  - just-a-string\n'), 'rule #1 is not a mapping');
});

test('newline in a field is escaped in the diagnostic', () => {
  const res = run(ruleYaml({ ...GOOD_RULE, id: 'bad\nid' }));
  assertRejected(res, 'invalid id');
  assert.ok(res.diagnostics.every((d) => !d.includes('\n')));
});

test('digest is independent of file order', () => {
  const r2 = { ...GOOD_RULE, id: 'S2-SUPPRESS-X', engine: 'suppressions' };
  const a = validateCatalogue([{ path: 'a.yaml', text: ruleYaml(GOOD_RULE) }, { path: 'b.yaml', text: ruleYaml(r2) }], allFixtures);
  const b = validateCatalogue([{ path: 'b.yaml', text: ruleYaml(r2) }, { path: 'a.yaml', text: ruleYaml(GOOD_RULE) }], allFixtures);
  assert.equal(a.digest, b.digest);
});
