import { globMatch } from '../core/exceptions.mjs';

/**
 * @typedef {object} Group
 * @property {string} id `change:<id>`, `merge:<sha>` or `commit:<sha>`
 * @property {'change' | 'merge' | 'commit'} kind
 * @property {string[]} commits shas, oldest first
 * @property {string[]} paths touched paths (sorted, unique)
 * @property {boolean} risk touches a configured risk path
 */

const ID = '[a-z0-9]+(?:-[a-z0-9]+)+';
/** Secondary signal: the commit message names `openspec/changes/<id>` or `change <id>` literally. */
export const CHANGE_ID_PATTERN = new RegExp(`(?:\\bopenspec/changes/(${ID})\\b|\\bchange (${ID})\\b)`);
const CHANGE_DIR = new RegExp(`^openspec/changes/(?:archive/\\d{4}-\\d{2}-\\d{2}-)?(${ID})/`);

/**
 * The openspec change a commit belongs to: the change directory it touches
 * most (`openspec/changes/<id>/**` or `openspec/changes/archive/<date>-<id>/**`),
 * else a literal mention in the message, else null.
 * @param {{ message: string, paths: string[] }} commit
 * @param {RegExp} [pattern]
 * @returns {string | null}
 */
export function changeIdOf(commit, pattern = CHANGE_ID_PATTERN) {
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const p of commit.paths) {
    const m = CHANGE_DIR.exec(p);
    if (m && m[1] !== 'archive') counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
  }
  if (counts.size > 0) return [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0][0];
  const m = pattern.exec(commit.message);
  return m ? (m[1] ?? m[2] ?? null) : null;
}

/**
 * Group the range's commits: by openspec change id found in the message;
 * else by the first-parent merge that brought the commit in; else one group
 * per commit. Groups touching `riskPaths` come first, then range order.
 * @param {{
 *   commits: (import('../git/diff.mjs').Commit & { paths: string[] })[],
 *   merges: Map<string, string[]>,
 *   riskPaths: string[],
 *   changeIdPattern?: RegExp,
 * }} input `merges` maps each first-parent merge sha to the shas it brought in
 * @returns {Group[]}
 */
export function groupCommits(input) {
  const pattern = input.changeIdPattern ?? CHANGE_ID_PATTERN;
  /** @type {Map<string, string>} */
  const mergeOf = new Map();
  for (const [merge, members] of input.merges) {
    mergeOf.set(merge, merge);
    for (const m of members) if (!mergeOf.has(m)) mergeOf.set(m, merge);
  }
  /** @type {Map<string, Group & { order: number }>} */
  const groups = new Map();
  input.commits.forEach((c, order) => {
    const change = changeIdOf(c, pattern);
    /** @type {Group['kind']} */
    let kind = 'commit';
    let id = `commit:${c.sha}`;
    if (change) {
      kind = 'change';
      id = `change:${change}`;
    } else if (mergeOf.has(c.sha)) {
      kind = 'merge';
      id = `merge:${mergeOf.get(c.sha)}`;
    }
    const g = groups.get(id) ?? { id, kind, commits: [], paths: [], risk: false, order };
    g.commits.push(c.sha);
    g.paths = [...new Set([...g.paths, ...c.paths])].sort();
    groups.set(id, g);
  });
  const list = [...groups.values()].map((g) => ({ ...g, risk: g.paths.some((p) => input.riskPaths.some((r) => globMatch(r, p))) }));
  list.sort((a, b) => Number(b.risk) - Number(a.risk) || a.order - b.order);
  return list.map(({ order: _o, ...g }) => g);
}
