import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import fc from 'fast-check';
import { sha256Hex } from '../src/core/fingerprint.mjs';
import { main } from '../src/cli/main.mjs';
import { hasMention } from '../src/review/render.mjs';
import { createGitHub } from '../src/issues/github.mjs';
import { GATE_LABEL, REVIEW_LABEL, gateItems, parseKey, publish, reviewItems } from '../src/issues/publish.mjs';
import { findingMarker } from '../src/review/render.mjs';
import { writeRunArtifacts } from './issues/run-artifacts.mjs';
import { findingKey as reviewKey } from '../src/review/validate.mjs';
import { StateIssue, parseState } from '../src/issues/state.mjs';
import { cleanupTemps, copyMiniRepo } from './cli-helpers.mjs';
import { FakeGitHub } from './issues/fake-github.mjs';

after(cleanupTemps);

const RUNS = { numRuns: 60 };
const POOL = 6;
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const NOTIFY = ['alice', 'bob', 'carol'];

/** @param {number} i @param {boolean} mention */
function reviewFinding(i, mention) {
  return { severity: ['Blocker', 'Major', 'Minor', 'Nit'][i % 4], path: `src/f${i}.ts`, line: i + 1, side: 'RIGHT', title: `Defect ${i}`, body: mention ? `ask @eve${i} about it` : 'text', failure_case: `case ${i}${mention ? ' cc @dave' : ''}`, suggestion: 'fix', enclosing_symbol: `fn${i}`, mechanizable: false, commit: SHA_B };
}
/** @param {number} i */
const gateKey = (i) => sha256Hex(`gate-${i}`);
/** @param {'gate' | 'review'} kind @param {number} i */
const keyOf = (kind, i) => (kind === 'gate' ? gateKey(i) : reviewKey(reviewFinding(i, false)));

/** existing issue per pool slot: none, open, closed completed, closed not planned */
const existingArb = fc.array(fc.constantFrom('none', 'open', 'completed', 'not_planned'), { minLength: POOL, maxLength: POOL });
const subsetArb = fc.uniqueArray(fc.integer({ min: 0, max: POOL - 1 }), { maxLength: POOL });

/**
 * @typedef {{ kind: 'gate' | 'review', existing: string[], items: number[], observedExtra: number[], cap: number, mentions: boolean }} Scenario
 */
const scenarioArb = fc.record({
  kind: fc.constantFrom(/** @type {const} */ ('gate'), /** @type {const} */ ('review')),
  existing: existingArb,
  items: subsetArb,
  observedExtra: subsetArb,
  cap: fc.integer({ min: 0, max: POOL }),
  mentions: fc.boolean(),
});

/** @param {Scenario} s */
function seeded(s) {
  const fake = new FakeGitHub({ pageSize: 2 });
  s.existing.forEach((st, i) => {
    if (st === 'none') return;
    const label = s.kind === 'gate' ? GATE_LABEL : REVIEW_LABEL;
    const rule = s.kind === 'gate' ? '<!-- square2:rule:S2-DEP-X -->\n' : '';
    fake.seed({ title: `old ${i}`, body: `${findingMarker(keyOf(s.kind, i))}\n${rule}old`, labels: ['square2', label], state: st === 'open' ? 'open' : 'closed', state_reason: st === 'open' ? null : st });
  });
  return fake;
}

/** @param {Scenario} s */
function gateReport(s) {
  const observed = [...new Set([...s.items, ...s.observedExtra])];
  return {
    head_sha: SHA_B,
    catalogue_digest: 'c'.repeat(64),
    exit_code: 1,
    rules: { 'S2-DEP-X': {} },
    new_violations: s.items.map((i) => ({ rule_id: 'S2-DEP-X', path: `apps/f${i}.ts`, line: 1, message: `banned ${i}${s.mentions ? ' @mallory' : ''}`, fingerprint: gateKey(i), count: 1 })),
    observed: observed.map((i) => ({ fingerprint: gateKey(i), rule_id: 'S2-DEP-X', path: `apps/f${i}.ts`, count: 1 })),
    excepted: [],
  };
}

/** @param {Scenario} s */
function reviewDoc(s) {
  return { ok: true, input_id: 'review-input', range: { from_sha: SHA_A, to_sha: SHA_B }, branch: 'dev', published: s.items.map((i) => ({ ...reviewFinding(i, s.mentions), key: keyOf('review', i) })) };
}

/**
 * One publish of the scenario's run.
 * @param {FakeGitHub} fake
 * @param {Scenario} s
 */
function runOnce(fake, s) {
  const gh = createGitHub({ token: 't', repo: fake.repo, fetch: fake.fetch });
  const state = new StateIssue(gh);
  if (s.kind === 'gate') {
    const rep = gateReport(s);
    return publish({ gh, state, run: { kind: 'gate', inputId: 'gate-input', branch: 'dev', sha: SHA_B }, items: gateItems(rep), cap: s.cap, notify: NOTIFY, resolveGate: { observed: new Set(rep.observed.map((o) => o.fingerprint)), baselined: new Set(), rules: new Set(['S2-DEP-X']) } });
  }
  return publish({ gh, state, run: { kind: 'review', inputId: 'review-input', branch: 'dev', sha: SHA_B }, items: reviewItems(reviewDoc(s)), cap: s.cap, notify: NOTIFY });
}

/** @param {FakeGitHub} fake */
function stateIssue(fake) {
  return fake.issues.find((i) => i.labels.includes('square2-state'));
}

