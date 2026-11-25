// v0.1.1 ship decision: escape records are experimental and off by default; commit trailers beyond
// the allow-listed ones never reach the context or a prompt.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { main } from '../src/cli/main.mjs';
import { parseConfig } from '../src/cli/config.mjs';
import { escapesEnabled } from '../src/cli/review-cmd.mjs';
import { ESCAPE_LABEL, escapeMarker } from '../src/issues/escape.mjs';
import { reviewConfig, stripTrailers } from '../src/review/prepare.mjs';
import { REDACTED } from '../src/review/render.mjs';
import { REPO, cleanupTemps, tempDir } from './cli-helpers.mjs';
import { FakeGitHub } from './issues/fake-github.mjs';

after(cleanupTemps);

const NOW = new Date('2026-11-20T08:00:00Z');
/** built at run time so no credential-shaped literal sits in the repository */
const TOKEN = ['gh', 'p_', 'A1b2C3d4'.repeat(5)].join('');
const GH = { GITHUB_TOKEN: 'tok', GITHUB_REPOSITORY: 'octo/demo', SQUARE2_TODAY: '2026-11-20' };

test('escapes.enabled: default false; unknown keys and non-booleans are config errors', () => {
  assert.deepEqual(parseConfig(null).config.escapes, { enabled: false });
  assert.deepEqual(parseConfig('branch: main\n').config.escapes, { enabled: false });
  assert.deepEqual(parseConfig('escapes:\n  enabled: true\n').config.escapes, { enabled: true });
  assert.deepEqual(parseConfig('escapes:\n  enabled: true\n').diagnostics, []);
  assert.deepEqual(parseConfig('escapes:\n  enable: true\n').diagnostics, ['[S2-CONFIG] .square2/config.yaml: unknown setting escapes.enable — Instead: use escapes.enabled']);
  assert.match(parseConfig('escapes:\n  enabled: yes please\n').diagnostics[0], /escapes\.enabled must be true or false/);
  assert.match(parseConfig('escapes: true\n').diagnostics[0], /escapes must be a mapping/);
  assert.equal(escapesEnabled({}), false);
  assert.equal(escapesEnabled({ escapes: { enabled: true } }), true);
  assert.equal(reviewConfig({ reviewer: 'openai/azure/m' }).config.escapes_enabled, false);
});

