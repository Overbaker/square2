// Phase 2 final fix pass: items 1–12, one regression test each.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { main } from '../src/cli/main.mjs';
import { runRules } from '../src/cli/engines.mjs';
import { candidatesFrom, mergeCalls } from '../src/cli/review-cmd.mjs';
import { adapter as patternAdapter, PATTERN_TIMEOUTS } from '../src/engines/pattern.mjs';
import * as diffModule from '../src/git/diff.mjs';
import { changedLinesFromJSON, changedLinesToJSON, shownLines } from '../src/git/changed-lines.mjs';
import { createGitHub } from '../src/issues/github.mjs';
import { publish, reviewItems } from '../src/issues/publish.mjs';
import { parseState, StateIssue } from '../src/issues/state.mjs';
import { parseCandidate } from '../src/review/candidate.mjs';
import * as prepareModule from '../src/review/prepare.mjs';
import { fenceFor } from '../src/review/prompt.mjs';
import { digestMarker, escapeMd, findingMarker, looksSecret, MAX_DIGEST, parseTarget, renderDigest, renderGateIssue, renderReviewIssue, SecretError, targetMarker } from '../src/review/render.mjs';
import { leaksKey } from '../src/review/run.mjs';
import { findingKey, validateReview } from '../src/review/validate.mjs';
import { copyMiniRepo, cleanupTemps, tempDir } from './cli-helpers.mjs';
import { FakeGitHub } from './issues/fake-github.mjs';

after(cleanupTemps);

const NOW = new Date('2026-11-20T08:00:00Z');
const SHA = (/** @type {string} */ c) => c.repeat(40);
const gh = (/** @type {FakeGitHub} */ fake) => createGitHub({ token: 't', repo: fake.repo, fetch: fake.fetch });

/** @param {string} cwd @param {string[]} args @param {string} [date] */
function g(cwd, args, date = '2026-11-20T05:00:00Z') {
  const res = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
  if (res.status !== 0) throw new Error(`git ${args.join(' ')}: ${res.stderr}`);
  return res.stdout.trim();
}

/** @param {string} dir @param {string} msg @param {Record<string, string>} files */
function commit(dir, msg, files, date) {
  for (const [p, content] of Object.entries(files)) {
    mkdirSync(join(dir, p, '..'), { recursive: true });
    writeFileSync(join(dir, p), content);
  }
  g(dir, ['add', '-A']);
  g(dir, ['commit', '--quiet', '--allow-empty', '-m', msg], date);
  return g(dir, ['rev-parse', 'HEAD']);
}

function repo(config = 'branch: main\nreviewer: openai/azure/model-a\nlanguage: en\n') {
  const dir = join(tempDir('square2-final-'), 'repo');
  mkdirSync(join(dir, '.square2'), { recursive: true });
  writeFileSync(join(dir, '.square2', 'config.yaml'), config);
  g(dir, ['init', '--quiet', '-b', 'main']);
  const base = commit(dir, 'base', { 'README.md': 'base\n' }, '2026-11-18T00:00:00Z');
  return { dir, base };
}

/** @param {string[]} args @param {{ cwd: string, env?: Record<string, string | undefined>, fake?: FakeGitHub, gitOps?: any }} o */
async function cli(args, o) {
  let stdout = '';
  let stderr = '';
  const code = await main(args, { cwd: o.cwd, env: { GITHUB_REPOSITORY: o.fake?.repo, SQUARE2_TODAY: '2026-11-20', ...(o.env ?? {}) }, stdout: (t) => { stdout += t; }, stderr: (t) => { stderr += t; }, fetch: o.fake?.fetch, gitOps: o.gitOps, now: NOW });
  return { code, stdout, stderr };
}

const stage = (/** @type {string} */ status) => ({ status, summary: 's', evidence: status === 'pass' ? ['e'] : [] });
/** @param {any} f */
const finding = (f = {}) => ({ severity: 'Minor', path: 'src/a.ts', line: 1, side: 'RIGHT', title: 'Race on retry', failure_case: 'two retries interleave', suggestion: 'lock', enclosing_symbol: 'retry', mechanizable: false, ...f });
/** @param {string[]} ids @param {Record<string, any[]>} [findings] */
const result = (ids, findings = {}, extra = {}) => JSON.stringify({ language: 'en', groups: ids.map((id) => ({ id, requirement: stage('pass'), approach: stage('pass'), code: { status: (findings[id] ?? []).length ? 'needs_changes' : 'pass', summary: 's', findings: findings[id] ?? [] } })), questions: [], suggestions: [], ...extra });

