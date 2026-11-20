import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { ADAPTERS } from '../src/cli/engines.mjs';
import { loadRepo } from '../src/cli/load.mjs';
import { finalizeViolations } from '../src/core/violation.mjs';
import { cleanupTemps, copyMiniRepo, runMain } from './cli-helpers.mjs';

after(cleanupTemps);

const DIR = copyMiniRepo();
const RULES = loadRepo(DIR).catalogue.rules;
const ENGINES = /** @type {string[]} */ ([...new Set(RULES.map((r) => r.engine))].sort());

/** @type {import('../src/cli/engine-util.mjs').EngineAdapter} */
const silent = { run: async () => ({ violations: [], version: 'stub' }) };

test('P11: stubbing any set of engine adapters to return [] makes selftest fail for exactly their rules', async () => {
  assert.deepEqual(ENGINES, ['command', 'depcruise', 'eslint', 'ruff', 'suppressions']);
  await fc.assert(
    fc.asyncProperty(fc.subarray(ENGINES, { minLength: 1 }), async (stubbed) => {
      const adapters = { ...ADAPTERS, ...Object.fromEntries(stubbed.map((e) => [e, silent])) };
      for (const cmd of [['selftest'], ['check', '--report', `${DIR}/r.json`]]) {
        const res = await runMain(cmd, { cwd: DIR, adapters });
        assert.equal(res.code, 2);
        const dead = res.stdout.trim().split('\n').map((l) => /^\[S2-SELFTEST\] (\S+) did not fire/.exec(l)?.[1]).filter(Boolean).sort();
        assert.deepEqual(dead, RULES.filter((r) => stubbed.includes(r.engine)).map((r) => r.id).sort());
      }
    }),
    { numRuns: 31 },
  );
});

test('P11: an adapter reporting a rule it was not asked to run is an adapter error (exit 2)', async () => {
  /** @type {import('../src/cli/engine-util.mjs').EngineAdapter} */
  const liar = { run: async () => ({ violations: finalizeViolations([{ rule_id: 'S2-OTHER-RULE', path: 'a.ts', subject: 'x' }]), version: 'stub' }) };
  const res = await runMain(['selftest'], { cwd: DIR, adapters: { ...ADAPTERS, command: liar } });
  assert.equal(res.code, 2);
  assert.match(res.stdout, /^\[S2-ADAPTER-INVALID\] engine command reported rule S2-OTHER-RULE/m);
});

test('selftest: a rule firing on its good fixture fails', async () => {
  /** @type {import('../src/cli/engine-util.mjs').EngineAdapter} */
  const always = { run: async (ctx) => ({ violations: finalizeViolations(ctx.rules.map((r) => ({ rule_id: r.id, path: 'x.ts', subject: 's' }))), version: 'stub' }) };
  const res = await runMain(['selftest', '--only', 'S2-DEP-*'], { cwd: DIR, adapters: { ...ADAPTERS, depcruise: always } });
  assert.equal(res.code, 2);
  assert.match(res.stdout, /^\[S2-SELFTEST\] S2-DEP-NO-VENDOR fired on \.square2\/fixtures\/S2-DEP-NO-VENDOR\/good\/ \(x\.ts s\)/);
});
