import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256Hex } from '../src/core/fingerprint.mjs';
import { main } from '../src/cli/main.mjs';
import { credentialsInEnv } from '../src/cli/review-cmd.mjs';
import { checkBudget, monthToDateMinutes, threshold } from '../src/issues/budget.mjs';
import { hasMention, noMentions, notifyLogins } from '../src/review/render.mjs';
import { createGitHub } from '../src/issues/github.mjs';
import { GATE_LABEL, REVIEW_LABEL, TEST_LABEL, gateItems, parseKey, publish, reviewItems } from '../src/issues/publish.mjs';
import { findingMarker } from '../src/review/render.mjs';
import { MODEL, POLICY, writeRunArtifacts } from './issues/run-artifacts.mjs';
import { findingKey as reviewKey } from '../src/review/validate.mjs';
import { StateIssue, advanceState, parseState, serializeState } from '../src/issues/state.mjs';
import { cleanupTemps, copyMiniRepo } from './cli-helpers.mjs';
import { FakeGitHub } from './issues/fake-github.mjs';

after(cleanupTemps);

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const fp = (/** @type {string} */ s) => sha256Hex(s);

/** @param {FakeGitHub} fake */
function client(fake) {
  return createGitHub({ token: 't0ken', repo: fake.repo, fetch: fake.fetch });
}

/**
 * @param {{ fp: string, rule?: string, path?: string, line?: number | null }[]} fresh
 * @param {{ fp: string, rule?: string }[]} [also] observed but not new
 */
function report(fresh, also = [], head = SHA_A) {
  const rule = (/** @type {{ rule?: string }} */ v) => v.rule ?? 'S2-DEP-X';
  return {
    schema_version: 1,
    head_sha: head,
    catalogue_digest: 'c'.repeat(64),
    exit_code: fresh.length > 0 ? 1 : 0,
    rules: { 'S2-DEP-X': {}, 'S2-LINT-Y': {} },
    new_violations: fresh.map((v) => ({ rule_id: rule(v), path: v.path ?? 'apps/a.ts', line: v.line === undefined ? 3 : v.line, message: `banned import ${v.fp.slice(0, 4)}`, fingerprint: v.fp, count: 1 })),
    observed: [...fresh, ...also].map((v) => ({ fingerprint: v.fp, rule_id: rule(v), path: 'apps/a.ts', count: 1 })),
    excepted: [],
    expired_exceptions: [],
  };
}

/**
 * @param {FakeGitHub} fake
 * @param {any} rep
 * @param {{ test?: boolean, cap?: number, baselined?: string[], notify?: string[], inputId?: string }} [o]
 */
function gate(fake, rep, o = {}) {
  const gh = client(fake);
  return publish({
    gh,
    state: new StateIssue(gh),
    run: { kind: 'gate', inputId: o.inputId ?? `gate-${rep.head_sha.slice(0, 6)}`, branch: 'main', sha: rep.head_sha, test: o.test },
    items: gateItems(rep, { test: o.test }),
    cap: o.cap,
    notify: o.notify ?? ['alice', 'bob'],
    resolveGate: o.test ? undefined : { observed: new Set(rep.observed.map((/** @type {any} */ x) => x.fingerprint)), baselined: new Set(o.baselined ?? []), rules: new Set(Object.keys(rep.rules)) },
  });
}

/** @param {FakeGitHub} fake */
const stateIssue = (fake) => fake.issues.find((i) => i.labels.includes('square2-state'));
/** @param {FakeGitHub} fake */
const findings = (fake) => fake.issues.filter((i) => i.labels.includes('square2'));

function finding(over = {}) {
  return { severity: 'Major', path: 'src/a.ts', line: 10, side: 'RIGHT', title: 'Race between writer and reader', body: 'The writer @someone mentioned.', failure_case: 'two requests interleave', suggestion: 'lock', enclosing_symbol: 'write', mechanizable: false, commit: SHA_B, ...over };
}

function reviewDoc(list = [finding()], over = {}) {
  return { ok: true, input_id: 'in-1', range: { from_sha: SHA_A, to_sha: SHA_B }, branch: 'main', published: list.map((f) => ({ ...f, key: reviewKey(f) })), ...over };
}

