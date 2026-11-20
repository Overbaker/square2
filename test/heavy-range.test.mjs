import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import fc from 'fast-check';
import { main } from '../src/cli/main.mjs';
import { mergeCalls } from '../src/cli/review-cmd.mjs';
import { canonicalStringify } from '../src/core/canonical-json.mjs';
import { sha256Hex } from '../src/core/fingerprint.mjs';
import { changedLinesFromJSON, changedLinesToJSON, shownLines } from '../src/git/changed-lines.mjs';
import { parseState } from '../src/issues/state.mjs';
import { inputId } from '../src/review/input-id.mjs';
import { prepareReview, reviewConfig } from '../src/review/prepare.mjs';
import { renderDigest } from '../src/review/render.mjs';
import { validateReview } from '../src/review/validate.mjs';
import { REPO, cleanupTemps, tempDir } from './cli-helpers.mjs';
import { FakeGitHub } from './issues/fake-github.mjs';

after(cleanupTemps);

const NOW = new Date('2026-11-20T08:00:00Z');

/** @param {string} cwd @param {string[]} args @param {string} [date] */
function g(cwd, args, date) {
  const env = date ? { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : process.env;
  const res = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', env });
  if (res.status !== 0) throw new Error(`git ${args.join(' ')}: ${res.stderr}`);
  return res.stdout.trim();
}

/** @returns {import('../src/review/policy-digest.mjs').Policy} */
function policy() {
  return {
    template: readFileSync(join(REPO, 'prompts', 'review.staged.md'), 'utf8'),
    schema: readFileSync(join(REPO, 'schemas', 'review.v1.json'), 'utf8'),
    reviewContext: '',
    enforcedRules: [],
    triagePatterns: [],
    version: '0.1.0',
  };
}

const lines = (/** @type {number} */ n, /** @type {string} */ tag) => Array.from({ length: n }, (_, i) => `export const ${tag}${i} = ${i}; // ${tag}`).join('\n') + '\n';

/** One heavy change group (risk files of three sizes plus a huge non-risk file) and one small group. */
function heavyRepo() {
  const dir = join(tempDir('square2-heavy-'), 'repo');
  mkdirSync(join(dir, 'src', 'db'), { recursive: true });
  writeFileSync(join(dir, 'README.md'), 'base\n');
  g(dir, ['init', '--quiet', '-b', 'main']);
  g(dir, ['add', '-A']);
  g(dir, ['commit', '--quiet', '-m', 'base'], '2026-11-18T00:00:00Z');
  const base = g(dir, ['rev-parse', 'HEAD']);
  writeFileSync(join(dir, 'src', 'db', 'a.sql'), lines(30, 'acol'));
  writeFileSync(join(dir, 'src', 'db', 'b.sql'), lines(10, 'bcol'));
  writeFileSync(join(dir, 'src', 'db', 'dump.sql'), lines(3000, 'dumprow'));
  writeFileSync(join(dir, 'src', 'huge.ts'), lines(5000, 'hugeval'));
  g(dir, ['add', '-A']);
  g(dir, ['commit', '--quiet', '-m', 'feat: big change (openspec/changes/big-change)'], '2026-11-20T05:00:00Z');
  writeFileSync(join(dir, 'src', 'x.ts'), lines(5, 'x'));
  g(dir, ['add', '-A']);
  g(dir, ['commit', '--quiet', '-m', 'feat: small change (openspec/changes/small-change)'], '2026-11-20T06:00:00Z');
  return { dir, base, head: g(dir, ['rev-parse', 'HEAD']) };
}

const CONFIG = reviewConfig({ reviewer: 'openai/azure/model-a', risk_paths: ['src/db/**'] }).config;

test('heavy range: a group whose diff exceeds the budget but whose risk files fit is reviewed with a trimmed diff', async () => {
  const { dir, base } = heavyRepo();
  const state = { last_reviewed_sha: base };
  const probe = /** @type {any} */ (await prepareReview({ repoRoot: dir, branch: 'main', state, now: NOW, config: CONFIG, policy: policy() }));
  assert.equal(probe.context.diff_mode, 'range', 'fits the default budget');
  const budget = probe.context.estimated_tokens.prefix + 6000;
  assert.ok(probe.context.estimated_tokens.total > budget * 4, 'the big group alone is far over the budget');
  const out = tempDir('square2-heavy-out-');
  const res = /** @type {any} */ (await prepareReview({ repoRoot: dir, branch: 'main', state, now: NOW, config: { ...CONFIG, max_input_tokens: budget }, policy: policy(), outDir: out }));
  const c = res.context;
  assert.equal(c.diff_mode, 'calls');
  assert.deepEqual(c.calls.map((/** @type {any} */ x) => [x.id, x.group, x.trimmed]), [['call-1', 'change:big-change', true], ['call-2', 'change:small-change', false]], 'risk group first');
  const big = c.calls[0];
  assert.deepEqual(big.shown_files, ['src/db/a.sql', 'src/db/b.sql'], 'risk files largest first; the one that does not fit is skipped');
  assert.deepEqual(big.listed.map((/** @type {any} */ f) => f.path).sort(), ['src/db/dump.sql', 'src/huge.ts']);
  assert.deepEqual(big.listed.find((/** @type {any} */ f) => f.path === 'src/huge.ts'), { path: 'src/huge.ts', added: 5000, removed: 0 });
  assert.deepEqual(Object.keys(big.changed_lines), big.commits, 'anchoring is per commit');
  assert.deepEqual(Object.keys(Object.values(big.changed_lines)[0]), big.shown_files, 'anchoring covers exactly the diff the call shows');
  assert.deepEqual(c.not_reviewed, [], 'no file of the trimmed group is not_reviewed');
  assert.ok(c.groups.every((/** @type {any} */ x) => x.shown));
  for (const call of c.calls) assert.ok(call.tokens <= budget, `${call.id} within the budget`);
  const suffix = readFileSync(join(out, big.prompt_suffix_file), 'utf8');
  assert.match(suffix, /## Diff of group `change:big-change` \(trimmed\)/);
  assert.match(suffix, /## Files of this group without a diff above/);
  assert.match(suffix, /Read them from the tree/);
  assert.match(suffix, /`src\/huge\.ts` \(\+5000 -0\)/);
  assert.ok(suffix.includes('acol29') && suffix.includes('bcol9'), 'the shown risk diffs are full');
  assert.ok(!suffix.includes('hugeval0') && !suffix.includes('dumprow0'), 'listed files carry no diff');
  assert.match(suffix, /`change:small-change`/, 'the range index names the other group');
  assert.match(suffix, /`src\/x\.ts` \(\+5 -0\)/, 'with its file stats');
  assert.deepEqual(c.estimated_tokens.calls, c.calls.map((/** @type {any} */ x) => ({ id: x.id, tokens: x.tokens })));
});

test('heavy range: the call cap is respected; groups beyond it are not_reviewed', async () => {
  const { dir, base } = heavyRepo();
  const state = { last_reviewed_sha: base };
  const probe = /** @type {any} */ (await prepareReview({ repoRoot: dir, branch: 'main', state, now: NOW, config: CONFIG, policy: policy() }));
  const config = { ...CONFIG, max_input_tokens: probe.context.estimated_tokens.prefix + 6000, max_calls_per_run: 1 };
  const c = /** @type {any} */ (await prepareReview({ repoRoot: dir, branch: 'main', state, now: NOW, config, policy: policy() })).context;
  assert.deepEqual(c.calls.map((/** @type {any} */ x) => x.group), ['change:big-change']);
  assert.deepEqual(c.not_reviewed, [{ group: 'change:small-change', reason: 'left out: the run reached its call limit' }]);
  assert.equal(c.groups.find((/** @type {any} */ x) => x.id === 'change:small-change').shown, false);
  assert.equal(c.caps.max_calls_per_run, 1);
  assert.equal(reviewConfig({ reviewer: 'a/b/c' }).config.max_calls_per_run, 6, 'default cap');
  assert.ok(reviewConfig({ reviewer: 'a/b/c', max_calls_per_run: 0 }).errors.length > 0);
});

// ---------- per-call validation and merge (P13 / P22 per call) ----------

const DIFF_A = 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,0 +1,10 @@\n' + '+x\n'.repeat(10);
const DIFF_B = 'diff --git a/src/b.ts b/src/b.ts\n--- a/src/b.ts\n+++ b/src/b.ts\n@@ -1,0 +1,10 @@\n' + '+y\n'.repeat(10);
const stage = (/** @type {string} */ status, /** @type {boolean} */ ev) => ({ status, summary: 's', evidence: ev ? ['e'] : [] });
/** @param {any} [o] */
const finding = (o = {}) => ({ severity: 'Minor', path: 'src/a.ts', line: 3, side: 'RIGHT', title: 'Race on retry', failure_case: 'two retries interleave', suggestion: 'lock', enclosing_symbol: 'retry', mechanizable: false, commit: '0'.repeat(40), ...o });
const passing = (/** @type {string} */ id, /** @type {any[]} */ findings) => ({ id, requirement: stage('pass', true), approach: stage('pass', true), code: { status: findings.length ? 'needs_changes' : 'pass', summary: 's', findings } });
const out = (/** @type {any[]} */ groups, extra = {}) => JSON.stringify({ language: 'en', groups, questions: [], suggestions: [], ...extra });

const CSHA = (/** @type {number} */ i) => `${i % 10}`.repeat(40);

/** @param {number} n groups, one call each, alternating between the two diffs */
function callsContext(n) {
  const groups = Array.from({ length: n }, (_, i) => ({ id: `change:g${i}`, commits: [], paths: [i % 2 ? 'src/b.ts' : 'src/a.ts'], risk: false, shown: true }));
  return {
    range: { from_sha: 'a'.repeat(40), to_sha: 'b'.repeat(40), branch_or_pr: 'branch:main' },
    policy_digest: 'd'.repeat(64),
    reviewer: { family: 'openai', provider: 'azure', model: 'model-a' },
    groups,
    changed_lines: {},
    calls: groups.map((gr, i) => ({ id: `call-${i + 1}`, group: gr.id, commits: [CSHA(i)], shown_files: gr.paths, changed_lines: { [CSHA(i)]: changedLinesToJSON(shownLines(i % 2 ? DIFF_B : DIFF_A)) } })),
  };
}

/** @param {any} o */
const validate = async (o) => validateReview(o.output, {
  groups: o.context.groups,
  changedLines: changedLinesFromJSON(o.context.changed_lines),
  commitLines: o.context.commit_lines ? new Map(Object.entries(o.context.commit_lines).map(([k, v]) => [k, changedLinesFromJSON(/** @type {any} */ (v))])) : undefined,
  commits: o.context.call_commits,
});
const REPO_STUB = /** @type {any} */ ({ root: '/nonexistent', dir: '/nonexistent', config: {} });

/** @param {any} context @param {(string | null)[]} results @param {string[]} [models] */
function analysis(context, results, models) {
  return {
    result: null,
    results: context.calls.map((/** @type {any} */ c, /** @type {number} */ i) => ({ call: c.id, result: results[i] })),
    resolutions: [],
    candidates: [],
    usage: { model_used: models?.[0] ?? 'model-a', attempts: [], calls: context.calls.map((/** @type {any} */ c, /** @type {number} */ i) => ({ call: c.id, model_used: models?.[i] ?? 'model-a', attempts: [] })), usage: null, allow_same_family: false },
  };
}

const merge = (/** @type {any} */ context, /** @type {any} */ a) => mergeCalls({ context, analysis: a, validate, repo: REPO_STUB, calls: context.calls });

test('P13 per call: a call is accepted exactly when its own output is stage-consistent', async () => {
  const STATUSES = ['pass', 'needs_changes', 'needs_clarification', 'not_reviewed'];
  const context = callsContext(2);
  const good = out([passing('change:g0', [finding()])]);
  for (const r of STATUSES) for (const a of STATUSES) for (const c of STATUSES) for (const fk of [false, true]) for (const q of [false, true]) {
    const grp = { id: 'change:g1', requirement: stage(r, r !== 'not_reviewed' && r !== 'needs_clarification'), approach: stage(a, a !== 'not_reviewed' && a !== 'needs_clarification'), code: { status: c, summary: 's', findings: fk ? [finding({ path: 'src/b.ts', commit: CSHA(1) })] : [] } };
    const alone = validateReview(out([grp], { questions: q ? ['why?'] : [] }), { groups: [{ id: 'change:g1' }], changedLines: new Map(), commitLines: new Map([[CSHA(1), changedLinesFromJSON(context.calls[1].changed_lines[CSHA(1)])]]), commits: [CSHA(1)] });
    const merged = await merge(context, analysis(context, [good, out([grp], { questions: q ? ['why?'] : [] })]));
    assert.equal(merged.ok, alone.ok, JSON.stringify({ r, a, c, fk, q }));
    if (!merged.ok) assert.match(/** @type {any} */ (merged).errors[0], /^call call-2 \(group change:g1\): /);
  }
  const other = await merge(context, analysis(context, [out([passing('change:g0', []), passing('change:g1', [])]), good.replace('g0', 'g1')]));
  assert.equal(other.ok, false, 'a call may not review a group outside its focus');
});

test('P22 per call: a failing call group never suppresses another call\'s code findings', async () => {
  const failing = [
    { requirement: stage('needs_changes', true), approach: stage('not_reviewed', false), code: { status: 'not_reviewed', summary: 's', findings: [] } },
    { requirement: stage('pass', true), approach: stage('needs_changes', true), code: { status: 'not_reviewed', summary: 's', findings: [] } },
  ];
  await fc.assert(
    fc.asyncProperty(fc.array(fc.oneof(fc.constantFrom(...failing).map((f) => ({ kind: 'fail', f })), fc.integer({ min: 1, max: 10 }).map((line) => ({ kind: 'pass', line }))), { minLength: 1, maxLength: 6 }), async (specs) => {
      const context = callsContext(specs.length);
      const results = specs.map((s, i) => {
        const id = `change:g${i}`;
        if (s.kind === 'fail') return out([{ id, .../** @type {any} */ (s).f }], { questions: ['q'] });
        return out([passing(id, [finding({ line: /** @type {any} */ (s).line, title: `bug ${i}`, path: i % 2 ? 'src/b.ts' : 'src/a.ts', commit: CSHA(i) })])]);
      });
      const merged = /** @type {any} */ (await merge(context, analysis(context, results)));
      assert.ok(merged.ok, JSON.stringify(merged));
      const want = specs.flatMap((s, i) => (s.kind === 'pass' ? [`change:g${i}`] : [])).sort();
      assert.deepEqual([...new Set(merged.res.published.map((/** @type {any} */ f) => f.group))].sort(), want);
      assert.equal(merged.res.groups.length, specs.length);
    }),
    { numRuns: 100 },
  );
});

test('merge: anchoring per call; findings on files a call did not show become notes; input_id from sorted call ids', async () => {
  const context = callsContext(2);
  const offLine = finding({ line: 40, title: 'off the shown lines' });
  const unshown = finding({ path: 'src/huge.ts', line: 7, title: 'listed file, read from the tree' });
  const onB = finding({ path: 'src/b.ts', line: 2, title: 'b bug', severity: 'Major', commit: CSHA(1) });
  const crossCall = finding({ path: 'src/b.ts', line: 2, title: 'a call anchoring on another call\'s file' });
  const a = analysis(context, [out([passing('change:g0', [finding(), offLine, unshown, crossCall])]), out([passing('change:g1', [onB])])]);
  const m = /** @type {any} */ (await merge(context, a));
  assert.ok(m.ok, JSON.stringify(m));
  assert.deepEqual(m.res.published.map((/** @type {any} */ f) => f.title).sort(), ['Race on retry', 'b bug']);
  assert.deepEqual(m.res.demoted.map((/** @type {any} */ f) => f.title), ['off the shown lines'], 'shown file, line not shown: demoted');
  assert.deepEqual(m.res.notes.map((/** @type {any} */ f) => f.title).sort(), ['a call anchoring on another call\'s file', 'listed file, read from the tree'], 'files the call did not show: notes');
  const callIds = context.calls.map((c, i) => sha256Hex(canonicalStringify(['call', inputId({ ...context.range, policy_digest: context.policy_digest, reviewer_family: 'openai', model: 'model-a' }), `change:g${i}`])));
  assert.equal(m.id, sha256Hex(canonicalStringify(['calls', ...callIds.sort()])));
  const swapped = { ...context, calls: [...context.calls].reverse() };
  const m2 = /** @type {any} */ (await merge(swapped, analysis(swapped, [out([passing('change:g1', [onB])]), out([passing('change:g0', [finding()])])])));
  assert.equal(m2.id, m.id, 'order of calls does not change the run input_id');
  const m3 = /** @type {any} */ (await merge(context, analysis(context, a.results.map((r) => r.result), ['model-a', 'gpt-other'])));
  assert.notEqual(m3.id, m.id, 'the model of any one call is part of the run input_id');
  const missing = await merge(context, analysis(context, [a.results[0].result, null]));
  assert.equal(missing.ok, false);
  const digest = renderDigest({ inputId: m.id, kind: 'review', branch: 'main', sha: 'b'.repeat(40), changes: [], notify: [], extras: { notes: m.res.notes } });
  assert.match(digest, /Notes on files whose diff was not shown \(not filed as issues\)/);
  assert.match(digest, /- Minor src\/huge\.ts:7: listed file, read from the tree/);
});

// ---------- end to end: prepare → run (fake codex, one call per group) → validate → publish ----------

function e2eRepo() {
  const dir = join(tempDir('square2-heavy-e2e-'), 'repo');
  mkdirSync(join(dir, 'src'), { recursive: true });
  mkdirSync(join(dir, '.square2'), { recursive: true });
  writeFileSync(join(dir, '.square2', 'config.yaml'), 'branch: main\nreviewer: openai/azure/model-a\nnotify:\n  - alice\nlanguage: en\n');
  writeFileSync(join(dir, 'src', 'db.ts'), 'export const tenantColumn = "tenant_id";\n');
  g(dir, ['init', '--quiet', '-b', 'main']);
  g(dir, ['add', '-A']);
  g(dir, ['commit', '--quiet', '-m', 'base'], '2026-11-18T00:00:00Z');
  const base = g(dir, ['rev-parse', 'HEAD']);
  writeFileSync(join(dir, 'src', 'cache.ts'), 'export const cacheKey = (id: string) => id;\n' + lines(120, 'cacheval'));
  g(dir, ['add', '-A']);
  g(dir, ['commit', '--quiet', '-m', 'feat: cache (openspec/changes/add-cache)'], '2026-11-20T05:00:00Z');
  writeFileSync(join(dir, 'src', 'tmp.ts'), 'export const scratch = 1;\n');
  g(dir, ['add', '-A']);
  g(dir, ['commit', '--quiet', '-m', 'wip scratch (openspec/changes/add-cache)'], '2026-11-20T05:30:00Z');
  g(dir, ['rm', '--quiet', 'src/tmp.ts']);
  g(dir, ['commit', '--quiet', '-m', 'revert scratch (openspec/changes/add-cache)'], '2026-11-20T05:40:00Z');
  writeFileSync(join(dir, 'src', 'db.ts'), 'export const tenantColumn = "tenant";\n' + lines(100, 'dbval'));
  g(dir, ['commit', '--quiet', '-am', 'fix: column name (openspec/changes/fix-db)'], '2026-11-20T06:00:00Z');
  return { dir, base, head: g(dir, ['rev-parse', 'HEAD']) };
}

/** @param {string[]} args @param {{ cwd: string, env: Record<string, string | undefined>, fake?: FakeGitHub, gitOps?: any }} o */
async function cli(args, o) {
  let stdout = '';
  let stderr = '';
  const code = await main(args, { cwd: o.cwd, env: o.env, stdout: (t) => { stdout += t; }, stderr: (t) => { stderr += t; }, fetch: o.fake?.fetch, gitOps: o.gitOps, now: NOW });
  return { code, stdout, stderr };
}

test('heavy range end to end: one codex call per group with per-call fallback, one digest, idempotent publish', async () => {
  const { dir, head } = e2eRepo();
  const fake = new FakeGitHub({ repo: 'octo/demo', defaultBranch: 'main' });
  const gh = { GITHUB_TOKEN: 'tok', GITHUB_REPOSITORY: 'octo/demo' };
  const root = tempDir('square2-heavy-ctx-');
  const probeDir = join(root, 'probe');
  assert.equal((await cli(['review', 'prepare', '--root', dir, '--branch', 'main', '--out', probeDir], { cwd: dir, env: gh, fake })).code, 0);
  const probe = JSON.parse(readFileSync(join(probeDir, 'context.json'), 'utf8'));
  assert.equal(probe.diff_mode, 'range');
  writeFileSync(join(dir, '.square2', 'config.yaml'), readFileSync(join(dir, '.square2', 'config.yaml'), 'utf8') + `max_input_tokens: ${probe.estimated_tokens.total - 1}\n`);

  const ctxDir = join(root, 'ctx');
  const p = await cli(['review', 'prepare', '--root', dir, '--branch', 'main', '--out', ctxDir], { cwd: dir, env: gh, fake });
  assert.equal(p.code, 0, p.stdout + p.stderr);
  const context = JSON.parse(readFileSync(join(ctxDir, 'context.json'), 'utf8'));
  assert.equal(context.diff_mode, 'calls');
  assert.deepEqual(context.calls.map((/** @type {any} */ c) => [c.group, c.trimmed]), [['change:add-cache', false], ['change:fix-db', false]]);
  assert.deepEqual(context.calls[0].shown_files, ['src/cache.ts', 'src/tmp.ts'], 'each commit\'s own patch: the add and the revert are both shown');
  assert.equal(context.calls[0].commits.length, 3);

  const fakeDir = tempDir('square2-heavy-codex-');
  const bin = join(fakeDir, 'codex');
  copyFileSync(join(REPO, 'test', 'fixtures', 'fake-codex.mjs'), bin);
  spawnSync('chmod', ['+x', bin]);
  const llm = { PATH: process.env.PATH, SQ2_AZURE_OPENAI_ENDPOINT: 'https://example.invalid/', SQ2_AZURE_OPENAI_API_KEY: 'heavy-range-secret-key-0042', SQUARE2_CODEX_BIN: bin };

  const leakDir = join(root, 'leak');
  const leak = await cli(['review', 'run', '--context', ctxDir, '--out', leakDir, '--model', 'gpt-leak-on-db'], { cwd: dir, env: llm });
  assert.equal(leak.code, 2);
  assert.match(leak.stdout, /contains the LLM key/);
  assert.equal(existsSync(leakDir), false, 'a leak in the second call output writes nothing');
  writeFileSync(join(fakeDir, 'observed.jsonl'), '');

  const anaDir = join(root, 'analysis');
  const r = await cli(['review', 'run', '--context', ctxDir, '--out', anaDir, '--model', 'gpt-broken-on-db', '--fallback-model', 'gpt-fallback'], { cwd: dir, env: llm });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const observed = readFileSync(join(fakeDir, 'observed.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(observed.map((o) => [o.focus, o.model]), [['change:add-cache', 'gpt-broken-on-db'], ['change:fix-db', 'gpt-broken-on-db'], ['change:fix-db', 'gpt-fallback']], 'sequential calls, fallback per call');
  for (const o of observed) {
    assert.equal(o.sandbox, 'read-only');
    assert.ok(o.promptHasRangeMarker);
    assert.ok(o.args.includes('--ignore-user-config') && o.args.includes('--ephemeral'));
  }
  assert.deepEqual(readdirSync(anaDir).sort(), ['candidates.json', 'resolutions.json', 'result.call-1.json', 'result.call-2.json', 'usage.json']);
  const usage = JSON.parse(readFileSync(join(anaDir, 'usage.json'), 'utf8'));
  assert.deepEqual(usage.usage, { input: 2400, cached: 2000, output: 600 }, 'usage summed over calls');
  assert.deepEqual(usage.calls.map((/** @type {any} */ c) => [c.call, c.model_used, c.attempts.length]), [['call-1', 'gpt-broken-on-db', 1], ['call-2', 'gpt-fallback', 2]]);

  const v = await cli(['review', 'validate', '--root', dir, '--context', ctxDir, '--analysis', anaDir, '--out', join(root, 'review.json')], { cwd: dir, env: {} });
  assert.equal(v.code, 0, v.stdout);
  assert.match(v.stdout, /review validate: ok, 1 finding\(s\), demoted: 1, notes: 1/);
  const review = JSON.parse(readFileSync(join(root, 'review.json'), 'utf8'));
  assert.deepEqual(review.published.map((/** @type {any} */ f) => f.path), ['src/cache.ts']);
  assert.deepEqual(review.demoted.map((/** @type {any} */ f) => f.path), ['src/tmp.ts'], 'shown file, but not a line of the named commit\'s patch: demoted');
  assert.deepEqual(review.notes.map((/** @type {any} */ f) => f.path), ['src/elsewhere.ts'], 'a finding on a file the call did not show is a note');
  assert.equal(review.published[0].commit, context.calls[0].commits[0], 'commit expanded from the model\'s short sha; blame agrees');
  const base = (/** @type {string} */ model) => inputId({ ...context.range, policy_digest: context.policy_digest, reviewer_family: 'openai', model });
  const ids = [sha256Hex(canonicalStringify(['call', base('gpt-broken-on-db'), 'change:add-cache'])), sha256Hex(canonicalStringify(['call', base('gpt-fallback'), 'change:fix-db']))];
  assert.equal(review.input_id, sha256Hex(canonicalStringify(['calls', ...ids.sort()])));

  const fresh = { liveHead: async () => head, isAncestor: async (/** @type {string} */ _r, /** @type {string} */ a, /** @type {string} */ b) => a === b };
  const env = { ...gh, SQUARE2_TODAY: '2026-11-20' };
  const pub = await cli(['review', 'publish', '--root', dir, '--context', ctxDir, '--analysis', anaDir], { cwd: dir, env, fake, gitOps: fresh });
  assert.equal(pub.code, 0, pub.stdout + pub.stderr);
  const issues = fake.issues.filter((i) => i.labels.includes('square2:review'));
  assert.deepEqual(issues.map((i) => i.title), ['Cache key ignores the tenant'], 'notes are not filed as issues');
  const state = fake.issues.find((i) => i.labels.includes('square2-state'));
  assert.ok(state);
  const digests = state.comments.filter((c) => c.body.includes('square2:digest:'));
  assert.equal(digests.length, 1, 'one digest for the run');
  assert.ok(digests[0].body.includes(`square2:digest:${review.input_id}`));
  assert.match(digests[0].body, /Notes on files whose diff was not shown/);
  assert.match(digests[0].body, /src\/elsewhere\.ts:1: Elsewhere looks off/);
  assert.match(digests[0].body, /input 2400, cached 2000, output 600 tokens/);
  assert.ok(parseState(state.body).published_input_ids.includes(review.input_id));

  const before = JSON.stringify(fake.snapshot());
  const again = await cli(['review', 'publish', '--root', dir, '--context', ctxDir, '--analysis', anaDir], { cwd: dir, env, fake, gitOps: fresh });
  assert.equal(again.code, 0);
  assert.match(again.stdout, /already published/);
  assert.equal(JSON.stringify(fake.snapshot()), before, 'a multi-call run publishes once');
});
