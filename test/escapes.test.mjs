import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import fc from 'fast-check';
import { main } from '../src/cli/main.mjs';
import { createGitHub } from '../src/issues/github.mjs';
import { ESCAPE_LABEL, contextEscapes, detectEscapes, isFixCommit, parseEscapeMarker, publishEscapes } from '../src/issues/escape.mjs';
import { authorFamilies, selectReviewer } from '../src/review/family.mjs';
import { changeIdOf, groupCommits } from '../src/review/group.mjs';
import { reviewConfig } from '../src/review/prepare.mjs';
import { hasMention, renderDigest } from '../src/review/render.mjs';
import { REPO, cleanupTemps, tempDir } from './cli-helpers.mjs';
import { FakeGitHub } from './issues/fake-github.mjs';

after(cleanupTemps);

const NOW = new Date('2026-11-20T08:00:00Z');
const TRAILERS = ['Co-Authored-By', 'X-Writers'];

/** @param {string} subject @param {[string, string][]} trailers */
const msg = (subject, trailers) => (trailers.length === 0 ? subject : `${subject}\n\n${trailers.map(([k, v]) => `${k}: ${v}`).join('\n')}`);

test('P1: author families are the union over every configured trailer', () => {
  const writer = fc.constantFrom(['Claude Opus <noreply@example.invalid>', 'anthropic'], ['codex', 'openai'], ['GPT-5', 'openai'], ['Gemini', 'google'], ['agy', 'google'], ['antigravity', 'google'], ['Some Human <h@example.invalid>', null]);
  const key = fc.constantFrom('Co-Authored-By', 'co-authored-by', 'X-Writers', 'x-writers', 'X-Other', 'Signed-off-by');
  fc.assert(fc.property(fc.array(fc.array(fc.tuple(key, writer), { maxLength: 5 }), { minLength: 1, maxLength: 4 }), (commits) => {
    const messages = commits.map((ts) => ({ message: msg('feat: x', ts.map(([k, [v]]) => [k, v])) }));
    const want = new Set();
    for (const ts of commits) for (const [k, [, fam]] of ts) if (fam && TRAILERS.some((t) => t.toLowerCase() === k.toLowerCase())) want.add(fam);
    assert.deepEqual(authorFamilies(messages, undefined, TRAILERS), [...want].sort());
    const one = commits.flatMap((ts) => ts.map(([k, [v]]) => ({ message: msg('feat: y', [[k, v]]) })));
    const union = new Set(one.flatMap((c) => authorFamilies([c], undefined, TRAILERS)));
    assert.deepEqual(authorFamilies(messages, undefined, TRAILERS), [...union].sort());
  }), { numRuns: 200 });
  fc.assert(fc.property(fc.array(fc.tuple(key, writer), { maxLength: 4 }), (rest) => {
    const m = msg('feat: z', [...rest.map(([k, [v]]) => /** @type {[string, string]} */ ([k, v])), ['X-Writers', 'codex']]);
    assert.ok(authorFamilies([{ message: m }], undefined, TRAILERS).includes('openai'));
  }), { numRuns: 100 });
});

test('P1 scenario: codex-written code committed by Claude', () => {
  const commit = { message: msg('feat: planner', [['Co-Authored-By', 'Claude Opus <noreply@example.invalid>'], ['X-Writers', 'codex']]) };
  const fams = authorFamilies([commit], undefined, TRAILERS);
  assert.deepEqual(fams, ['anthropic', 'openai']);
  assert.deepEqual(authorFamilies([commit]), ['anthropic'], 'default: Co-Authored-By only');
  assert.deepEqual(authorFamilies([{ message: msg('x', [['X-Writers', 'codex, gemini']]) }], undefined, TRAILERS), ['google', 'openai']);
  const openaiOnly = selectReviewer([{ family: 'openai', model: 'a' }], fams);
  assert.equal(openaiOnly.sameFamily, true);
  const withGoogle = selectReviewer([{ family: 'openai', model: 'a' }, { family: 'google', model: 'g' }], fams);
  assert.deepEqual(withGoogle, { reviewer: { family: 'google', model: 'g' }, sameFamily: false });
});

