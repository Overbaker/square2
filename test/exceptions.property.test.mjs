import { test } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { addDays } from '../src/core/clock.mjs';
import { globMatch, parseExceptions, validateExceptions } from '../src/core/exceptions.mjs';
import { exceptionsYaml } from './helpers.mjs';
import { runP6 } from './p6-property.mjs';

const RUNS = { numRuns: 300 };
const RULES = ['S2-R-A', 'S2-R-B'];
const TZ_CASES = [
  ['Pacific/Kiritimati', -840],
  ['Etc/GMT+12', 720],
];

test('P6: expired iff the UTC run date is after expires_at, for inputs in UTC-14..UTC+14', () => {
  runP6();
});

for (const [tz, offset] of TZ_CASES) {
  test(`P6 under TZ=${tz} in a child process`, () => {
    const res = spawnSync(process.execPath, [fileURLToPath(new URL('./p6-property.mjs', import.meta.url))], {
      env: { ...process.env, TZ: String(tz), SQUARE2_TODAY: '' },
      encoding: 'utf8',
    });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout.trim(), `ok offset=${offset}`);
  });
}

const text = fc.string({ minLength: 1, maxLength: 12, unit: 'grapheme' }).filter((s) => s.trim() !== '');
const REQUIRED = ['id', 'rule_id', 'scope', 'reason', 'owner', 'adr', 'created_at', 'expires_at'];

test('P7: omitted fields, over-wide scopes, future created_at and TTL over the cap are rejected; valid entries are accepted', () => {
  fc.assert(
    fc.property(
      fc.record({
        id: fc.stringMatching(/^E-[0-9]{1,4}$/),
        rule: fc.constantFrom(...RULES),
        dir: fc.stringMatching(/^[a-z]{1,6}$/),
        reason: text,
        owner: text,
        adr: text,
        created: fc.integer({ min: 0, max: 2000 }),
        cap: fc.integer({ min: 1, max: 180 }),
        ttlFrac: fc.double({ min: 0, max: 1, noNaN: true }),
      }),
      fc.oneof(
        fc.constant({ kind: 'none' }),
        fc.record({ kind: fc.constant('omit'), field: fc.constantFrom(...REQUIRED) }),
        fc.record({ kind: fc.constant('wide'), scope: fc.constantFrom('**', '*', '**/*', './**', '*/*', '**/**', '**/?*', '*?', '?*/**', '/**') }),
        fc.record({ kind: fc.constant('future'), ahead: fc.integer({ min: 1, max: 60 }) }),
        fc.record({ kind: fc.constant('ttl'), over: fc.integer({ min: 1, max: 400 }) }),
      ),
      fc.boolean(),
      (base, mutation, viaYaml) => {
        const runDate = addDays('2024-01-01', 2000);
        const created = addDays('2024-01-01', base.created);
        const ttl = Math.floor(base.ttlFrac * base.cap);
        /** @type {Record<string, unknown>} */
        const entry = {
          id: base.id,
          rule_id: base.rule,
          scope: `${base.dir}/**`,
          reason: base.reason,
          owner: base.owner,
          adr: base.adr,
          created_at: created,
          expires_at: addDays(created, ttl),
        };
        if (mutation.kind === 'omit') delete entry[/** @type {{ field: string }} */ (mutation).field];
        if (mutation.kind === 'wide') entry.scope = /** @type {{ scope: string }} */ (mutation).scope;
        if (mutation.kind === 'future') {
          entry.created_at = addDays(runDate, /** @type {{ ahead: number }} */ (mutation).ahead);
          entry.expires_at = addDays(/** @type {string} */ (entry.created_at), ttl);
        }
        if (mutation.kind === 'ttl') entry.expires_at = addDays(created, base.cap + /** @type {{ over: number }} */ (mutation).over);

        /** @type {unknown[]} */
        let entries = [entry];
        if (viaYaml) {
          const parsed = parseExceptions(exceptionsYaml([entry]));
          assert.deepEqual(parsed.diagnostics, []);
          entries = parsed.entries;
        }
        const res = validateExceptions(entries, { ruleIds: RULES, maxTtlDays: base.cap, today: runDate });
        if (mutation.kind === 'none') {
          assert.deepEqual(res.diagnostics, []);
          assert.equal(res.valid.length, 1);
        } else {
          assert.equal(res.valid.length, 0);
          assert.equal(res.diagnostics.length, 1);
          assert.match(res.diagnostics[0], /^\[S2-EXC-INVALID\] /);
          if (mutation.kind !== 'omit' || /** @type {{ field: string }} */ (mutation).field !== 'id') {
            assert.ok(res.diagnostics[0].startsWith(`[S2-EXC-INVALID] ${base.id} `));
          }
          if (mutation.kind === 'future') {
            assert.ok(res.diagnostics[0].includes('created_at is in the future'), res.diagnostics[0]);
          }
        }
      },
    ),
    RUNS,
  );
});

/**
 * Reference matcher: plain recursion over segments and characters.
 * @param {string[]} g
 * @param {string[]} p
 * @returns {boolean}
 */
function refSegments(g, p) {
  if (g.length === 0) return p.length === 0;
  if (g[0] === '**') return refSegments(g.slice(1), p) || (p.length > 0 && refSegments(g, p.slice(1)));
  return p.length > 0 && refChars(g[0], p[0]) && refSegments(g.slice(1), p.slice(1));
}

/**
 * @param {string} g
 * @param {string} t
 * @returns {boolean}
 */
function refChars(g, t) {
  if (g === '') return t === '';
  if (g[0] === '*') return refChars(g.slice(1), t) || (t !== '' && refChars(g, t.slice(1)));
  return t !== '' && (g[0] === '?' || g[0] === t[0]) && refChars(g.slice(1), t.slice(1));
}

test('globMatch agrees with a reference matcher on random globs and paths', () => {
  const gseg = fc.constantFrom('**', '*', '?', 'a', 'b', 'a*', '*b', '?a', 'a**', '*a*', 'ab');
  const pseg = fc.constantFrom('a', 'b', 'ab', 'ba', 'aa', 'aab');
  fc.assert(
    fc.property(fc.array(gseg, { minLength: 1, maxLength: 6 }), fc.array(pseg, { minLength: 1, maxLength: 7 }), (g, p) => {
      assert.equal(globMatch(g.join('/'), p.join('/')), refSegments(g, p), `${g.join('/')} vs ${p.join('/')}`);
    }),
    { numRuns: 1000 },
  );
});
