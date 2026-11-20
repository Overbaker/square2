import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { main } from '../src/cli/main.mjs';
import { parseKey } from '../src/issues/publish.mjs';
import { parseState } from '../src/issues/state.mjs';
import { hasMention, parseTarget } from '../src/review/render.mjs';
import { codexArgs, extractTar, parseUsage, stripFence } from '../src/review/run.mjs';
import { inputId } from '../src/review/input-id.mjs';
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

/** Commits across two openspec change ids, including an add-then-revert pair. */
function reviewRepo() {
  const dir = join(tempDir('square2-e2e-'), 'repo');
  mkdirSync(join(dir, 'src'), { recursive: true });
  mkdirSync(join(dir, '.square2'), { recursive: true });
  writeFileSync(join(dir, '.square2', 'config.yaml'), 'branch: main\nreviewer: openai/azure/model-a\nnotify:\n  - alice\n  - bob\nlanguage: en\nreview_price:\n  input: 2\n  cached: 0.5\n  output: 8\n  currency: USD\n');
  writeFileSync(join(dir, '.square2', 'review-context.md'), 'Tenancy: every cached row belongs to one tenant.\n');
  writeFileSync(join(dir, 'src', 'db.ts'), 'export const tenantColumn = "tenant_id";\n');
  g(dir, ['init', '--quiet', '-b', 'main']);
  g(dir, ['add', '-A']);
  g(dir, ['commit', '--quiet', '-m', 'base'], '2026-11-18T00:00:00Z');
  const base = g(dir, ['rev-parse', 'HEAD']);
  writeFileSync(join(dir, 'src', 'cache.ts'), 'export const cacheKey = (id: string) => id;\n');
  g(dir, ['add', '-A']);
  g(dir, ['commit', '--quiet', '-m', 'feat: cache (openspec/changes/add-cache)\n\nCo-Authored-By: Claude Opus <noreply@example.invalid>'], '2026-11-20T05:00:00Z');
  writeFileSync(join(dir, 'src', 'tmp.ts'), 'export const scratch = 1;\n');
  g(dir, ['add', '-A']);
  g(dir, ['commit', '--quiet', '-m', 'wip scratch (openspec/changes/add-cache)'], '2026-11-20T05:30:00Z');
  g(dir, ['rm', '--quiet', 'src/tmp.ts']);
  g(dir, ['commit', '--quiet', '-m', 'revert scratch (openspec/changes/add-cache)'], '2026-11-20T05:40:00Z');
  writeFileSync(join(dir, 'src', 'db.ts'), 'export const tenantColumn = "tenant";\n');
  g(dir, ['commit', '--quiet', '-am', 'fix: column name (openspec/changes/fix-db)\n\nCo-Authored-By: Claude Opus <noreply@example.invalid>'], '2026-11-20T06:00:00Z');
  return { dir, base, head: g(dir, ['rev-parse', 'HEAD']) };
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

test('review end to end: prepare → run (fake codex) → validate → publish, idempotent', async () => {
  const { dir, base, head } = reviewRepo();
  const fake = new FakeGitHub({ repo: 'octo/demo', defaultBranch: 'main' });
  const gh = { GITHUB_TOKEN: 'tok', GITHUB_REPOSITORY: 'octo/demo' };
  const ctxDir = join(tempDir('square2-ctx-'), 'square2-review');

  const p = await cli(['review', 'prepare', '--root', dir, '--branch', 'main', '--out', ctxDir], { cwd: dir, env: gh, fake });
  assert.equal(p.code, 0, p.stdout + p.stderr);
  const context = JSON.parse(readFileSync(join(ctxDir, 'context.json'), 'utf8'));
  assert.deepEqual(context.range, { from_sha: base, to_sha: head, branch_or_pr: 'branch:main' });
  assert.equal(context.branch, 'main');
  assert.deepEqual(context.groups.map((/** @type {any} */ x) => x.id), ['change:add-cache', 'change:fix-db']);
  assert.deepEqual(Object.keys(context.changed_lines).sort(), ['src/cache.ts', 'src/db.ts'], 'the add+revert pair cancels in the range diff');
  assert.deepEqual(context.reviewer, { family: 'openai', provider: 'azure', model: 'model-a' });
  for (const f of [context.archive_file, context.prompt_prefix_file, context.prompt_suffix_file]) assert.ok(existsSync(join(ctxDir, f)), f);
  assert.match(context.input_id, /^[0-9a-f]{64}$/);

  const fakeDir = tempDir('square2-codex-');
  const bin = join(fakeDir, 'codex');
  copyFileSync(join(REPO, 'test', 'fixtures', 'fake-codex.mjs'), bin);
  spawnSync('chmod', ['+x', bin]);
  const llm = { PATH: process.env.PATH, HOME: process.env.HOME, SQ2_AZURE_OPENAI_ENDPOINT: 'https://example.invalid/', SQ2_AZURE_OPENAI_API_KEY: 'llm-key', SQUARE2_CODEX_BIN: bin, ACTIONS_ID_TOKEN_REQUEST_URL: 'https://x.invalid', OPENAI_API_KEY: 'other-key', NODE_OPTIONS: '--require /nope' };

  const refused = await cli(['review', 'run', '--context', ctxDir], { cwd: dir, env: { ...llm, GITHUB_TOKEN: 'tok' } });
  assert.equal(refused.code, 1);
  assert.match(refused.stdout, /^\[S2-REVIEW-CREDENTIALS\] /);
  assert.equal(existsSync(join(fakeDir, 'observed.jsonl')), false, 'codex never started with credentials present');

  const anaDir = join(ctxDir, '..', 'square2-analysis');
  const otherFamily = await cli(['review', 'run', '--context', ctxDir, '--out', anaDir, '--model', 'claude-x'], { cwd: dir, env: llm });
  assert.equal(otherFamily.code, 2);
  assert.match(otherFamily.stdout, /^\[S2-REVIEW-FAMILY\] model claude-x is in family anthropic, not the selected reviewer family openai/);
  const r = await cli(['review', 'run', '--context', ctxDir, '--out', anaDir, '--model', 'gpt-broken', '--fallback-model', 'gpt-fallback'], { cwd: dir, env: llm });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const observed = readFileSync(join(fakeDir, 'observed.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(observed.map((o) => o.model), ['gpt-broken', 'gpt-fallback'], 'one retry with the fallback model');
  for (const o of observed) {
    assert.equal(o.sandbox, 'read-only');
    assert.equal(o.cwd, o.tree);
    assert.notEqual(o.tree, dir);
    assert.equal(o.hasGit, false);
    assert.equal(o.writable, false, 'the extracted tree is read-only');
    assert.deepEqual(o.files, ['.square2/config.yaml', '.square2/review-context.md', 'src/cache.ts', 'src/db.ts'], 'the committed tree at to_sha, nothing else (no .git, no working-tree files)');
    assert.ok(o.stdinPrompt && o.promptHasRangeMarker);
    for (const flag of ['--skip-git-repo-check', '--json', '--ignore-user-config', '--ignore-rules', '--ephemeral']) assert.ok(o.args.includes(flag), flag);
    assert.ok(o.home && o.home === o.codexHome && o.home !== process.env.HOME, 'a fresh CODEX_HOME is also HOME');
    assert.deepEqual(o.configs, ['model_provider="sq2azure"', 'model_providers.sq2azure={ name = "sq2azure", base_url = "https://example.invalid/openai/v1", env_key = "SQ2_AZURE_OPENAI_API_KEY", wire_api = "responses" }']);
    assert.ok(o.envKeys.includes('SQ2_AZURE_OPENAI_API_KEY') && o.envKeys.includes('SQ2_AZURE_OPENAI_ENDPOINT'));
    assert.deepEqual(o.envKeys.filter((/** @type {string} */ k) => /^(GITHUB_|GH_|ACTIONS_)|NODE_OPTIONS|^OPENAI_API_KEY$|^SQUARE2_/.test(k)), []);
    assert.equal(existsSync(o.tree), false, 'the temporary tree is removed after the run');
  }
  const usage = JSON.parse(readFileSync(join(anaDir, 'usage.json'), 'utf8'));
  assert.equal(usage.model_used, 'gpt-fallback');
  assert.deepEqual(usage.attempts, [{ model: 'gpt-broken', exit_code: 3 }, { model: 'gpt-fallback', exit_code: 0 }]);
  assert.deepEqual(usage.usage, { input: 1200, cached: 1000, output: 300 });
  assert.deepEqual(readdirSync(anaDir).sort(), ['candidates.json', 'resolutions.json', 'result.json', 'usage.json'], 'the analysis artifact holds exactly four files');
  assert.ok(readFileSync(join(ctxDir, 'prompt.md'), 'utf8').startsWith(readFileSync(join(ctxDir, context.prompt_prefix_file), 'utf8')));
  writeFileSync(join(anaDir, 'review.json'), '{"published": [{"path": "src/evil.ts"}]}', 'utf8');

  const v = await cli(['review', 'validate', '--root', dir, '--context', ctxDir, '--analysis', anaDir, '--out', join(ctxDir, 'review.json')], { cwd: dir, env: {} });
  assert.equal(v.code, 0, v.stdout);
  assert.match(v.stdout, /review validate: ok, 1 finding\(s\), demoted: 1/);
  const review = JSON.parse(readFileSync(join(ctxDir, 'review.json'), 'utf8'));
  assert.deepEqual(review.published.map((/** @type {any} */ f) => f.path), ['src/cache.ts']);
  assert.deepEqual(review.demoted.map((/** @type {any} */ f) => f.path), ['src/tmp.ts'], 'the reverted file is no finding target');
  assert.deepEqual(review.usage, usage.usage);
  assert.equal(review.model, 'gpt-fallback');
  assert.equal(review.input_id, inputId({ ...context.range, policy_digest: context.policy_digest, reviewer_family: 'openai', model: 'gpt-fallback' }), 'input_id names the model actually used');

  const fresh = { liveHead: async () => head, isAncestor: async (/** @type {string} */ _r, /** @type {string} */ a, /** @type {string} */ b) => a === b };
  const pub = await cli(['review', 'publish', '--root', dir, '--context', ctxDir, '--analysis', anaDir], { cwd: dir, env: { ...gh, SQUARE2_TODAY: '2026-11-20' }, fake, gitOps: fresh });
  assert.equal(pub.code, 0, pub.stdout + pub.stderr);
  const issues = fake.issues.filter((i) => i.labels.includes('square2:review'));
  assert.equal(issues.length, 1);
  const [issue] = issues;
  assert.equal(issue.title, 'Cache key ignores the tenant');
  assert.deepEqual(issue.labels.sort(), ['sev:major', 'square2', 'square2:review']);
  assert.equal(parseKey(issue.body), review.published[0].key);
  assert.equal(parseTarget(issue.body)?.path, 'src/cache.ts');
  assert.ok(issue.body.includes('src/db.ts:1 tenant column'), 'cross-file evidence kept');
  assert.equal(hasMention(issue.body), false);
  const state = fake.issues.find((i) => i.labels.includes('square2-state'));
  assert.ok(state);
  const digests = state.comments.filter((c) => c.body.includes('square2:digest:'));
  assert.equal(digests.length, 1);
  assert.match(digests[0].body, /@alice @bob/);
  assert.match(digests[0].body, /\| created \| \[#\d+\]/);
  assert.match(digests[0].body, /demoted \(outside changed lines\): 1/);
  assert.match(digests[0].body, /estimated cost 0\.0033 USD/);
  assert.match(digests[0].body, /consider a cache metrics counter/);
  const st = parseState(state.body);
  assert.equal(st.last_reviewed_sha, head);
  assert.ok(st.published_input_ids.includes(review.input_id));
  assert.ok(!fake.issues.some((i) => i.body.includes('src/evil.ts')), 'publish ignores files other than the four analysis files');

  const before = JSON.stringify(fake.snapshot());
  const again = await cli(['review', 'publish', '--root', dir, '--context', ctxDir, '--analysis', anaDir], { cwd: dir, env: { ...gh, SQUARE2_TODAY: '2026-11-20' }, fake, gitOps: fresh });
  assert.equal(again.code, 0);
  assert.match(again.stdout, /already published/);
  assert.equal(JSON.stringify(fake.snapshot()), before, 'no new issues or comments on a re-run');

  const next = await cli(['review', 'prepare', '--root', dir, '--branch', 'main', '--out', join(ctxDir, '..', 'next')], { cwd: dir, env: gh, fake });
  assert.equal(next.code, 0);
  assert.match(next.stdout, /nothing new since the last review/);
  const quiet = await cli(['review', 'run', '--context', join(ctxDir, '..', 'next'), '--out', join(ctxDir, '..', 'next-analysis')], { cwd: dir, env: llm });
  assert.equal(quiet.code, 0);
  assert.match(quiet.stdout, /no model call/);
  assert.equal(readFileSync(join(fakeDir, 'observed.jsonl'), 'utf8').trim().split('\n').length, 2, 'no model call for an empty range or a refused family');
});

test('review run: both models failing exits 2; missing LLM settings exit 2', async () => {
  const { dir } = reviewRepo();
  const ctxDir = join(tempDir('square2-ctx2-'), 'ctx');
  assert.equal((await cli(['review', 'prepare', '--root', dir, '--branch', 'main', '--out', ctxDir], { cwd: dir, env: {} })).code, 0);
  const fakeDir = tempDir('square2-codex2-');
  const bin = join(fakeDir, 'codex');
  copyFileSync(join(REPO, 'test', 'fixtures', 'fake-codex.mjs'), bin);
  spawnSync('chmod', ['+x', bin]);
  const env = { PATH: process.env.PATH, SQ2_AZURE_OPENAI_ENDPOINT: 'https://example.invalid', SQ2_AZURE_OPENAI_API_KEY: 'k', SQUARE2_CODEX_BIN: bin };
  const both = await cli(['review', 'run', '--context', ctxDir, '--model', 'gpt-broken', '--fallback-model', 'gpt-broken'], { cwd: dir, env });
  assert.equal(both.code, 2);
  assert.match(both.stdout, /^\[S2-REVIEW-MODEL\] the model step failed \(gpt-broken: exit 3\)/);
  const noKey = await cli(['review', 'run', '--context', ctxDir], { cwd: dir, env: { PATH: process.env.PATH } });
  assert.equal(noKey.code, 2);
  assert.match(noKey.stdout, /SQ2_AZURE_OPENAI_ENDPOINT and SQ2_AZURE_OPENAI_API_KEY must be set/);
  const missingBin = await cli(['review', 'run', '--context', ctxDir], { cwd: dir, env: { ...env, SQUARE2_CODEX_BIN: join(fakeDir, 'nope') } });
  assert.equal(missingBin.code, 2);
  assert.match(missingBin.stdout, /^\[S2-REVIEW-MODEL\] cannot run .*nope: not found — Instead: install the codex CLI/);
  const help = await cli(['review', 'run', '--help'], { cwd: dir, env: {} });
  assert.equal(help.code, 0);
  assert.match(help.stdout, /^Usage: square2 review run/);
});

test('run helpers: codex args, usage parsing, fence stripping, safe tar extraction', () => {
  const a = codexArgs({ model: 'm', endpoint: 'https://e.invalid///', tree: '/t', outFile: '/o' });
  assert.ok(a.includes('--sandbox') && a[a.indexOf('--sandbox') + 1] === 'read-only');
  assert.equal(a.at(-1), '-');
  assert.ok(a.some((x) => x.includes('base_url = "https://e.invalid/openai/v1"')));
  assert.deepEqual(parseUsage('noise\n{"type":"turn.completed","usage":{"input_tokens":5,"cached_input_tokens":2,"output_tokens":1}}\n{"type":"turn.completed","usage":{"input_tokens":3,"output_tokens":4}}\n'), { input: 8, cached: 2, output: 5 });
  assert.equal(parseUsage('{"type":"x"}\n'), null);
  assert.equal(stripFence('```json\n{"a":1}\n```\n'), '{"a":1}');
  assert.equal(stripFence('  {"a":1}  '), '{"a":1}');

  const dir = join(tempDir('square2-tar-'), 'repo');
  mkdirSync(join(dir, 'a'), { recursive: true });
  writeFileSync(join(dir, 'a', `${'long-name-'.repeat(12)}.txt`), 'long\n');
  writeFileSync(join(dir, 'ü.txt'), 'u\n');
  g(dir, ['init', '--quiet']);
  g(dir, ['add', '-A']);
  g(dir, ['commit', '--quiet', '-m', 'x']);
  const tar = join(tempDir('square2-tarout-'), 't.tar');
  g(dir, ['archive', '--format=tar', `--output=${tar}`, 'HEAD']);
  const dest = join(tempDir('square2-tarx-'), 'x');
  const res = extractTar(tar, dest);
  assert.equal(res.files, 2);
  assert.equal(readFileSync(join(dest, 'a', `${'long-name-'.repeat(12)}.txt`), 'utf8'), 'long\n');
  assert.equal(readFileSync(join(dest, 'ü.txt'), 'utf8'), 'u\n');
  const evil = Buffer.alloc(1536);
  evil.write('../escape.txt', 0);
  evil.write('0000644\0', 100);
  evil.write('00000000004\0', 124);
  evil[156] = 0x30;
  evil.write('evil', 512);
  const evilTar = join(tempDir('square2-evil-'), 'e.tar');
  writeFileSync(evilTar, evil);
  assert.throws(() => extractTar(evilTar, join(tempDir('square2-evx-'), 'x')), /unsafe path/);
});
