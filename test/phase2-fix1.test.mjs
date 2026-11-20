import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { main } from '../src/cli/main.mjs';
import { apiGitOps } from '../src/cli/publish-cmd.mjs';
import { modelProblem } from '../src/cli/review-cmd.mjs';
import { patternOptionsProblem, validateCatalogue } from '../src/core/catalogue.mjs';
import { changedLines } from '../src/git/changed-lines.mjs';
import { rangeDiff } from '../src/git/diff.mjs';
import { createGitHub } from '../src/issues/github.mjs';
import { gateItems, publish, reviewItems } from '../src/issues/publish.mjs';
import { StateIssue, parseState, serializeState } from '../src/issues/state.mjs';
import { changeIdOf } from '../src/review/group.mjs';
import { DEFAULT_REVIEW_EXCLUDES, prepareReview, reviewConfig } from '../src/review/prepare.mjs';
import { FIELD_CAPS, MAX_BODY, looksSecret, parseTarget, renderReviewIssue, sanitize } from '../src/review/render.mjs';
import { codexArgs, leaksKey, readAnalysis } from '../src/review/run.mjs';
import { validateReview } from '../src/review/validate.mjs';
import { adapter as patternAdapter } from '../src/engines/pattern.mjs';
import { parseConfig } from '../src/cli/config.mjs';
import { REPO, cleanupTemps, copyMiniRepo, tempDir } from './cli-helpers.mjs';
import { FakeGitHub } from './issues/fake-github.mjs';
import { writeRunArtifacts } from './issues/run-artifacts.mjs';

after(cleanupTemps);

const NOW = new Date('2026-11-20T08:00:00Z');
const SHA = (/** @type {string} */ c) => c.repeat(40);

/** @param {string} cwd @param {string[]} args @param {string} [date] */
function g(cwd, args, date) {
  const env = date ? { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : process.env;
  const res = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', env });
  if (res.status !== 0) throw new Error(`git ${args.join(' ')}: ${res.stderr}`);
  return res.stdout.trim();
}

/**
 * @param {string[]} args
 * @param {{ cwd: string, env?: Record<string, string | undefined>, fake?: FakeGitHub, gitOps?: any, review?: any, replay?: any }} o
 */
async function cli(args, o) {
  let stdout = '';
  let stderr = '';
  const code = await main(args, { cwd: o.cwd, env: { SQUARE2_TODAY: '2026-11-20', GITHUB_REPOSITORY: o.fake?.repo, ...(o.env ?? {}) }, stdout: (t) => { stdout += t; }, stderr: (t) => { stderr += t; }, fetch: o.fake?.fetch, gitOps: o.gitOps, review: o.review, replay: o.replay, now: NOW });
  return { code, stdout, stderr };
}

/** A repository with `.square2/config.yaml` and a base commit dated 2026-11-18. */
function repo(config = 'branch: main\nreviewer: openai/azure/gpt-main\nlanguage: en\n') {
  const dir = join(tempDir('square2-fix-'), 'repo');
  mkdirSync(join(dir, '.square2'), { recursive: true });
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, '.square2', 'config.yaml'), config);
  writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 1;\n');
  g(dir, ['init', '--quiet', '-b', 'main']);
  g(dir, ['add', '-A']);
  g(dir, ['commit', '--quiet', '-m', 'base'], '2026-11-18T00:00:00Z');
  return dir;
}

/** @returns {import('../src/review/policy-digest.mjs').Policy} */
function policy() {
  return { template: readFileSync(join(REPO, 'prompts', 'review.staged.md'), 'utf8'), schema: readFileSync(join(REPO, 'schemas', 'review.v1.json'), 'utf8'), reviewContext: '', enforcedRules: [], triagePatterns: [], version: '0', extraPrompts: { resolution: readFileSync(join(REPO, 'prompts', 'review.resolution.md'), 'utf8') } };
}
const CONFIG = reviewConfig({ reviewer: 'openai/azure/gpt-main' }).config;

// ---------- 1. key leak, codex isolation ----------

