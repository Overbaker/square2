// Phase 2 fix round 2: design changes A–E and fixes 1–11, one regression test each.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { main } from '../src/cli/main.mjs';
import { blameCommit, candidatesFrom, mergeCalls, reviewTargets } from '../src/cli/review-cmd.mjs';
import { adapter as patternAdapter, PATTERN_TIMEOUTS } from '../src/engines/pattern.mjs';
import { changedLinesFromJSON, changedLinesToJSON, shownLines } from '../src/git/changed-lines.mjs';
import { diffSections } from '../src/git/diff.mjs';
import { createGitHub } from '../src/issues/github.mjs';
import { parseState, StateIssue } from '../src/issues/state.mjs';
import { findingMarker, looksSecret, parseTarget, renderCandidateComment, renderDigest, renderReviewIssue, targetMarker } from '../src/review/render.mjs';
import { leaksKey } from '../src/review/run.mjs';
import { prepareReview, reviewConfig, trimOrder } from '../src/review/prepare.mjs';
import { validateReview } from '../src/review/validate.mjs';
import { REPO, cleanupTemps, tempDir } from './cli-helpers.mjs';
import { FakeGitHub } from './issues/fake-github.mjs';

after(cleanupTemps);

const NOW = new Date('2026-11-20T08:00:00Z');

/** @param {string} cwd @param {string[]} args @param {string} [date] */
function g(cwd, args, date = '2026-11-20T05:00:00Z') {
  const env = { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
  const res = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', env });
  if (res.status !== 0) throw new Error(`git ${args.join(' ')}: ${res.stderr}`);
  return res.stdout.trim();
}

/** @param {string} dir @param {string} msg @param {Record<string, string | null>} files */
function commit(dir, msg, files, date) {
  for (const [p, content] of Object.entries(files)) {
    if (content === null) g(dir, ['rm', '--quiet', p]);
    else {
      mkdirSync(join(dir, p, '..'), { recursive: true });
      writeFileSync(join(dir, p), content);
    }
  }
  g(dir, ['add', '-A']);
  g(dir, ['commit', '--quiet', '--allow-empty', '-m', msg], date);
  return g(dir, ['rev-parse', 'HEAD']);
}

/** @param {string} [config] */
function repo(config = 'branch: main\nreviewer: openai/azure/model-a\nlanguage: en\n') {
  const dir = join(tempDir('square2-f2-'), 'repo');
  mkdirSync(join(dir, '.square2'), { recursive: true });
  writeFileSync(join(dir, '.square2', 'config.yaml'), config);
  g(dir, ['init', '--quiet', '-b', 'main']);
  const base = commit(dir, 'base', { 'README.md': 'base\n' }, '2026-11-18T00:00:00Z');
  return { dir, base };
}

/** @returns {import('../src/review/policy-digest.mjs').Policy} */
function policy() {
  return { template: readFileSync(join(REPO, 'prompts', 'review.staged.md'), 'utf8'), schema: readFileSync(join(REPO, 'schemas', 'review.v1.json'), 'utf8'), reviewContext: '', enforcedRules: [], triagePatterns: [], version: '0.1.0' };
}

const lines = (/** @type {number} */ n, /** @type {string} */ tag) => Array.from({ length: n }, (_, i) => `export const ${tag}${i} = ${i};`).join('\n') + '\n';

/** @param {string[]} args @param {{ cwd: string, env?: Record<string, string | undefined>, fake?: FakeGitHub, gitOps?: any, replay?: any }} o */
async function cli(args, o) {
  let stdout = '';
  let stderr = '';
  const code = await main(args, { cwd: o.cwd, env: { GITHUB_REPOSITORY: o.fake?.repo, ...(o.env ?? {}) }, stdout: (t) => { stdout += t; }, stderr: (t) => { stderr += t; }, fetch: o.fake?.fetch, gitOps: o.gitOps, replay: o.replay, now: NOW });
  return { code, stdout, stderr };
}

const stage = (/** @type {string} */ status) => ({ status, summary: 's', evidence: status === 'pass' ? ['e'] : [] });
/** @param {any} f */
const finding = (f = {}) => ({ severity: 'Minor', path: 'src/a.ts', line: 1, side: 'RIGHT', title: 'Race on retry', failure_case: 'two retries interleave', suggestion: 'lock', enclosing_symbol: 'retry', mechanizable: true, ...f });
/** @param {string[]} ids @param {Record<string, any[]>} [findings] */
const result = (ids, findings = {}, extra = {}) => JSON.stringify({ language: 'en', groups: ids.map((id) => ({ id, requirement: stage('pass'), approach: stage('pass'), code: { status: (findings[id] ?? []).length ? 'needs_changes' : 'pass', summary: 's', findings: findings[id] ?? [] } })), questions: [], suggestions: [], ...extra });

/** Write a single-call analysis artifact next to a context. */
function analysis(/** @type {string} */ dir, /** @type {string} */ res, usage = {}) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'result.json'), res);
  writeFileSync(join(dir, 'resolutions.json'), '[]\n');
  writeFileSync(join(dir, 'candidates.json'), '[]\n');
  writeFileSync(join(dir, 'usage.json'), JSON.stringify({ model_used: 'model-a', attempts: [{ model: 'model-a', exit_code: 0 }], usage: null, ...usage }));
  return dir;
}

const gh = (/** @type {FakeGitHub} */ fake) => createGitHub({ token: 't', repo: fake.repo, fetch: fake.fetch });
const TOKEN = { GITHUB_TOKEN: 't' };