describe('github client', () => {
  test('lists open and closed issues across pages and drops pull requests', async () => {
    const fake = new FakeGitHub({ pageSize: 2 });
    for (let i = 0; i < 5; i++) fake.seed({ title: `t${i}`, labels: ['square2'], state: i % 2 ? 'closed' : 'open', state_reason: i % 2 ? 'completed' : null });
    fake.seed({ title: 'pr', labels: ['square2'], pull_request: true });
    fake.seed({ title: 'other', labels: ['x'] });
    const list = await client(fake).listIssues('square2');
    assert.deepEqual(list.map((i) => i.title).sort(), ['t0', 't1', 't2', 't3', 't4']);
    assert.equal(list.filter((i) => i.state === 'closed').length, 2);
    assert.deepEqual([...fake.tokens], ['Bearer t0ken']);
  });
});

describe('state issue', () => {
  test('JSON body round-trips, keeps the newest 50 ids, tolerates garbage', () => {
    let s = parseState('not json');
    assert.deepEqual(s, { last_reviewed_sha: null, published_input_ids: [] });
    for (let i = 0; i < 60; i++) s = advanceState(s, { input_id: `id${i}`, last_reviewed_sha: SHA_B });
    assert.equal(s.published_input_ids.length, 50);
    assert.equal(s.published_input_ids[0], 'id59');
    assert.deepEqual(parseState(serializeState(s)), s);
    assert.deepEqual(Object.keys(JSON.parse(serializeState(s))), ['last_reviewed_sha', 'published_input_ids']);
  });
});

describe('digest helpers', () => {
  test('mentions are neutralised and notify logins validated', () => {
    assert.equal(hasMention('ping @alice now'), true);
    assert.equal(hasMention(noMentions('ping @alice now')), false);
    assert.deepEqual(notifyLogins(['alice', '@bob', 'bad login', 'alice', 'org/team', 3]), ['alice', 'bob', 'org/team']);
  });
});

