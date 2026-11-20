import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import fc from 'fast-check';
import { changedLines, changedLinesFromJSON, changedLinesToJSON, isChangedLine, unquoteGitPath } from '../src/git/changed-lines.mjs';
import { changedLineCount, commitsInRange, rangeDiff } from '../src/git/diff.mjs';
import { coAuthors, parseTrailers } from '../src/git/trailers.mjs';
import { archiveTree } from '../src/git/archive.mjs';
import { cleanupTemps, tempDir } from './cli-helpers.mjs';

after(cleanupTemps);

/**
 * @param {string} cwd
 * @param {string[]} args
 * @param {Record<string, string>} [env]
 */
function g(cwd, args, env = {}) {
  const res = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.quotePath=false', ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
  if (res.status !== 0) throw new Error(`git ${args.join(' ')}: ${res.stderr}`);
  return res.stdout;
}

/** Changed lines from hunk bodies (not headers) and paths from `--name-status -z`. */
function oracle(/** @type {string} */ dir, /** @type {string} */ a, /** @type {string} */ b) {
  const names = g(dir, ['diff', '--name-status', '-z', '-M', a, b]).split('\0').filter((x) => x !== '');
  /** @type {string[]} */
  const paths = [];
  for (let i = 0; i < names.length;) {
    const st = names[i];
    if (st.startsWith('R') || st.startsWith('C')) { paths.push(names[i + 2]); i += 3; } else { paths.push(names[i + 1]); i += 2; }
  }
  /** @type {Map<string, { LEFT: Set<number>, RIGHT: Set<number> }>} */
  const out = new Map();
  for (const p of paths) {
    const d = g(dir, ['diff', '--unified=0', '--inter-hunk-context=0', '-M', a, b, '--', ...pathspecFor(dir, a, b, p)]);
    let oldN = 0;
    let newN = 0;
    const sets = { LEFT: new Set(), RIGHT: new Set() };
    let inHunk = false;
    for (const line of d.split('\n')) {
      const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (h) { oldN = Number(h[1]); newN = Number(h[2]); inHunk = true; continue; }
      if (!inHunk) continue;
      if (line.startsWith('-')) sets.LEFT.add(oldN++);
      else if (line.startsWith('+')) sets.RIGHT.add(newN++);
    }
    if (sets.LEFT.size + sets.RIGHT.size > 0) out.set(p, /** @type {any} */ (sets));
  }
  return out;
}

/** Pathspecs for one file, including the rename source so -M still pairs them. */
function pathspecFor(/** @type {string} */ dir, /** @type {string} */ a, /** @type {string} */ b, /** @type {string} */ p) {
  const names = g(dir, ['diff', '--name-status', '-z', '-M', a, b]).split('\0').filter((x) => x !== '');
  for (let i = 0; i < names.length;) {
    if (names[i].startsWith('R') || names[i].startsWith('C')) {
      if (names[i + 2] === p) return [`:(literal)${names[i + 1]}`, `:(literal)${p}`];
      i += 3;
    } else i += 2;
  }
  return [`:(literal)${p}`];
}

/** @param {[number, number][]} ranges */
const expand = (ranges) => new Set(ranges.flatMap(([s, e]) => Array.from({ length: e - s + 1 }, (_, i) => s + i)));

const NAMES = ['a.txt', 'dir/b.ts', 'with space.md', 'tab\tname.txt', 'quote"d.txt', 'back\\slash.txt', 'ünïcödé.py', 'new\nline.txt', 'dir/sub/ç.sql'];
const lineArb = fc.constantFrom('alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', '', '  indented', 'x = 1;', '-- leading dashes', '+++ not a header', '@@ not a hunk');
const contentArb = fc.array(lineArb, { minLength: 0, maxLength: 12 }).map((ls) => ls.join('\n') + (ls.length ? '\n' : ''));

