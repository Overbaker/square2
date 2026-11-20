/**
 * Changed lines of a unified diff, rename-aware (ported from a PR review
 * script). With `--unified=0` every line in each hunk range is changed. The
 * new filename is used for renamed files on both sides, matching how review
 * comments anchor.
 */

/**
 * @typedef {{ LEFT: [number, number][], RIGHT: [number, number][] }} SideRanges
 * @typedef {Map<string, SideRanges>} ChangedLines
 */

const C_ESCAPES = /** @type {Record<string, number>} */ ({ a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 });

/**
 * Decode a C-quoted git path (`"a\tb"`, `"\303\251"`); unquoted paths pass through.
 * @param {string} value
 * @returns {string}
 */
export function unquoteGitPath(value) {
  if (!value.startsWith('"')) return value;
  /** @type {number[]} */
  const bytes = [];
  for (let i = 1; i < value.length; i++) {
    const ch = value[i];
    if (ch === '"') break;
    if (ch !== '\\') {
      for (const b of Buffer.from(ch, 'utf8')) bytes.push(b);
      continue;
    }
    const next = value[i + 1];
    if (/[0-7]/.test(next)) {
      bytes.push(parseInt(value.slice(i + 1, i + 4), 8));
      i += 3;
    } else if (next in C_ESCAPES) {
      bytes.push(C_ESCAPES[next]);
      i += 1;
    } else {
      throw new Error(`invalid escape in quoted path ${value}`);
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

/**
 * @param {string} value text after `--- ` / `+++ `
 * @returns {string | null}
 */
function decodeHeaderPath(value) {
  // Git appends a tab to ambiguous unquoted headers (e.g. trailing spaces);
  // literal tabs in filenames are C-quoted instead.
  const raw = value.startsWith('"') ? value : value.split('\t', 1)[0];
  const decoded = unquoteGitPath(raw);
  return decoded === '/dev/null' ? null : decoded.replace(/^[ab]\//, '');
}

/**
 * @param {string} diff unified diff (any context; use `--unified=0` for exact changed lines)
 * @returns {ChangedLines}
 */
export function changedLines(diff) {
  /** @type {ChangedLines} */
  const files = new Map();
  /** @type {string | null} */
  let oldPath = null;
  /** @type {string | null} */
  let newPath = null;
  let inHunks = false;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      oldPath = newPath = null;
      inHunks = false;
    } else if (!inHunks && line.startsWith('--- ')) {
      oldPath = decodeHeaderPath(line.slice(4));
    } else if (!inHunks && line.startsWith('+++ ')) {
      newPath = decodeHeaderPath(line.slice(4));
    } else {
      const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!hunk) continue;
      inHunks = true;
      const filename = newPath ?? oldPath;
      if (!filename) throw new Error('diff hunk has no filename');
      const ranges = files.get(filename) ?? { LEFT: [], RIGHT: [] };
      for (const [side, start, count] of /** @type {const} */ ([
        ['LEFT', Number(hunk[1]), Number(hunk[2] ?? 1)],
        ['RIGHT', Number(hunk[3]), Number(hunk[4] ?? 1)],
      ])) {
        if (count) ranges[side].push([start, start + count - 1]);
      }
      files.set(filename, ranges);
    }
  }
  return files;
}

/**
 * @param {ChangedLines} lines
 * @param {string} path
 * @param {'LEFT' | 'RIGHT'} side
 * @param {number} line
 * @returns {boolean}
 */
export function isChangedLine(lines, path, side, line) {
  const ranges = lines.get(path);
  return Boolean(ranges && ranges[side].some(([a, b]) => line >= a && line <= b));
}

/**
 * @param {ChangedLines} lines
 * @returns {Record<string, SideRanges>}
 */
export function changedLinesToJSON(lines) {
  return Object.fromEntries([...lines].sort((a, b) => (a[0] < b[0] ? -1 : 1)));
}

/**
 * @param {Record<string, SideRanges>} json
 * @returns {ChangedLines}
 */
export function changedLinesFromJSON(json) {
  return new Map(Object.entries(json));
}

/**
 * Exactly the added (`RIGHT`) and removed (`LEFT`) lines a unified diff
 * shows, at any context size; context lines are not included. Used to
 * anchor findings against what the model actually saw.
 * @param {string} diff
 * @returns {ChangedLines}
 */
export function shownLines(diff) {
  /** @type {ChangedLines} */
  const files = new Map();
  /** @type {string | null} */
  let oldPath = null;
  /** @type {string | null} */
  let newPath = null;
  let inHunks = false;
  let left = 0;
  let right = 0;
  /** @type {SideRanges | null} */
  let ranges = null;
  /** @param {[number, number][]} list @param {number} n */
  const add = (list, n) => {
    const last = list[list.length - 1];
    if (last && last[1] === n - 1) last[1] = n;
    else list.push([n, n]);
  };
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      oldPath = newPath = null;
      inHunks = false;
      ranges = null;
      continue;
    }
    if (!inHunks && line.startsWith('--- ')) {
      oldPath = decodeHeaderPath(line.slice(4));
      continue;
    }
    if (!inHunks && line.startsWith('+++ ')) {
      newPath = decodeHeaderPath(line.slice(4));
      continue;
    }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      inHunks = true;
      left = Number(hunk[1]);
      right = Number(hunk[2]);
      const filename = newPath ?? oldPath;
      if (!filename) throw new Error('diff hunk has no filename');
      ranges = files.get(filename) ?? { LEFT: [], RIGHT: [] };
      files.set(filename, ranges);
      continue;
    }
    if (!inHunks || !ranges) continue;
    if (line.startsWith('+')) add(ranges.RIGHT, right++);
    else if (line.startsWith('-')) add(ranges.LEFT, left++);
    else if (line.startsWith(' ')) {
      left++;
      right++;
    }
  }
  return files;
}