function analysis(/** @type {string} */ dir, /** @type {string} */ res, usage = {}) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'result.json'), res);
  writeFileSync(join(dir, 'resolutions.json'), '[]\n');
  writeFileSync(join(dir, 'candidates.json'), '[]\n');
  writeFileSync(join(dir, 'usage.json'), JSON.stringify({ model_used: 'model-a', attempts: [], usage: null, ...usage }));
  return dir;
}

// ---------- 1. normalised secret checks ----------

test('1: secret and key-leak checks see through NFKC, zero-width/format/control characters and separators, everywhere', () => {
  const ghp = 'ghp_' + 'a1B2c3D4'.repeat(5);
  const bypasses = [
    ghp.slice(0, 2) + '​' + ghp.slice(2),
    ghp.split('').join('‍'),
    ghp.replace('_', '­_'),
    '﻿' + ghp.slice(0, 10) + '⁠' + ghp.slice(10),
    ghp.normalize('NFKC').replace(/[A-Za-z0-9_]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0)),
    'AKIA' + '‌' + 'ABCDEFGHIJKLMNOP',
    'sk-' + 'x'.repeat(12) + ' ' + 'y'.repeat(12),
    `api_key = "${'k'.repeat(12)}‎${'k'.repeat(14)}"`,
    `the to​ken is ${'0123456789abcdef'.repeat(2)}`,
    'xox' + 'b-' + '1234567890-abc'.replace(/(.)/g, '$1\u0007'),
  ];
  for (const b of bypasses) {
    assert.equal(looksSecret(b), true, JSON.stringify(b));
    assert.throws(() => escapeMd(`see ${b}`), SecretError);
  }
  const key = 'abcd1234efgh5678ijkl';
  for (const t of [key.split('').join('​'), key.replace(/[a-z0-9]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0)), `${key.slice(0, 5)}­-\n${key.slice(5)}`]) assert.equal(leaksKey(t, key), true, JSON.stringify(t));
  assert.equal(looksSecret('an ordinary sentence with a trace id 9e107d9d372bb6826bd81d3542a419d6'), false);
  for (const prose of ['the password: must be rotated regularly by the operators', 'the token: is not configured anywhere in this file', 'see the skip-list and the gh_pages branch']) assert.equal(looksSecret(prose), false, prose);

  const ctx = { language: /** @type {const} */ ('en'), range: { from_sha: null, to_sha: SHA('a') } };
  for (const field of ['title', 'failure_case', 'suggestion', 'body']) {
    assert.throws(() => renderReviewIssue({ ...finding(), [field]: `x ${bypasses[0]}` }, ctx), SecretError, field);
  }
  assert.throws(() => renderReviewIssue({ ...finding(), evidence: [bypasses[4]] }, ctx), SecretError);
  const d = renderDigest({ inputId: 'i', kind: 'review', branch: 'main', sha: SHA('a'), changes: [], notify: [], extras: { questions: [`q ${bypasses[1]}`, 'fine question'], suggestions: [`s ${bypasses[2]}`], notes: [{ severity: 'Minor', path: 'src/a.ts', line: 1, title: `n ${bypasses[3]}` }] } });
  assert.ok(d.includes('fine question'));
  assert.doesNotMatch(d, /a1B2c3D4|\ba1/, 'secret-shaped questions, suggestions and notes are dropped');
  const yaml = `rules:\n  - id: S2-C-X\n    dune_rule: 2\n    engine: pattern\n    scope: src/**\n    instead: x ${bypasses[4]}\n    owner: o\n    enabled: false\n    born_from: ${SHA('b')}\n    options:\n      pattern: X\n`;
  const cand = parseCandidate(JSON.stringify({ rule_yaml: yaml, fixtures: { bad: [{ path: 'src/a.ts', content: 'X\n' }], good: [] } }), { bornFrom: SHA('b'), existingIds: [] });
  assert.equal(cand.ok, false, 'candidate YAML');
  const fix = parseCandidate(JSON.stringify({ rule_yaml: yaml.replace(` ${bypasses[4]}`, ''), fixtures: { bad: [{ path: 'src/a.ts', content: `X ${bypasses[0]}\n` }], good: [] } }), { bornFrom: SHA('b'), existingIds: [] });
  assert.equal(fix.ok, false, 'candidate fixtures');
});