describe('gate publishing', () => {
  test('creates one issue per new violation with marker and labels, one digest with mentions', async () => {
    const fake = new FakeGitHub();
    const res = await gate(fake, report([{ fp: fp('1') }, { fp: fp('2') }]));
    assert.equal(res.created, 2);
    const issues = findings(fake);
    assert.equal(issues.length, 2);
    for (const i of issues) {
      assert.ok(i.labels.includes(GATE_LABEL));
      assert.ok(i.body.includes(findingMarker(/** @type {string} */ (parseKey(i.body)))));
      assert.equal(hasMention(i.body), false);
    }
    const st = /** @type {import('./issues/fake-github.mjs').FakeIssue} */ (stateIssue(fake));
    assert.equal(st.comments.length, 1);
    assert.match(st.comments[0].body, /@alice @bob/);
    assert.match(st.comments[0].body, /\| created \|/);
  });

  test('closed as not planned stays closed and silent; completed is reopened with the commit', async () => {
    const fake = new FakeGitHub();
    const k1 = fp('np');
    const k2 = fp('done');
    fake.seed({ title: 'np', body: findingMarker(k1), labels: ['square2', GATE_LABEL], state: 'closed', state_reason: 'not_planned' });
    fake.seed({ title: 'done', body: findingMarker(k2), labels: ['square2', GATE_LABEL], state: 'closed', state_reason: 'completed' });
    const res = await gate(fake, report([{ fp: k1 }, { fp: k2 }], [], SHA_B));
    assert.deepEqual(res.changes.map((c) => c.action), ['reopened']);
    assert.equal(fake.issue(1)?.state, 'closed');
    assert.equal(fake.issue(1)?.comments.length, 0);
    assert.equal(fake.issue(2)?.state, 'open');
    assert.match(fake.issue(2)?.comments[0].body ?? '', new RegExp(`reappeared in ${SHA_B}`));
  });

  test('resolved gate issues close as completed; excepted, baselined, or unrun rules stay open; review issues never auto-close', async () => {
    const fake = new FakeGitHub();
    const gone = fp('gone');
    const exc = fp('excepted');
    const base = fp('baselined');
    const other = fp('other-rule');
    const rev = fp('review');
    const mk = (/** @type {string} */ k, /** @type {string} */ rule, labels = ['square2', GATE_LABEL]) => fake.seed({ title: k.slice(0, 4), body: `${findingMarker(k)}\n<!-- square2:rule:${rule} -->\n`, labels });
    mk(gone, 'S2-DEP-X');
    mk(exc, 'S2-DEP-X');
    mk(base, 'S2-DEP-X');
    mk(other, 'S2-NOT-RUN');
    mk(rev, 'S2-DEP-X', ['square2', REVIEW_LABEL]);
    const rep = report([], [{ fp: exc }]);
    const res = await gate(fake, rep, { baselined: [base] });
    assert.deepEqual(res.changes.map((c) => [c.action, c.number]), [['closed', 1]]);
    assert.equal(fake.issue(1)?.state_reason, 'completed');
    assert.match(fake.issue(1)?.comments[0].body ?? '', new RegExp(`resolved in ${SHA_A}`));
    for (const n of [2, 3, 4, 5]) assert.equal(fake.issue(n)?.state, 'open');
    assert.equal(res.digest, false, 'a close alone posts no gate digest');
  });

  test('test mode labels square2:test, posts the digest, then closes as not planned; real issues are untouched', async () => {
    const fake = new FakeGitHub();
    const k = fp('smoke');
    fake.seed({ title: 'real', body: findingMarker(k), labels: ['square2', GATE_LABEL], state: 'closed', state_reason: 'not_planned' });
    const res = await gate(fake, report([{ fp: k }]), { test: true });
    assert.equal(res.created, 1);
    const t = fake.issues.filter((i) => i.labels.includes(TEST_LABEL));
    assert.equal(t.length, 1);
    assert.equal(t[0].state, 'closed');
    assert.equal(t[0].state_reason, 'not_planned');
    assert.equal(stateIssue(fake)?.comments.length, 1);
    assert.equal(fake.issue(1)?.comments.length, 0);
  });

  test('cap limits creates and lists overflow once on the state issue', async () => {
    const fake = new FakeGitHub();
    const rep = report([1, 2, 3, 4].map((n) => ({ fp: fp(String(n)) })));
    const res = await gate(fake, rep, { cap: 2 });
    assert.equal(res.created, 2);
    assert.equal(res.overflow.length, 2);
    await gate(fake, rep, { cap: 2 });
    const st = stateIssue(fake);
    assert.equal(st?.comments.filter((c) => c.body.includes('square2:overflow:')).length, 1);
    assert.equal(findings(fake).length, 2);
  });
});

