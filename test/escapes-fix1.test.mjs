// v0.1.1 fix round 1: escape trailers, model override, credit rules, test isolation, shared cap,
// label-independent lookup, Fixes-Commit validity, budget skips, PR digests, review keys, CRLF.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { main } from '../src/cli/main.mjs';
import { parseConfig } from '../src/cli/config.mjs';
import { ownFamilyEnv } from '../src/cli/review-cmd.mjs';
import { createGitHub } from '../src/issues/github.mjs';
import { ESCAPE_LABEL, closingRefs, contextEscapes, detectEscapes, escapeMarker, isFixCommit, parseEscapeMarker, publishEscapes } from '../src/issues/escape.mjs';
import { parseState } from '../src/issues/state.mjs';
import { REDACTED, renderEscapeIssue } from '../src/review/render.mjs';
import { REPO, cleanupTemps, tempDir } from './cli-helpers.mjs';
import { FakeGitHub } from './issues/fake-github.mjs';

after(cleanupTemps);

const NOW = new Date('2026-11-20T08:00:00Z');
const sha = (/** @type {string} */ c) => c.repeat(40);
/** built at run time so no credential-shaped literal sits in the repository */
const TOKEN = ['gh', 'p_', 'A1b2C3d4'.repeat(5)].join('');
/** @param {FakeGitHub} fake */
const client = (fake) => createGitHub({ token: 't', repo: fake.repo, fetch: fake.fetch });
/** @param {string} s @param {Partial<import('../src/issues/escape.mjs').Escape>} [x] */
const esc = (s, x = {}) => ({ fix_sha: s, subject: `fix: ${s.slice(0, 6)}`, introducing: 'unknown', files: ['src/a.ts'], trailers: [], refs: [], ...x });

test('fix 1: escape bodies show only allow-listed trailers; secret-shaped commit text is redacted', async () => {
  const [e] = detectEscapes({
    excludes: [],
    trailers: ['Co-Authored-By', 'X-Writers'],
    commits: [{ sha: sha('a'), parents: [], paths: ['src/a.ts'], message: `fix: leak ${TOKEN}\n\nX-Writers: codex\nX-Secret: plain\nSigned-off-by: a <a@example.invalid>\nFixes-Commit: ABCDEF1` }],
  });
  assert.deepEqual(e.trailers.map((t) => t.key), ['X-Writers', 'Fixes-Commit']);
  const shown = renderEscapeIssue({ ...e, trailers: [...e.trailers, { key: 'Co-Authored-By', value: TOKEN }, { key: 'X-Writers', value: TOKEN.split('').join('​') }, { key: 'X-Writers', value: `${TOKEN.slice(0, 10)} ${TOKEN.slice(10, 25)}-${TOKEN.slice(25)}` }] });
  assert.ok(!shown.body.includes(TOKEN.slice(4, 30)), 'no part of the token is published');
  assert.ok(!shown.title.includes(TOKEN.slice(4, 30)));
  assert.equal(shown.title, `escape: ${REDACTED}`);
  assert.match(shown.body, /- subject: <redacted>/);
  assert.equal((shown.body.match(/<redacted>/g) ?? []).length, 4, 'subject plus three secret-shaped trailer values');
  assert.match(shown.body, /- X-Writers: codex/);
  assert.match(shown.body, /- Fixes-Commit: ABCDEF1/);
  assert.ok(!shown.body.includes('Signed-off-by') && !shown.body.includes('X-Secret'));

  const fake = new FakeGitHub();
  await publishEscapes({ gh: client(fake), escapes: [esc(sha('b'), { trailers: [{ key: 'X-Other', value: 'hidden' }, { key: 'X-Writers', value: 'codex' }] })], inputId: 'r', cap: 5, trailers: ['X-Writers'] });
  assert.ok(!fake.issues[0].body.includes('hidden'), 'the publisher filters the context trailers again');
  assert.match(fake.issues[0].body, /X-Writers: codex/);
  assert.deepEqual(contextEscapes({ escapes: [{ fix_sha: sha('c'), trailers: [{ key: 'X-Other', value: 'v' }, { key: 'fixes-commit', value: 'abcdef1' }] }] }, [])[0].trailers, [{ key: 'fixes-commit', value: 'abcdef1' }]);
});

