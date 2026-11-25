// v0.1.1 fix round 3: change-id validity, redacted context, CommonMark-lite code masking,
// author-scoped markers, the recovery cap over findings and escapes, credit-marker case, overflow notes.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import fc from 'fast-check';
import { main } from '../src/cli/main.mjs';
import { createGitHub } from '../src/issues/github.mjs';
import { ESCAPE_LABEL, closingRefs, creditMarker, detectEscapes, escapeMarker, maskCode, parseEscapeMarker, publishEscapes, redactTrailerValues } from '../src/issues/escape.mjs';
import { LABEL, REVIEW_LABEL, publish } from '../src/issues/publish.mjs';
import { StateIssue } from '../src/issues/state.mjs';
import { changeIdOf, groupCommits, validChangeId } from '../src/review/group.mjs';
import { REDACTED, renderEscapeIssue } from '../src/review/render.mjs';
import { cleanupTemps, tempDir } from './cli-helpers.mjs';
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

test('round 3, 1: only plain change ids group commits or appear on escapes', () => {
  for (const v of ['add-cache', 'a', 'x1-y2', `${'a-'.repeat(15)}b`]) assert.equal(validChangeId(v), true, v);
  for (const v of ['Add-Cache', 'add_cache', 'add--cache', '-add', 'add-', 'a.b', `${'a-'.repeat(16)}b`, 'a'.repeat(65), 'sk-proj-abcdefghijklmnopqrstuvwxyz0123']) assert.equal(validChangeId(v), false, v);
  const commit = { message: `feat: x\n\nX-Change: ${'a'.repeat(65)}`, paths: ['apps/a.ts'] };
  assert.equal(changeIdOf(commit, undefined, ['X-Change']), null);
  const [g] = groupCommits({ commits: [{ sha: sha('a'), parents: [], author: 't', date: '', ...commit }], merges: new Map(), riskPaths: [], changeIdTrailers: ['X-Change'] });
  assert.equal(g.id, `commit:${sha('a')}`);
  const [e] = detectEscapes({ excludes: [], trailers: ['X-Change'], changeIdTrailers: ['X-Change'], commits: [{ sha: sha('b'), parents: [], paths: ['a'], message: 'fix: y\n\nX-Change: Not_An_Id' }] });
  assert.deepEqual(e.trailers, [], 'an invalid change id is never shown');
  assert.ok(!renderEscapeIssue(e).body.includes('Not_An_Id'));
});