test('1: gate pattern matches and rule messages that look secret are redacted in gate issues', async () => {
  const root = tempDir('square2-final-gate-');
  writeFileSync(join(root, 'cfg.ts'), `const t = "${'ghp_' + 'Z'.repeat(36)}";\n`);
  const rule = { id: 'S2-NO-TOKEN', engine: 'pattern', scope: ['**'], exclude: [], options: { pattern: 'gh[p]_[A-Za-z0-9]+' }, enabled: true };
  const res = await patternAdapter.run(/** @type {any} */ ({ root, repoRoot: root, mode: 'repo', rules: [rule], config: {}, excludes: [], files: async () => ['cfg.ts'], warn: () => {} }));
  assert.equal(res.violations.length, 1);
  assert.match(res.violations[0].subject, /^<redacted [0-9a-f]{12}>$/);
  assert.equal(res.violations[0].message, 'matches <redacted>');
  const issue = renderGateIssue({ rule_id: 'S2-NO-TOKEN', path: 'cfg.ts', line: 1, message: `found ${'ghp_' + 'Q'.repeat(18)}​${'Q'.repeat(18)}`, fingerprint: 'f'.repeat(64) }, { sha: SHA('a') });
  assert.doesNotMatch(issue.body + issue.title, /QQQQ/);
  assert.ok(issue.body.includes('`<redacted>`') && issue.title.includes('<redacted>'));
});

// ---------- 2. pattern timeouts: per (rule, file) budget, unknown result ----------