test('fix 2: SQ2_REVIEW_MODEL applies only to the selected reviewer\'s family', () => {
  const reviewers = [{ family: 'openai', model: 'gpt-review' }, { family: 'google', model: 'gemini-review' }];
  let stderr = '';
  const io = (/** @type {Record<string, string>} */ env) => /** @type {any} */ ({ env, stderr: (/** @type {string} */ t) => { stderr += t; } });
  const alternate = { reviewer: reviewers[1], reviewers };
  assert.equal(ownFamilyEnv(alternate, 'SQ2_REVIEW_MODEL', io({ SQ2_REVIEW_MODEL: 'gpt-review' })), undefined);
  assert.match(stderr, /SQ2_REVIEW_MODEL=gpt-review is not a google deployment \(the selected reviewer\); ignored/);
  assert.equal(ownFamilyEnv(alternate, 'SQ2_REVIEW_FALLBACK_MODEL', io({ SQ2_REVIEW_FALLBACK_MODEL: 'gemini-2' })), 'gemini-2');
  assert.equal(ownFamilyEnv({ reviewer: reviewers[0], reviewers }, 'SQ2_REVIEW_MODEL', io({ SQ2_REVIEW_MODEL: 'gpt-review' })), 'gpt-review');
  assert.equal(ownFamilyEnv({ reviewer: reviewers[0], reviewers }, 'SQ2_REVIEW_MODEL', io({})), undefined);
});

test('fix 3: only closing keywords outside code credit, and only on real gate/review issues', async () => {
  assert.deepEqual(closingRefs('fix: x\n\nSee #42'), []);
  assert.deepEqual(closingRefs('Closes #42'), [42]);
  assert.deepEqual(closingRefs('closes #3, Fixed #4 and RESOLVES #5; fixes #4'), [3, 4, 5]);
  assert.deepEqual(closingRefs('closes: #3, Fixes\n#4'), [], 'only spaces or tabs between keyword and reference');
  assert.deepEqual(closingRefs('Closes owner/repo#6, prefixes #7, closes#8x, unfixes #9'), []);
  assert.deepEqual(closingRefs('x\n\n```\nCloses #10\n```\n~~~\nFixes #11\n~~~\n    Closes #12\n\tFixes #13\nuse `Closes #14` here'), []);
  assert.deepEqual(closingRefs('x\n\n```\nCloses #10\n```\nCloses #15'), [15]);

  const fake = new FakeGitHub({ pageSize: 2 });
  const review = fake.seed({ title: 'r', labels: ['square2', 'square2:review'] });
  const testIssue = fake.seed({ title: 't', labels: ['square2', 'square2:review', 'square2:test'], state: 'closed', state_reason: 'not_planned' });
  const dropped = fake.seed({ title: 'n', labels: ['square2', 'square2:gate'], state: 'closed', state_reason: 'not_planned' });
  const dup = fake.seed({ title: 'd', labels: ['square2', 'square2:gate'], state: 'closed', state_reason: 'duplicate' });
  const done = fake.seed({ title: 'c', labels: ['square2', 'square2:gate'], state: 'closed', state_reason: 'completed' });
  const gh = client(fake);
  const cases = [[testIssue.number, true], [dropped.number, true], [dup.number, true], [done.number, false], [review.number, false]];
  for (const [i, [n, escapes]] of cases.entries()) {
    const s = String(i + 1).repeat(40);
    await publishEscapes({ gh, escapes: [esc(s, { refs: [/** @type {number} */ (n)] })], inputId: `r${i}`, cap: 10 });
    assert.equal(fake.issues.some((x) => parseEscapeMarker(x.body) === s), escapes, `#${n}`);
    assert.equal(/** @type {any} */ (fake.issue(/** @type {number} */ (n))).comments.some((/** @type {any} */ c) => c.body.includes(`square2:credited:${s}`)), !escapes, `#${n} credit`);
  }
  const [mention] = detectEscapes({ excludes: [], commits: [{ sha: sha('d'), parents: [], paths: ['a'], message: `fix: y\n\nSee #${review.number}` }] });
  await publishEscapes({ gh, escapes: [mention], inputId: 'm', cap: 10 });
  assert.ok(fake.issues.some((x) => parseEscapeMarker(x.body) === sha('d')), 'a bare mention never credits');
});