// ---------- A. per-commit patches, per-commit anchoring ----------

/** A heavy range: change group `a-b` (edit, add-then-revert) and a merge with a conflict resolution. */
function patchRepo() {
  const { dir, base } = repo();
  writeFileSync(join(dir, 'conflict.txt'), 'start\n');
  g(dir, ['add', '-A']);
  g(dir, ['commit', '--quiet', '-m', 'conflict base'], '2026-11-18T01:00:00Z');
  const start = g(dir, ['rev-parse', 'HEAD']);
  const c1 = commit(dir, 'feat: x (openspec/changes/a-b)', { 'src/x.ts': 'one\ntwo\nthree\n' });
  const c2 = commit(dir, 'feat: edit x (openspec/changes/a-b)', { 'src/x.ts': 'one\nTWO\nthree\n' });
  const c3 = commit(dir, 'wip (openspec/changes/a-b)', { 'src/tmp.ts': 'scratch\n' });
  const c4 = commit(dir, 'revert wip (openspec/changes/a-b)', { 'src/tmp.ts': null });
  g(dir, ['checkout', '--quiet', '-b', 'feature', start]);
  commit(dir, 'feature side', { 'conflict.txt': 'feature\n' });
  g(dir, ['checkout', '--quiet', 'main']);
  commit(dir, 'main side', { 'conflict.txt': 'main\n' });
  spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'merge', '--no-ff', '--quiet', 'feature', '-m', 'merge feature'], { cwd: dir });
  writeFileSync(join(dir, 'conflict.txt'), 'resolved by hand\n');
  g(dir, ['add', '-A']);
  g(dir, ['commit', '--quiet', '--no-edit']);
  const merge = g(dir, ['rev-parse', 'HEAD']);
  commit(dir, 'pad (openspec/changes/pad-it)', { 'src/pad.ts': lines(200, 'pad') });
  return { dir, base, c1, c2, c3, c4, merge };
}

test('A: calls mode shows each member commit\'s own patch (merges via --remerge-diff), anchored per commit', async () => {
  const r = patchRepo();
  const config = reviewConfig({ reviewer: 'openai/azure/model-a' }).config;
  const probe = /** @type {any} */ (await prepareReview({ repoRoot: r.dir, branch: 'main', state: { last_reviewed_sha: r.base }, now: NOW, config, policy: policy() }));
  const out = tempDir('square2-f2-out-');
  const res = /** @type {any} */ (await prepareReview({ repoRoot: r.dir, branch: 'main', state: { last_reviewed_sha: r.base }, now: NOW, config: { ...config, max_input_tokens: probe.context.estimated_tokens.total - 1 }, policy: policy(), outDir: out }));
  const c = res.context;
  assert.equal(c.diff_mode, 'calls');
  const ab = c.calls.find((/** @type {any} */ x) => x.group === 'change:a-b');
  assert.ok(ab, JSON.stringify(c.calls.map((/** @type {any} */ x) => x.group)));
  const suffix = readFileSync(join(out, ab.prompt_suffix_file), 'utf8');
  for (const sha of [r.c1, r.c2, r.c3, r.c4]) assert.match(suffix, new RegExp(`^### commit ${sha} `, 'm'), 'each commit headed by its sha and subject');
  assert.match(suffix, /^-two$/m, 'c2 shows its own edit');
  assert.match(suffix, /^\+scratch$/m, 'the add of an add-then-revert pair is visible');
  assert.match(suffix, /^-scratch$/m, 'and so is the revert');
  assert.deepEqual(Object.keys(ab.changed_lines).sort(), [r.c1, r.c2, r.c3, r.c4].sort());
  assert.deepEqual(ab.changed_lines[r.c2]['src/x.ts'], { LEFT: [[2, 2]], RIGHT: [[2, 2]] }, 'exactly the lines c2 changed');
  const mg = c.calls.find((/** @type {any} */ x) => x.group === `merge:${r.merge}`);
  assert.ok(mg, 'merge group has a call');
  const mtext = readFileSync(join(out, mg.prompt_suffix_file), 'utf8');
  assert.match(mtext, new RegExp(`^### commit ${r.merge} merge feature`, 'm'));
  assert.match(mtext, /^\+resolved by hand$/m, 'the hand resolution (remerge diff)');
  assert.doesNotMatch(mtext, /^diff --cc /m, 'never a combined diff');

  const ctx = { groups: [{ id: 'change:a-b' }], changedLines: new Map(), commitLines: new Map(Object.entries(ab.changed_lines).map(([k, v]) => [k, changedLinesFromJSON(/** @type {any} */ (v))])), commits: ab.commits };
  const f = finding({ path: 'src/x.ts', line: 2 });
  assert.equal(validateReview(result(['change:a-b'], { 'change:a-b': [f] }), ctx).ok, false, 'a calls-mode finding without commit is invalid');
  const good = /** @type {any} */ (validateReview(result(['change:a-b'], { 'change:a-b': [{ ...f, commit: r.c2.slice(0, 9) }] }), ctx));
  assert.deepEqual(good.published.map((/** @type {any} */ x) => x.commit), [r.c2], 'short sha expanded; anchored in c2');
  const wrong = /** @type {any} */ (validateReview(result(['change:a-b'], { 'change:a-b': [{ ...f, commit: r.c3 }] }), ctx));
  assert.deepEqual([wrong.published.length, wrong.demoted.length], [0, 1], 'the same line under another commit is not anchored');
});

