// v0.1.1 fix round 2: redact before truncating, masked code, frozen decisions and the pre-counted
// cap, legacy state, label-independent lookup, lowercase shas, scoped skip notes, provenance
// trailers, overflow note, budget-skip output, auth.md wording.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { main } from '../src/cli/main.mjs';
import { parseConfig } from '../src/cli/config.mjs';
import { reviewTrailers } from '../src/cli/review-cmd.mjs';
import { createGitHub } from '../src/issues/github.mjs';
import { CODE_PLACEHOLDER, ESCAPE_LABEL, closingRefs, contextEscapes, creditMarker, detectEscapes, escapeMarker, maskCode, parseEscapeMarker, publishEscapes } from '../src/issues/escape.mjs';
import { StateIssue } from '../src/issues/state.mjs';
import { REDACTED, SecretError, capChecked, renderEscapeIssue, renderOverflow, renderReviewIssue, renderSeenAgain } from '../src/review/render.mjs';
import { reviewConfig } from '../src/review/prepare.mjs';
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

test('round 2, 1: secrets straddling a cap are redacted before truncation', () => {
  const subject = `fix: ${'x'.repeat(190)} ${TOKEN}`;
  const e = renderEscapeIssue(esc(sha('a'), { subject, trailers: [{ key: 'X-Writers', value: `${'w '.repeat(147)}${TOKEN}` }] }));
  assert.equal(e.title, `escape: ${REDACTED}`);
  assert.match(e.body, /- subject: <redacted>/);
  assert.match(e.body, /- X-Writers: <redacted>/);
  assert.ok(!e.body.includes(TOKEN.slice(0, 8)) && !e.title.includes(TOKEN.slice(0, 8)), 'no prefix of the token survives the cap');

  assert.throws(() => capChecked(`${'a '.repeat(10)}${TOKEN}`, 5), SecretError);
  assert.equal(capChecked('plain text', 5), 'plain… [truncated 5 characters]');
  const f = { severity: 'Major', path: 'src/a.ts', line: 1, title: 't', failure_case: `${'y'.repeat(3990)} ${TOKEN}`, suggestion: 's' };
  assert.throws(() => renderReviewIssue(f, { range: { to_sha: sha('b') } }), SecretError);
  assert.throws(() => renderSeenAgain({ failure_case: f.failure_case }, { range: { to_sha: sha('b') }, commit: sha('b') }), SecretError);
});

test('round 2, 2: code is masked by a placeholder token, never removed', () => {
  assert.ok(maskCode('Closes `x` #5').includes(CODE_PLACEHOLDER.trim()));
  for (const m of [
    'Closes `x` #5',
    'Clo`x`ses #5',
    'Closes ``a``#5',
    'Closes\n```\n```\n#5',
    'x\n\n> ```\n> Closes #6\n> ```',
    'x\n\n>     Closes #7',
    'Closes\n#8',
  ]) assert.deepEqual(closingRefs(m), [], JSON.stringify(m));
  assert.deepEqual(closingRefs('Fixes \t #8 and `Closes #9`'), [8]);
  assert.deepEqual(closingRefs('x\n\n> ```\n> code\n> ```\nResolves #10'), [10]);
});

test('round 2, 3: credit and escape decisions are frozen on first publish', async () => {
  const fake = new FakeGitHub();
  const target = fake.seed({ title: 'r', labels: ['square2', 'square2:review'] });
  const gh = client(fake);
  await publishEscapes({ gh, escapes: [esc(sha('1'), { refs: [target.number] })], inputId: 'a', cap: 5 });
  assert.equal(target.comments.filter((c) => c.body.includes(creditMarker(sha('1')))).length, 1);
  target.labels.push('square2:test');
  const again = await publishEscapes({ gh, escapes: [esc(sha('1'), { refs: [target.number] })], inputId: 'b', cap: 5 });
  assert.deepEqual(again.credited, [{ number: target.number, sha: sha('1') }], 'the recorded credit stands');
  assert.ok(!fake.issues.some((i) => parseEscapeMarker(i.body) === sha('1')), 'no escape after the target changed');
  assert.equal(target.comments.filter((c) => c.body.includes(creditMarker(sha('1')))).length, 1);

  const dropped = fake.seed({ title: 'n', labels: ['square2', 'square2:gate'], state: 'closed', state_reason: 'not_planned' });
  await publishEscapes({ gh, escapes: [esc(sha('2'), { refs: [dropped.number] })], inputId: 'c', cap: 5 });
  Object.assign(dropped, { state: 'open', state_reason: null });
  await publishEscapes({ gh, escapes: [esc(sha('2'), { refs: [dropped.number] })], inputId: 'd', cap: 5 });
  assert.equal(fake.issues.filter((i) => parseEscapeMarker(i.body) === sha('2')).length, 1, 'the recorded escape stands');
  assert.equal(dropped.comments.length, 0, 'and no credit is added later');
});