describe('review publishing', () => {
  test('a finding seen again updates body and comments; different titles never share an issue', async () => {
    const fake = new FakeGitHub();
    const gh = client(fake);
    const run = (/** @type {string} */ id, /** @type {any} */ doc) => publish({ gh, state: new StateIssue(gh), run: { kind: 'review', inputId: id, branch: 'main', sha: SHA_B }, items: reviewItems(doc), notify: ['alice'] });
    await run('day1', reviewDoc());
    const second = await run('day2', reviewDoc([finding({ body: 'newer text' }), finding({ title: 'Another defect' })]));
    assert.deepEqual(second.changes.map((c) => c.action).sort(), ['created', 'updated']);
    const issues = findings(fake);
    assert.equal(issues.length, 2);
    assert.match(issues[0].body, /newer text/);
    assert.equal(issues[0].comments.length, 1);
    assert.ok(issues[0].labels.includes('sev:major'));
    for (const i of issues) for (const c of i.comments) assert.equal(hasMention(c.body), false);
    assert.equal(stateIssue(fake)?.comments.length, 2);
  });

  test('a quiet day posts nothing', async () => {
    const fake = new FakeGitHub();
    const gh = client(fake);
    const res = await publish({ gh, state: new StateIssue(gh), run: { kind: 'review', inputId: 'q', branch: 'main', sha: SHA_B }, items: [], notify: ['alice'] });
    assert.equal(res.digest, false);
    assert.equal(fake.issues.length, 0);
  });

  test('resolution closes only resolved review issues; candidates post only when the replay discriminates', async () => {
    const fake = new FakeGitHub();
    const k1 = fp('r1');
    const k2 = fp('r2');
    fake.seed({ title: 'r1', body: findingMarker(k1), labels: ['square2', REVIEW_LABEL, 'sev:major'] });
    fake.seed({ title: 'r2', body: findingMarker(k2), labels: ['square2', REVIEW_LABEL], state: 'closed', state_reason: 'completed' });
    const gh = client(fake);
    const res = await publish({
      gh,
      state: new StateIssue(gh),
      run: { kind: 'review', inputId: 'res', branch: 'main', sha: SHA_B },
      items: [],
      notify: [],
      resolved: [{ key: k1, commit: SHA_B }],
      candidates: [
        { key: k2, rule_id: 'S2-CAND-OK', body: 'rule yaml', fires_born_from: true, fires_parent: false },
        { key: k2, rule_id: 'S2-CAND-BAD', body: 'rule yaml', fires_born_from: true, fires_parent: true },
      ],
    });
    assert.deepEqual(res.changes.map((c) => c.action), ['closed', 'candidate']);
    assert.equal(fake.issue(1)?.state_reason, 'completed');
    assert.equal(fake.issue(2)?.comments.length, 1);
    assert.match(fake.issue(2)?.comments[0].body ?? '', /S2-CAND-OK/);
    assert.ok(fake.issue(2)?.labels.includes('square2:rule-candidate'));
  });
});

describe('budget', () => {
  test('spec example: 260 minutes on day 10 of 30 warns (threshold 240)', async () => {
    assert.equal(threshold({ monthly: 600, day: 10, daysInMonth: 30 }), 240);
    const fake = new FakeGitHub();
    fake.runs['square2-gate.yml'] = [{ id: 1, created_at: '2026-11-02T00:00:00Z', run_started_at: '2026-11-02T00:00:00Z', updated_at: '2026-11-02T02:01:30Z' }];
    fake.runs['square2-review.yml'] = [
      { id: 2, created_at: '2026-11-03T00:00:00Z', run_started_at: '2026-11-03T00:00:00Z', updated_at: '2026-11-03T00:46:00Z' },
      { id: 4, created_at: '2026-11-04T00:00:00Z', run_started_at: null, updated_at: null },
      { id: 3, created_at: '2026-10-31T00:00:00Z', run_started_at: '2026-10-31T00:00:00Z', updated_at: '2026-10-31T09:00:00Z' },
    ];
    fake.runs['other.yml'] = [{ id: 5, created_at: '2026-11-03T00:00:00Z', run_started_at: '2026-11-03T00:00:00Z', updated_at: '2026-11-03T10:00:00Z' }];
    const gh = client(fake);
    const now = new Date('2026-11-10T12:00:00Z');
    assert.equal(await monthToDateMinutes({ gh, workflows: ['square2-gate.yml', 'square2-review.yml'], now }), 122 * 1 + 46 * 3, 'ceil(run minutes) x jobs per workflow (gate 1, review 3); other workflows and last month ignored');
    const calls = fake.log.filter((l) => l.includes('runs') || l.includes('jobs'));
    assert.deepEqual(calls, ['list runs', 'list runs'], 'one paginated runs listing (two pages of three), no per-run jobs calls');
    const r = await checkBudget({ gh, state: new StateIssue(gh), now, monthly: 600, workflows: ['square2-gate.yml', 'square2-review.yml'] });
    assert.equal(r.minutes, 260);
    assert.equal(r.warned, true);
    assert.match(stateIssue(fake)?.comments[0].body ?? '', /260 billed minutes.*threshold 240/);
    await checkBudget({ gh: client(fake), state: new StateIssue(client(fake)), now, monthly: 600, workflows: ['square2-gate.yml'] });
    assert.equal(stateIssue(fake)?.comments.length, 1, 'one warning per day');
    const quiet = new FakeGitHub();
    const q = await checkBudget({ gh: client(quiet), state: new StateIssue(client(quiet)), now, monthly: 600, workflows: ['square2-gate.yml'] });
    assert.equal(q.warned, false);
    assert.equal(quiet.issues.length, 0);
  });
});