// ---------- B. trimming order, renames, never empty ----------

test('B: trimmed calls show risk files then the others largest first, keep renames whole, never show nothing', async () => {
  const { dir, base } = repo();
  commit(dir, 'seed old', { 'src/old.ts': lines(30, 'old') });
  const seed = g(dir, ['rev-parse', 'HEAD']);
  commit(dir, 'step 1 (openspec/changes/big-one)', { 'src/db/r1.sql': lines(400, 'rone'), 'src/db/r2.sql': lines(60, 'rtwo'), 'src/n1.ts': lines(300, 'nbig'), 'src/n2.ts': lines(20, 'nsmall'), 'src/old.ts': lines(30, 'old') + 'export const extra = 1;\n' });
  g(dir, ['mv', 'src/old.ts', 'src/new.ts']);
  commit(dir, 'step 2: rename (openspec/changes/big-one)', { 'src/new.ts': lines(30, 'old') + 'export const extra = 2;\n' });
  commit(dir, 'small (openspec/changes/tiny-one)', { 'src/t.ts': 'x\n' });
  const config = { ...reviewConfig({ reviewer: 'openai/azure/model-a', risk_paths: ['src/db/**'] }).config };
  const state = { last_reviewed_sha: seed };
  const probe = /** @type {any} */ (await prepareReview({ repoRoot: dir, branch: 'main', state, now: NOW, config, policy: policy() }));
  const prefix = probe.context.estimated_tokens.prefix;
  let sawTrim = 0;
  for (let budget = prefix + 400; budget < probe.context.estimated_tokens.total; budget += 900) {
    const prepared = /** @type {any} */ (await prepareReview({ repoRoot: dir, branch: 'main', state, now: NOW, config: { ...config, max_input_tokens: budget }, policy: policy() }));
    if (prepared.skip) {
      assert.equal(prepared.skip_kind, 'budget', `budget ${budget}: nothing fits -> skip`);
      continue;
    }
    const c = prepared.context;
    const call = c.calls.find((/** @type {any} */ x) => x.group === 'change:big-one');
    if (!call) {
      assert.ok(c.not_reviewed.some((/** @type {any} */ n) => n.group === 'change:big-one'), `budget ${budget}: an unplanned group is not_reviewed`);
      continue;
    }
    assert.ok(call.tokens <= budget, `budget ${budget}: within budget`);
    const shown = new Set(call.shown_files);
    assert.ok(shown.size > 0 && Object.keys(call.changed_lines).length > 0, `budget ${budget}: never an empty diff`);
    assert.equal(shown.has('src/old.ts'), shown.has('src/new.ts'), `budget ${budget}: both sides of the rename together`);
    const listed = call.listed.map((/** @type {any} */ f) => f.path);
    for (const p of ['src/db/r1.sql', 'src/db/r2.sql', 'src/n1.ts', 'src/n2.ts', 'src/new.ts']) assert.ok(shown.has(p) || listed.includes(p), `budget ${budget}: ${p} shown or listed`);
    if (!call.trimmed) continue;
    sawTrim++;
    if (!call.partial) {
      for (const p of listed) assert.ok(!shown.has(p), 'listed only what is not shown');
      if ([...shown].some((p) => !p.startsWith('src/db/'))) {
        assert.ok(shown.has('src/db/r2.sql'), `budget ${budget}: a risk file that fits is shown before any other file`);
      }
    }
  }
  assert.ok(sawTrim >= 3, `the sweep covers trimmed plans (${sawTrim})`);
  const units = [{ paths: ['n2'], size: 5, risk: false }, { paths: ['r2'], size: 2, risk: true }, { paths: ['n1'], size: 50, risk: false }, { paths: ['r1'], size: 9, risk: true }];
  assert.deepEqual(trimOrder(units).map((u) => u.paths[0]), ['r1', 'r2', 'n1', 'n2'], 'risk largest first, then the others largest first');
  const pure = diffSections('diff --git a/src/a.ts b/src/b.ts\nsimilarity index 100%\nrename from src/a.ts\nrename to src/b.ts\n');
  assert.deepEqual(pure.map((x) => [x.path, x.old]), [['src/b.ts', 'src/a.ts']], 'a pure rename is a section too');
});

// ---------- 9. re-plan after a dropped call ----------

test('9: a call over the budget even trimmed frees its slot for the next group; not_reviewed in every call is exact', async () => {
  const { dir, base } = repo();
  commit(dir, 'huge (openspec/changes/huge-one)', { 'src/db/huge.sql': lines(6000, 'huge') });
  commit(dir, 'small one (openspec/changes/small-one)', { 'src/s1.ts': lines(40, 'sone') });
  commit(dir, 'small two (openspec/changes/small-two)', { 'src/s2.ts': lines(20, 'stwo') });
  const config = { ...reviewConfig({ reviewer: 'openai/azure/model-a', risk_paths: ['src/db/**'] }).config };
  const probe = /** @type {any} */ (await prepareReview({ repoRoot: dir, branch: 'main', state: { last_reviewed_sha: base }, now: NOW, config, policy: policy() }));
  const out = tempDir('square2-f2-replan-');
  const c = /** @type {any} */ (await prepareReview({ repoRoot: dir, branch: 'main', state: { last_reviewed_sha: base }, now: NOW, config: { ...config, max_input_tokens: probe.context.estimated_tokens.prefix + 3000, max_calls_per_run: 2 }, policy: policy(), outDir: out })).context;
  assert.deepEqual(c.calls.map((/** @type {any} */ x) => [x.id, x.group]), [['call-1', 'change:small-one'], ['call-2', 'change:small-two']], 'the slot is reused by the next group');
  assert.deepEqual(c.not_reviewed, [{ group: 'change:huge-one', reason: 'left out: over the input budget even with a trimmed diff' }]);
  for (const call of c.calls) {
    const meta = /```json\n([\s\S]*?)\n```/.exec(readFileSync(join(out, call.prompt_suffix_file), 'utf8'));
    assert.ok(meta);
    assert.deepEqual(JSON.parse(meta[1]).not_reviewed, c.not_reviewed, `${call.id}: exact not_reviewed metadata`);
  }
});

