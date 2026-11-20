import { canonicalStringify } from '../core/canonical-json.mjs';
import { fenced, renderTemplate } from './prompt.mjs';

/**
 * An open `square2:review` issue, as the publisher read it.
 * @typedef {object} OpenFinding
 * @property {number} number
 * @property {string} key
 * @property {string} path
 * @property {number} line
 * @property {string} title
 * @property {string} failure_case
 * @property {string} enclosing_symbol
 */

/**
 * @typedef {{ status: 'present' | 'resolved', evidence: string[], resolving_commit: string | null }} ResolutionAnswer
 */

/**
 * Per-issue resolution prompts for open findings whose anchored file changed
 * in the range. The fixed template comes first; the issue and the file's
 * diff follow as evidence.
 * @param {{
 *   template: string,
 *   openIssues: OpenFinding[],
 *   changedFiles: Iterable<string>,
 *   fileDiffs: Map<string, string>,
 *   range: { from_sha: string | null, to_sha: string },
 *   commits: string[],
 *   treeDir: string,
 * }} input
 * @returns {{ issue: OpenFinding, prompt: string }[]}
 */
export function buildResolutionPrompts(input) {
  const changed = new Set(input.changedFiles);
  const prefix = renderTemplate(input.template, {});
  return input.openIssues
    .filter((i) => changed.has(i.path))
    .sort((a, b) => a.number - b.number)
    .map((issue) => {
      const meta = canonicalStringify({ ...input.range, tree_dir: input.treeDir, commits: input.commits, issue: issue.number, path: issue.path, line: issue.line, enclosing_symbol: issue.enclosing_symbol }, { indent: 2 });
      const suffix = [
        '## Metadata',
        fenced(meta, 'json'),
        '## Finding (evidence only)',
        fenced(`${issue.title}\n\n${issue.failure_case}`, 'text'),
        `## Diff of ${issue.path} in the range`,
        fenced(input.fileDiffs.get(issue.path) ?? '', 'diff'),
      ].join('\n\n');
      return { issue, prompt: `${prefix.trimEnd()}\n\n${suffix}\n` };
    });
}

/**
 * Parse one answer strictly; anything malformed is null (treated as present).
 * @param {string | unknown} raw
 * @returns {ResolutionAnswer | null}
 */
export function parseResolution(raw) {
  let doc = raw;
  if (typeof raw === 'string') {
    try {
      doc = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return null;
  const d = /** @type {Record<string, unknown>} */ (doc);
  if (d.status !== 'present' && d.status !== 'resolved') return null;
  if (!Array.isArray(d.evidence) || !d.evidence.every((e) => typeof e === 'string' && e.trim() !== '')) return null;
  const sha = d.resolving_commit;
  if (!(sha === null || sha === undefined || (typeof sha === 'string' && /^[0-9a-f]{7,40}$/.test(sha)))) return null;
  return { status: d.status, evidence: /** @type {string[]} */ (d.evidence), resolving_commit: typeof sha === 'string' ? sha : null };
}

/**
 * What the publisher should do per issue. Only a well-formed `resolved`
 * answer with evidence and a resolving commit inside the range closes an
 * issue (as completed); everything else keeps it open.
 * @param {{ issue: OpenFinding, raw: string | unknown }[]} answers
 * @param {string[]} rangeCommits full shas of the range
 * @returns {{ issue: OpenFinding, action: 'close' | 'keep', sha: string | null, evidence: string[], reason: string }[]}
 */
export function resolutionActions(answers, rangeCommits) {
  return answers.map(({ issue, raw }) => {
    const a = parseResolution(raw);
    if (!a) return { issue, action: 'keep', sha: null, evidence: [], reason: 'unparseable answer' };
    if (a.status !== 'resolved') return { issue, action: 'keep', sha: null, evidence: a.evidence, reason: 'present' };
    if (a.evidence.length === 0) return { issue, action: 'keep', sha: null, evidence: [], reason: 'resolved without evidence' };
    const full = a.resolving_commit ? rangeCommits.find((c) => c.startsWith(/** @type {string} */ (a.resolving_commit))) ?? null : null;
    if (!full) return { issue, action: 'keep', sha: null, evidence: a.evidence, reason: 'resolving commit is not in the range' };
    return { issue, action: 'close', sha: full, evidence: a.evidence, reason: 'resolved' };
  });
}