test('round 2, 3: the shared cap counts this run\'s existing escapes before any decision', async () => {
  const fake = new FakeGitHub();
  const gh = client(fake);
  const first = await publishEscapes({ gh, escapes: [esc(sha('1')), esc(sha('2'))], inputId: 'run', cap: 2 });
  assert.equal(first.counted, 2);
  const retry = await publishEscapes({ gh, escapes: [esc(sha('3')), esc(sha('1'))], inputId: 'run', cap: 2 });
  assert.deepEqual([retry.created.length, retry.counted, retry.overflow.map((o) => o.key)], [0, 2, [sha('3')]], 'reordered or partial retries keep the total');
});

test('round 2, 5 and 6: escapes are found by marker on any listed issue; shas compare lowercase', async () => {
  const fake = new FakeGitHub();
  const classified = fake.seed({ title: 'escape: x', body: `<!-- square2:escape:${sha('A')} -->\n`, labels: ['layer:tests'] });
  const gh = client(fake);
  const r = await publishEscapes({ gh, escapes: [esc(sha('A')), esc(sha('a'))], inputId: 'x', cap: 5 });
  assert.equal(r.created.length, 0, 'found without any square2 label, whatever the case of the sha');
  assert.deepEqual(classified.labels.sort(), ['layer:tests', 'square2', 'square2:escape']);
  assert.deepEqual(r.unclassified, [], 'a classified escape is not awaiting classification');
  assert.equal(parseEscapeMarker(classified.body), sha('a'));
  assert.equal(escapeMarker(sha('B')), `<!-- square2:escape:${sha('b')} -->`);
  assert.equal(creditMarker(sha('C')), `<!-- square2:credited:${sha('c')} -->`);
  assert.equal(detectEscapes({ excludes: [], commits: [{ sha: sha('D'), parents: [], paths: ['a'], message: 'fix: x' }] })[0].fix_sha, sha('d'));
  assert.equal(contextEscapes({ escapes: [{ fix_sha: sha('E') }] })[0].fix_sha, sha('e'));
});

test('round 2, 8: provenance trailers are configurable, shown and redacted', () => {
  const raw = { reviewer: 'openai/azure/m', review: { author_trailers: ['X-Writers'], change_id_trailers: ['X-Change'], provenance_trailers: ['X-Reviewers'] } };
  assert.deepEqual(reviewConfig(raw).errors, []);
  assert.deepEqual(reviewConfig(raw).config.provenance_trailers, ['X-Reviewers']);
  assert.deepEqual(reviewTrailers(raw), ['X-Writers', 'X-Change', 'X-Reviewers']);
  assert.deepEqual(parseConfig('review:\n  provenance_trailers:\n    - X-Reviewers\n').diagnostics, []);
  const [e] = detectEscapes({ excludes: [], trailers: reviewTrailers(raw), commits: [{ sha: sha('a'), parents: [], paths: ['a'], message: `fix: x\n\nX-Writers: codex\nX-Change: c-1\nX-Reviewers: gemini, ${TOKEN}\nX-Other: no` }] });
  assert.deepEqual(e.trailers.map((t) => t.key), ['X-Writers', 'X-Change', 'X-Reviewers']);
  const body = renderEscapeIssue(e).body;
  assert.match(body, /- X-Change: c-1/);
  assert.match(body, /- X-Reviewers: <redacted>/);
});

test('round 2, 9: the overflow note shows the configured cap and the remaining allowance', async () => {
  const note = renderOverflow({ inputId: 'i', overflow: [{ key: sha('a'), title: 't', label: 'escape' }], cap: 10, remaining: 3 });
  assert.match(note, /max_new_issues_per_run \(configured: 10; remaining for findings after escapes: 3\)/);
  assert.match(renderOverflow({ inputId: 'i', overflow: [], cap: 4 }), /configured: 4; remaining for findings after escapes: 4/);
});