test('P2: a change-id trailer decides the group even without openspec paths', () => {
  const id = fc.stringMatching(/^[a-z][a-z0-9]{0,6}(-[a-z0-9]{1,6}){0,2}$/);
  const commit = fc.record({
    change: fc.option(id, { nil: undefined }),
    paths: fc.array(fc.constantFrom('apps/a.ts', 'src/b.ts', 'openspec/changes/other-change/tasks.md', 'docs/c.md'), { minLength: 1, maxLength: 3 }),
    subject: fc.constantFrom('feat: a', 'fix: b', 'work on change some-thing', 'chore'),
  });
  fc.assert(fc.property(fc.array(commit, { minLength: 1, maxLength: 6 }), (cs) => {
    const commits = cs.map((c, i) => ({ sha: `${i}`.padStart(40, '0'), parents: [], author: 't', date: '', message: msg(c.subject, c.change ? [['X-Change', c.change]] : []), paths: c.paths }));
    const groups = groupCommits({ commits, merges: new Map(), riskPaths: [], changeIdTrailers: ['X-Change'] });
    const plain = groupCommits({ commits, merges: new Map(), riskPaths: [] });
    commits.forEach((c, i) => {
      const g = groups.find((x) => x.commits.includes(c.sha));
      const change = cs[i].change;
      if (change) assert.equal(g?.id, `change:${change}`);
      else assert.equal(g?.id, plain.find((x) => x.commits.includes(c.sha))?.id, 'without a trailer the grouping is unchanged');
    });
  }), { numRuns: 200 });
});

test('P2 scenario: a code-only commit joins its change group', () => {
  const commit = { message: msg('feat: endpoint', [['X-Change', 'add-cache']]), paths: ['apps/api/x.ts'] };
  assert.equal(changeIdOf(commit, undefined, ['X-Change']), 'add-cache');
  assert.equal(changeIdOf(commit), null, 'not configured: no trailer grouping');
  const [g] = groupCommits({ commits: [{ sha: 'a'.repeat(40), parents: [], author: 't', date: '', ...commit }], merges: new Map(), riskPaths: [], changeIdTrailers: ['x-change'] });
  assert.equal(g.id, 'change:add-cache');
  assert.equal(g.kind, 'change');
});

test('review config: review.author_trailers and review.change_id_trailers', () => {
  const base = { reviewer: 'openai/azure/m' };
  const d = reviewConfig(base);
  assert.deepEqual(d.errors, []);
  assert.deepEqual(d.config.author_trailers, ['Co-Authored-By']);
  assert.deepEqual(d.config.change_id_trailers, []);
  const c = reviewConfig({ ...base, review: { author_trailers: ['Co-Authored-By', 'X-Writers'], change_id_trailers: ['X-Change'] } });
  assert.deepEqual(c.errors, []);
  assert.deepEqual(c.config.author_trailers, ['Co-Authored-By', 'X-Writers']);
  assert.deepEqual(c.config.change_id_trailers, ['X-Change']);
  assert.deepEqual(reviewConfig({ ...base, review: { author_trailers: ['bad key'] } }).errors, ['review.author_trailers must be a list of trailer keys']);
  assert.match(reviewConfig({ ...base, review: ['x'] }).errors[0], /^review must be a mapping/);
});