test('2: a rule that times out on any file is unknown for the run; healthy rules keep their results; unknown rules never auto-close and fail replay', async () => {
  const root = tempDir('square2-final-pat-');
  writeFileSync(join(root, 'a.txt'), 'zzz\n');
  writeFileSync(join(root, 'slow.txt'), `zzz\n${'a'.repeat(48)}!\n`);
  writeFileSync(join(root, 'b.txt'), 'zzz\naac\n');
  const rule = (/** @type {string} */ id, /** @type {string} */ pattern) => /** @type {any} */ ({ id, engine: 'pattern', scope: ['**'], exclude: [], options: { pattern }, enabled: true });
  const saved = { ...PATTERN_TIMEOUTS };
  PATTERN_TIMEOUTS.perFileMs = 300;
  try {
    const run = await runRules({ root, repoRoot: root, mode: 'repo', rules: [rule('S2-SLOW', '(?:a|aa)*c'), rule('S2-FAST', 'zzz')], config: /** @type {any} */ ({}), excludes: [] });
    assert.deepEqual(run.unknown, ['S2-SLOW']);
    assert.deepEqual(run.violations.map((v) => `${v.rule_id} ${v.path}`), ['S2-FAST a.txt', 'S2-FAST b.txt', 'S2-FAST slow.txt'], 'the slow rule reports nothing (not even its a.txt-free match on b.txt); the fast rule everything');
    assert.deepEqual(run.errors, []);
    assert.ok(run.warnings.some((w) => w.startsWith('[S2-PATTERN-TIMEOUT] rule S2-SLOW')));
    const strict = await runRules({ root, repoRoot: root, mode: 'repo', rules: [rule('S2-SLOW', '(?:a|aa)*c')], config: /** @type {any} */ ({}), excludes: [], failOnUnknown: true });
    assert.match(strict.errors[0], /^\[S2-PATTERN-TIMEOUT\] result unknown for S2-SLOW/, 'replay runs with failOnUnknown');
    // a quadratic pattern calibrated to ~150 ms per file: eight files exceed one budget in total, none alone does
    let n = 2000;
    for (;;) {
      const t = Date.now();
      /b*c/.test('b'.repeat(n));
      if (Date.now() - t >= 150 || n > 400_000) break;
      n = Math.ceil(n * 1.5);
    }
    PATTERN_TIMEOUTS.perFileMs = 1000;
    const many = Array.from({ length: 8 }, (_, i) => `f${i}.txt`);
    for (const f of many) writeFileSync(join(root, f), 'b'.repeat(n));
    const t0 = Date.now();
    const pooled = await runRules({ root, repoRoot: root, mode: 'repo', rules: [rule('S2-B', 'b*c')], config: /** @type {any} */ ({}), excludes: [] });
    assert.deepEqual(pooled.unknown, [], `each (rule, file) has its own budget, no shared pool (${Date.now() - t0} ms in total)`);
  } finally {
    Object.assign(PATTERN_TIMEOUTS, saved);
  }

  const dir = copyMiniRepo();
  writeFileSync(join(dir, '.square2', 'config.yaml'), readFileSync(join(dir, '.square2', 'config.yaml'), 'utf8') + 'branch: dev\n');
  const fake = new FakeGitHub();
  const mk = (/** @type {string} */ k, /** @type {string} */ rid) => fake.seed({ title: rid, body: `${findingMarker(k)}\n<!-- square2:rule:${rid} -->\n`, labels: ['square2', 'square2:gate'] });
  const lanes = mk('1'.repeat(64), 'S2-ROUTE-LANES');
  const lint = mk('2'.repeat(64), 'S2-LINT-NO-CONSOLE');
  const stats = { hits: 0, new: 0, baselined: 0, excepted: 0, expired: 0 };
  const rep = join(dir, 'square2-report.json');
  writeFileSync(rep, JSON.stringify({ schema_version: 1, head_sha: SHA('a'), catalogue_digest: 'c'.repeat(64), exit_code: 0, rules: { 'S2-ROUTE-LANES': { ...stats, unknown: true }, 'S2-LINT-NO-CONSOLE': stats }, new_violations: [], observed: [], excepted: [], expired_exceptions: [] }));
  const r = await cli(['publish-gate', '--root', dir, '--report', rep, '--branch', 'dev'], { cwd: dir, fake, env: { GITHUB_TOKEN: 't' } });
  assert.equal(r.code, 0, r.stdout);
  assert.equal(lanes.state, 'open', 'an unknown rule\'s issue is never auto-closed');
  assert.equal(lint.state, 'closed', 'a healthy rule\'s resolved issue closes');

  const born = SHA('b');
  const yaml = `rules:\n  - id: S2-C-T\n    dune_rule: 2\n    engine: pattern\n    scope: src/**\n    instead: x\n    owner: o\n    enabled: false\n    born_from: ${born}\n    options:\n      pattern: T\n`;
  const out = await candidatesFrom({
    context: { candidate_prompts: [{ issue: { number: 1, key: 'k', born_from: born, title: 't', failure_case: 'f', path: 'src/a.ts', line: 1, enclosing_symbol: '<file>' }, file: 'c.md' }] },
    analysis: /** @type {any} */ ({ candidates: [{ issue: 1, answer: JSON.stringify({ rule_yaml: yaml, fixtures: { bad: [{ path: 'src/a.ts', content: 'T\n' }], good: [] } }) }] }),
    repo: /** @type {any} */ ({ root: '/x', dir: '/x', config: {}, catalogue: { rules: [] } }),
    replay: async () => { throw new Error('[S2-PATTERN-TIMEOUT] result unknown for S2-C-T (pattern timeout) — Instead: x'); },
  });
  assert.deepEqual(out.dropped, { 'pattern timeout': 1 });
});

// ---------- 3. autolinks ----------

test('3: every autolink form is neutralised regardless of what precedes it', () => {
  const s = escapeMd('xhttps://evil.example/a (https://e.example) x.www.evil.example WWW.Evil.example mail me@evil.example mailto:a@b.example ftp://f.example');
  assert.doesNotMatch(s, /:\/\/(?!‍)/, 'a zero-width joiner after every scheme separator');
  assert.doesNotMatch(s, /www(?!‍)\./i, 'and after every www');
  assert.doesNotMatch(s, /@(?!‍)/, 'e-mail autolinks broken at the at sign');
  assert.ok(s.includes('xhttps://‍evil') && s.includes('x.www‍.evil') && s.includes('WWW‍.Evil'));
});

// ---------- 4. digest size ----------

