import { test } from 'node:test';
import assert from 'node:assert/strict';
import { YamlError, parseYaml } from '../src/core/yaml.mjs';

test('parses block maps, lists and scalars', () => {
  const doc = parseYaml(`# header
rules:
  - id: S2-A-B   # trailing comment
    dune_rule: 2
    enabled: true
    scope:
      - "apps/**"
      - 'lib/it''s/**'
    instead: "use x: not y"
    created_at: 2026-11-20
    nothing:
  - id: S2-C-D
top: -5
list:
- a
- b
empty: []
emptymap: {}
hash: "a # not comment"
`);
  assert.deepEqual(doc, {
    rules: [
      { id: 'S2-A-B', dune_rule: 2, enabled: true, scope: ['apps/**', "lib/it's/**"], instead: 'use x: not y', created_at: '2026-11-20', nothing: null },
      { id: 'S2-C-D' },
    ],
    top: -5,
    list: ['a', 'b'],
    empty: [],
    emptymap: {},
    hash: 'a # not comment',
  });
});

test('empty document is null', () => {
  assert.equal(parseYaml(''), null);
  assert.equal(parseYaml('# only comment\n\n'), null);
});

test('nested lists of lists', () => {
  assert.deepEqual(parseYaml('a:\n  - - x\n    - y\n  - z\n'), { a: [['x', 'y'], 'z'] });
});

for (const [name, text] of [
  ['anchor', 'a: &x 1\n'],
  ['alias', 'a: *x\n'],
  ['tag', 'a: !!str 1\n'],
  ['flow list', 'a: [1, 2]\n'],
  ['flow map', 'a: {b: 1}\n'],
  ['block scalar', 'a: |\n  text\n'],
  ['folded scalar', 'a: >\n  text\n'],
  ['multi document', 'a: 1\n---\nb: 2\n'],
  ['duplicate key', 'a: 1\na: 2\n'],
  ['tab indent', 'a:\n\t- x\n'],
  ['bad indentation', 'a:\n    b: 1\n  c: 2\n'],
  ['unterminated quote', 'a: "abc\n'],
  ['inline nested map', '- a: b: c\n'],
  ['unquoted star', 'scope: **\n'],
  ['complex key', '? a\n'],
  ['proto key', '__proto__: 1\n'],
]) {
  test(`rejects ${name}`, () => {
    assert.throws(() => parseYaml(text), YamlError);
  });
}