test('1: model output carrying the LLM key in any encoding is rejected', () => {
  const key = 'k3y-' + 'Z9'.repeat(14);
  const b = Buffer.from(key);
  for (const form of [key, b.toString('base64'), b.toString('base64url'), b.toString('hex'), b.toString('hex').toUpperCase(), encodeURIComponent(key + '/x')]) {
    assert.equal(leaksKey(`note: ${form}`, key), true, form);
  }
  assert.equal(leaksKey('an ordinary finding about tokens', key), false);
  for (const shape of ['0123456789abcdef0123456789abcdef', 'A'.repeat(52) + '1'.repeat(32)]) assert.equal(looksSecret(`key ${shape}`), true, shape);
  const args = codexArgs({ model: 'm', endpoint: 'https://e.invalid', tree: '/t', outFile: '/o' });
  for (const f of ['--ignore-user-config', '--ignore-rules', '--ephemeral']) assert.ok(args.includes(f), f);
});

test('1: review run exits 2 and writes nothing when the model echoes the key', async () => {
  const dir = repo();
  writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 2;\n');
  g(dir, ['commit', '--quiet', '-am', 'change a'], '2026-11-20T06:00:00Z');
  const ctx = join(tempDir('square2-leak-'), 'ctx');
  assert.equal((await cli(['review', 'prepare', '--root', dir, '--branch', 'main', '--out', ctx], { cwd: dir })).code, 0);
  const bin = join(tempDir('square2-leakbin-'), 'codex');
  copyFileSync(join(REPO, 'test', 'fixtures', 'fake-codex.mjs'), bin);
  spawnSync('chmod', ['+x', bin]);
  const out = join(ctx, '..', 'analysis');
  const r = await cli(['review', 'run', '--context', ctx, '--out', out, '--model', 'gpt-leak'], { cwd: dir, env: { PATH: process.env.PATH, SQ2_AZURE_OPENAI_ENDPOINT: 'https://e.invalid', SQ2_AZURE_OPENAI_API_KEY: 'super-secret-key-value-1234', SQUARE2_CODEX_BIN: bin } });
  assert.equal(r.code, 2);
  assert.match(r.stdout, /^\[S2-REVIEW-MODEL\] the model output contains the LLM key/);
  assert.equal(existsSync(out), false);
});

// ---------- 2. sanitize ----------

test('2: sanitize strips every link and image form, keeps <file> and generics as text, never yields a marker', () => {
  const cases = /** @type {[string, (s: string) => void][]} */ ([
    ['see //evil.example/p and (//cdn.example/x.js)', (s) => assert.doesNotMatch(s, /(?<!\\)[()]/, 'no link syntax: parentheses escaped')],
    ['[a][r] and ![i][r]\n[r]: https://evil.example', (s) => { assert.ok(s.includes('https://\u200devil'), 'autolink neutralised'); assert.doesNotMatch(s, /(?<!\\)[[\]!]/, 'every bracket and bang escaped'); }],
    ['<!-<!-- x -->- square2:finding:abc -->', (s) => assert.doesNotMatch(s, /<!--/)],
    ['symbol <file> in Map<string, Array<T>>', (s) => assert.equal(s, 'symbol &lt;file&gt; in Map&lt;string, Array&lt;T&gt;&gt;')],
    ['`<!-- square2:finding:k -->` and `a<b>`', (s) => { assert.doesNotMatch(s, /<!--/); assert.match(s, /\\`a&lt;b&gt;\\`/); }],
    ['<img src=x onerror=alert(1)>', (s) => assert.equal(s, '&lt;img src=x onerror=alert\\(1\\)&gt;')],
  ]);
  for (const [input, check] of cases) check(sanitize(input));
  const issue = renderReviewIssue({ severity: 'Major', path: 'src/a.ts', line: 1, title: 'x', failure_case: '<!-- square2:finding:evil -->', suggestion: 's', enclosing_symbol: '<file>' }, { language: 'en', range: { from_sha: null, to_sha: SHA('a') } });
  assert.doesNotMatch(issue.body, /<!-- square2:finding:/);
  assert.match(issue.body, /\*\*Symbol:\*\* &lt;file&gt;/, '<file> shown as escaped text, outside code');
});

// ---------- 3. length caps ----------