test('fix 5: escapes and findings share max_new_issues_per_run, escapes first; retries keep the count', async () => {
  const fake = new FakeGitHub();
  const gh = client(fake);
  const escapes = [esc(sha('1')), esc(sha('2')), esc(sha('3'))];
  const r1 = await publishEscapes({ gh, escapes, inputId: 'run-a', cap: 2 });
  assert.deepEqual([r1.created.length, r1.counted, r1.overflow.map((o) => o.key)], [2, 2, [sha('3')]]);
  const retry = await publishEscapes({ gh, escapes, inputId: 'run-a', cap: 2 });
  assert.deepEqual([retry.created.length, retry.counted, retry.overflow.map((o) => o.key)], [0, 2, [sha('3')]], 'a retry counts its earlier creations');
  const next = await publishEscapes({ gh, escapes, inputId: 'run-b', cap: 2 });
  assert.deepEqual([next.created.length, next.counted], [1, 1]);
});

test('fix 6: escapes are found by marker whatever their labels; a missing square2 label is re-added', async () => {
  const fake = new FakeGitHub();
  const bare = fake.seed({ title: 'escape: old', body: `${escapeMarker(sha('e'))}\n\nx`, labels: ['square2:escape'] });
  const credit = fake.seed({ title: 'r', labels: ['square2:review'] });
  const gh = client(fake);
  for (let i = 0; i < 2; i++) await publishEscapes({ gh, escapes: [esc(sha('e')), esc(sha('f'), { refs: [credit.number] })], inputId: `r${i}`, cap: 10 });
  assert.equal(fake.issues.filter((i) => parseEscapeMarker(i.body) === sha('e')).length, 1);
  assert.ok(!fake.issues.some((i) => parseEscapeMarker(i.body) === sha('f')));
  assert.deepEqual(bare.labels.sort(), ['square2', 'square2:escape']);
  assert.deepEqual(credit.labels.sort(), ['square2', 'square2:review']);
  assert.equal(credit.comments.filter((c) => c.body.includes(`square2:credited:${sha('f')}`)).length, 1);
});

test('fix 7: Fixes-Commit counts only with a 7 to 40 hex sha', () => {
  for (const v of ['abc', 'not-a-sha', 'g'.repeat(7), 'a'.repeat(41), 'abcdef1 extra']) {
    assert.equal(isFixCommit(`feat: x\n\nFixes-Commit: ${v}`), false, v);
    assert.equal(detectEscapes({ excludes: [], commits: [{ sha: sha('a'), parents: [], paths: ['a'], message: `fix: x\n\nFixes-Commit: ${v}` }] })[0].introducing, 'unknown', v);
  }
  for (const v of ['abcdef1', 'A'.repeat(40)]) assert.equal(isFixCommit(`feat: x\n\nFixes-Commit: ${v}`), true, v);
});

test('fix 10: unknown review keys are config errors naming the valid key', () => {
  const r = parseConfig('review:\n  author_trailer:\n    - X-Writers\n  change_ids:\n    - X-Change\n');
  assert.deepEqual(r.diagnostics, [
    '[S2-CONFIG] .square2/config.yaml: unknown setting review.author_trailer — Instead: use review.author_trailers',
    '[S2-CONFIG] .square2/config.yaml: unknown setting review.change_ids — Instead: use review.change_id_trailers',
  ]);
  assert.match(parseConfig('review: x\n').diagnostics[0], /review must be a mapping — Instead: write review as a block map/);
  assert.deepEqual(parseConfig('review:\n  author_trailers:\n    - X-Writers\n').diagnostics, []);
});