test('4: digest items are capped at 1000 characters and 20 in total; the digest stays under 60000 with a note', () => {
  const long = 'word '.repeat(2000);
  const d = renderDigest({ inputId: 'i', kind: 'review', branch: 'main', sha: SHA('a'), changes: [], notify: ['alice'], extras: { questions: Array.from({ length: 10 }, (_, i) => `q${i} ${long}`), suggestions: Array.from({ length: 10 }, (_, i) => `s${i} ${long}`), notes: Array.from({ length: 10 }, (_, i) => ({ severity: 'Minor', path: 'src/a.ts', line: i + 1, title: `n${i} ${long}` })) } });
  const items = d.split('\n').filter((l) => l.startsWith('- '));
  assert.equal(items.length, 20);
  assert.ok(items.every((l) => l.length < 1100), 'each item capped');
  assert.match(d, /\(10 more questions, suggestions or notes not shown\)/);
  const changes = Array.from({ length: 3000 }, (_, i) => ({ action: /** @type {const} */ ('created'), number: i + 1, url: `https://github.invalid/o/r/issues/${i + 1}`, title: `finding number ${i} with a long title to fill the table`, label: 'Minor', commit: SHA('a') }));
  const big = renderDigest({ inputId: 'i', kind: 'review', branch: 'main', sha: SHA('a'), changes, notify: ['alice'], extras: {} });
  assert.ok(big.length < MAX_DIGEST, `${big.length}`);
  assert.match(big, /digest truncated/);
  assert.ok(big.startsWith(digestMarker('i')));
  assert.match(big, /@alice\n$/, 'notify mentions survive the truncation');
});

// ---------- 5. rename re-keying ----------

test('5: a finding on a renamed file updates the retargeted issue and re-keys it instead of opening a new one', async () => {
  const fake = new FakeGitHub();
  const oldKey = findingKey({ path: 'src/old.ts', enclosing_symbol: 'retry', title: 'Race on retry' });
  const seeded = fake.seed({ title: 'Race on retry', labels: ['square2', 'square2:review', 'sev:minor'], body: `${findingMarker(oldKey)}\n${targetMarker({ path: 'src/old.ts', line: 3, enclosing_symbol: 'retry', title: 'Race on retry', commit: SHA('c') })}\n\nbody\n` });
  const review = { range: { from_sha: SHA('1'), to_sha: SHA('2') }, language: 'en', published: [{ ...finding({ path: 'src/new.ts', line: 4 }), key: findingKey({ path: 'src/new.ts', enclosing_symbol: 'retry', title: 'Race on retry' }), group: 'g', commit: SHA('2'), born_from: SHA('2') }] };
  const run = async (/** @type {string} */ inputId) => publish({ gh: gh(fake), state: new StateIssue(gh(fake)), run: { kind: 'review', inputId, branch: 'main', sha: SHA('2') }, items: reviewItems(review), notify: [], retarget: [{ key: oldKey, path: 'src/new.ts' }] });
  const res = await run('run-1');
  assert.equal(fake.issues.filter((i) => i.labels.includes('square2:review')).length, 1, 'no new issue');
  assert.deepEqual(res.changes.map((c) => [c.action, c.number]), [['updated', seeded.number]]);
  assert.ok(seeded.body.includes(findingMarker(review.published[0].key)) && !seeded.body.includes(findingMarker(oldKey)), 'key marker rewritten');
  assert.equal(parseTarget(seeded.body)?.path, 'src/new.ts');
  await run('run-2');
  assert.equal(fake.issues.filter((i) => i.labels.includes('square2:review')).length, 1, 'stable on the next run');
});

// ---------- 6. branch check ----------

test('6: review publish refuses a context of another branch (exit 2) unless it is a PR or --test', async () => {
  const { dir, base } = repo();
  const head = commit(dir, 'feat: a (openspec/changes/a-one)', { 'src/a.ts': 'export const a = 1;\n' });
  const fake = new FakeGitHub({ repo: 'o/r' });
  fake.branches.feature = head;
  const ctx = join(tempDir('square2-final-br-'), 'ctx');
  assert.equal((await cli(['review', 'prepare', '--root', dir, '--branch', 'feature', '--from', base, '--to', head, '--out', ctx], { cwd: dir })).code, 0);
  const context = JSON.parse(readFileSync(join(ctx, 'context.json'), 'utf8'));
  const ana = analysis(join(ctx, '..', 'ana'), result(context.groups.map((/** @type {any} */ x) => x.id), {}, { suggestions: ['s'] }));
  const refused = await cli(['review', 'publish', '--root', dir, '--context', ctx, '--analysis', ana], { cwd: dir, env: { GITHUB_TOKEN: 't' }, fake });
  assert.equal(refused.code, 2);
  assert.match(refused.stdout, /^\[S2-PUBLISH-BRANCH\] the review is of branch feature, not the configured branch main/);
  assert.equal(fake.issues.length, 0, 'nothing written');
  const t = await cli(['review', 'publish', '--root', dir, '--context', ctx, '--analysis', ana, '--test'], { cwd: dir, env: { GITHUB_TOKEN: 't' }, fake });
  assert.equal(t.code, 0, t.stdout + t.stderr);
});