test('3: fields are capped with a note and bodies stay under 60000', () => {
  const long = 'x'.repeat(10000);
  const issue = renderReviewIssue({ severity: 'Minor', path: 'src/a.ts', line: 1, title: 't'.repeat(500), body: long, failure_case: long, suggestion: long, enclosing_symbol: 'f', evidence: Array.from({ length: 40 }, () => long) }, { language: 'en', range: { from_sha: null, to_sha: SHA('a') } });
  assert.ok(issue.title.length <= FIELD_CAPS.title + 40);
  assert.match(issue.body, /truncated 6000 characters/);
  assert.match(issue.body, /20 more evidence items truncated/);
  assert.ok(issue.body.length < MAX_BODY);
});

// ---------- 4. state ----------

test('4: the state is re-read right before writing and never moves backward', async () => {
  const fake = new FakeGitHub({ repo: 'o/r' });
  const gh = createGitHub({ token: 't', repo: 'o/r', fetch: fake.fetch });
  const st = new StateIssue(gh);
  await st.write({ last_reviewed_sha: SHA('a'), published_input_ids: ['x'] });
  const issue = fake.issues.find((i) => i.labels.includes('square2-state'));
  assert.ok(issue);
  issue.body = serializeState({ last_reviewed_sha: SHA('c'), published_input_ids: ['other-writer'] });
  assert.equal((await st.read()).last_reviewed_sha, SHA('a'), 'cached');
  assert.deepEqual(await st.reread(), { last_reviewed_sha: SHA('c'), published_input_ids: ['other-writer'] });

  const dir = repo();
  fake.branches.main = SHA('b');
  fake.ancestors.add(`${SHA('b')}..${SHA('c')}`);
  const art = writeRunArtifacts(tempDir('square2-st-'), { from_sha: SHA('a'), to_sha: SHA('b'), branch: 'main' });
  const ok = { validate: async () => ({ ok: true, language: 'en', published: [], demoted: [], questions: [], suggestions: [] }) };
  const r = await cli(['review', 'publish', '--root', dir, '--context', art.context, '--analysis', art.analysis], { cwd: dir, env: { GITHUB_TOKEN: 't' }, fake, review: ok });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const after = parseState(issue.body);
  assert.equal(after.last_reviewed_sha, SHA('c'), 'b is behind the recorded c: not moved back');
  assert.deepEqual(after.published_input_ids, [art.inputId, 'other-writer'], 'the concurrent writer\'s id is kept');
  assert.match(r.stderr, /not moved back/);
});

// ---------- 5. model override vs family ----------

test('5: a model override must stay in the selected reviewer family', () => {
  const ctx = { reviewer: { family: 'openai', model: 'gpt-main' }, reviewers: [{ family: 'openai', model: 'gpt-main' }, { family: 'google', model: 'gem-x' }] };
  assert.equal(modelProblem(ctx, 'gpt-main', false), null);
  assert.equal(modelProblem(ctx, 'gpt-6.2-sol', false), null);
  assert.match(String(modelProblem(ctx, 'claude-opus', false)), /family anthropic/);
  assert.match(String(modelProblem(ctx, 'gem-x', false)), /family google/);
  assert.match(String(modelProblem(ctx, 'deployment-7', false)), /unknown family/);
  assert.equal(modelProblem(ctx, 'claude-opus', true), null);
});

// ---------- 6. PR and explicit ranges, error mapping ----------