// ---------------------------------------------------------------- CLI

/**
 * @param {string[]} args
 * @param {{ cwd: string, fake?: FakeGitHub, env?: Record<string, string | undefined>, gitOps?: any, review?: any }} o
 */
async function cli(args, o) {
  let stdout = '';
  let stderr = '';
  const code = await main(args, {
    cwd: o.cwd,
    env: { SQUARE2_TODAY: '2026-11-20', GITHUB_REPOSITORY: o.fake?.repo, ...(o.env ?? {}) },
    stdout: (t) => { stdout += t; },
    stderr: (t) => { stderr += t; },
    fetch: o.fake?.fetch,
    gitOps: o.gitOps,
    review: o.review,
    now: new Date('2026-11-20T08:00:00Z'),
  });
  return { code, stdout, stderr };
}

/** @param {string} extra */
function repoWithConfig(extra) {
  const dir = copyMiniRepo();
  const p = join(dir, '.square2', 'config.yaml');
  writeFileSync(p, readFileSync(p, 'utf8') + extra);
  return dir;
}

const CONFIG = 'branch: dev\nnotify:\n  - alice\n  - bob\nmax_new_issues_per_run: 10\n';
const FRESH = { liveHead: async () => SHA_B, isAncestor: async (/** @type {string} */ _r, /** @type {string} */ a, /** @type {string} */ b) => a === b };

describe('square2 review guard-env (P19 canary)', () => {
  for (const v of ['GITHUB_TOKEN', 'GH_TOKEN', 'ACTIONS_RUNTIME_TOKEN']) {
    test(`exits 1 when ${v} is set`, async () => {
      const r = await cli(['review', 'guard-env'], { cwd: '/', env: { [v]: 'x' } });
      assert.equal(r.code, 1);
      assert.match(r.stdout, /^\[S2-REVIEW-CREDENTIALS\] .* — Instead: /);
      assert.ok(r.stdout.includes(v));
    });
  }
  test('exits 0 with a clean environment; detection is by presence', async () => {
    assert.equal((await cli(['review', 'guard-env'], { cwd: '/', env: { PATH: '/bin' } })).code, 0);
    assert.deepEqual(credentialsInEnv({ GH_TOKEN: '' }), ['GH_TOKEN']);
  });
});