// ---------- C. pattern engine limits; candidate dedupe and replay cap ----------

test('C: a pathological pattern is stopped by the worker timeout: no violations, S2-PATTERN-TIMEOUT; other rules unaffected', async () => {
  const root = tempDir('square2-f2-pat-');
  writeFileSync(join(root, 'slow.txt'), `${'a'.repeat(48)}!\nzzz\n`);
  writeFileSync(join(root, 'ok.txt'), 'zzz here\n');
  const rule = (/** @type {string} */ id, /** @type {string} */ pattern) => /** @type {any} */ ({ id, engine: 'pattern', scope: ['**'], exclude: [], options: { pattern }, enabled: true });
  /** @type {string[]} */
  const warnings = [];
  const saved = { ...PATTERN_TIMEOUTS };
  PATTERN_TIMEOUTS.perFileMs = 300;
  try {
    const t0 = Date.now();
    const res = await patternAdapter.run(/** @type {any} */ ({ root, repoRoot: root, mode: 'repo', rules: [rule('S2-SLOW', '(?:a|aa)*c'), rule('S2-FAST', 'zzz')], config: {}, excludes: [], files: async () => ['ok.txt', 'slow.txt'], warn: (/** @type {string} */ m) => warnings.push(m) }));
    assert.ok(Date.now() - t0 < 5000, 'terminated, not waited out');
    assert.deepEqual(res.violations.map((v) => [v.rule_id, v.path]).sort(), [['S2-FAST', 'ok.txt'], ['S2-FAST', 'slow.txt']], 'the slow rule reports nothing; the fast rule, evaluated alone after the batch timed out, still reports');
    assert.equal(warnings.length, 1);
    assert.ok(warnings.every((w) => w.startsWith('[S2-PATTERN-TIMEOUT] ')), warnings.join('\n'));
    assert.ok(warnings.some((w) => w.includes('S2-SLOW')));
  } finally {
    Object.assign(PATTERN_TIMEOUTS, saved);
  }
});

test('C: candidates are deduplicated by pattern and scope, at most 3 replayed per run, drop reasons counted', async () => {
  const born = 'b'.repeat(40);
  const ruleYaml = (/** @type {string} */ id, /** @type {string} */ pattern, scope = 'src/**') => `rules:\n  - id: ${id}\n    dune_rule: 2\n    engine: pattern\n    scope: ${scope}\n    instead: do not\n    owner: o\n    enabled: false\n    born_from: ${born}\n    options:\n      pattern: ${pattern}\n`;
  const draft = (/** @type {string} */ yaml) => JSON.stringify({ rule_yaml: yaml, fixtures: { bad: [{ path: 'src/a.ts', content: 'X\n' }], good: [] }, rationale: 'r' });
  const issue = (/** @type {number} */ n) => ({ number: n, key: `k${n}`, born_from: born, title: 't', failure_case: 'f', path: 'src/a.ts', line: 1, enclosing_symbol: '<file>' });
  const context = { language: 'en', candidate_prompts: [1, 2, 3, 4, 5, 6].map((n) => ({ issue: issue(n), file: `c${n}.md` })), candidate_skipped: [{ issue: 9, reason: 'born_from unknown (blame failed)' }] };
  const answers = [
    { issue: 1, answer: draft(ruleYaml('S2-C-ONE', 'HACK-ONE')) },
    { issue: 2, answer: draft(ruleYaml('S2-C-TWO', 'HACK-ONE')) },
    { issue: 3, answer: draft(ruleYaml('S2-C-THREE', 'HACK-THREE')) },
    { issue: 4, answer: draft(ruleYaml('S2-C-FOUR', 'HACK-ONE', 'lib/**')) },
    { issue: 5, answer: draft(ruleYaml('S2-C-FIVE', 'HACK-FIVE')) },
    { issue: 6, answer: null },
  ];
  /** @type {string[]} */
  const replayed = [];
  const replay = async (/** @type {any} */ rule) => {
    replayed.push(rule.id);
    return { commit: { sha: born, fires: true }, parent: { sha: 'c'.repeat(40), fires: false } };
  };
  const res = await candidatesFrom({ context, analysis: /** @type {any} */ ({ candidates: answers }), repo: /** @type {any} */ ({ root: '/x', dir: '/x', config: {}, catalogue: { rules: [] } }), replay });
  assert.deepEqual(replayed, ['S2-C-ONE', 'S2-C-THREE', 'S2-C-FOUR'], 'same pattern+scope replayed once; a different scope is another candidate; three replays at most');
  assert.deepEqual(res.posted.map((p) => p.rule_id), replayed);
  assert.deepEqual(res.dropped, { 'duplicate pattern and scope': 1, 'replay limit reached': 1, 'no answer': 1, 'born_from unknown (blame failed)': 1 });
});

// ---------- D. markdown policy ----------