test('6: --from/--to and --pr ranges; bad ranges and config errors exit 2 with a diagnostic', async () => {
  const dir = repo();
  const base = g(dir, ['rev-parse', 'HEAD']);
  writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 3;\n');
  g(dir, ['commit', '--quiet', '-am', 'c1'], '2026-11-10T00:00:00Z');
  const head = g(dir, ['rev-parse', 'HEAD']);
  const out = join(tempDir('square2-rng-'), 'ctx');
  const r = await cli(['review', 'prepare', '--root', dir, '--from', base, '--to', head, '--out', out], { cwd: dir });
  assert.equal(r.code, 0, r.stdout);
  assert.deepEqual(JSON.parse(readFileSync(join(out, 'context.json'), 'utf8')).range, { from_sha: base, to_sha: head, branch_or_pr: 'branch:main' });
  const pr = await cli(['review', 'prepare', '--root', dir, '--pr', '7', '--base', base, '--head', head, '--out', out], { cwd: dir });
  assert.equal(pr.code, 0);
  assert.equal(JSON.parse(readFileSync(join(out, 'context.json'), 'utf8')).range.branch_or_pr, 'pr:7');
  const back = await cli(['review', 'prepare', '--root', dir, '--from', head, '--to', base, '--out', out], { cwd: dir });
  assert.equal(back.code, 2);
  assert.match(back.stdout, /^\[S2-REVIEW-PREPARE\] --from .* is not an ancestor of --to/);
  const missing = await cli(['review', 'prepare', '--root', dir, '--from', 'f'.repeat(40), '--to', head, '--out', out], { cwd: dir });
  assert.equal(missing.code, 2);
  assert.match(missing.stdout, /is not a commit in this repository/);
  writeFileSync(join(dir, '.square2', 'config.yaml'), 'reviewer: nope\n');
  const cfg = await cli(['review', 'prepare', '--root', dir, '--out', out], { cwd: dir });
  assert.equal(cfg.code, 2);
  assert.match(cfg.stdout, /^\[S2-REVIEW-PREPARE\] review config: reviewer must be family\/provider\/model/);
  assert.equal((await cli(['review', 'prepare', '--root', dir, '--pr', 'x', '--out', out], { cwd: dir })).code, 2);
});

// ---------- 7. renames ----------

test('7: open issues follow renames in the range', async () => {
  const dir = repo();
  const base = g(dir, ['rev-parse', 'HEAD']);
  g(dir, ['mv', 'src/a.ts', 'src/b.ts']);
  writeFileSync(join(dir, 'src', 'b.ts'), 'export const a = 1;\nexport const b = 2;\n');
  g(dir, ['add', '-A']);
  g(dir, ['commit', '--quiet', '-m', 'rename'], '2026-11-20T06:00:00Z');
  const res = /** @type {any} */ (await prepareReview({ repoRoot: dir, branch: 'main', state: { last_reviewed_sha: base }, now: NOW, config: CONFIG, policy: policy(), outDir: tempDir('square2-ren-'), openIssues: [{ number: 4, key: 'k'.repeat(64), path: 'src/a.ts', line: 1, title: 'old', failure_case: 'f', enclosing_symbol: 'a' }] }));
  assert.deepEqual(res.context.open_issues.map((/** @type {any} */ o) => [o.number, o.path, o.renamed_from]), [[4, 'src/b.ts', 'src/a.ts']]);
  assert.deepEqual(res.context.resolution_prompts.map((/** @type {any} */ p) => p.issue.path), ['src/b.ts']);
});

// ---------- 8. publish-gate: disabled rules, test nonce ----------

test('8: disabled rules never auto-close; test publications get their own keys per run', async () => {
  const dir = copyMiniRepo();
  writeFileSync(join(dir, '.square2', 'config.yaml'), readFileSync(join(dir, '.square2', 'config.yaml'), 'utf8') + 'branch: main\nbudget: false\n');
  const rules = join(dir, '.square2', 'rules', 'routes.yaml');
  writeFileSync(rules, readFileSync(rules, 'utf8').replace('    owner: platform\n', '    owner: platform\n    enabled: false\n'));
  const fake = new FakeGitHub({ repo: 'o/r', defaultBranch: 'main' });
  fake.seed({ title: 'route', body: '<!-- square2:finding:fp1 -->\n<!-- square2:rule:S2-ROUTE-LANES -->\n', labels: ['square2', 'square2:gate'] });
  const report = { head_sha: SHA('b'), catalogue_digest: 'c'.repeat(64), exit_code: 0, rules: { 'S2-ROUTE-LANES': {} }, new_violations: [], observed: [], excepted: [] };
  writeFileSync(join(dir, 'r.json'), JSON.stringify(report));
  const env = { GITHUB_TOKEN: 't', GITHUB_REF_NAME: 'main' };
  assert.equal((await cli(['publish-gate', '--root', dir, '--report', join(dir, 'r.json')], { cwd: dir, env, fake })).code, 0);
  assert.equal(fake.issue(1)?.state, 'open', 'a disabled rule\'s issue stays open');

  const viol = { ...report, new_violations: [{ rule_id: 'S2-DEP-NO-VENDOR', path: 'apps/x.ts', line: 1, message: 'imports pg', fingerprint: 'fp2', count: 1 }] };
  writeFileSync(join(dir, 'r.json'), JSON.stringify(viol));
  for (const nonce of ['run-1', 'run-2']) {
    assert.equal((await cli(['publish-gate', '--root', dir, '--report', join(dir, 'r.json'), '--test', '--nonce', nonce], { cwd: dir, env, fake })).code, 0);
  }
  const tests = fake.issues.filter((i) => i.labels.includes('square2:test'));
  assert.equal(tests.length, 2, 'each test run publishes again');
  assert.equal(gateItems(viol)[0].key, 'fp2', 'real keys are the fingerprints');
  assert.notEqual(gateItems(viol, { test: true, nonce: 'run-1' })[0].key, 'fp2');
});

