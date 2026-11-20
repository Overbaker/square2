import { test } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { baselineFromViolations, normalizeBaseline, parseBaseline, serializeBaseline } from '../src/core/baseline.mjs';
import { fingerprint, toPosixPath } from '../src/core/fingerprint.mjs';
import { finalizeViolations } from '../src/core/violation.mjs';
import { permute } from './helpers.mjs';

const RUNS = { numRuns: 250 };
const RULE = 'S2-TOY-USE';

/**
 * Toy engine: every `use <subject>;` line is a violation.
 * @param {string} path
 * @param {string} text
 */
function extract(path, text) {
  return text.split('\n').flatMap((line, i) => {
    const m = /^\s*use\s+(.+?)\s*;\s*$/.exec(line);
    return m ? [{ rule_id: RULE, path, subject: m[1], line: i + 1 }] : [];
  });
}

/** @param {ReturnType<typeof finalizeViolations>} vs */
const keys = (vs) => vs.map((v) => `${v.fingerprint}#${v.occurrence}`).sort();

const word = fc.stringMatching(/^[a-z@/.-]{1,8}$/);
const subjectWords = fc.array(word, { minLength: 1, maxLength: 3 });
const ws = fc.stringMatching(/^[ \t]{1,4}$/);

test('P1: fingerprints ignore line moves and whitespace, and change with the subject', () => {
  fc.assert(
    fc.property(
      fc.array(fc.integer({ min: 0, max: 3 }), { minLength: 1, maxLength: 12 }),
      fc.array(subjectWords, { minLength: 4, maxLength: 4 }),
      fc.array(fc.tuple(fc.nat(), fc.constantFrom('', '// note', 'const x = 1;', '  ')), { maxLength: 10 }),
      fc.array(ws, { minLength: 1, maxLength: 8 }),
      fc.nat(),
      (picks, pool, inserts, spaces, target) => {
        const path = 'src/a.ts';
        const original = picks.map((p) => `use ${pool[p].join(' ')};`);
        const before = keys(finalizeViolations(extract(path, original.join('\n'))));

        let k = 0;
        const sp = () => spaces[k++ % spaces.length];
        const edited = picks.map((p) => `${sp()}use${sp()}${pool[p].join(sp())}${sp()};${sp()}`);
        for (const [pos, filler] of inserts) edited.splice(pos % (edited.length + 1), 0, filler);
        const after = keys(finalizeViolations(extract(path, edited.join('\n'))));
        assert.deepEqual(after, before);

        const changed = original.slice();
        const idx = target % changed.length;
        changed[idx] = `use ${pool[picks[idx]].join(' ')}-changed;`;
        const mutated = keys(finalizeViolations(extract(path, changed.join('\n'))));
        assert.notDeepEqual(mutated, before);
      },
    ),
    RUNS,
  );
});

test('P1: the rule id and the path participate in the fingerprint', () => {
  fc.assert(
    fc.property(word, word, fc.string(), (p1, p2, subject) => {
      /** @param {string} p */
      const ok = (p) => { try { return toPosixPath(p); } catch { return null; } };
      fc.pre(ok(p1) !== null && ok(p2) !== null && ok(p1) !== ok(p2));
      assert.notEqual(fingerprint(RULE, p1, subject), fingerprint(RULE, p2, subject));
      assert.notEqual(fingerprint(RULE, p1, subject), fingerprint('S2-TOY-OTHER', p1, subject));
    }),
    RUNS,
  );
});

const unicodeText = fc.string({ unit: 'binary', maxLength: 12 }).filter((s) => !/[\u0000-\u001f]/.test(s.replace(/\s+/gu, ' ')));
const rawViolation = fc.record({
  rule_id: fc.constantFrom('S2-A-B', 'S2-C-D', 'X-1'),
  path: fc.constantFrom('a.ts', 'dir/ü.py', 'z/日本.mjs'),
  subject: fc.oneof(fc.constantFrom('pg', 'pg', 'ws'), unicodeText),
  line: fc.integer({ min: 1, max: 50 }),
});

test('P2: parse(serialize(B)) = B and serialization is canonical', () => {
  fc.assert(
    fc.property(fc.array(rawViolation, { maxLength: 25 }), fc.array(fc.nat(), { maxLength: 25 }), (raws, order) => {
      const b = baselineFromViolations(finalizeViolations(raws));
      const text = serializeBaseline(b);
      assert.deepEqual(parseBaseline(text), b);
      assert.equal(serializeBaseline(parseBaseline(text)), text);

      const shuffled = serializeBaseline(baselineFromViolations(finalizeViolations(permute(raws, order))));
      assert.equal(shuffled, text);

      const split = b.entries.flatMap((e) => Array.from({ length: e.count }, () => ({ ...e, count: 1 })));
      assert.equal(serializeBaseline(normalizeBaseline(permute(split, order))), text);
    }),
    RUNS,
  );
});