test('escape detection: subject patterns, Fixes-Commit, merges and excluded paths', () => {
  for (const s of ['fix: a', 'fix(planner): a', 'Fix a thing', 'hotfix: b', 'Revert "feat: x"', 'revert: y', 'feat: guard against regression', 'chore: hotfix bump']) assert.equal(isFixCommit(s), true, s);
  for (const s of ['feat: fixture loader', 'prefix: a', 'docs: fixes list', 'feat: reverted-state flag']) assert.equal(isFixCommit(s), false, s);
  assert.equal(isFixCommit(msg('feat: a', [['Fixes-Commit', '6f7737e']])), true);
  const sha = (/** @type {string} */ c) => c.repeat(40);
  const escapes = detectEscapes({
    excludes: ['**/package-lock.json'],
    trailers: ['X-Change', 'X-Writers'],
    commits: [
      { sha: sha('a'), parents: [sha('0')], message: msg('fix(planner): wrong order\n\nCloses #42 and see #7, fixes #42.', [['Fixes-Commit', '6F7737E'], ['X-Change', 'c-1'], ['X-Writers', 'codex'], ['Signed-off-by', 'x']]), paths: ['src/b.ts', 'src/a.ts'] },
      { sha: sha('b'), parents: [sha('a'), sha('9')], message: 'fix: merge', paths: ['src/a.ts'] },
      { sha: sha('c'), parents: [sha('a')], message: 'fix: lockfile', paths: ['package-lock.json'] },
      { sha: sha('d'), parents: [sha('c')], message: 'feat: new', paths: ['src/c.ts'] },
      { sha: sha('e'), parents: [sha('d')], message: 'hotfix: urgent', paths: ['src/c.ts', 'package-lock.json'] },
    ],
  });
  assert.deepEqual(escapes.map((e) => e.fix_sha), [sha('a'), sha('e')]);
  assert.equal(escapes[0].introducing, '6f7737e');
  assert.deepEqual(escapes[0].files, ['src/a.ts', 'src/b.ts']);
  assert.deepEqual(escapes[0].refs, [42], 'closing references only, deduplicated');
  assert.deepEqual(escapes[0].trailers.map((t) => t.key), ['Fixes-Commit', 'X-Change', 'X-Writers']);
  assert.equal(escapes[1].introducing, 'unknown');
  assert.deepEqual(escapes[1].files, ['src/c.ts']);
  assert.deepEqual(contextEscapes(JSON.parse(JSON.stringify({ escapes: [...escapes, { fix_sha: 'nope' }, null] })), ['X-Change', 'X-Writers']), escapes);
});

/** @param {FakeGitHub} fake */
const client = (fake) => createGitHub({ token: 't', repo: fake.repo, fetch: fake.fetch });
const hex = fc.stringMatching(/^[0-9a-f]{40}$/);
/** @param {string} s @param {number[]} [refs] */
const esc = (s, refs = []) => ({ fix_sha: s, subject: `fix: ${s.slice(0, 6)}`, introducing: 'unknown', files: ['src/a.ts'], trailers: [], refs });

test('P3: at most one escape issue per fix sha, however often the publisher runs', async () => {
  await fc.assert(fc.asyncProperty(fc.array(hex, { minLength: 1, maxLength: 5 }), fc.integer({ min: 1, max: 4 }), fc.boolean(), async (shas, runs, closeFirst) => {
    const fake = new FakeGitHub({ pageSize: 2 });
    const gh = client(fake);
    const escapes = [...shas, ...shas.slice(0, 2)].map((s) => esc(s));
    for (let i = 0; i < runs; i++) {
      await publishEscapes({ gh, escapes, inputId: `run-${i}`, cap: 100 });
      if (closeFirst && i === 0) for (const issue of fake.issues) issue.state = 'closed';
    }
    const recorded = fake.issues.filter((i) => i.labels.includes(ESCAPE_LABEL)).map((i) => parseEscapeMarker(i.body));
    assert.deepEqual([...recorded].sort(), [...new Set(shas)].sort());
    for (const i of fake.issues) assert.deepEqual(i.labels, ['square2', ESCAPE_LABEL], 'square² never sets a layer label');
  }), { numRuns: 40 });
});

test('P4: a fix referencing a gate or review issue credits it and never creates an escape', async () => {
  const labelSet = fc.constantFrom(['square2', 'square2:gate'], ['square2', 'square2:review', 'sev:major'], ['square2', 'square2:escape'], ['square2', 'square2:rule-candidate'], ['square2'], ['square2-state']);
  await fc.assert(fc.asyncProperty(fc.array(labelSet, { minLength: 1, maxLength: 5 }), fc.array(fc.integer({ min: 1, max: 7 }), { maxLength: 4 }), hex, async (sets, refs, sha) => {
    const fake = new FakeGitHub({ pageSize: 2 });
    for (const [i, labels] of sets.entries()) fake.seed({ title: `issue ${i}`, labels, state: i % 2 === 0 ? 'open' : 'closed' });
    const gh = client(fake);
    const caught = refs.filter((n) => { const l = fake.issue(n)?.labels ?? []; return l.includes('square2:gate') || l.includes('square2:review'); });
    for (let run = 0; run < 2; run++) await publishEscapes({ gh, escapes: [esc(sha, refs)], inputId: `run-${run}`, cap: 100 });
    const created = fake.issues.filter((i) => parseEscapeMarker(i.body) === sha);
    assert.equal(created.length, caught.length > 0 ? 0 : 1);
    for (const n of new Set(caught)) {
      const credits = /** @type {any} */ (fake.issue(n)).comments.filter((/** @type {any} */ c) => c.body.includes(`<!-- square2:credited:${sha} -->`));
      assert.equal(credits.length, 1, 'one credit comment, also on a re-run');
      assert.match(credits[0].body, new RegExp(`credited: fixed by ${sha}`));
    }
    for (const i of fake.issues) if (!caught.includes(i.number)) assert.ok(!i.comments.some((c) => c.body.includes('square2:credited')));
  }), { numRuns: 60 });
});