test('round 2, 11: auth.md states the family rule for SQ2_REVIEW_MODEL', () => {
  const auth = readFileSync(join(REPO, 'docs', 'auth.md'), 'utf8').replace(/\s+/g, ' ');
  assert.match(auth, /overrides the model only when it belongs to the selected reviewer's family/);
  assert.match(auth, /otherwise it is ignored with a notice/);
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

const GH = { GITHUB_TOKEN: 'tok', GITHUB_REPOSITORY: 'octo/demo', SQUARE2_TODAY: '2026-11-20' };

/** A range with one feature commit and one uncredited fix commit. @param {string} extra */
function fixRepo(extra = '') {
  const dir = join(tempDir('square2-fix2-'), 'repo');
  mkdirSync(join(dir, 'src'), { recursive: true });
  mkdirSync(join(dir, '.square2'), { recursive: true });
  writeFileSync(join(dir, '.square2', 'config.yaml'), `branch: main\nlanguage: en\nreviewer: openai/azure/gpt-review\nescapes:\n  enabled: true\n${extra}`);
  writeFileSync(join(dir, 'src', 'db.ts'), 'export const a = 1;\n');
  g(dir, ['init', '--quiet', '-b', 'main']);
  g(dir, ['add', '-A']);
  g(dir, ['commit', '--quiet', '-m', 'base'], '2026-11-18T00:00:00Z');
  writeFileSync(join(dir, 'src', 'cache.ts'), 'export const k = 1;\n');
  g(dir, ['add', '-A']);
  g(dir, ['commit', '--quiet', '-m', 'feat: cache'], '2026-11-20T05:00:00Z');
  writeFileSync(join(dir, 'src', 'db.ts'), 'export const a = 2;\n');
  g(dir, ['commit', '--quiet', '-am', 'fix: column'], '2026-11-20T06:00:00Z');
  const head = g(dir, ['rev-parse', 'HEAD']);
  const gitOps = { liveHead: async () => head, isAncestor: async (/** @type {string} */ _r, /** @type {string} */ a, /** @type {string} */ b) => a === b };
  return { dir, head, gitOps };
}

/** @param {string} dir @param {FakeGitHub} fake */
async function prepare(dir, fake) {
  const ctxDir = join(tempDir('square2-fix2-ctx-'), 'square2-review');
  const p = await cli(['review', 'prepare', '--root', dir, '--branch', 'main', '--out', ctxDir], { cwd: dir, env: GH, fake });
  assert.equal(p.code, 0, p.stdout + p.stderr);
  return { ctxDir, context: JSON.parse(readFileSync(join(ctxDir, 'context.json'), 'utf8')) };
}

test('round 2, 4: an input id recorded by a legacy run that did not advance never suppresses escapes', async () => {
  const r = fixRepo();
  const fake = new FakeGitHub();
  const { ctxDir, context } = await prepare(r.dir, fake);
  await new StateIssue(client(fake)).write({ last_reviewed_sha: null, published_input_ids: [context.input_id] });
  const anaDir = join(ctxDir, '..', 'square2-analysis');
  mkdirSync(anaDir, { recursive: true });
  const result = { language: 'en', groups: context.groups.map((/** @type {any} */ x) => ({ id: x.id, requirement: { status: 'pass', summary: 's', evidence: ['e'] }, approach: { status: 'pass', summary: 's', evidence: ['e'] }, code: { status: 'pass', summary: 's', findings: [] } })), questions: [], suggestions: [] };
  writeFileSync(join(anaDir, 'result.json'), JSON.stringify(result));
  writeFileSync(join(anaDir, 'usage.json'), JSON.stringify({ model_used: 'gpt-review', attempts: [{ model: 'gpt-review', exit_code: 0 }], calls: [], usage: null, allow_same_family: false }));
  writeFileSync(join(anaDir, 'resolutions.json'), '[]');
  writeFileSync(join(anaDir, 'candidates.json'), '[]');
  for (let i = 0; i < 2; i++) {
    const p = await cli(['review', 'publish', '--root', r.dir, '--context', ctxDir, '--analysis', anaDir], { cwd: r.dir, env: GH, fake, gitOps: r.gitOps });
    assert.equal(p.code, 0, p.stdout + p.stderr);
    assert.match(p.stdout, /already published/);
  }
  assert.equal(fake.issues.filter((i) => parseEscapeMarker(i.body) === r.head).length, 1, 'recorded once, deduplicated by its marker only');
});

test('round 2, 7 and 10: budget skips report the escapes they record; test skip notes are nonce-scoped', async () => {
  const r = fixRepo('max_input_tokens: 1\nskip_note: true\n');
  const fake = new FakeGitHub();
  const { ctxDir, context } = await prepare(r.dir, fake);
  assert.equal(context.skip_kind, 'budget');
  const publish = (/** @type {string[]} */ extra) => cli(['review', 'publish', '--root', r.dir, '--context', ctxDir, ...extra], { cwd: r.dir, env: GH, fake, gitOps: r.gitOps });
  const prod = await publish([]);
  assert.equal(prod.code, 0, prod.stdout + prod.stderr);
  assert.match(prod.stdout, /skipped by prepare \(.*\); no findings reviewed; escapes: 1 recorded, 0 credited, 0 over the cap; state unchanged/);
  assert.doesNotMatch(prod.stdout, /nothing published/);
  for (const nonce of ['n1', 'n2', 'n1']) assert.equal((await publish(['--test', '--nonce', nonce])).code, 0);
  const state = /** @type {any} */ (fake.issues.find((i) => i.labels.includes('square2-state')));
  const notes = state.comments.filter((/** @type {any} */ c) => c.body.includes('square2:skip:'));
  assert.equal(notes.length, 3, 'one production note plus one per test nonce');
  assert.equal(new Set(notes.map((/** @type {any} */ c) => c.body.split('\n')[0])).size, 3);
  assert.equal(fake.issues.filter((i) => i.labels.includes(ESCAPE_LABEL)).length, 1, 'test publications record no escapes');
});