// ---------- 9. diff flags ----------

test('9: diffs ignore noprefix, external diff and textconv settings of the repository', async () => {
  const dir = repo();
  const base = g(dir, ['rev-parse', 'HEAD']);
  g(dir, ['config', 'diff.noprefix', 'true']);
  g(dir, ['config', 'diff.mnemonicPrefix', 'true']);
  g(dir, ['config', 'diff.external', '/bin/false']);
  writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 9;\n');
  g(dir, ['commit', '--quiet', '-am', 'x']);
  const d = await rangeDiff(dir, base, 'HEAD', { unified: 0 });
  assert.match(d, /^--- a\/src\/a\.ts$/m);
  assert.match(d, /^\+\+\+ b\/src\/a\.ts$/m);
  assert.deepEqual([...changedLines(d).keys()], ['src/a.ts']);
});

// ---------- 10. freshness via the API ----------

test('10: freshness uses the GitHub API (branch head, compare)', async () => {
  const fake = new FakeGitHub({ repo: 'o/r' });
  fake.branches.dev = SHA('c');
  fake.ancestors.add(`${SHA('b')}..${SHA('c')}`);
  const ops = apiGitOps(createGitHub({ token: 't', repo: 'o/r', fetch: fake.fetch }));
  assert.equal(await ops.liveHead('/nowhere', 'dev'), SHA('c'));
  assert.equal(await ops.liveHead('/nowhere', 'gone'), null);
  assert.equal(await ops.isAncestor('/nowhere', SHA('b'), SHA('c')), true);
  assert.equal(await ops.isAncestor('/nowhere', SHA('d'), SHA('c')), false);
  assert.equal(await ops.isAncestor('/nowhere', SHA('c'), SHA('c')), true);
  assert.ok([...fake.tokens].every((t) => t === 'Bearer t'), 'the publish token travels only in the API header');
});

// ---------- 11. budget command ----------

test('11: square2 budget reports minutes; missing permissions degrade to a note', async () => {
  const dir = copyMiniRepo();
  const fake = new FakeGitHub({ repo: 'o/r' });
  const ok = await cli(['budget', '--root', dir], { cwd: dir, env: { GITHUB_TOKEN: 't' }, fake });
  assert.equal(ok.code, 0, ok.stdout);
  assert.match(ok.stdout, /^budget: 0 minutes month-to-date/);
  /** @type {any} */
  const denied = { repo: 'o/r', fetch: async (/** @type {any} */ input, /** @type {any} */ init) => (String(input).includes('/actions/') ? new Response('{"message":"Resource not accessible"}', { status: 403 }) : fake.fetch(input, init)) };
  const r = await cli(['budget', '--root', dir], { cwd: dir, env: { GITHUB_TOKEN: 't' }, fake: denied });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /^note: budget check skipped \(403\)/);
});

// ---------- 12. severity labels, digest for questions only ----------