test('stripTrailers keeps subject and body, only allow-listed trailers, redacted', () => {
  const keep = ['Co-Authored-By', 'X-Writers', 'X-Change'];
  const m = `fix: crash\r\n\r\nBody line one.\r\nKey: value inside prose stays.\r\n\r\nCo-Authored-By: Claude <c@example.invalid>\r\nX-Writers: ${TOKEN}\r\nX-Change: Not_An_Id\r\nSigned-off-by: Dev <d@example.invalid>\r\nFixes-Commit: abcdef1\r\nX-Private: internal-ticket-77\r\n`;
  assert.equal(stripTrailers(m, keep, ['X-Change']), `fix: crash\n\nBody line one.\nKey: value inside prose stays.\n\nCo-Authored-By: Claude <c@example.invalid>\nX-Writers: ${REDACTED}`);
  assert.equal(stripTrailers('feat: x\n\nbody\n\nSigned-off-by: a\nX-Other: b', keep), 'feat: x\n\nbody', 'an emptied trailer paragraph goes');
  assert.equal(stripTrailers('feat: x\n\nNote: not a trailer block\nbecause this line is prose', keep), 'feat: x\n\nNote: not a trailer block\nbecause this line is prose');
  assert.equal(stripTrailers('feat: only a subject', keep), 'feat: only a subject');
  assert.equal(stripTrailers('fix: x\n\nFixes-Commit: abcdef1', ['Fixes-Commit']), 'fix: x\n\nFixes-Commit: abcdef1', 'kept only when listed');
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

/** A range with a fix commit that closes #1 and carries trailers that must not leak. @param {string} extra */
function repo(extra = '') {
  const dir = join(tempDir('square2-off-'), 'repo');
  mkdirSync(join(dir, 'src'), { recursive: true });
  mkdirSync(join(dir, '.square2'), { recursive: true });
  writeFileSync(join(dir, '.square2', 'config.yaml'), `branch: main\nlanguage: en\nreviewer: openai/azure/gpt-review\nreview:\n  author_trailers:\n    - Co-Authored-By\n    - X-Writers\n${extra}`);
  writeFileSync(join(dir, 'src', 'db.ts'), 'export const a = 1;\n');
  g(dir, ['init', '--quiet', '-b', 'main']);
  g(dir, ['add', '-A']);
  g(dir, ['commit', '--quiet', '-m', 'base'], '2026-11-18T00:00:00Z');
  writeFileSync(join(dir, 'src', 'db.ts'), 'export const a = 2;\n');
  g(dir, ['commit', '--quiet', '-am', `fix: column\n\nCloses #1\n\nX-Writers: codex\nX-Private: internal-ticket-77\nSigned-off-by: Dev <dev-signoff@example.invalid>\nFixes-Commit: abcdef1\nX-Token: ${TOKEN}`], '2026-11-20T06:00:00Z');
  const head = g(dir, ['rev-parse', 'HEAD']);
  const fakeDir = tempDir('square2-off-codex-');
  const bin = join(fakeDir, 'codex');
  copyFileSync(join(REPO, 'test', 'fixtures', 'fake-codex.mjs'), bin);
  spawnSync('chmod', ['+x', bin]);
  const gitOps = { liveHead: async () => head, isAncestor: async (/** @type {string} */ _r, /** @type {string} */ a, /** @type {string} */ b) => a === b };
  return { dir, head, bin, gitOps };
}

/** Every file prepare wrote, as one string. @param {string} ctxDir */
function written(ctxDir) {
  return readdirSync(ctxDir).filter((f) => f.endsWith('.json') || f.endsWith('.md')).map((f) => readFileSync(join(ctxDir, f), 'utf8')).join('\n');
}

test('escapes disabled by default: no detection, no context fields, no issues, no credit, no digest section', async () => {
  const r = repo();
  const fake = new FakeGitHub();
  const review = fake.seed({ title: 'r', labels: ['square2', 'square2:review'] });
  fake.seed({ title: 'escape: older', body: `${escapeMarker('9'.repeat(40))}\n`, labels: ['square2', ESCAPE_LABEL] });
  const ctxDir = join(tempDir('square2-off-ctx-'), 'square2-review');
  const p = await cli(['review', 'prepare', '--root', r.dir, '--branch', 'main', '--out', ctxDir], { cwd: r.dir, env: GH, fake });
  assert.equal(p.code, 0, p.stdout + p.stderr);
  const context = JSON.parse(readFileSync(join(ctxDir, 'context.json'), 'utf8'));
  assert.equal('escapes' in context, false, 'no escape data in context.json');
  const files = written(ctxDir);
  for (const leak of ['internal-ticket-77', 'dev-signoff', 'Fixes-Commit', 'X-Token', TOKEN.slice(4, 30)]) assert.ok(!files.includes(leak), `${leak} never reaches the context or a prompt`);
  assert.match(context.commits[0].message, /^fix: column\n\nCloses #1\n\nX-Writers: codex$/);
  assert.ok(readFileSync(join(ctxDir, context.prompt_suffix_file), 'utf8').includes('X-Writers: codex'), 'allow-listed trailers still reach the prompt');

  const anaDir = join(ctxDir, '..', 'square2-analysis');
  const run = await cli(['review', 'run', '--context', ctxDir, '--out', anaDir], { cwd: r.dir, env: { PATH: process.env.PATH, HOME: process.env.HOME, SQUARE2_CODEX_BIN: r.bin, SQ2_AZURE_OPENAI_ENDPOINT: 'https://example.invalid/', SQ2_AZURE_OPENAI_API_KEY: 'k' } });
  assert.equal(run.code, 0, run.stdout + run.stderr);
  const before = fake.issues.length;
  const pub = await cli(['review', 'publish', '--root', r.dir, '--context', ctxDir, '--analysis', anaDir], { cwd: r.dir, env: GH, fake, gitOps: r.gitOps });
  assert.equal(pub.code, 0, pub.stdout + pub.stderr);
  assert.doesNotMatch(pub.stdout, /escapes:/);
  assert.equal(fake.issues.filter((i) => i.labels.includes(ESCAPE_LABEL)).length, 1, 'no escape created');
  assert.equal(review.comments.length, 0, 'no credit');
  assert.equal(fake.issues.length, before + 1, 'only the state issue is new');
  const st = /** @type {any} */ (fake.issues.find((i) => i.labels.includes('square2-state')));
  const digest = st.comments.find((/** @type {any} */ c) => c.body.includes('square2:digest:'));
  assert.ok(digest, 'the digest is still posted (the run has a suggestion)');
  assert.doesNotMatch(digest.body, /Escapes awaiting classification/);
});

test('escapes disabled: a budget skip writes no escape data and publishes nothing', async () => {
  const r = repo('max_input_tokens: 1\n');
  const fake = new FakeGitHub();
  const ctxDir = join(tempDir('square2-off-skip-'), 'square2-review');
  assert.equal((await cli(['review', 'prepare', '--root', r.dir, '--branch', 'main', '--out', ctxDir], { cwd: r.dir, env: GH, fake })).code, 0);
  const text = readFileSync(join(ctxDir, 'context.json'), 'utf8');
  const context = JSON.parse(text);
  assert.equal(context.skip_kind, 'budget');
  assert.equal('escapes' in context, false);
  assert.ok(!text.includes('internal-ticket-77') && !text.includes('fix: column'));
  const pub = await cli(['review', 'publish', '--root', r.dir, '--context', ctxDir], { cwd: r.dir, env: GH, fake, gitOps: r.gitOps });
  assert.equal(pub.code, 0, pub.stdout + pub.stderr);
  assert.match(pub.stdout, /nothing published, state unchanged/);
  assert.equal(fake.issues.length, 0);
});

test('escapes enabled: the experimental records work as before', async () => {
  const r = repo('escapes:\n  enabled: true\nmax_input_tokens: 1\n');
  const fake = new FakeGitHub();
  const ctxDir = join(tempDir('square2-on-skip-'), 'square2-review');
  assert.equal((await cli(['review', 'prepare', '--root', r.dir, '--branch', 'main', '--out', ctxDir], { cwd: r.dir, env: GH, fake })).code, 0);
  const context = JSON.parse(readFileSync(join(ctxDir, 'context.json'), 'utf8'));
  assert.deepEqual(context.escapes.map((/** @type {any} */ e) => [e.fix_sha, e.introducing]), [[r.head, 'abcdef1']]);
  assert.deepEqual(context.escapes[0].trailers.map((/** @type {any} */ t) => t.key), ['X-Writers', 'Fixes-Commit']);
  const pub = await cli(['review', 'publish', '--root', r.dir, '--context', ctxDir], { cwd: r.dir, env: GH, fake, gitOps: r.gitOps });
  assert.equal(pub.code, 0, pub.stdout + pub.stderr);
  assert.match(pub.stdout, /escapes: 1 recorded/);
  assert.equal(existsSync(join(ctxDir, 'prompt.prefix.md')), false, 'skipped: no prompt written');
});