test('digest: escapes awaiting classification', async () => {
  const fake = new FakeGitHub();
  const gh = client(fake);
  const shas = ['1'.repeat(40), '2'.repeat(40), '3'.repeat(40)];
  await publishEscapes({ gh, escapes: shas.map((s) => esc(s)), inputId: 'r1', cap: 10 });
  fake.issues[2].labels.push('layer:tests');
  const r = await publishEscapes({ gh, escapes: [], inputId: 'r2', cap: 10 });
  assert.deepEqual(r.unclassified.map((i) => i.number), [1, 2]);
  const body = renderDigest({ inputId: 'x', kind: 'review', branch: 'main', sha: 'a'.repeat(40), changes: [], notify: [], extras: { escapes: r.unclassified.map((i) => ({ number: i.number, url: i.html_url, title: i.title })) } });
  assert.match(body, /\*\*Escapes awaiting classification\*\*\n- \[#1\]\(https:\/\/github\.invalid\/octo\/demo\/issues\/1\) escape: fix: 111111\n- \[#2\]/);
  assert.ok(!body.includes('#3'));
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

test('P5 and end to end: prepare detects escapes without a model call; publish records and credits them once', async () => {
  const dir = join(tempDir('square2-esc-'), 'repo');
  mkdirSync(join(dir, 'src'), { recursive: true });
  mkdirSync(join(dir, 'apps'), { recursive: true });
  mkdirSync(join(dir, '.square2'), { recursive: true });
  writeFileSync(join(dir, '.square2', 'config.yaml'), 'branch: main\nreviewer: openai/azure/model-a\nlanguage: en\nescapes:\n  enabled: true\nreview:\n  author_trailers:\n    - Co-Authored-By\n    - X-Writers\n  change_id_trailers:\n    - X-Change\n');
  writeFileSync(join(dir, 'src', 'db.ts'), 'export const a = 1;\n');
  g(dir, ['init', '--quiet', '-b', 'main']);
  g(dir, ['add', '-A']);
  g(dir, ['commit', '--quiet', '-m', 'base'], '2026-11-18T00:00:00Z');
  writeFileSync(join(dir, 'apps', 'planner.ts'), 'export const plan = 1;\n');
  g(dir, ['add', '-A']);
  g(dir, ['commit', '--quiet', '-m', msg('feat: planner', [['Co-Authored-By', 'Claude Opus <noreply@example.invalid>'], ['X-Writers', 'codex'], ['X-Change', 'add-planner']])], '2026-11-20T05:00:00Z');
  const intro = g(dir, ['rev-parse', 'HEAD']);
  writeFileSync(join(dir, 'apps', 'planner.ts'), 'export const plan = 2;\n');
  g(dir, ['commit', '--quiet', '-am', msg('fix(planner): off by one', [['Fixes-Commit', intro.slice(0, 7)], ['X-Change', 'add-planner']])], '2026-11-20T06:00:00Z');
  const fix1 = g(dir, ['rev-parse', 'HEAD']);
  writeFileSync(join(dir, 'src', 'db.ts'), 'export const a = 2;\n');
  g(dir, ['commit', '--quiet', '-am', 'fix: column\n\nCloses #1'], '2026-11-20T06:30:00Z');
  const fix2 = g(dir, ['rev-parse', 'HEAD']);

  const fake = new FakeGitHub({ repo: 'octo/demo', defaultBranch: 'main' });
  fake.seed({ title: 'Column is wrong', labels: ['square2', 'square2:review', 'sev:minor'] });
  const fakeDir = tempDir('square2-codex-esc-');
  const bin = join(fakeDir, 'codex');
  copyFileSync(join(REPO, 'test', 'fixtures', 'fake-codex.mjs'), bin);
  spawnSync('chmod', ['+x', bin]);
  const gh = { GITHUB_TOKEN: 'tok', GITHUB_REPOSITORY: 'octo/demo', SQUARE2_CODEX_BIN: bin, SQ2_AZURE_OPENAI_ENDPOINT: 'https://example.invalid/', SQ2_AZURE_OPENAI_API_KEY: 'k' };
  const ctxDir = join(tempDir('square2-esc-ctx-'), 'square2-review');
  const p = await cli(['review', 'prepare', '--root', dir, '--branch', 'main', '--out', ctxDir], { cwd: dir, env: gh, fake });
  assert.equal(p.code, 0, p.stdout + p.stderr);
  assert.equal(existsSync(join(fakeDir, 'observed.jsonl')), false, 'P5: prepare never starts the model');
  const context = JSON.parse(readFileSync(join(ctxDir, 'context.json'), 'utf8'));
  assert.deepEqual(context.author_families, ['anthropic', 'openai']);
  assert.equal(context.same_family, true);
  assert.deepEqual(context.groups.map((/** @type {any} */ x) => x.id), ['change:add-planner', `commit:${fix2}`]);
  assert.deepEqual(context.escapes.map((/** @type {any} */ e) => [e.fix_sha, e.introducing, e.refs]), [[fix1, intro.slice(0, 7), []], [fix2, 'unknown', [1]]]);

  const anaDir = join(ctxDir, '..', 'square2-analysis');
  const r = await cli(['review', 'run', '--context', ctxDir, '--out', anaDir], { cwd: dir, env: { PATH: process.env.PATH, HOME: process.env.HOME, SQUARE2_CODEX_BIN: bin, SQ2_AZURE_OPENAI_ENDPOINT: 'https://example.invalid/', SQ2_AZURE_OPENAI_API_KEY: 'k' } });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const head = fix2;
  const fresh = { liveHead: async () => head, isAncestor: async (/** @type {string} */ _r, /** @type {string} */ a, /** @type {string} */ b) => a === b };
  for (let i = 0; i < 2; i++) {
    const pub = await cli(['review', 'publish', '--root', dir, '--context', ctxDir, '--analysis', anaDir], { cwd: dir, env: { ...gh, SQUARE2_TODAY: '2026-11-20' }, fake, gitOps: fresh });
    assert.equal(pub.code, 0, pub.stdout + pub.stderr);
  }
  const escapes = fake.issues.filter((i) => i.labels.includes(ESCAPE_LABEL));
  assert.equal(escapes.length, 1, 'one escape for the uncredited fix, none for the credited one, no duplicate on the re-run');
  const [e] = escapes;
  assert.equal(parseEscapeMarker(e.body), fix1);
  assert.match(e.body, new RegExp(`- introducing: \`${intro.slice(0, 7)}\``));
  assert.match(e.body, /- layer: unclassified/);
  assert.match(e.body, /apps\/planner\.ts/);
  assert.match(e.body, /X-Change: add-planner/);
  assert.equal(hasMention(e.body), false);
  const credited = /** @type {any} */ (fake.issue(1)).comments.filter((/** @type {any} */ c) => c.body.includes('square2:credited'));
  assert.equal(credited.length, 1);
  assert.match(credited[0].body, new RegExp(`credited: fixed by ${fix2}`));
  const state = fake.issues.find((i) => i.labels.includes('square2-state'));
  const digests = state?.comments.filter((c) => c.body.includes('square2:digest:')) ?? [];
  assert.equal(digests.length, 1);
  assert.match(digests[0].body, new RegExp(`Escapes awaiting classification\\*\\*\\n- \\[#${e.number}\\]`));
});

test('pre-push hook: a checkout without tools/square2 exits 0 with one notice', () => {
  const hook = join(REPO, 'templates', 'consumer', '.githooks', 'pre-push');
  const dir = join(tempDir('square2-nohook-'), 'repo');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'a.txt'), 'a\n');
  g(dir, ['init', '--quiet', '-b', 'main']);
  g(dir, ['add', '-A']);
  g(dir, ['commit', '--quiet', '-m', 'old tree']);
  const sha = g(dir, ['rev-parse', 'HEAD']);
  const res = spawnSync('sh', [hook, 'origin', 'https://example.invalid/r.git'], { cwd: dir, input: `refs/heads/main ${sha} refs/heads/main ${'0'.repeat(40)}\n`, encoding: 'utf8' });
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.equal(res.stderr, 'square² not present in this checkout; skipping\n');
  assert.equal(res.stdout, '');
});