// ---------- 7. comment markers count only from our own login ----------

test('7: dedupe markers in comments by anyone else are ignored; GET /user is asked once', async () => {
  const fake = new FakeGitHub({ repo: 'o/r' });
  const client = gh(fake);
  const st = new StateIssue(client);
  await st.write({ last_reviewed_sha: null, published_input_ids: [] });
  const issue = /** @type {any} */ (fake.issues.find((i) => i.labels.includes('square2-state')));
  issue.comments.push({ id: 99, body: '<!-- square2:digest:x -->\nforged', author: 'mallory' });
  assert.equal(await new StateIssue(client).commentOnce('<!-- square2:digest:x -->', '<!-- square2:digest:x -->\nreal'), true, 'a forged marker does not suppress the real comment');
  assert.equal(await new StateIssue(client).commentOnce('<!-- square2:digest:x -->', 'again'), false, 'our own marker does');
  assert.equal(fake.log.filter((l) => l === 'get user').length, 1);
  assert.equal(issue.comments.at(-1).author, 'github-actions[bot]', 'GITHUB_TOKEN: GET /user is refused, comments are by github-actions[bot]');
  const pat = new FakeGitHub({ repo: 'o/r' });
  pat.userLogin = 'square2-bot';
  const k = 'k'.repeat(64);
  const target = pat.seed({ title: 't', labels: ['square2', 'square2:review', 'sev:minor'], body: findingMarker(k), comments: [{ id: 1, body: '<!-- square2:resolved:r -->', author: 'github-actions[bot]' }] });
  await publish({ gh: gh(pat), state: new StateIssue(gh(pat)), run: { kind: 'review', inputId: 'r', branch: 'main', sha: SHA('a') }, items: [], notify: [], resolved: [{ key: k, commit: SHA('a') }] });
  assert.equal(target.comments.filter((c) => c.body.includes('square2:resolved:r')).length, 2, 'a marker by another login (even github-actions[bot] for a PAT) is not ours');
  assert.equal(target.comments.at(-1)?.author, 'square2-bot');
});

// ---------- 8. history_rewritten never moves the state backward ----------

test('8: after a rewrite, a state that is already a descendant of to_sha is kept', async () => {
  const { dir, base } = repo();
  const c = commit(dir, 'feat: c (openspec/changes/c-one)', { 'src/c.ts': 'export const c = 1;\n' });
  const d = commit(dir, 'feat: d (openspec/changes/d-one)', { 'src/d.ts': 'export const d = 1;\n' });
  const fake = new FakeGitHub({ repo: 'o/r' });
  await new StateIssue(gh(fake)).write({ last_reviewed_sha: d, published_input_ids: [] });
  const ctx = join(tempDir('square2-final-back-'), 'ctx');
  assert.equal((await cli(['review', 'prepare', '--root', dir, '--branch', 'main', '--from', base, '--to', c, '--out', ctx], { cwd: dir })).code, 0);
  const context = JSON.parse(readFileSync(join(ctx, 'context.json'), 'utf8'));
  writeFileSync(join(ctx, 'context.json'), JSON.stringify({ ...context, explicit_range: false, history_rewritten: true }));
  const ana = analysis(join(ctx, '..', 'ana'), result(context.groups.map((/** @type {any} */ x) => x.id), {}, { suggestions: ['s'] }));
  const local = { liveHead: async () => d, isAncestor: async (/** @type {string} */ r, /** @type {string} */ a, /** @type {string} */ b) => spawnSync('git', ['merge-base', '--is-ancestor', a, b], { cwd: r }).status === 0 };
  const pub = await cli(['review', 'publish', '--root', dir, '--context', ctx, '--analysis', ana], { cwd: dir, env: { GITHUB_TOKEN: 't' }, fake, gitOps: local });
  assert.equal(pub.code, 0, pub.stdout + pub.stderr);
  const st = parseState(/** @type {any} */ (fake.issues.find((i) => i.labels.includes('square2-state'))).body);
  assert.equal(st.last_reviewed_sha, d, 'not moved back to to_sha');
  assert.equal(st.published_input_ids.length, 1);
});

