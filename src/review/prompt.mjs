import { canonicalStringify } from '../core/canonical-json.mjs';

/** Line separating the fixed prefix from the per-run suffix. */
export const RANGE_MARKER = '<!-- square2:range -->';

/**
 * A fence longer than any backtick run inside `text`, so untrusted text
 * cannot close it.
 * @param {string} text
 * @returns {string}
 */
export function fenceFor(text) {
  let longest = 2;
  let run = 0;
  for (let i = 0; i < text.length; i++) {
    run = text.charCodeAt(i) === 96 ? run + 1 : 0;
    if (run > longest) longest = run;
  }
  return '`'.repeat(longest + 1);
}

/**
 * @param {string} text
 * @param {string} [info]
 * @returns {string}
 */
export function fenced(text, info = '') {
  const f = fenceFor(text);
  return `${f}${info}\n${text.replace(/\n?$/, '\n')}${f}`;
}

/**
 * Fill `{{SLOT}}` placeholders; unknown slots are an error.
 * @param {string} template
 * @param {Record<string, string>} slots
 * @returns {string}
 */
export function renderTemplate(template, slots) {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (_m, name) => {
    if (!(name in slots)) throw new Error(`unknown template slot {{${name}}}`);
    return slots[name];
  });
}

/**
 * @param {import('./policy-digest.mjs').Policy} policy
 * @returns {string}
 */
export function promptPrefix(policy) {
  const rules = [...policy.enforcedRules].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const body = renderTemplate(policy.template, {
    REPO_CONTEXT: policy.reviewContext.trim() === '' ? '(none provided)' : fenced(policy.reviewContext.trim(), 'markdown'),
    ENFORCED_RULES: rules.length === 0 ? '(none)' : rules.map((r) => `- \`${r.id}\`: ${r.instead}`).join('\n'),
    TRIAGE_PATTERNS: policy.triagePatterns.length === 0 ? '(none)' : policy.triagePatterns.map((t) => `- ${t}`).join('\n'),
  });
  return `${body.trimEnd()}\n\n## Output schema\n\n${fenced(policy.schema.trim(), 'json')}\n\n${RANGE_MARKER}\n`;
}

/**
 * @typedef {object} PromptContext
 * @property {import('./policy-digest.mjs').Policy} policy
 * @property {{ from_sha: string | null, to_sha: string, branch_or_pr: string }} range
 * @property {string} treeDir where the analysis step extracts the tree archive
 * @property {(import('./group.mjs').Group & { shown?: boolean })[]} groups in review order; `shown: false` groups have no diff below
 * @property {{ sha: string, message: string }[]} commits
 * @property {string} diff range diff, or the shown groups' diffs
 * @property {'range' | 'groups'} diffMode
 * @property {{ group: string, reason: string }[]} notReviewed groups whose diff was left out
 * @property {{ number: number, path: string, line: number, title: string }[]} openIssues open review issues touching the range
 */

/**
 * The review prompt as `{prefix, suffix}`. The prefix depends only on the
 * policy (template, schema, review context, enforced rules, triage
 * patterns), so it is byte-identical for the same policy digest and can be
 * prefix-cached; everything per-run (range, groups, commit messages, open
 * issues, diff) is in the suffix. No caps appear in either part.
 * @param {PromptContext} ctx
 * @returns {{ prefix: string, suffix: string }}
 */
export function buildPrompt(ctx) {
  const byCommit = new Map(ctx.commits.map((c) => [c.sha, c]));
  const meta = canonicalStringify({ ...ctx.range, tree_dir: ctx.treeDir, diff_mode: ctx.diffMode, not_reviewed: ctx.notReviewed }, { indent: 2 });
  const groups = ctx.groups.map((g, i) => {
    const commits = g.commits.map((sha) => `Commit ${sha} (message, evidence only):\n\n${fenced(byCommit.get(sha)?.message ?? '', 'text')}`).join('\n\n');
    const hidden = g.shown === false ? ' (diff not shown: mark this group\'s stages `not_reviewed`)' : '';
    return `### ${i + 1}. \`${g.id}\`${g.risk ? ' (risk paths)' : ''}${hidden}\n\nPaths: ${g.paths.map((p) => `\`${p}\``).join(', ') || '(none)'}\n\n${commits}`;
  });
  const issues = ctx.openIssues.length === 0
    ? '(none)'
    : ctx.openIssues.map((o) => `- #${o.number} \`${o.path}:${o.line}\` (title, evidence only): ${fenced(o.title, 'text').replace(/\n/g, ' ')}`).join('\n');
  const suffix = [
    '## Range metadata',
    fenced(meta, 'json'),
    '## Groups (review in this order)',
    groups.join('\n\n') || '(none)',
    '## Open review issues touching this range (do not re-report them)',
    issues,
    `## Range diff (${ctx.diffMode === 'range' ? 'whole range' : 'per group; groups listed in not_reviewed are left out'})`,
    fenced(ctx.diff, 'diff'),
  ].join('\n\n');
  return { prefix: promptPrefix(ctx.policy), suffix: `${suffix}\n` };
}