test('12: severity labels follow the finding; a run with only questions still posts one digest', async () => {
  const fake = new FakeGitHub({ repo: 'o/r' });
  const gh = createGitHub({ token: 't', repo: 'o/r', fetch: fake.fetch });
  const f = { severity: 'Major', path: 'src/a.ts', line: 1, side: 'RIGHT', title: 'Race', failure_case: 'c', suggestion: 's', enclosing_symbol: 'f', mechanizable: false };
  const items = reviewItems({ range: { from_sha: SHA('a'), to_sha: SHA('b') }, language: 'en', published: [{ ...f, severity: 'Minor' }] });
  await publish({ gh, state: new StateIssue(gh), run: { kind: 'review', inputId: 'one', branch: 'main', sha: SHA('b') }, items, notify: [] });
  const issue = fake.issues.find((i) => i.labels.includes('square2:review'));
  assert.ok(issue?.labels.includes('sev:minor'));
  await publish({ gh, state: new StateIssue(gh), run: { kind: 'review', inputId: 'two', branch: 'main', sha: SHA('c') }, items: reviewItems({ range: { from_sha: SHA('b'), to_sha: SHA('c') }, language: 'en', published: [f] }), notify: [] });
  assert.ok(issue?.labels.includes('sev:major') && !issue.labels.includes('sev:minor'), JSON.stringify(issue?.labels));
  const quiet = await publish({ gh, state: new StateIssue(gh), run: { kind: 'review', inputId: 'three', branch: 'main', sha: SHA('d') }, items: [], notify: ['alice'], extras: { questions: ['Is the cache shared across tenants?'] } });
  assert.equal(quiet.digest, true);
  const st = fake.issues.find((i) => i.labels.includes('square2-state'));
  assert.equal(st?.comments.filter((c) => c.body.includes('square2:digest:three')).length, 1);
  assert.match(st?.comments.at(-1)?.body ?? '', /Is the cache shared across tenants\?/);
});

// ---------- D-a excludes, D-b grouping, D-c unshown groups ----------

test('D-a: generated and lock files leave the diff and are listed with their size', async () => {
  const dir = repo('branch: main\nreviewer: openai/azure/gpt-main\ngenerated:\n  - gen/**\n');
  const base = g(dir, ['rev-parse', 'HEAD']);
  mkdirSync(join(dir, 'gen'), { recursive: true });
  writeFileSync(join(dir, 'pnpm-lock.yaml'), 'lockfile: x\n'.repeat(50));
  writeFileSync(join(dir, 'src', 'bundle.min.js'), 'var a=1;');
  writeFileSync(join(dir, 'gen', 'api.ts'), 'export const generated = 1;\n');
  writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 5;\n');
  g(dir, ['add', '-A']);
  g(dir, ['commit', '--quiet', '-m', 'mixed'], '2026-11-20T06:00:00Z');
  const cfg = reviewConfig({ reviewer: 'openai/azure/gpt-main', generated: ['gen/**'] }).config;
  assert.ok(DEFAULT_REVIEW_EXCLUDES.includes('**/pnpm-lock.yaml'));
  const res = /** @type {any} */ (await prepareReview({ repoRoot: dir, branch: 'main', state: { last_reviewed_sha: base }, now: NOW, config: cfg, policy: policy() }));
  assert.deepEqual(res.context.excluded.map((/** @type {any} */ e) => e.path), ['gen/api.ts', 'pnpm-lock.yaml', 'src/bundle.min.js']);
  assert.equal(res.context.excluded_bytes, readFileSync(join(dir, 'pnpm-lock.yaml')).length + 8 + 28);
  assert.deepEqual(Object.keys(res.context.changed_lines), ['src/a.ts']);
  assert.doesNotMatch(res.prompt.suffix, /lockfile: x|generated = 1/);
});

test('D-b: change ids come from openspec/changes paths first, then literal mentions', () => {
  assert.equal(changeIdOf({ message: 'chore', paths: ['openspec/changes/add-cache/tasks.md', 'src/x.ts'] }), 'add-cache');
  assert.equal(changeIdOf({ message: 'archive', paths: ['openspec/changes/archive/2026-11-16-fix-db/proposal.md'] }), 'fix-db');
  assert.equal(changeIdOf({ message: 'implements openspec/changes/tune-a', paths: ['src/x.ts'] }), 'tune-a');
  assert.equal(changeIdOf({ message: 'openspec: tune-a', paths: [] }), null);
  assert.equal(changeIdOf({ message: 'change logs only', paths: [] }), null);
  assert.equal(changeIdOf({ message: 'x', paths: ['openspec/changes/archive/README.md'] }), null);
});