/** @param {FakeGitHub} fake */
function assertNoDuplicates(fake) {
  const keys = fake.issues.map((i) => parseKey(i.body)).filter((k) => k !== null);
  assert.equal(new Set(keys).size, keys.length, 'one issue per key');
  assert.ok(fake.issues.filter((i) => i.labels.includes('square2-state')).length <= 1, 'one state issue');
  for (const i of fake.issues) {
    const markers = i.comments.map((c) => /<!-- square2:[a-z-]+:[^\s>]+ -->/.exec(c.body)?.[0]).filter(Boolean);
    assert.equal(new Set(markers).size, markers.length, `no duplicate comment on #${i.number}`);
  }
}

describe('P16: publishing is idempotent', () => {
  test('N runs against the fake API leave the same state as one run', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, fc.integer({ min: 2, max: 4 }), async (s, n) => {
        const once = seeded(s);
        await runOnce(once, s);
        const many = seeded(s);
        for (let k = 0; k < n; k++) await runOnce(many, s);
        assert.deepEqual(many.snapshot(), once.snapshot());
      }),
      RUNS,
    );
  });
});

describe('P18: at most max_new_issues_per_run creates', () => {
  test('random finding counts and caps, including a retry after a failure', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, fc.integer({ min: 1, max: 40 }), async (s, failAt) => {
        const fake = seeded(s);
        fake.failAt = failAt;
        await runOnce(fake, s).catch(() => {});
        fake.failAt = null;
        const res = await runOnce(fake, s);
        const creates = fake.log.filter((l) => l.startsWith('create ') && !l.includes('square² state')).length;
        assert.ok(creates <= s.cap, `${creates} creates > cap ${s.cap}`);
        assert.ok(res.created <= s.cap);
        const fresh = s.items.filter((i) => s.existing[i] === 'none').length;
        assert.equal(creates, Math.min(fresh, s.cap));
        assert.equal(res.overflow.length, fresh - Math.min(fresh, s.cap));
      }),
      RUNS,
    );
  });
});

describe('P20: one digest per changing run; mentions only in the digest', () => {
  test('random publish outcomes', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async (s) => {
        const fake = seeded(s);
        const res = await runOnce(fake, s);
        const st = stateIssue(fake);
        const digests = (st?.comments ?? []).filter((c) => c.body.includes('square2:digest:'));
        const qualifying = s.kind === 'gate' ? res.changes.some((c) => c.action === 'created' || c.action === 'reopened') : res.changes.length > 0;
        assert.equal(digests.length, qualifying ? 1 : 0);
        if (qualifying) for (const login of NOTIFY) assert.ok(digests[0].body.includes(`@${login}`));
        for (const i of fake.issues) {
          if (i === st) continue;
          assert.equal(hasMention(i.body), false, `mention in #${i.number} body`);
          for (const c of i.comments) assert.equal(hasMention(c.body), false, `mention in a comment on #${i.number}`);
        }
        for (const c of st?.comments ?? []) if (!c.body.includes('square2:digest:')) assert.equal(hasMention(c.body), false);
        await runOnce(fake, s);
        assert.equal((stateIssue(fake)?.comments ?? []).filter((c) => c.body.includes('square2:digest:')).length, qualifying ? 1 : 0);
      }),
      RUNS,
    );
  });
});

describe('P17: a partial failure never advances state and never duplicates', () => {
  const dir = copyMiniRepo();
  const cfg = join(dir, '.square2', 'config.yaml');
  writeFileSync(cfg, readFileSync(cfg, 'utf8') + 'branch: dev\nbudget: false\nnotify:\n  - alice\n');
  const fresh = { liveHead: async () => SHA_B, isAncestor: async () => true };

  /**
   * @param {FakeGitHub} fake
   * @param {Scenario} s
   */
  async function cliPublish(fake, s) {
    const art = writeRunArtifacts(join(dir, `run-${s.cap}`), { from_sha: SHA_A, to_sha: SHA_B });
    writeFileSync(cfg, readFileSync(cfg, 'utf8').replace(/max_new_issues_per_run: \d+\n/, '') + `max_new_issues_per_run: ${s.cap}\n`);
    let stdout = '';
    const code = await main(['review', 'publish', '--root', dir, '--context', art.context, '--analysis', art.analysis], {
      cwd: dir,
      env: { GITHUB_TOKEN: 't', GITHUB_REPOSITORY: fake.repo },
      stdout: (t) => { stdout += t; },
      stderr: () => {},
      fetch: fake.fetch,
      gitOps: fresh,
      review: { validate: async () => ({ ...reviewDoc(s), demoted: [], questions: [], suggestions: [], language: 'en' }) },
    });
    return { code, stdout };
  }

  test('inject an API failure at a random call (before or after it applies), then retry', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb.map((s) => ({ ...s, kind: /** @type {const} */ ('review') })), fc.integer({ min: 1, max: 30 }), fc.boolean(), async (s, failAt, failAfter) => {
        const clean = seeded(s);
        assert.equal((await cliPublish(clean, s)).code, 0);
        const fake = seeded(s);
        fake.failAt = failAt;
        fake.failAfter = failAfter;
        const first = await cliPublish(fake, s);
        const failed = fake.calls >= failAt;
        assert.equal(first.code, failed ? 2 : 0, first.stdout);
        if (failed) {
          assertNoDuplicates(fake);
          const st = parseState(stateIssue(fake)?.body ?? '');
          const finalWrite = failAfter && failAt === fake.calls;
          if (!finalWrite) {
            assert.equal(st.last_reviewed_sha, null, 'state not advanced');
            assert.deepEqual(st.published_input_ids, []);
          }
        }
        fake.failAt = null;
        assert.equal((await cliPublish(fake, s)).code, 0);
        assertNoDuplicates(fake);
        assert.equal(parseState(stateIssue(fake)?.body ?? '').last_reviewed_sha, SHA_B);
        assert.deepEqual(fake.snapshot(), clean.snapshot());
      }),
      RUNS,
    );
  });
});