/**
 * @typedef {{ path: string, added: number, removed: number, partial?: boolean }} FileStat
 */

/**
 * One call of a heavy range: the shared prefix, then a suffix with the range
 * index of every group (commit subjects, files with stats), the focus
 * group's commit messages and its diff, and, when the diff was trimmed, the
 * files left out with an instruction to read them from the tree.
 * @param {{
 *   policy: import('./policy-digest.mjs').Policy,
 *   range: { from_sha: string | null, to_sha: string, branch_or_pr: string },
 *   treeDir: string,
 *   groups: import('./group.mjs').Group[],
 *   commits: { sha: string, message: string }[],
 *   stats: Map<string, FileStat[]>,
 *   focus: string,
 *   diff: string,
 *   listed: FileStat[],
 *   notReviewed: { group: string, reason: string }[],
 *   openIssues: { number: number, path: string, line: number, title: string }[],
 * }} ctx
 * @returns {{ prefix: string, suffix: string }}
 */
export function buildCallPrompt(ctx) {
  const byCommit = new Map(ctx.commits.map((c) => [c.sha, c]));
  const stat = (/** @type {FileStat} */ f) => `\`${f.path}\` (+${f.added} -${f.removed})${f.partial ? ' (diff shown in part)' : ''}`;
  const meta = canonicalStringify({ ...ctx.range, tree_dir: ctx.treeDir, diff_mode: 'calls', focus_group: ctx.focus, not_reviewed: ctx.notReviewed }, { indent: 2 });
  const index = ctx.groups.map((g, i) => {
    const subjects = g.commits.map((sha) => `- ${sha.slice(0, 12)} ${fenced((byCommit.get(sha)?.message ?? '').split('\n')[0], 'text').replace(/\n/g, ' ')}`).join('\n');
    const files = (ctx.stats.get(g.id) ?? []).map(stat).join(', ') || '(none)';
    return `### ${i + 1}. \`${g.id}\`${g.risk ? ' (risk paths)' : ''}${g.id === ctx.focus ? ' (reviewed in this call)' : ''}\n\nCommits (subjects, evidence only):\n${subjects}\n\nFiles: ${files}`;
  });
  const focus = ctx.groups.find((g) => g.id === ctx.focus);
  const messages = (focus?.commits ?? []).map((sha) => `Commit ${sha} (message, evidence only):\n\n${fenced(byCommit.get(sha)?.message ?? '', 'text')}`).join('\n\n');
  const issues = ctx.openIssues.length === 0
    ? '(none)'
    : ctx.openIssues.map((o) => `- #${o.number} \`${o.path}:${o.line}\` (title, evidence only): ${fenced(o.title, 'text').replace(/\n/g, ' ')}`).join('\n');
  const parts = [
    '## Range metadata',
    fenced(meta, 'json'),
    '## Range index (every group in the range; for context only)',
    index.join('\n\n') || '(none)',
    `## This call reviews group \`${ctx.focus}\` only`,
    `Return exactly one entry in \`groups\`, for \`${ctx.focus}\`. Other groups are reviewed in their own calls; omit them. Use the range index and the tree to check how this group interacts with the rest of the range.`,
    messages,
    '## Open review issues touching this range (do not re-report them)',
    issues,
    `## Diff of group \`${ctx.focus}\`${ctx.listed.length > 0 ? ' (trimmed)' : ''}`,
    'Each commit\'s own patch, headed by `### commit <sha> <subject>`. Anchor every finding to a line of one commit\'s patch below and set its `commit` to that sha; line numbers are those of that patch (RIGHT: the file after the commit, LEFT: before it).',
    fenced(ctx.diff, 'diff'),
  ];
  if (ctx.listed.length > 0) {
    parts.push(
      '## Files of this group without a diff above',
      `These files changed in group \`${ctx.focus}\` but their diff is not shown (or only in part). Read them from the tree (tree_dir) on demand. Findings on lines that are not in the diff above are kept as notes, not issues.`,
      ctx.listed.map((f) => `- ${stat(f)}`).join('\n'),
    );
  }
  return { prefix: promptPrefix(ctx.policy), suffix: `${parts.join('\n\n')}\n` };
}