// ---------- 9. same_family over calls ----------

test('9: calls mode records each call\'s family; same_family when any call is outside the selected family or an author family', async () => {
  const sha = (/** @type {number} */ i) => `${i}`.repeat(40);
  const diff = (/** @type {string} */ p) => `diff --git a/${p} b/${p}\n--- a/${p}\n+++ b/${p}\n@@ -1,0 +1,3 @@\n+x\n+y\n+z\n`;
  const groups = [0, 1].map((i) => ({ id: `change:g${i}`, commits: [sha(i)], paths: [`src/f${i}.ts`] }));
  const context = {
    range: { from_sha: SHA('a'), to_sha: SHA('b'), branch_or_pr: 'branch:main' }, policy_digest: 'd'.repeat(64), reviewer: { family: 'openai', model: 'model-a' }, author_families: ['anthropic'], groups, changed_lines: {},
    calls: groups.map((gr, i) => ({ id: `call-${i + 1}`, group: gr.id, commits: [sha(i)], shown_files: gr.paths, changed_lines: { [sha(i)]: changedLinesToJSON(shownLines(diff(`src/f${i}.ts`))) } })),
  };
  const validate = async (/** @type {any} */ o) => validateReview(o.output, { groups: o.context.groups, changedLines: new Map(), commitLines: new Map(Object.entries(o.context.commit_lines).map(([k, v]) => [k, changedLinesFromJSON(/** @type {any} */ (v))])), commits: o.context.call_commits });
  const an = (/** @type {string[]} */ models) => /** @type {any} */ ({ results: context.calls.map((c, i) => ({ call: c.id, result: result([groups[i].id]) })), usage: { model_used: models[0], calls: context.calls.map((c, i) => ({ call: c.id, model_used: models[i], attempts: [] })) } });
  const m = /** @type {any} */ (await mergeCalls({ context, analysis: an(['model-a', 'claude-x']), validate, repo: /** @type {any} */ ({}), calls: context.calls, allowSameFamily: true }));
  assert.ok(m.ok, JSON.stringify(m));
  assert.deepEqual(m.res.call_families, [{ call: 'call-1', model: 'model-a', family: 'openai' }, { call: 'call-2', model: 'claude-x', family: 'anthropic' }]);

  // end to end through validate: the second call's family makes the run same-family
  const { dir } = repo();
  const big = (/** @type {string} */ tag) => Array.from({ length: 150 }, (_, i) => `export const ${tag}${i} = ${i};`).join('\n') + '\n';
  const from = g(dir, ['rev-parse', 'HEAD']);
  commit(dir, 'feat: one (openspec/changes/g-one)', { 'src/one.ts': big('one') });
  const to = commit(dir, 'feat: two (openspec/changes/g-two)', { 'src/two.ts': big('two') });
  const probe = join(tempDir('square2-final-sf-'), 'probe');
  assert.equal((await cli(['review', 'prepare', '--root', dir, '--branch', 'main', '--from', from, '--to', to, '--out', probe], { cwd: dir })).code, 0);
  const total = JSON.parse(readFileSync(join(probe, 'context.json'), 'utf8')).estimated_tokens.total;
  writeFileSync(join(dir, '.square2', 'config.yaml'), readFileSync(join(dir, '.square2', 'config.yaml'), 'utf8') + `max_input_tokens: ${total - 1}\n`);
  const ctx = join(probe, '..', 'ctx');
  assert.equal((await cli(['review', 'prepare', '--root', dir, '--branch', 'main', '--from', from, '--to', to, '--out', ctx], { cwd: dir })).code, 0);
  const c2 = JSON.parse(readFileSync(join(ctx, 'context.json'), 'utf8'));
  assert.equal(c2.calls.length, 2);
  const ana = join(ctx, '..', 'ana');
  mkdirSync(ana, { recursive: true });
  for (const c of c2.calls) writeFileSync(join(ana, `result.${c.id}.json`), result([c.group]));
  writeFileSync(join(ana, 'resolutions.json'), '[]');
  writeFileSync(join(ana, 'candidates.json'), '[]');
  writeFileSync(join(ana, 'usage.json'), JSON.stringify({ model_used: 'model-a', attempts: [], calls: [{ call: 'call-1', model_used: 'model-a', attempts: [] }, { call: 'call-2', model_used: 'claude-x', attempts: [] }], usage: null }));
  const v = await cli(['review', 'validate', '--root', dir, '--context', ctx, '--analysis', ana, '--allow-same-family', '--out', join(ctx, 'review.json')], { cwd: dir });
  assert.equal(v.code, 0, v.stdout);
  const review = JSON.parse(readFileSync(join(ctx, 'review.json'), 'utf8'));
  assert.equal(review.same_family, true, 'any call in another family');
  assert.deepEqual(review.call_families.map((/** @type {any} */ f) => f.family), ['openai', 'anthropic']);
  writeFileSync(join(ana, 'usage.json'), JSON.stringify({ model_used: 'model-a', attempts: [], calls: [{ call: 'call-1', model_used: 'model-a', attempts: [] }, { call: 'call-2', model_used: 'model-a', attempts: [] }], usage: null }));
  assert.equal((await cli(['review', 'validate', '--root', dir, '--context', ctx, '--analysis', ana, '--out', join(ctx, 'review.json')], { cwd: dir })).code, 0);
  assert.equal(JSON.parse(readFileSync(join(ctx, 'review.json'), 'utf8')).same_family, false);
});

