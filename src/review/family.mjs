import { parseTrailers } from '../git/trailers.mjs';

/** Default author-name → model family map (design D10). */
export const DEFAULT_FAMILIES = Object.freeze([
  { family: 'anthropic', pattern: /\b(?:claude|anthropic)\b/i },
  { family: 'openai', pattern: /\b(?:codex|gpt[\w.-]*|openai)\b/i },
  { family: 'google', pattern: /\b(?:gemini|antigravity|agy)\b/i },
]);

/** Trailers whose values name the writers of a commit, unless configured otherwise. */
export const DEFAULT_AUTHOR_TRAILERS = Object.freeze(['Co-Authored-By']);

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
 * Sorted, unique author families from the values of the commits' author
 * trailers (keys compared case-insensitively; a value may list several
 * writers separated by commas or semicolons).
 * @param {{ message: string }[]} commits
 * @param {readonly { family: string, pattern: RegExp }[]} [map]
 * @param {readonly string[]} [trailers]
 * @returns {string[]}
 */
export function authorFamilies(commits, map = DEFAULT_FAMILIES, trailers = DEFAULT_AUTHOR_TRAILERS) {
  const keys = new Set(trailers.map((t) => t.toLowerCase()));
  const set = new Set();
  for (const c of commits) {
    for (const t of parseTrailers(c.message)) {
      if (!keys.has(t.key.toLowerCase())) continue;
      for (const part of t.value.split(/[,;]/)) for (const m of map) if (m.pattern.test(part)) set.add(m.family);
    }
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