test('D-c: groups not shown to the model may be omitted or not_reviewed, nothing else', () => {
  const lines = changedLines('diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -0,0 +1 @@\n+x\n');
  const ctx = { groups: [{ id: 'g1', shown: true }, { id: 'g2', shown: false }], changedLines: lines };
  const pass = { id: 'g1', requirement: { status: 'pass', summary: 's', evidence: ['e'] }, approach: { status: 'pass', summary: 's', evidence: ['e'] }, code: { status: 'pass', summary: 's', findings: [] } };
  const skipped = { id: 'g2', requirement: { status: 'not_reviewed', summary: 'not shown', evidence: [] }, approach: { status: 'not_reviewed', summary: 's', evidence: [] }, code: { status: 'not_reviewed', summary: 's', findings: [] } };
  const doc = (/** @type {any[]} */ groups) => ({ language: 'en', groups, questions: [], suggestions: [] });
  assert.equal(validateReview(doc([pass]), ctx).ok, true, 'omitted');
  assert.equal(validateReview(doc([pass, skipped]), ctx).ok, true, 'not_reviewed');
  assert.equal(validateReview(doc([pass, { ...pass, id: 'g2' }]), ctx).ok, false, 'reviewed although not shown');
  assert.equal(validateReview(doc([skipped]), ctx).ok, false, 'a shown group is still required');
});

// ---------- D-d pattern engine and candidates ----------

test('D-d: the pattern engine matches text, honours require_absent, and rejects unsafe regexes', async () => {
  for (const bad of [{ pattern: '(a+)+' }, { pattern: '(?:x*)*' }, { pattern: '(.)\\1' }, { pattern: 'a', flags: 'gy' }, { pattern: 'a'.repeat(501) }, { pattern: 'a', exec: 'rm' }]) assert.ok(patternOptionsProblem(bad), JSON.stringify(bad));
  const yaml = 'rules:\n  - id: S2-MIG-HEADER\n    dune_rule: 2\n    engine: pattern\n    scope: db/**\n    instead: add a supersedes header\n    owner: o\n    options:\n      pattern: CREATE OR REPLACE FUNCTION\n      flags: i\n      require_absent: "^-- supersedes:"\n';
  const cat = validateCatalogue([{ path: 'r.yaml', text: yaml }], { fixtureDirExists: () => true });
  assert.deepEqual(cat.diagnostics, []);
  const bad = validateCatalogue([{ path: 'r.yaml', text: yaml.replace('CREATE OR REPLACE FUNCTION', '"(a+)+"') }], { fixtureDirExists: () => true });
  assert.match(bad.diagnostics[0], /invalid pattern options: pattern has a nested quantifier/);
  const root = tempDir('square2-pat-');
  mkdirSync(join(root, 'db'), { recursive: true });
  writeFileSync(join(root, 'db', '001.sql'), 'select 1;\ncreate or replace function f() returns int;\n');
  writeFileSync(join(root, 'db', '002.sql'), '-- supersedes: 001.sql\ncreate or replace function f() returns int;\n');
  const res = await patternAdapter.run({ root, repoRoot: root, mode: 'fixture', rules: cat.rules, config: parseConfig(null).config, excludes: [], exec: /** @type {any} */ (null), resolveBin: () => [], files: async () => ['db/001.sql', 'db/002.sql'], warn: () => {} });
  assert.deepEqual(res.violations.map((v) => [v.path, v.line, v.subject]), [['db/001.sql', 2, 'create or replace function']]);
});