// ---------- 10. fenceFor ----------

test('10: fenceFor handles any number of backtick runs (no argument-spread limit)', () => {
  const text = '`'.repeat(7) + ' a`'.repeat(600_000);
  assert.equal(fenceFor(text), '`'.repeat(8));
  assert.equal(fenceFor('no ticks'), '```');
});

// ---------- 11. nothing fits: a clean skip ----------

test('11: when no call fits even trimmed, prepare writes skip: true; run and publish are clean no-ops', async () => {
  const { dir, base } = repo('branch: main\nreviewer: openai/azure/model-a\nlanguage: en\nmax_input_tokens: 50\nskip_note: true\n');
  const head = commit(dir, 'feat: a (openspec/changes/a-one)', { 'src/a.ts': 'export const a = 1;\n' });
  const fake = new FakeGitHub({ repo: 'o/r' });
  fake.branches.main = head;
  const ctx = join(tempDir('square2-final-skip-'), 'ctx');
  assert.equal((await cli(['review', 'prepare', '--root', dir, '--branch', 'main', '--from', base, '--to', head, '--out', ctx], { cwd: dir })).code, 0);
  const context = JSON.parse(readFileSync(join(ctx, 'context.json'), 'utf8'));
  assert.equal(context.skip, true);
  assert.equal(context.skip_kind, 'budget');
  assert.match(context.reason, /no group fits the input budget/);
  const r = await cli(['review', 'run', '--context', ctx, '--out', join(ctx, '..', 'ana')], { cwd: dir, env: { PATH: process.env.PATH } });
  assert.equal(r.code, 0, r.stdout);
  assert.match(r.stdout, /skipped .*no model call/);
  for (const sub of ['validate', 'publish']) {
    const p = await cli(['review', sub, '--root', dir, '--context', ctx, '--analysis', join(ctx, '..', 'missing')], { cwd: dir, env: { GITHUB_TOKEN: 't' }, fake });
    assert.equal(p.code, 0, p.stdout);
    assert.match(p.stdout, /skipped by prepare/);
  }
  const st = /** @type {any} */ (fake.issues.find((i) => i.labels.includes('square2-state')));
  assert.equal(parseState(st.body).last_reviewed_sha, null, 'state unchanged');
  assert.equal(st.comments.length, 1, 'skip_note configured: one note');
  await cli(['review', 'publish', '--root', dir, '--context', ctx], { cwd: dir, env: { GITHUB_TOKEN: 't' }, fake });
  assert.equal(st.comments.length, 1, 'idempotent');
  assert.equal(fake.issues.length, 1, 'no finding issues');
});

// ---------- 12. unused helpers removed ----------

test('12: fileStats and remergeDiff are gone', () => {
  assert.equal(/** @type {any} */ (prepareModule).fileStats, undefined);
  assert.equal(/** @type {any} */ (diffModule).remergeDiff, undefined);
});