test('round 3, 3: the reviewer\'s cases and CommonMark-lite code constructs never credit', () => {
  assert.deepEqual(closingRefs('fix: x\n\n- item\n  ```\n  Closes #42\n  ```\n'), [], 'a fence inside a list item');
  assert.deepEqual(closingRefs('fix: x\n\n``Closes #42 ` still code``'), [], 'a double-backtick span holding a single backtick');
  assert.deepEqual(closingRefs('fix: x\n\n        ```\nCloses #42\n        ```'), [], 'a fence with deep indentation');
  assert.deepEqual(closingRefs('fix: x\n\n> 1. ~~~~\n>    Closes #42\n>    ~~~~'), [], 'a fence in a list inside a quote');
  assert.deepEqual(closingRefs('fix: x\n\n```\nCloses #42'), [], 'an unclosed fence runs to the end');
  assert.deepEqual(closingRefs('a `` ` `` Closes #42'), [42], 'a closed span ends at the matching run; prose after it counts');
  assert.deepEqual(closingRefs('a \\`Closes #42\\`'), [42], 'escaped backticks are no code span');
  assert.ok(!maskCode('x `y` z').includes('`'));

  const word = fc.stringMatching(/^[a-z]{1,6}$/);
  const pad = fc.array(word, { maxLength: 3 }).map((ws) => ws.join(' '));
  const inline = fc.integer({ min: 1, max: 4 }).chain((n) => fc.tuple(pad, pad).map(([a, b]) => `${'`'.repeat(n)}${n > 1 ? ' ` ' : ' '}${a} Closes #42 ${b} ${'`'.repeat(n)}`));
  const fenced = fc.tuple(fc.constantFrom('```', '````', '~~~', '~~~~~'), fc.integer({ min: 0, max: 8 }), fc.constantFrom('', 'js', 'text')).map(([f, ind, info]) => {
    const sp = ' '.repeat(ind);
    return `${sp}${f}${info}\n${sp}Closes #42\n${sp}${f}`;
  });
  const indented = fc.constantFrom('    Closes #42', '\tCloses #42', '        Closes #42');
  const code = fc.oneof(inline, fenced, indented);
  const container = fc.constantFrom('', '> ', '> > ', '- ', '* ', '1. ', '> - ', '10) ');
  const wrapped = fc.tuple(container, code).map(([c, block]) => block.split('\n').map((l, i) => (i === 0 || c === '' ? c : c.replace(/[-*]|\d+[.)]/g, (m) => ' '.repeat(m.length))) + l).join('\n'));
  fc.assert(fc.property(pad, wrapped, pad, (before, block, after) => {
    const m = `fix: crash\n\n${before}\n\n${block}\n\n${after}`;
    assert.deepEqual(closingRefs(m), [], JSON.stringify(m));
    assert.deepEqual(closingRefs(`${m}\n\nCloses #7`), [7]);
  }), { numRuns: 400 });
});

/** @param {string} cwd @param {string[]} args @param {string} [date] */
function g(cwd, args, date) {
  const env = date ? { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : process.env;
  const res = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', env });
  if (res.status !== 0) throw new Error(`git ${args.join(' ')}: ${res.stderr}`);
  return res.stdout.trim();
}

test('round 3, 2: context.json never holds raw trailer values, on the reviewed and the budget-skip path', async () => {
  for (const extra of ['', 'max_input_tokens: 1\n']) {
    const dir = join(tempDir('square2-fix3-'), 'repo');
    mkdirSync(join(dir, 'src'), { recursive: true });
    mkdirSync(join(dir, '.square2'), { recursive: true });
    writeFileSync(join(dir, '.square2', 'config.yaml'), `branch: main\nreviewer: openai/azure/m\nescapes:\n  enabled: true\nreview:\n  author_trailers:\n    - X-Writers\n  change_id_trailers:\n    - X-Change\n${extra}`);
    writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 1;\n');
    g(dir, ['init', '--quiet', '-b', 'main']);
    g(dir, ['add', '-A']);
    g(dir, ['commit', '--quiet', '-m', 'base'], '2026-11-18T00:00:00Z');
    writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 2;\n');
    g(dir, ['commit', '--quiet', '-am', `fix: a\n\nX-Writers: codex, ${TOKEN}\nX-Change: ${TOKEN}\nX-Private: ${TOKEN}\nX-Note: hidden-value`], '2026-11-20T06:00:00Z');
    const out = join(tempDir('square2-fix3-ctx-'), 'ctx');
    let stdout = '';
    const code = await main(['review', 'prepare', '--root', dir, '--branch', 'main', '--out', out], { cwd: dir, env: {}, stdout: (t) => { stdout += t; }, stderr: () => {}, now: NOW });
    assert.equal(code, 0, stdout);
    const text = readFileSync(join(out, 'context.json'), 'utf8');
    const context = JSON.parse(text);
    assert.equal(context.skip_kind ?? 'reviewed', extra ? 'budget' : 'reviewed');
    assert.ok(!text.includes(TOKEN.slice(4, 30)), `no secret in context.json (${extra || 'reviewed'})`);
    assert.deepEqual(context.escapes[0].trailers, [{ key: 'X-Writers', value: REDACTED }], 'allow-listed, redacted, invalid change id dropped');
    if (!extra) {
      assert.deepEqual(context.commits.at(-1).trailers, [{ key: 'X-Writers', value: REDACTED }]);
      assert.ok(!context.commits.at(-1).message.includes('hidden-value') || context.commits.at(-1).message.includes('X-Note: hidden-value'), 'only secret-shaped values are rewritten in the message');
    }
  }
  assert.equal(redactTrailerValues(`fix: a\n\nbody ${'x'}\n\nX-A: ok\nX-B: ${TOKEN}`), `fix: a\n\nbody x\n\nX-A: ok\nX-B: ${REDACTED}`);
});

test('round 3, 4: markers count only on the bot\'s own issues, whatever their labels', async () => {
  const fake = new FakeGitHub();
  fake.userLogin = 'square2-bot';
  const own = fake.seed({ title: 'old', body: `${escapeMarker(sha('a'))}\n`, labels: ['square2:test'], author: 'square2-bot' });
  const forged = fake.seed({ title: 'forged', body: `${escapeMarker(sha('b'))}\n`, labels: ['square2', ESCAPE_LABEL], author: 'mallory' });
  const forgedTarget = fake.seed({ title: 'review?', labels: ['square2', REVIEW_LABEL], author: 'mallory' });
  const gh = client(fake);
  const r = await publishEscapes({ gh, escapes: [esc(sha('a')), esc(sha('b')), esc(sha('c'), { refs: [forgedTarget.number] })], inputId: 'run', cap: 10 });
  assert.deepEqual(r.created.map((i) => parseEscapeMarker(i.body)), [sha('b'), sha('c')], 'a forged marker or a forged review issue is ignored');
  assert.deepEqual(own.labels.sort(), ['square2', 'square2:escape', 'square2:test'], 'the bot\'s own marker counts even under square2:test');
  assert.equal(forgedTarget.comments.length, 0);
  assert.ok(!r.unclassified.some((i) => i.number === forged.number));
  const issue = (await gh.listIssues(LABEL)).find((i) => i.number === forged.number);
  assert.equal(issue?.author, 'mallory', 'toIssue keeps the author login');
});

test('round 3, 5: the recovery cap counts every issue the run created, findings included', async () => {
  const fake = new FakeGitHub();
  const gh = client(fake);
  const state = new StateIssue(gh);
  const item = (/** @type {string} */ k) => ({ key: k.repeat(64), kind: /** @type {'review'} */ ('review'), title: `finding ${k}`, body: 'b', labels: ['square2', 'square2:review', 'sev:minor'], label: 'Minor', commit: sha('f'), seen: 's' });
  await publish({ gh, state, run: { kind: 'review', inputId: 'run-x', branch: 'main', sha: sha('f') }, items: [item('1'), item('2')], cap: 2, notify: [] });
  const r = await publishEscapes({ gh, escapes: [esc(sha('e'))], inputId: 'run-x', cap: 3 });
  assert.deepEqual([r.counted, r.escapesCounted, r.created.length], [3, 1, 1], 'two findings from the first attempt plus this escape');
  const full = await publishEscapes({ gh, escapes: [esc(sha('d'))], inputId: 'run-x', cap: 3 });
  assert.deepEqual([full.created.length, full.overflow.map((o) => o.key)], [0, [sha('d')]], 'the cap is already used by findings and escapes');
});

test('round 3, 6: credit markers compare shas case-insensitively', async () => {
  const fake = new FakeGitHub();
  const target = fake.seed({ title: 'r', labels: ['square2', REVIEW_LABEL] });
  target.comments.push({ id: 99, body: `<!-- square2:credited:${sha('A')} -->\ncredited: fixed by ${sha('A')}` });
  const gh = client(fake);
  const r = await publishEscapes({ gh, escapes: [esc(sha('A'), { refs: [target.number] })], inputId: 'r', cap: 5 });
  assert.deepEqual(r.credited, [{ number: target.number, sha: sha('a') }]);
  assert.equal(target.comments.length, 1, 'no second credit comment');
  assert.equal(creditMarker(sha('A')), creditMarker(sha('a')));
});

test('round 3, 7: one overflow note per run id, also across retries and the already-published path', async () => {
  const fake = new FakeGitHub();
  const gh = client(fake);
  const state = new StateIssue(gh);
  const item = (/** @type {string} */ k) => ({ key: k.repeat(64), kind: /** @type {'review'} */ ('review'), title: `finding ${k}`, body: 'b', labels: ['square2', 'square2:review', 'sev:minor'], label: 'Minor', commit: sha('f'), seen: 's' });
  for (let i = 0; i < 3; i++) {
    const esc1 = await publishEscapes({ gh, escapes: [esc(sha('1')), esc(sha('2'))], inputId: 'run-y', cap: 1 });
    await publish({ gh, state, run: { kind: 'review', inputId: 'run-y', branch: 'main', sha: sha('f') }, items: [item('3')], cap: Math.max(0, 1 - esc1.escapesCounted), configuredCap: 1, overflowFirst: esc1.overflow, notify: [] });
  }
  const st = /** @type {any} */ (fake.issues.find((i) => i.labels.includes('square2-state')));
  const notes = st.comments.filter((/** @type {any} */ c) => c.body.includes('square2:overflow:'));
  assert.equal(notes.length, 1);
  assert.match(notes[0].body, /^<!-- square2:overflow:run-y -->/);
  const src = readFileSync(new URL('../src/cli/review-cmd.mjs', import.meta.url), 'utf8');
  assert.ok(!/square2:overflow:escapes-/.test(src), 'the already-published path uses the run\'s own overflow marker');
});