test('D-d/D-e: publish replays only pattern candidates for confirmed issues and posts them; others are dropped', async () => {
  const dir = repo();
  const base = g(dir, ['rev-parse', 'HEAD']);
  writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 1; // HACK-RETRY\n');
  g(dir, ['commit', '--quiet', '-am', 'introduce the defect'], '2026-11-19T00:00:00Z');
  const born = g(dir, ['rev-parse', 'HEAD']);
  const fake = new FakeGitHub({ repo: 'o/r' });
  fake.branches.main = born;
  const issue = fake.seed({ title: 'retry hack', body: '<!-- square2:finding:keyx -->\n', labels: ['square2', 'square2:review'], state: 'closed', state_reason: 'completed' });
  const rule = (/** @type {string} */ engine, /** @type {string} */ id) => `rules:\n  - id: ${id}\n    dune_rule: 2\n    engine: ${engine}\n    scope: src/**\n    instead: remove the retry hack\n    owner: o\n    enabled: false\n    born_from: ${born}\n` + (engine === 'pattern' ? '    options:\n      pattern: HACK-RETRY\n' : '    options:\n      argv:\n        - node\n        - -e\n        - "1"\n');
  const draft = (/** @type {string} */ yaml) => JSON.stringify({ rule_yaml: yaml, fixtures: { bad: [{ path: 'src/a.ts', content: '// HACK-RETRY\n' }], good: [] }, rationale: 'r' });
  const art = writeRunArtifacts(tempDir('square2-cnd-'), { from_sha: base, to_sha: born, branch: 'main', context: { candidate_prompts: [{ issue: { number: issue.number, key: 'keyx', born_from: born, title: 'retry hack', failure_case: 'f', path: 'src/a.ts', line: 1, enclosing_symbol: '<file>' }, file: 'candidate.md' }] } });
  writeFileSync(join(art.analysis, 'candidates.json'), JSON.stringify([{ issue: issue.number, answer: draft(rule('pattern', 'S2-HACK-RETRY')) }, { issue: issue.number, answer: draft(rule('command', 'S2-HACK-CMD')) }, { issue: 999, answer: draft(rule('pattern', 'S2-OTHER-X')) }]));
  const ok = { validate: async () => ({ ok: true, language: 'en', published: [], demoted: [], questions: [], suggestions: [] }) };
  const r = await cli(['review', 'publish', '--root', dir, '--context', art.context, '--analysis', art.analysis], { cwd: dir, env: { GITHUB_TOKEN: 't' }, fake, review: ok });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /candidates dropped \(not a pattern rule\): 1\ncandidates dropped \(not a prepared target\): 1/);
  const comments = fake.issue(issue.number)?.comments ?? [];
  assert.equal(comments.length, 1);
  assert.match(comments[0].body, /square2:rule-candidate:S2-HACK-RETRY/);
  assert.ok(fake.issue(issue.number)?.labels.includes('square2:rule-candidate'));
});

test('D-e: malformed analysis artifacts are refused', () => {
  const art = writeRunArtifacts(tempDir('square2-mal-'), { from_sha: SHA('a'), to_sha: SHA('b') });
  assert.equal(readAnalysis(art.analysis).usage.model_used, 'gpt-test');
  writeFileSync(join(art.analysis, 'usage.json'), '{"model_used": 5, "attempts": []}');
  assert.throws(() => readAnalysis(art.analysis), /usage.json is malformed/);
  writeFileSync(join(art.analysis, 'usage.json'), '{"model_used": "m", "attempts": [], "usage": {"input": -1, "cached": 0, "output": 0}}');
  assert.throws(() => readAnalysis(art.analysis), /malformed token usage/);
  writeFileSync(join(art.analysis, 'usage.json'), '{"model_used": "m", "attempts": [], "usage": null}');
  writeFileSync(join(art.analysis, 'resolutions.json'), '[{"issue": "x"}]');
  assert.throws(() => readAnalysis(art.analysis), /resolutions.json is malformed/);
});

test('13: tree_dir is the working directory of the analysis step; targets carry the introducing commit', () => {
  const t = parseTarget(reviewItems({ range: { from_sha: SHA('a'), to_sha: SHA('b') }, language: 'en', published: [{ severity: 'Major', path: 'src/a.ts', line: 1, side: 'RIGHT', title: 'x', failure_case: 'c', suggestion: 's', enclosing_symbol: 'f', mechanizable: true, commit: SHA('c') }] })[0].target ?? '');
  assert.deepEqual([t?.mechanizable, t?.commit], [true, SHA('c')]);
});