describe('square2 publish-gate', () => {
  test('publishes on the configured branch; skips elsewhere; --test publishes and closes', async () => {
    const dir = repoWithConfig(CONFIG);
    const rep = join(dir, 'square2-report.json');
    writeFileSync(rep, JSON.stringify(report([{ fp: fp('cli') }])));
    const fake = new FakeGitHub();
    const env = { GITHUB_TOKEN: 'tok' };
    const off = await cli(['publish-gate', '--root', dir, '--report', rep, '--branch', 'feature'], { cwd: dir, fake, env });
    assert.equal(off.code, 0, off.stdout);
    assert.match(off.stdout, /not the configured branch dev/);
    assert.equal(fake.calls, 0);
    const t = await cli(['publish-gate', '--root', dir, '--report', rep, '--branch', 'feature', '--test'], { cwd: dir, fake, env });
    assert.equal(t.code, 0, t.stdout);
    const testIssues = fake.issues.filter((i) => i.labels.includes(TEST_LABEL));
    assert.equal(testIssues.length, 1);
    assert.equal(testIssues[0].state_reason, 'not_planned');
    const on = await cli(['publish-gate', '--root', dir, '--report', rep, '--branch', 'dev'], { cwd: dir, fake, env });
    assert.equal(on.code, 0, on.stdout);
    const real = findings(fake).filter((i) => !i.labels.includes(TEST_LABEL));
    assert.equal(real.length, 1);
    assert.equal(real[0].state, 'open');
    const digests = stateIssue(fake)?.comments.filter((c) => c.body.includes('square2:digest:')) ?? [];
    assert.equal(digests.length, 2);
    for (const d of digests) assert.match(d.body, /@alice @bob/);
    const again = await cli(['publish-gate', '--root', dir, '--report', rep, '--branch', 'dev'], { cwd: dir, fake, env });
    assert.equal(again.code, 0);
    assert.equal(stateIssue(fake)?.comments.length, 2);
  });

  test('falls back to the repository default branch and needs GITHUB_TOKEN', async () => {
    const dir = repoWithConfig('notify:\n  - alice\n');
    const rep = join(dir, 'square2-report.json');
    writeFileSync(rep, JSON.stringify(report([])));
    const fake = new FakeGitHub({ defaultBranch: 'trunk' });
    const none = await cli(['publish-gate', '--root', dir, '--report', rep, '--branch', 'trunk'], { cwd: dir, fake });
    assert.equal(none.code, 2);
    assert.match(none.stdout, /\[S2-PUBLISH\] GITHUB_TOKEN is not set/);
    const ok = await cli(['publish-gate', '--root', dir, '--report', rep, '--branch', 'trunk'], { cwd: dir, fake, env: { GITHUB_TOKEN: 'x' } });
    assert.equal(ok.code, 0, ok.stdout);
    assert.match(ok.stdout, /published: 0 change/);
  });

  test('an API error exits 2 with a diagnostic', async () => {
    const dir = repoWithConfig(CONFIG);
    const rep = join(dir, 'square2-report.json');
    writeFileSync(rep, JSON.stringify(report([{ fp: fp('x') }])));
    const fake = new FakeGitHub();
    fake.failAt = 1;
    const r = await cli(['publish-gate', '--root', dir, '--report', rep, '--branch', 'dev'], { cwd: dir, fake, env: { GITHUB_TOKEN: 'x' } });
    assert.equal(r.code, 2);
    assert.match(r.stdout, /^\[S2-PUBLISH\] .*500/);
  });
});