test('fix 11 and 12: CRLF messages, lowercase introducing sha, unique refs', () => {
  const m = 'fix: crlf\r\n\r\nCloses #3, closes #3, fixes #1\r\n\r\nX-Writers: codex\r\nFixes-Commit: ABCDEF1\r\n';
  assert.equal(isFixCommit('feat: x\r\n\r\nFixes-Commit: abcdef1\r\n'), true);
  const [e] = detectEscapes({ excludes: [], trailers: ['X-Writers'], commits: [{ sha: sha('a'), parents: [], paths: ['a'], message: m }] });
  assert.equal(e.subject, 'fix: crlf');
  assert.equal(e.introducing, 'abcdef1');
  assert.deepEqual(e.refs, [1, 3]);
  assert.deepEqual(e.trailers, [{ key: 'X-Writers', value: 'codex' }, { key: 'Fixes-Commit', value: 'ABCDEF1' }]);
  const [c] = contextEscapes({ escapes: [{ fix_sha: sha('b'), subject: 's\r', introducing: 'ABCDEF1', refs: [3, 3, 1], files: [], trailers: [] }] });
  assert.deepEqual([c.subject, c.introducing, c.refs], ['s', 'abcdef1', [1, 3]]);
});

/** @param {string} cwd @param {string[]} args @param {string} [date] */
function g(cwd, args, date) {
  const env = date ? { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : process.env;
  const res = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', env });
  if (res.status !== 0) throw new Error(`git ${args.join(' ')}: ${res.stderr}`);
  return res.stdout.trim();
}

/**
 * @param {string[]} args
 * @param {{ cwd: string, env: Record<string, string | undefined>, fake?: FakeGitHub, gitOps?: any }} o
 */
async function cli(args, o) {
  let stdout = '';
  let stderr = '';
  const code = await main(args, { cwd: o.cwd, env: o.env, stdout: (t) => { stdout += t; }, stderr: (t) => { stderr += t; }, fetch: o.fake?.fetch, gitOps: o.gitOps, now: NOW });
  return { code, stdout, stderr };
}

/**
 * A repository whose range has a codex-written change `add-cache` (one review finding from the fake
 * codex) and an uncredited fix commit.
 * @param {string} extraConfig
 */
function loopRepo(extraConfig = '') {
  const dir = join(tempDir('square2-fix1-'), 'repo');
  mkdirSync(join(dir, 'src'), { recursive: true });
  mkdirSync(join(dir, '.square2'), { recursive: true });
  writeFileSync(join(dir, '.square2', 'config.yaml'), `branch: main\nlanguage: en\nescapes:\n  enabled: true\nreviewers:\n  - family: openai\n    provider: azure\n    model: gpt-review\n  - family: google\n    provider: azure\n    model: gemini-review\nreview:\n  author_trailers:\n    - Co-Authored-By\n    - X-Writers\n  change_id_trailers:\n    - X-Change\n${extraConfig}`);
  writeFileSync(join(dir, 'src', 'db.ts'), 'export const a = 1;\n');
  g(dir, ['init', '--quiet', '-b', 'main']);
  g(dir, ['add', '-A']);
  g(dir, ['commit', '--quiet', '-m', 'base'], '2026-11-18T00:00:00Z');
  const base = g(dir, ['rev-parse', 'HEAD']);
  writeFileSync(join(dir, 'src', 'cache.ts'), 'export const cacheKey = (id: string) => id;\n');
  g(dir, ['add', '-A']);
  g(dir, ['commit', '--quiet', '-m', 'feat: cache\n\nCo-Authored-By: Claude Opus <noreply@example.invalid>\nX-Writers: codex\nX-Change: add-cache'], '2026-11-20T05:00:00Z');
  writeFileSync(join(dir, 'src', 'db.ts'), 'export const a = 2;\n');
  g(dir, ['commit', '--quiet', '-am', 'fix: column\n\nSee #1'], '2026-11-20T06:00:00Z');
  const fakeDir = tempDir('square2-fix1-codex-');
  const bin = join(fakeDir, 'codex');
  copyFileSync(join(REPO, 'test', 'fixtures', 'fake-codex.mjs'), bin);
  spawnSync('chmod', ['+x', bin]);
  return { dir, base, head: g(dir, ['rev-parse', 'HEAD']), fakeDir, bin };
}

const GH = { GITHUB_TOKEN: 'tok', GITHUB_REPOSITORY: 'octo/demo', SQUARE2_TODAY: '2026-11-20' };

/**
 * prepare → run (fake codex) for one repository.
 * @param {ReturnType<typeof loopRepo>} r
 * @param {FakeGitHub} fake
 * @param {string[]} [prepareArgs]
 * @param {Record<string, string>} [runEnv]
 */
async function prepareAndRun(r, fake, prepareArgs = ['--branch', 'main'], runEnv = {}) {
  const ctxDir = join(tempDir('square2-fix1-ctx-'), 'square2-review');
  const p = await cli(['review', 'prepare', '--root', r.dir, ...prepareArgs, '--out', ctxDir], { cwd: r.dir, env: GH, fake });
  assert.equal(p.code, 0, p.stdout + p.stderr);
  const anaDir = join(ctxDir, '..', 'square2-analysis');
  const run = await cli(['review', 'run', '--context', ctxDir, '--out', anaDir], { cwd: r.dir, env: { PATH: process.env.PATH, HOME: process.env.HOME, SQUARE2_CODEX_BIN: r.bin, SQ2_AZURE_OPENAI_ENDPOINT: 'https://example.invalid/', SQ2_AZURE_OPENAI_API_KEY: 'k', ...runEnv } });
  return { ctxDir, anaDir, run, context: JSON.parse(readFileSync(join(ctxDir, 'context.json'), 'utf8')) };
}

test('fix 2 end to end: the variable naming the primary does not force it when an alternate was selected', async () => {
  const r = loopRepo();
  const fake = new FakeGitHub();
  const { context, run } = await prepareAndRun(r, fake, ['--branch', 'main'], { SQ2_REVIEW_MODEL: 'gpt-review', SQ2_REVIEW_FALLBACK_MODEL: 'gpt-review' });
  assert.deepEqual(context.author_families, ['anthropic', 'openai']);
  assert.deepEqual(context.reviewer, { family: 'google', provider: 'azure', model: 'gemini-review' });
  assert.equal(run.code, 0, run.stdout + run.stderr);
  assert.match(run.stderr, /SQ2_REVIEW_MODEL=gpt-review is not a google deployment/);
  const observed = readFileSync(join(r.fakeDir, 'observed.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(observed.map((o) => o.model), ['gemini-review']);
});

test('fix 4 and 5 end to end: test publications are nonce-scoped and leave production alone; escapes take the shared cap first', async () => {
  const r = loopRepo('max_new_issues_per_run: 1\n');
  const fake = new FakeGitHub();
  const { ctxDir, anaDir, run, context } = await prepareAndRun(r, fake);
  assert.equal(run.code, 0, run.stdout + run.stderr);
  const fresh = { liveHead: async () => r.head, isAncestor: async (/** @type {string} */ _r, /** @type {string} */ a, /** @type {string} */ b) => a === b };
  const publish = (/** @type {string[]} */ extra) => cli(['review', 'publish', '--root', r.dir, '--context', ctxDir, '--analysis', anaDir, ...extra], { cwd: r.dir, env: GH, fake, gitOps: fresh });

  for (const nonce of ['n1', 'n2']) {
    const t = await publish(['--test', '--nonce', nonce]);
    assert.equal(t.code, 0, t.stdout + t.stderr);
  }
  const testIssues = fake.issues.filter((i) => i.labels.includes('square2:test'));
  assert.equal(testIssues.length, 2, 'each nonce publishes again');
  assert.ok(testIssues.every((i) => i.state === 'closed' && i.state_reason === 'not_planned'));
  assert.ok(!fake.issues.some((i) => i.labels.includes(ESCAPE_LABEL)), 'a test publication records no escapes');
  const state = fake.issues.find((i) => i.labels.includes('square2-state'));
  assert.ok(!state || parseState(state.body).published_input_ids.length === 0, 'no input id recorded by a test publication');

  const prod = await publish([]);
  assert.equal(prod.code, 0, prod.stdout + prod.stderr);
  assert.doesNotMatch(prod.stdout, /already published/);
  const escapes = fake.issues.filter((i) => i.labels.includes(ESCAPE_LABEL));
  assert.equal(escapes.length, 1);
  assert.equal(parseEscapeMarker(escapes[0].body), r.head);
  assert.equal(fake.issues.filter((i) => i.labels.includes('square2:review') && !i.labels.includes('square2:test')).length, 0, 'the finding is over the shared cap');
  const st = /** @type {any} */ (fake.issues.find((i) => i.labels.includes('square2-state')));
  assert.ok(parseState(st.body).published_input_ids.includes(context.input_id));
  const overflow = st.comments.filter((/** @type {any} */ c) => c.body.includes('square2:overflow:'));
  assert.equal(overflow.length, 1);
  assert.match(overflow[0].body, /Cache key ignores the tenant/);
});

test('fix 8: escapes of a range skipped for the input budget are still published', async () => {
  const r = loopRepo('max_input_tokens: 1\n');
  const fake = new FakeGitHub();
  const ctxDir = join(tempDir('square2-fix1-skip-'), 'square2-review');
  assert.equal((await cli(['review', 'prepare', '--root', r.dir, '--branch', 'main', '--out', ctxDir], { cwd: r.dir, env: GH, fake })).code, 0);
  const context = JSON.parse(readFileSync(join(ctxDir, 'context.json'), 'utf8'));
  assert.equal(context.skip_kind, 'budget');
  assert.deepEqual(context.escapes.map((/** @type {any} */ e) => e.fix_sha), [r.head]);
  const fresh = { liveHead: async () => r.head, isAncestor: async (/** @type {string} */ _r, /** @type {string} */ a, /** @type {string} */ b) => a === b };
  for (let i = 0; i < 2; i++) {
    const p = await cli(['review', 'publish', '--root', r.dir, '--context', ctxDir], { cwd: r.dir, env: GH, fake, gitOps: fresh });
    assert.equal(p.code, 0, p.stdout + p.stderr);
  }
  assert.equal(fake.issues.filter((i) => parseEscapeMarker(i.body) === r.head).length, 1);
  assert.equal(existsSync(join(r.fakeDir, 'observed.jsonl')), false, 'no model call');
});

test('fix 9: pull request digests list the unclassified escapes and record none', async () => {
  const r = loopRepo();
  const fake = new FakeGitHub();
  const old = fake.seed({ title: 'escape: older fix', body: `${escapeMarker(sha('9'))}\n`, labels: ['square2', ESCAPE_LABEL] });
  fake.pulls[5] = r.head;
  const { ctxDir, anaDir, run } = await prepareAndRun(r, fake, ['--pr', '5', '--base', r.base, '--head', r.head]);
  assert.equal(run.code, 0, run.stdout + run.stderr);
  const p = await cli(['review', 'publish', '--root', r.dir, '--context', ctxDir, '--analysis', anaDir], { cwd: r.dir, env: GH, fake, gitOps: { pullHead: async () => r.head } });
  assert.equal(p.code, 0, p.stdout + p.stderr);
  assert.equal(fake.issues.filter((i) => i.labels.includes(ESCAPE_LABEL)).length, 1, 'no escape recorded from a pull request');
  const st = /** @type {any} */ (fake.issues.find((i) => i.labels.includes('square2-state')));
  const digest = st.comments.find((/** @type {any} */ c) => c.body.includes('square2:digest:'));
  assert.ok(digest);
  assert.match(digest.body, new RegExp(`Escapes awaiting classification\\*\\*\\n- \\[#${old.number}\\]`));
});
