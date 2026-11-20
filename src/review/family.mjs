import { coAuthors } from '../git/trailers.mjs';

/** Default author-name → model family map (design D10). */
export const DEFAULT_FAMILIES = Object.freeze([
  { family: 'anthropic', pattern: /\b(?:claude|anthropic)\b/i },
  { family: 'openai', pattern: /\b(?:codex|gpt[\w.-]*|openai)\b/i },
  { family: 'google', pattern: /\b(?:gemini|antigravity)\b/i },
]);

/**
 * @typedef {{ family: string, provider?: string, model: string }} Reviewer
 */

/**
 * Model family of a `Co-Authored-By` value, or null for humans and unknown tools.
 * @param {string} name
 * @param {readonly { family: string, pattern: RegExp }[]} [map]
 * @returns {string | null}
 */
export function familyOf(name, map = DEFAULT_FAMILIES) {
  return map.find((m) => m.pattern.test(name))?.family ?? null;
}

/**
 * Sorted, unique author families from the commits' `Co-Authored-By` trailers.
 * @param {{ message: string }[]} commits
 * @param {readonly { family: string, pattern: RegExp }[]} [map]
 * @returns {string[]}
 */
export function authorFamilies(commits, map = DEFAULT_FAMILIES) {
  const set = new Set();
  for (const c of commits) for (const a of coAuthors(c.message)) {
    const f = familyOf(a, map);
    if (f) set.add(f);
  }
  return [...set].sort();
}

/**
 * The first configured reviewer whose family is not among the author
 * families; if none qualifies, the primary reviewer with `sameFamily: true`.
 * @param {Reviewer[]} reviewers configured order, primary first
 * @param {string[]} families author families
 * @returns {{ reviewer: Reviewer, sameFamily: boolean }}
 */
export function selectReviewer(reviewers, families) {
  if (reviewers.length === 0) throw new Error('no reviewer configured');
  const other = reviewers.find((r) => !families.includes(r.family));
  return other ? { reviewer: other, sameFamily: false } : { reviewer: reviewers[0], sameFamily: true };
}