describe('square2 review (end to end with a fake API and canned model JSON)', () => {
  const MODEL_OUT = JSON.stringify({ language: 'en', groups: [{ id: 'g1' }], questions: [], suggestions: [] });
  const stubReview = {
    /** @param {any} o */
    async prepare(o) {
      return { range: { from_sha: o.lastReviewedSha ?? SHA_A, to_sha: SHA_B, branch_or_pr: 'branch:dev' }, branch: o.branch, groups: [{ id: 'g1' }], changed_lines: {}, policy_digest: POLICY, reviewer: { family: 'openai', model: MODEL } };
    },
    /** @param {any} o */
    async validate(o) {
      const doc = typeof o.output === 'string' ? JSON.parse(o.output) : o.output;
      if (!Array.isArray(doc.groups)) return { ok: false, errors: ['groups must be an array'] };
      return { ...reviewDoc([finding(), finding({ title: 'Second', severity: 'Blocker', path: 'src/b.ts' })]), demoted: [] };
    },
  };

  test('prepare → validate → publish creates the expected issues, advances state, and a re-run is a no-op', async () => {
    const dir = repoWithConfig(CONFIG);
    const fake = new FakeGitHub();
    const env = { GITHUB_TOKEN: 'tok' };
    const p = await cli(['review', 'prepare', '--root', dir, '--branch', 'dev', '--out', join(dir, 'ctx', 'context.json')], { cwd: dir, fake, env, review: stubReview });
    assert.equal(p.code, 0, p.stdout + p.stderr);
    const art = writeRunArtifacts(dir, { from_sha: SHA_A, to_sha: SHA_B, result: MODEL_OUT });
    const v = await cli(['review', 'validate', '--root', dir, '--context', art.context, '--analysis', art.analysis, '--out', join(dir, 'review.json')], { cwd: dir, review: stubReview });
    assert.equal(v.code, 0, v.stdout);
    const pub = await cli(['review', 'publish', '--root', dir, '--context', art.context, '--analysis', art.analysis], { cwd: dir, fake, env, gitOps: FRESH, review: stubReview });
    assert.equal(pub.code, 0, pub.stdout);
    const issues = findings(fake);
    assert.deepEqual(issues.map((i) => i.title).sort(), ['Race between writer and reader', 'Second']);
    assert.ok(issues.find((i) => i.title === 'Second')?.labels.includes('sev:blocker'));
    for (const i of issues) assert.equal(hasMention(i.body), false);
    const st = parseState(stateIssue(fake)?.body ?? '');
    assert.equal(st.last_reviewed_sha, SHA_B);
    assert.deepEqual(st.published_input_ids, [art.inputId], 'input_id recomputed from the context and the model actually used');
    assert.equal(stateIssue(fake)?.comments.filter((c) => c.body.includes('square2:digest:')).length, 1);
    const before = JSON.stringify(fake.snapshot());
    const again = await cli(['review', 'publish', '--root', dir, '--context', art.context, '--analysis', art.analysis], { cwd: dir, fake, env, gitOps: FRESH, review: stubReview });
    assert.equal(again.code, 0);
    assert.match(again.stdout, /already published/);
    assert.equal(JSON.stringify(fake.snapshot()), before);
    const next = await cli(['review', 'prepare', '--root', dir, '--branch', 'dev', '--out', join(dir, 'context2.json')], { cwd: dir, fake, env, review: stubReview });
    assert.equal(next.code, 0);
    assert.equal(JSON.parse(readFileSync(join(dir, 'context2.json'), 'utf8')).range.from_sha, SHA_B);
  });

  test('stale to_sha (force-push) skips and does not advance state', async () => {
    const dir = repoWithConfig(CONFIG);
    const fake = new FakeGitHub();
    const art = writeRunArtifacts(dir, { from_sha: SHA_A, to_sha: SHA_B, result: MODEL_OUT });
    const stale = { liveHead: async () => 'f'.repeat(40), isAncestor: async () => false };
    const r = await cli(['review', 'publish', '--root', dir, '--context', art.context, '--analysis', art.analysis], { cwd: dir, fake, env: { GITHUB_TOKEN: 't' }, gitOps: stale, review: stubReview });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /no longer an ancestor/);
    assert.equal(findings(fake).length, 0);
    assert.equal(parseState(stateIssue(fake)?.body ?? '').last_reviewed_sha, null);
  });

  test('invalid model output: validate and publish exit 1 with review-error and write nothing', async () => {
    const dir = repoWithConfig(CONFIG);
    const fake = new FakeGitHub();
    const art = writeRunArtifacts(dir, { from_sha: SHA_A, to_sha: SHA_B, result: JSON.stringify({ groups: 'nope' }) });
    const summary = join(dir, 'summary.md');
    const r = await cli(['review', 'validate', '--root', dir, '--context', art.context, '--analysis', art.analysis, '--out', join(dir, 'review.json')], { cwd: dir, review: stubReview, env: { GITHUB_STEP_SUMMARY: summary } });
    assert.equal(r.code, 1);
    assert.match(readFileSync(summary, 'utf8'), /review-error/);
    assert.throws(() => readFileSync(join(dir, 'review.json')));
    const pub = await cli(['review', 'publish', '--root', dir, '--context', art.context, '--analysis', art.analysis], { cwd: dir, fake, env: { GITHUB_TOKEN: 't' }, gitOps: FRESH, review: stubReview });
    assert.equal(pub.code, 1);
    assert.equal(fake.issues.length, 0);
  });

  test('a Blocker finding never fails the publish step', async () => {
    const dir = repoWithConfig(CONFIG);
    const fake = new FakeGitHub();
    const art = writeRunArtifacts(dir, { from_sha: SHA_A, to_sha: SHA_B, result: MODEL_OUT });
    const blocker = { ...stubReview, validate: async () => ({ ...reviewDoc([finding({ severity: 'Blocker' })]), demoted: [] }) };
    const r = await cli(['review', 'publish', '--root', dir, '--context', art.context, '--analysis', art.analysis], { cwd: dir, fake, env: { GITHUB_TOKEN: 't' }, gitOps: FRESH, review: blocker });
    assert.equal(r.code, 0, r.stdout);
  });

  test('existing commands and help still work', async () => {
    const r = await cli(['--help'], { cwd: '/' });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /review guard-env/);
    assert.match(r.stdout, /publish-gate/);
  });
});