test('P12: changedLines equals git\'s changed lines on random file pairs, renames and quoted paths', () => {
  const root = tempDir('square2-p12-');
  let n = 0;
  fc.assert(
    fc.property(
      fc.uniqueArray(fc.constantFrom(...NAMES), { minLength: 1, maxLength: 4 }),
      fc.array(contentArb, { minLength: 4, maxLength: 4 }),
      fc.array(contentArb, { minLength: 4, maxLength: 4 }),
      fc.array(fc.boolean(), { minLength: 4, maxLength: 4 }),
      (names, before, afterContents, renames) => {
        const dir = join(root, String(n++));
        mkdirSync(dir, { recursive: true });
        g(dir, ['init', '--quiet']);
        names.forEach((p, i) => {
          mkdirSync(join(dir, p, '..'), { recursive: true });
          writeFileSync(join(dir, p), before[i] + 'shared tail one\nshared tail two\nshared tail three\n');
        });
        g(dir, ['add', '-A']);
        g(dir, ['commit', '--quiet', '--allow-empty', '-m', 'a']);
        names.forEach((p, i) => {
          const target = renames[i] ? `renamed/${p}` : p;
          if (renames[i]) {
            mkdirSync(join(dir, target, '..'), { recursive: true });
            g(dir, ['mv', '--', p, target]);
          }
          writeFileSync(join(dir, target), afterContents[i] + 'shared tail one\nshared tail two\nshared tail three\n');
        });
        g(dir, ['add', '-A']);
        g(dir, ['commit', '--quiet', '--allow-empty', '-m', 'b']);
        const diff = g(dir, ['diff', '--no-ext-diff', '--no-color', '--unified=0', '--inter-hunk-context=0', '--find-renames', 'HEAD~1', 'HEAD', '--']);
        const ours = changedLines(diff);
        const expected = oracle(dir, 'HEAD~1', 'HEAD');
        assert.deepEqual([...ours.keys()].sort(), [...expected.keys()].sort());
        for (const [p, sets] of expected) {
          const mine = /** @type {import('../src/git/changed-lines.mjs').SideRanges} */ (ours.get(p));
          assert.deepEqual([...expand(mine.LEFT)].sort((x, y) => x - y), [...sets.LEFT].sort((x, y) => x - y), `${p} LEFT`);
          assert.deepEqual([...expand(mine.RIGHT)].sort((x, y) => x - y), [...sets.RIGHT].sort((x, y) => x - y), `${p} RIGHT`);
        }
        rmSync(dir, { recursive: true, force: true });
      },
    ),
    { numRuns: 40 },
  );
});

test('unquoteGitPath decodes C escapes and octal UTF-8 bytes', () => {
  assert.equal(unquoteGitPath('"a\\tb\\"c\\\\d"'), 'a\tb"c\\d');
  assert.equal(unquoteGitPath('"\\303\\274ber.txt"'), 'über.txt');
  assert.equal(unquoteGitPath('"new\\nline"'), 'new\nline');
  assert.equal(unquoteGitPath('plain.txt'), 'plain.txt');
  const quoted = changedLines('diff --git "a/\\303\\274.txt" "b/\\303\\274.txt"\n--- "a/\\303\\274.txt"\n+++ "b/\\303\\274.txt"\n@@ -1 +1 @@\n-a\n+b\n');
  assert.deepEqual([...quoted.keys()], ['ü.txt']);
});

test('isChangedLine and JSON round trip', () => {
  const lines = changedLines('diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -2,0 +3,2 @@\n+a\n+b\n@@ -9 +10,0 @@\n-c\n');
  assert.equal(isChangedLine(lines, 'x', 'RIGHT', 3), true);
  assert.equal(isChangedLine(lines, 'x', 'RIGHT', 5), false);
  assert.equal(isChangedLine(lines, 'x', 'LEFT', 9), true);
  assert.equal(isChangedLine(lines, 'y', 'RIGHT', 3), false);
  assert.deepEqual(changedLinesFromJSON(JSON.parse(JSON.stringify(changedLinesToJSON(lines)))), lines);
});

test('trailers: last paragraph only; Co-Authored-By case-insensitive', () => {
  const msg = 'feat: x\n\nBody line: not a trailer\n\nCo-Authored-By: Claude Opus <noreply@example.invalid>\nco-authored-by: Some Human <h@example.invalid>\nSigned-off-by: A <a@example.invalid>';
  assert.deepEqual(coAuthors(msg), ['Claude Opus <noreply@example.invalid>', 'Some Human <h@example.invalid>']);
  assert.equal(parseTrailers(msg).length, 3);
  assert.deepEqual(parseTrailers('subject only: no body'), []);
});

test('range diff cancels an add-then-revert; archive has the tree without .git', async () => {
  const dir = join(tempDir('square2-rd-'), 'repo');
  mkdirSync(dir, { recursive: true });
  g(dir, ['init', '--quiet']);
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  g(dir, ['add', '-A']);
  g(dir, ['commit', '--quiet', '-m', 'base']);
  const base = g(dir, ['rev-parse', 'HEAD']).trim();
  writeFileSync(join(dir, 'a.txt'), 'one\ntemporary\n');
  g(dir, ['commit', '--quiet', '-am', 'add']);
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  writeFileSync(join(dir, 'b.txt'), 'kept\n');
  g(dir, ['add', '-A']);
  g(dir, ['commit', '--quiet', '-m', 'revert and add b']);
  const diff = await rangeDiff(dir, base, 'HEAD');
  assert.doesNotMatch(diff, /temporary/);
  assert.match(diff, /\+kept/);
  assert.equal(changedLineCount(diff), 1);
  assert.equal((await commitsInRange(dir, base, 'HEAD')).length, 2);
  const out = join(tempDir('square2-arc-'), 'tree.tar');
  const arc = await archiveTree(dir, g(dir, ['rev-parse', 'HEAD']).trim(), out);
  const list = spawnSync('tar', ['-tf', arc.path], { encoding: 'utf8' }).stdout.trim().split('\n').sort();
  assert.deepEqual(list, ['a.txt', 'b.txt']);
  assert.match(arc.sha256, /^[0-9a-f]{64}$/);
});