test('D: model text is fully escaped outside fences; titles are plain text; code is never fenced', () => {
  const evil = '**bold** _x_ ~~s~~ |a|b| [l](u) ![i](u) `code` ```js\nalert(1)\n``` #12 owner/repo#3 GH-4 @alice <b>&amp;</b>\n    indented\n# heading\n- item\n1. one';
  const issue = renderReviewIssue({ severity: 'Major', path: 'src/a_b*.ts', line: 3, title: 'Title **bold** `x` <b>#7 @bob\u0007‮', failure_case: evil, suggestion: evil, enclosing_symbol: 'f<T>', evidence: [evil] }, { language: 'en', range: { from_sha: null, to_sha: 'a'.repeat(40) } });
  const body = issue.body;
  assert.doesNotMatch(body, /```/, 'no fences');
  assert.doesNotMatch(body.replace(/\\`/g, '').replace(/`(?:[0-9a-f]{7,64}|∅)(?:\.\.[0-9a-f]{0,12})?`/g, ''), /`/, 'no code span holds model text (only escaped backticks and our own shas)');
  const modelLines = body.split('\n').filter((l) => /bold|alert|heading|item|one/.test(l) && !l.startsWith('**'));
  for (const ch of ['*', '_', '~', '|', '[', ']', '(', ')', '!', '#']) {
    assert.ok(modelLines.every((l) => !new RegExp(`(?<!\\\\)\\${ch}`).test(l.replace(/^> /, '').replace(/^- /, ''))), `every ${ch} escaped`);
  }
  assert.ok(!/(?<![\\])<b>/.test(body) && body.includes('&lt;b&gt;&amp;amp;&lt;/b&gt;'), 'HTML as entities, & escaped too');
  assert.ok(body.includes('#‍12') && body.includes('repo\\#‍3') && body.includes('GH‍-4') && body.includes('@‍alice'), 'references and mentions neutralised with a zero-width joiner');
  assert.doesNotMatch(body, /^ {4}indented/m, 'no indented code block');
  assert.doesNotMatch(body, /^# heading|^- item|^1\. one/m, 'no headings or lists from model text');
  assert.match(body, /\*\*Location:\*\* src\/a\\_b\\\*\.ts:3/, 'paths are escaped text, not code');
  assert.equal(issue.title, 'Title **bold** `x` <b>#‍7 @‍bob', 'title: plain text, control and bidi characters stripped, no entities');
  const cand = renderCandidateComment({ candidate: { rule: { id: 'S2-X' }, ruleYaml: 'rules:\n  - id: S2-X\n    options:\n      pattern: "<a>`x`"\n', fixtures: { bad: [{ path: 'src/a.ts', content: '```\n</pre><img src=x>\n' }], good: [] } }, report: { commit: { sha: 'b'.repeat(40) } }, issue: 3 });
  assert.doesNotMatch(cand, /```/);
  assert.ok(cand.includes('<pre>rules:\n  - id: S2-X'), 'exact text kept verbatim (indentation) in a pre block');
  assert.ok(cand.includes('&#96;x&#96;'), 'backticks as entities inside pre');
  assert.ok(cand.includes('&lt;/pre&gt;&lt;img src=x&gt;') && !cand.includes('</pre><img'), 'no break-out of the pre block');
});

// ---------- E. trust: only results, model_used and usage numbers come from the analysis ----------

test('E: analysis flags are ignored; same-family needs the publish step\'s own --allow-same-family', async () => {
  const { dir, base } = repo();
  const head = commit(dir, 'feat: a (openspec/changes/a-one)', { 'src/a.ts': 'export const a = 1;\n' });
  const fake = new FakeGitHub({ repo: 'o/r' });
  fake.branches.main = head;
  const ctx = join(tempDir('square2-f2-e-'), 'ctx');
  assert.equal((await cli(['review', 'prepare', '--root', dir, '--branch', 'main', '--from', base, '--to', head, '--out', ctx], { cwd: dir })).code, 0);
  const context = JSON.parse(readFileSync(join(ctx, 'context.json'), 'utf8'));
  const ana = analysis(join(ctx, '..', 'ana'), result(context.groups.map((/** @type {any} */ x) => x.id)), { model_used: 'claude-x', allow_same_family: true, same_family: false });
  const refused = await cli(['review', 'publish', '--root', dir, '--context', ctx, '--analysis', ana], { cwd: dir, env: TOKEN, fake });
  assert.equal(refused.code, 1, refused.stdout);
  assert.match(refused.stdout, /model claude-x is in family anthropic, not the selected reviewer family openai/);
  const ok = await cli(['review', 'publish', '--root', dir, '--context', ctx, '--analysis', ana, '--allow-same-family'], { cwd: dir, env: TOKEN, fake });
  assert.equal(ok.code, 0, ok.stdout + ok.stderr);
  const v = await cli(['review', 'validate', '--root', dir, '--context', ctx, '--analysis', ana, '--allow-same-family', '--out', join(ctx, 'review.json')], { cwd: dir });
  assert.equal(v.code, 0, v.stdout);
  assert.equal(JSON.parse(readFileSync(join(ctx, 'review.json'), 'utf8')).same_family, true, 'computed from the reviewer family vs the model actually used');
});

// ---------- 1. force-push ----------

test('1: after a force-push the state moves to to_sha; a compare 404 otherwise exits 2 without advancing; re-runs are idempotent', async () => {
  const { dir } = repo();
  const a = commit(dir, 'feat: a (openspec/changes/a-one)', { 'src/a.ts': 'export const a = 1;\n' });
  const b = commit(dir, 'feat: b (openspec/changes/b-one)', { 'src/b.ts': 'export const b = 1;\n' });
  g(dir, ['reset', '--quiet', '--hard', a]);
  const c = commit(dir, 'feat: c (openspec/changes/c-one)', { 'src/c.ts': 'export const c = 1;\nexport const d = 2;\n' });
  const fake = new FakeGitHub({ repo: 'o/r' });
  fake.branches.main = c;
  await new StateIssue(gh(fake)).write({ last_reviewed_sha: b, published_input_ids: [] });
  const ctx = join(tempDir('square2-f2-fp-'), 'ctx');
  const p = await cli(['review', 'prepare', '--root', dir, '--branch', 'main', '--out', ctx], { cwd: dir, env: TOKEN, fake });
  assert.equal(p.code, 0, p.stdout + p.stderr);
  const context = JSON.parse(readFileSync(join(ctx, 'context.json'), 'utf8'));
  assert.equal(context.history_rewritten, true);
  assert.deepEqual([context.range.from_sha, context.range.to_sha], [a, c], 'the merge base');
  const ana = analysis(join(ctx, '..', 'ana'), result(context.groups.map((/** @type {any} */ x) => x.id), { [context.groups[0].id]: [finding({ path: 'src/c.ts', line: 2 })] }));
  const state = () => parseState(/** @type {any} */ (fake.issues.find((i) => i.labels.includes('square2-state'))).body);

  fake.missing.add(b);
  writeFileSync(join(ctx, 'context.json'), JSON.stringify({ ...context, history_rewritten: false }));
  const failed = await cli(['review', 'publish', '--root', dir, '--context', ctx, '--analysis', ana], { cwd: dir, env: TOKEN, fake });
  assert.equal(failed.code, 2, failed.stdout + failed.stderr);
  assert.match(failed.stdout, /^\[S2-PUBLISH\] GET \/repos\/o\/r\/compare\/.* returned 404/m);
  assert.equal(state().last_reviewed_sha, b, 'state not advanced');
  const issues = fake.issues.filter((i) => i.labels.includes('square2:review')).length;
  assert.equal(issues, 1, 'issues were written before the failure');

  writeFileSync(join(ctx, 'context.json'), JSON.stringify(context));
  const ok = await cli(['review', 'publish', '--root', dir, '--context', ctx, '--analysis', ana], { cwd: dir, env: TOKEN, fake });
  assert.equal(ok.code, 0, ok.stdout + ok.stderr);
  assert.equal(state().last_reviewed_sha, c, 'history_rewritten: state set to to_sha although it is not a descendant of the old state');
  assert.equal(fake.issues.filter((i) => i.labels.includes('square2:review')).length, issues, 'the re-run after the failure is idempotent');
});

// ---------- 2. PR freshness ----------

test('2: a PR run compares to the pull request\'s current head and skips only when it moved', async () => {
  const { dir, base } = repo();
  const head = commit(dir, 'feat: a (openspec/changes/a-one)', { 'src/a.ts': 'export const a = 1;\n' });
  const fake = new FakeGitHub({ repo: 'o/r' });
  const ctx = join(tempDir('square2-f2-pr-'), 'ctx');
  assert.equal((await cli(['review', 'prepare', '--root', dir, '--pr', '7', '--base', base, '--head', head, '--out', ctx], { cwd: dir })).code, 0);
  const context = JSON.parse(readFileSync(join(ctx, 'context.json'), 'utf8'));
  const ana = analysis(join(ctx, '..', 'ana'), result(context.groups.map((/** @type {any} */ x) => x.id), {}, { suggestions: ['note'] }));
  fake.pulls[7] = 'f'.repeat(40);
  const moved = await cli(['review', 'publish', '--root', dir, '--context', ctx, '--analysis', ana], { cwd: dir, env: TOKEN, fake });
  assert.equal(moved.code, 0);
  assert.match(moved.stdout, /pull request 7 moved to ffffffffffff/);
  fake.pulls[7] = head;
  const ok = await cli(['review', 'publish', '--root', dir, '--context', ctx, '--analysis', ana], { cwd: dir, env: TOKEN, fake });
  assert.equal(ok.code, 0, ok.stdout);
  assert.match(ok.stdout, /digest posted/);
  assert.equal(parseState(/** @type {any} */ (fake.issues.find((i) => i.labels.includes('square2-state'))).body).last_reviewed_sha, null, 'a PR never moves the state');
});

// ---------- 3. born_from via blame ----------

test('3: a published finding\'s commit is git blame of its line; blame failure leaves no born_from and drops the candidate later', async () => {
  const { dir, base } = repo();
  const c1 = commit(dir, 'feat: a (openspec/changes/a-one)', { 'src/a.ts': 'one\ntwo\nthree\n' });
  const c2 = commit(dir, 'feat: a2 (openspec/changes/a-one)', { 'src/a.ts': 'ONE\ntwo\nthree\n' });
  assert.equal(await blameCommit(dir, c2, 'src/a.ts', 2), c1);
  assert.equal(await blameCommit(dir, c2, 'src/a.ts', 1), c2);
  assert.equal(await blameCommit(dir, c2, 'src/missing.ts', 1), null);
  assert.equal(await blameCommit(dir, '--evil', 'src/a.ts', 1), null);
  const c3 = commit(dir, 'feat: a3 (openspec/changes/a-one)', { 'src/a.ts': 'ONE\ntwo\nthree\nfour\n' });
  const c4 = commit(dir, 'feat: a4 (openspec/changes/a-one)', { 'src/a.ts': 'ONE\nTWO\nthree\nfour\n' });
  const fake = new FakeGitHub({ repo: 'o/r' });
  fake.branches.main = c4;
  const ctx = join(tempDir('square2-f2-blame-'), 'ctx');
  assert.equal((await cli(['review', 'prepare', '--root', dir, '--branch', 'main', '--from', c1, '--to', c4, '--out', ctx], { cwd: dir })).code, 0);
  const context = JSON.parse(readFileSync(join(ctx, 'context.json'), 'utf8'));
  const id = context.groups[0].id;
  const ana = analysis(join(ctx, '..', 'ana'), result([id], { [id]: [finding({ path: 'src/a.ts', line: 4, title: 'four is wrong' }), finding({ path: 'src/a.ts', line: 1, side: 'LEFT', title: 'one removed' })] }));
  const pub = await cli(['review', 'publish', '--root', dir, '--context', ctx, '--analysis', ana], { cwd: dir, env: TOKEN, fake });
  assert.equal(pub.code, 0, pub.stdout + pub.stderr);
  const byTitle = (/** @type {string} */ t) => parseTarget(/** @type {any} */ (fake.issues.find((i) => i.title === t)).body);
  assert.equal(byTitle('four is wrong')?.commit, c3, 'born_from: the commit that introduced line 4 at to_sha, not the last commit touching the file');
  assert.equal(byTitle('one removed')?.commit, null, 'no blame for a removed line in range mode: no born_from');
  for (const i of fake.issues.filter((x) => x.labels.includes('square2:review'))) {
    i.state = 'closed';
    i.state_reason = 'completed';
  }
  const targets = await reviewTargets(gh(fake));
  assert.deepEqual(targets.confirmed.map((x) => x.born_from), [c3]);
  assert.deepEqual(targets.unborn.map((x) => x.reason), ['born_from unknown (blame failed)']);
});

// ---------- 4. run caps after merging calls ----------

test('4: merged calls keep at most max_findings x 2 findings (most severe) and 4 questions', async () => {
  const sha = (/** @type {number} */ i) => `${i}`.repeat(40);
  const diff = (/** @type {string} */ p) => `diff --git a/${p} b/${p}\n--- a/${p}\n+++ b/${p}\n@@ -1,0 +1,10 @@\n${'+x\n'.repeat(10)}`;
  const groups = [0, 1, 2].map((i) => ({ id: `change:g${i}`, commits: [sha(i)], paths: [`src/f${i}.ts`] }));
  const context = {
    range: { from_sha: 'a'.repeat(40), to_sha: 'b'.repeat(40), branch_or_pr: 'branch:main' }, policy_digest: 'd'.repeat(64), reviewer: { family: 'openai', model: 'model-a' }, caps: { max_findings: 2 }, groups, changed_lines: {},
    calls: groups.map((gr, i) => ({ id: `call-${i + 1}`, group: gr.id, commits: [sha(i)], shown_files: gr.paths, changed_lines: { [sha(i)]: changedLinesToJSON(shownLines(diff(`src/f${i}.ts`))) } })),
  };
  const sev = [['Nit', 'Minor'], ['Blocker', 'Nit'], ['Major', 'Minor']];
  const results = groups.map((gr, i) => result([gr.id], { [gr.id]: sev[i].map((s, j) => finding({ severity: s, path: `src/f${i}.ts`, line: j + 1, title: `t${i}${j}`, commit: sha(i) })) }, { questions: ['q1', 'q2'] }));
  const validate = async (/** @type {any} */ o) => validateReview(o.output, { groups: o.context.groups, changedLines: new Map(), maxFindings: 2, commitLines: new Map(Object.entries(o.context.commit_lines).map(([k, v]) => [k, changedLinesFromJSON(/** @type {any} */ (v))])), commits: o.context.call_commits });
  const m = /** @type {any} */ (await mergeCalls({ context, analysis: /** @type {any} */ ({ results: context.calls.map((c, i) => ({ call: c.id, result: results[i] })), usage: { model_used: 'model-a', calls: context.calls.map((c) => ({ call: c.id, model_used: 'model-a', attempts: [] })) } }), validate, repo: /** @type {any} */ ({}), calls: context.calls }));
  assert.ok(m.ok, JSON.stringify(m));
  assert.deepEqual(m.res.published.map((/** @type {any} */ f) => f.severity), ['Blocker', 'Major', 'Minor', 'Minor'], 'six findings, cap 4: the most severe kept');
  assert.equal(m.res.capped, 2);
  assert.deepEqual(m.res.questions, ['q1', 'q2', 'q1', 'q2'], 'questions capped at 4 per run');
});

// ---------- 5. key-leak check ----------

test('5: the key is found through whitespace and separators; trace ids and MD5s alone never abort a run', () => {
  const key = 'abcd1234efgh5678ijkl';
  assert.equal(leaksKey(`token: abcd-1234-efgh\n5678 ijkl.`, key), true, 'split with dashes, spaces and a line break');
  assert.equal(leaksKey('a:b:c:d:1:2:3:4:e:f:g:h:5:6:7:8:i:j:k:l', key), true);
  assert.equal(leaksKey('nothing to see', key), false);
  const md5 = '9e107d9d372bb6826bd81d3542a419d6';
  assert.equal(looksSecret(`trace ${md5} in the log`), false, 'a bare 32-hex is a trace id or MD5');
  assert.equal(leaksKey(`request id ${md5}`, key), false);
  assert.equal(looksSecret(`the api key is ${md5}`), true, 'within 40 characters of key/secret/token/api: flagged');
  assert.equal(looksSecret(`${md5} was the secret`), true);
});

// ---------- 6. explicit ranges never move the state ----------

test('6: an explicit --from/--to run records its input but never advances last_reviewed_sha', async () => {
  const { dir, base } = repo();
  const head = commit(dir, 'feat: a (openspec/changes/a-one)', { 'src/a.ts': 'export const a = 1;\n' });
  const fake = new FakeGitHub({ repo: 'o/r' });
  fake.branches.main = head;
  const ctx = join(tempDir('square2-f2-ex-'), 'ctx');
  assert.equal((await cli(['review', 'prepare', '--root', dir, '--branch', 'main', '--from', base, '--to', head, '--out', ctx], { cwd: dir })).code, 0);
  const context = JSON.parse(readFileSync(join(ctx, 'context.json'), 'utf8'));
  assert.equal(context.explicit_range, true);
  const ana = analysis(join(ctx, '..', 'ana'), result(context.groups.map((/** @type {any} */ x) => x.id), {}, { suggestions: ['s'] }));
  const pub = await cli(['review', 'publish', '--root', dir, '--context', ctx, '--analysis', ana], { cwd: dir, env: TOKEN, fake });
  assert.equal(pub.code, 0, pub.stdout + pub.stderr);
  assert.match(pub.stderr, /explicit --from\/--to range; last_reviewed_sha not moved/);
  const st = parseState(/** @type {any} */ (fake.issues.find((i) => i.labels.includes('square2-state'))).body);
  assert.equal(st.last_reviewed_sha, null);
  assert.equal(st.published_input_ids.length, 1);
});

// ---------- 7. rename chains ----------

test('7: an open issue follows its file through renames across ranges (target marker updated by publish)', async () => {
  const { dir } = repo();
  const start = commit(dir, 'add old', { 'src/old.ts': lines(20, 'v') });
  g(dir, ['mv', 'src/old.ts', 'src/mid.ts']);
  const r1 = commit(dir, 'rename to mid (openspec/changes/mv-one)', {});
  g(dir, ['mv', 'src/mid.ts', 'src/new.ts']);
  const r2 = commit(dir, 'rename to new (openspec/changes/mv-two)', {});
  const fake = new FakeGitHub({ repo: 'o/r' });
  const key = 'k'.repeat(64);
  const seeded = fake.seed({ title: 'old finding', labels: ['square2', 'square2:review', 'sev:minor'], body: `${findingMarker(key)}\n${targetMarker({ path: 'src/old.ts', line: 3, title: 'old finding', commit: start })}\n\nbody\n` });
  for (const [from, to] of [[start, r1], [r1, r2]]) {
    fake.branches.main = to;
    const ctx = join(tempDir('square2-f2-mv-'), 'ctx');
    assert.equal((await cli(['review', 'prepare', '--root', dir, '--branch', 'main', '--from', from, '--to', to, '--out', ctx], { cwd: dir, env: TOKEN, fake })).code, 0);
    const context = JSON.parse(readFileSync(join(ctx, 'context.json'), 'utf8'));
    assert.equal(context.open_issues.length, 1);
    const ana = analysis(join(ctx, '..', 'ana'), result(context.groups.map((/** @type {any} */ x) => x.id), {}, { suggestions: ['s'] }));
    const pub = await cli(['review', 'publish', '--root', dir, '--context', ctx, '--analysis', ana], { cwd: dir, env: TOKEN, fake });
    assert.equal(pub.code, 0, pub.stdout + pub.stderr);
  }
  assert.equal(parseTarget(seeded.body)?.path, 'src/new.ts', 'old.ts -> mid.ts -> new.ts over two ranges');
  assert.equal(parseTarget(seeded.body)?.line, 3);
});

// ---------- 10. --pr with --from/--to ----------

test('10: --pr together with --from/--to exits 2', async () => {
  const { dir, base } = repo();
  const head = commit(dir, 'x', { 'a.txt': 'a\n' });
  const r = await cli(['review', 'prepare', '--root', dir, '--pr', '3', '--base', base, '--head', head, '--from', base, '--to', head, '--out', join(tempDir('square2-f2-u-'), 'c')], { cwd: dir });
  assert.equal(r.code, 2);
  assert.match(r.stdout, /^\[S2-USAGE\] --pr cannot be combined with --from\/--to/);
});

// ---------- 11. digest labels ----------

test('11: dropped candidates are reported with their reason, never as secrets', () => {
  const d = renderDigest({ inputId: 'i', kind: 'review', branch: 'main', sha: 'a'.repeat(40), changes: [], notify: [], extras: { rejected: 0, candidatesDropped: { 'replay limit reached': 2, 'invalid candidate': 1 }, capped: 3 } });
  assert.match(d, /candidates dropped \(invalid candidate\): 1/);
  assert.match(d, /candidates dropped \(replay limit reached\): 2/);
  assert.match(d, /not filed \(over the run finding cap\): 3/);
  assert.doesNotMatch(d, /secret/);
  assert.match(renderDigest({ inputId: 'i', kind: 'review', branch: 'main', sha: 'a'.repeat(40), changes: [], notify: [], extras: { rejected: 2 } }), /not published \(secret-shaped text\): 2/);
});
