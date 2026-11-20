/**
 * The single source of every text square² publishes: finding issues (review
 * and gate), their comments, rule-candidate comments, the run digest, the
 * overflow note and the step summary, in English or Chinese. Templates only;
 * model text is sanitised before it is used.
 */

/** Shapes of credentials that must never be published. */
export const SECRET_PATTERNS = Object.freeze([
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{60,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bASIA[0-9A-Z]{16}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}\b/,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  /\b(?:api[_-]?key|secret|password|token)\s*[:=]\s*["']?[A-Za-z0-9+/_\-]{24,}/i,
  /\bAccountKey=[A-Za-z0-9+/=]{40,}/,
]);

/** Prefixed credential shapes, also checked on joined neighbouring words (key=value and key-name shapes are not: prose would match). */
const WINDOW_PATTERNS = Object.freeze(SECRET_PATTERNS.filter((p) => !/password|AccountKey/.test(p.source)));

/** Shape-only patterns: checked on the text as written, never on its separator-free form (prose would match). */
const SHAPE_PATTERNS = Object.freeze([
  /(?<![A-Za-z0-9])[A-Za-z0-9]{84}(?![A-Za-z0-9])/,
]);

/**
 * The text as a secret check sees it: NFKC, then every control and format
 * character (Cc, Cf: zero-width and bidi marks, soft hyphen, BOM, word
 * joiners) removed; line breaks and tabs become spaces.
 * @param {string} text
 * @returns {string}
 */
export function normalizeForSecrets(text) {
  return text.normalize('NFKC').replace(/[\t\n\r\v\f]/g, ' ').replace(/[\p{Cc}\p{Cf}]/gu, '');
}

/** Per-field length caps for model text in issues. */
export const FIELD_CAPS = Object.freeze({ title: 200, body: 4000, failure_case: 4000, suggestion: 4000, evidence: 2000 });
/** GitHub rejects bodies over 65536 characters; stay well below. */
export const MAX_BODY = 60000;
const MAX_EVIDENCE_ITEMS = 20;

/**
 * Truncate to `max` characters with a note saying how much was cut.
 * @param {string} text
 * @param {number} max
 * @returns {string}
 */
export function capText(text, max) {
  if (text.length <= max) return text;
  const cut = text.length - max;
  return `${text.slice(0, max)}… [truncated ${cut} characters]`;
}

export class SecretError extends Error {}

/**
 * @param {string} text
 * @returns {boolean}
 */
export function looksSecret(text) {
  const norm = normalizeForSecrets(text);
  for (const t of new Set([text, norm])) {
    if (SECRET_PATTERNS.some((p) => p.test(t)) || SHAPE_PATTERNS.some((p) => p.test(t))) return true;
    for (const m of t.matchAll(/(?<![0-9A-Fa-f])[0-9a-f]{32}(?![0-9A-Fa-f])/g)) {
      const at = m.index ?? 0;
      const near = t.slice(Math.max(0, at - 40), at) + t.slice(at + 32, at + 72);
      if (/key|secret|token|api/i.test(near)) return true;
    }
  }
  // a prefixed credential split into up to four pieces by spaces, dashes, dots or colons is still one
  const words = norm.split(/\s+/).filter((w) => w !== '');
  for (let i = 0; i < words.length; i++) {
    const joined = words.slice(i, i + 4).join('');
    if (WINDOW_PATTERNS.some((p) => p.test(joined) || p.test(joined.replace(/[-.:/]+/g, '')))) return true;
  }
  return false;
}

/**
 * Neutralise every mention (a zero-width space after the at sign), so finding
 * issues and their comments never notify anyone.
 * @param {string} text
 * @returns {string}
 */
export function noMentions(text) {
  return text.replace(/@(?=[A-Za-z0-9_-])/g, '@​');
}

/**
 * True when the text would mention someone on GitHub.
 * @param {string} text
 * @returns {boolean}
 */
export function hasMention(text) {
  return /(^|[^A-Za-z0-9_`​])@[A-Za-z0-9]/.test(text);
}

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\/[A-Za-z0-9._-]+)?$/;

/**
 * Valid logins (or org/team) from config `notify`, deduplicated, in order.
 * @param {unknown} notify
 * @returns {string[]}
 */
export function notifyLogins(notify) {
  if (!Array.isArray(notify)) return [];
  /** @type {string[]} */
  const out = [];
  for (const n of notify) {
    if (typeof n !== 'string') continue;
    const login = n.trim().replace(/^@/, '');
    if (LOGIN.test(login) && !out.includes(login)) out.push(login);
  }
  return out;
}

const ZWJ = '\u200d';

/**
 * Control characters, bidi overrides and zero-width characters removed;
 * CR/LF normalised, tabs and line/paragraph separators to spaces.
 * @param {string} text
 * @returns {string}
 */
export function stripControls(text) {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[\t\u2028\u2029]/g, ' ')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g, '');
}

/**
 * Issue references (`#12`, `owner/repo#12`, `GH-12`) and mentions (`@x`)
 * neutralised with a zero-width joiner.
 * @param {string} text
 * @returns {string}
 */
function neutralise(text) {
  return text.replace(/#(?=\d)/g, `#${ZWJ}`).replace(/\bGH-(?=\d)/gi, (m) => `${m.slice(0, 2)}${ZWJ}-`).replace(/@(?=[A-Za-z0-9_-])/g, `@${ZWJ}`);
}

/**
 * Model text as fully escaped Markdown, for use outside any code fence or
 * span: throws SecretError for secret-shaped text; control characters
 * stripped; every autolink form (`scheme://`, `www.`, e-mail) neutralised
 * with a zero-width joiner; HTML `& < >` as entities; every Markdown
 * control character (`` \ ` * _ ~ | [ ] ( ) ! `` and `#`) backslash-escaped;
 * line-leading indentation and list/heading/rule markers neutralised;
 * references and mentions neutralised with a zero-width joiner. Code from
 * the model is shown this way too, never fenced.
 * @param {string} text
 * @returns {string}
 */
export function escapeMd(text) {
  if (looksSecret(text)) throw new SecretError('text contains a secret-shaped string');
  const t = stripControls(text)
    .replace(/:\/\//g, `://${ZWJ}`)
    .replace(/(w)(w)(w)(?=\.)/gi, `$1$2$3${ZWJ}`)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/[\\`*_~|[\]()!#]/g, '\\$&')
    .split('\n')
    .map((l) => l.replace(/^[ ]+/, '').replace(/^([-+=])/, '\\$1').replace(/^(\d+)([.)])/, '$1\\$2'))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
  return neutralise(t);
}

/** Back-compatible name: all model text is escaped (see escapeMd). */
export const sanitize = escapeMd;

/**
 * Escaped single-line text (paths, symbols, group ids) for inline use.
 * @param {string} text
 * @returns {string}
 */
export function sanitizeCode(text) {
  return escapeMd(text.replace(/[\r\n]+/g, ' ').slice(0, 300));
}

/**
 * An issue title: plain text (titles are not Markdown), secret check,
 * control characters stripped, one line, mentions and references
 * neutralised, no HTML entities.
 * @param {string} text
 * @returns {string}
 */
export function titleText(text) {
  if (looksSecret(text)) throw new SecretError('text contains a secret-shaped string');
  return neutralise(stripControls(text).replace(/\s+/g, ' ').trim());
}

/**
 * Model text that must keep its exact characters (rule YAML, fixture
 * files): an HTML `<pre>` block with `& < >` and backticks as entities, so it renders
 * verbatim, cannot break out, and Markdown inside is not interpreted.
 * @param {string} text
 * @returns {string}
 */
export function preBlock(text) {
  if (looksSecret(text)) throw new SecretError('text contains a secret-shaped string');
  const body = stripControls(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/`/g, '&#96;').replace(/@(?=[A-Za-z0-9_-])/g, `@${ZWJ}`);
  return `<pre>${body.replace(/\n?$/, '')}</pre>`;
}

/** @param {string} sha @returns {string} a sha as is, or the escaped text */
function plainSha(sha) {
  return /^[0-9a-f]{7,64}$/.test(sha) ? sha : escapeMd(sha);
}

/** @param {string} sha @returns {string} a sha in a code span, or the escaped text */
function shaText(sha) {
  return /^[0-9a-f]{7,64}$/.test(sha) ? `\`${sha}\`` : escapeMd(sha);
}

const LABELS = /** @type {const} */ ({
  en: {
    severity: 'Severity', location: 'Location', symbol: 'Symbol', range: 'Range', group: 'Group', commit: 'Commit',
    failure: 'Failure case', suggestion: 'Suggested fix', evidence: 'Evidence', details: 'Details', mechanizable: 'mechanizable',
    advisory: 'Advisory finding from the square² range review. It does not gate anything.',
    rule: 'Rule', where: 'Where', fingerprint: 'Fingerprint', overBaseline: 'over baseline',
    reappeared: 'reappeared in', seen: 'Seen again in range', resolved: 'resolved in',
    digestHead: (/** @type {string} */ kind, /** @type {boolean} */ test, /** @type {string} */ branch, /** @type {string} */ sha, /** @type {number} */ n) => `square² ${kind}${test ? ' (test)' : ''} on \`${branch}\` at \`${sha}\`: ${n} issue(s) changed.`,
    table: '| action | issue | severity / rule | commit |',
    demoted: 'demoted (outside changed lines)', rejected: 'not published (secret-shaped text)', candidatesDropped: (/** @type {string} */ why) => `candidates dropped (${why})`, capped: 'not filed (over the run finding cap)', questions: 'Questions', suggestions: 'Suggestions',
    notes: 'Notes on files whose diff was not shown (not filed as issues)',
    sameFamily: 'Reviewed by the same model family as the authors (no alternative configured).',
    moreItems: (/** @type {number} */ n) => `(${n} more questions, suggestions or notes not shown)`,
    digestTruncated: (/** @type {number} */ n) => `… [digest truncated: ${n} characters]`,
    usage: 'Usage', tokens: 'tokens', input: 'input', cached: 'cached', output: 'output', cost: 'estimated cost',
    overflow: (/** @type {number} */ n, /** @type {number} */ cap) => `square²: ${n} finding(s) not filed because the run reached max_new_issues_per_run (${cap}):`,
    candidate: (/** @type {string} */ id, /** @type {string} */ label) => `Rule candidate \`${id}\` (label ${label}; never enabled automatically). Replay: fires on born_from, not on its parent.`,
  },
  zh: {
    severity: '严重程度', location: '位置', symbol: '符号', range: '范围', group: '分组', commit: '提交',
    failure: '失败场景', suggestion: '修复建议', evidence: '证据', details: '说明', mechanizable: '可规则化',
    advisory: '来自 square² 范围评审的建议性发现，不影响门禁。',
    rule: '规则', where: '位置', fingerprint: '指纹', overBaseline: '超出基线',
    reappeared: 'reappeared in', seen: '在新范围中再次发现', resolved: 'resolved in',
    digestHead: (/** @type {string} */ kind, /** @type {boolean} */ test, /** @type {string} */ branch, /** @type {string} */ sha, /** @type {number} */ n) => `square² ${kind}${test ? '（测试）' : ''}：\`${branch}\` @ \`${sha}\`，${n} 个议题有变化。`,
    table: '| action | issue | severity / rule | commit |',
    demoted: '降级（不在变更行内）', rejected: '未发布（含疑似密钥文本）', candidatesDropped: (/** @type {string} */ why) => `candidates dropped (${why})`, capped: '未建议题（超出本次运行发现上限）', questions: '问题', suggestions: '建议',
    notes: '未展示差异的文件上的备注（未建议题）',
    sameFamily: '评审模型与作者属于同一模型家族（未配置其他选择）。',
    moreItems: (/** @type {number} */ n) => `（另有 ${n} 条问题、建议或备注未显示）`,
    digestTruncated: (/** @type {number} */ n) => `…［摘要已截断：${n} 个字符］`,
    usage: '用量', tokens: '令牌', input: '输入', cached: '缓存', output: '输出', cost: '估算费用',
    overflow: (/** @type {number} */ n, /** @type {number} */ cap) => `square²：本次运行达到 max_new_issues_per_run（${cap}），${n} 个发现未建议题：`,
    candidate: (/** @type {string} */ id, /** @type {string} */ label) => `规则候选 \`${id}\`（标签 ${label}；不会自动启用）。回放：在 born_from 触发，在父提交上不触发。`,
  },
});

/**
 * @param {string | undefined} language
 */
function L(language) {
  return language === 'zh' ? LABELS.zh : LABELS.en;
}

/**
 * Hidden marker that identifies an issue by finding key.
 * @param {string} key
 * @returns {string}
 */
export function findingMarker(key) {
  if (!/^[^\s>]+$/.test(key)) throw new Error('finding key must be a token without spaces');
  return `<!-- square2:finding:${key} -->`;
}

/**
 * @typedef {{ path: string, line: number, side: string, enclosing_symbol: string, title: string, failure_case: string, mechanizable: boolean, commit: string | null }} Target
 */

/**
 * Machine-readable anchor of a review finding, read back by the next run
 * (open-issue targets, the resolution pass, rule candidates).
 * @param {{ path: string, line: number, side?: string, enclosing_symbol?: string, title: string, failure_case?: string, mechanizable?: boolean, commit?: string }} f
 * @returns {string}
 */
export function targetMarker(f) {
  /** @type {Target} */
  const t = { path: f.path, line: f.line, side: f.side ?? 'RIGHT', enclosing_symbol: f.enclosing_symbol ?? '<file>', title: f.title, failure_case: capText(f.failure_case ?? '', 1000), mechanizable: f.mechanizable === true, commit: typeof f.commit === 'string' ? f.commit : null };
  return `<!-- square2:target:${Buffer.from(JSON.stringify(t), 'utf8').toString('base64url')} -->`;
}

/**
 * @param {string} body
 * @returns {Target | null}
 */
export function parseTarget(body) {
  const m = /<!-- square2:target:([A-Za-z0-9_-]+) -->/.exec(body);
  if (!m) return null;
  try {
    const t = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8'));
    if (t && typeof t.path === 'string' && Number.isSafeInteger(t.line) && typeof t.title === 'string') return t;
  } catch {
    // ignore
  }
  return null;
}

/**
 * @param {string} text
 * @returns {string}
 */
function quote(text) {
  return text.split('\n').map((l) => `> ${l}`).join('\n');
}

/**
 * @param {string} s
 * @param {number} n
 * @returns {string}
 */
export function clip(s, n) {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length <= n ? one : `${one.slice(0, n - 1)}…`;
}

/**
 * @param {{ from_sha?: string | null, to_sha?: string }} r
 * @returns {string}
 */
function rangeText(r) {
  return `\`${(r.from_sha ?? '').slice(0, 12) || '∅'}..${(r.to_sha ?? '').slice(0, 12)}\``;
}

/**
 * Title, body (without markers; the publisher adds them) and labels of a
 * review finding issue. No mentions; the digest notifies. Throws SecretError
 * for secret-shaped model text.
 * @param {{ severity: string, path: string, line: number, side?: string, title: string, failure_case?: string, suggestion?: string, enclosing_symbol?: string, mechanizable?: boolean, evidence?: string[], body?: string, group?: string, commit?: string }} f
 * @param {{ language?: 'en' | 'zh', range: { from_sha?: string | null, to_sha?: string } }} ctx
 * @returns {{ title: string, body: string, labels: string[] }}
 */
export function renderReviewIssue(f, ctx) {
  const t = L(ctx.language);
  const commit = f.commit ?? ctx.range.to_sha ?? '';
  const cap = (/** @type {string | undefined} */ v, /** @type {number} */ n) => sanitize(capText(v ?? '', n));
  const lines = [
    `_${t.advisory}_`,
    '',
    `**${t.severity}:** ${escapeMd(String(f.severity))} · **${t.location}:** ${sanitizeCode(f.path)}:${Number(f.line)} (${f.side === 'LEFT' ? 'LEFT' : 'RIGHT'}) · **${t.symbol}:** ${sanitizeCode(f.enclosing_symbol ?? '<file>')}`,
    `**${t.commit}:** ${shaText(commit)} · **${t.range}:** ${rangeText(ctx.range)}${f.group ? ` · **${t.group}:** ${sanitizeCode(f.group)}` : ''}${f.mechanizable ? ` · ${t.mechanizable}` : ''}`,
  ];
  if (typeof f.body === 'string' && f.body.trim() !== '') lines.push('', `### ${t.details}`, '', cap(f.body, FIELD_CAPS.body));
  lines.push('', `### ${t.failure}`, '', quote(cap(f.failure_case, FIELD_CAPS.failure_case)), '', `### ${t.suggestion}`, '', cap(f.suggestion, FIELD_CAPS.suggestion));
  if (Array.isArray(f.evidence) && f.evidence.length > 0) {
    const ev = f.evidence.slice(0, MAX_EVIDENCE_ITEMS).map((e) => `- ${cap(e, FIELD_CAPS.evidence)}`);
    if (f.evidence.length > MAX_EVIDENCE_ITEMS) ev.push(`- … [${f.evidence.length - MAX_EVIDENCE_ITEMS} more evidence items truncated]`);
    lines.push('', `### ${t.evidence}`, '', ...ev);
  }
  return { title: clip(titleText(capText(f.title, FIELD_CAPS.title)), FIELD_CAPS.title + 40), body: capBody(`${lines.join('\n')}\n`), labels: ['square2', 'square2:review', `sev:${f.severity.toLowerCase()}`] };
}

/**
 * Hard cap for a whole issue body (the publisher adds a few hundred characters of markers).
 * @param {string} body
 * @returns {string}
 */
export function capBody(body) {
  return body.length <= MAX_BODY ? body : `${body.slice(0, MAX_BODY - 200)}\n\n… [body truncated: ${body.length - MAX_BODY + 200} characters]\n`;
}

/**
 * Comment when an open review issue is seen again in a new range.
 * @param {{ failure_case?: string, body?: string }} f
 * @param {{ language?: 'en' | 'zh', range: { from_sha?: string | null, to_sha?: string }, commit: string }} ctx
 * @returns {string}
 */
export function renderSeenAgain(f, ctx) {
  const t = L(ctx.language);
  const parts = [`${t.seen} ${rangeText(ctx.range)} @ ${shaText(ctx.commit)}.`];
  if (typeof f.body === 'string' && f.body.trim() !== '') parts.push(sanitize(capText(f.body, FIELD_CAPS.body)));
  parts.push(`**${t.failure}:** ${sanitize(capText(f.failure_case ?? '', FIELD_CAPS.failure_case))}`);
  return capBody(`${parts.join('\n\n')}\n`);
}

/**
 * Comment on a closed-as-completed issue that comes back.
 * @param {string} sha
 * @param {'en' | 'zh'} [language]
 * @returns {string}
 */
export function renderReappeared(sha, language) {
  return `${L(language).reappeared} ${plainSha(sha)}\n`;
}

/**
 * Comment when an issue is closed because it was resolved (gate: not
 * observed any more; review: the resolution pass).
 * @param {string} sha
 * @param {string | string[] | undefined} evidence
 * @param {'en' | 'zh'} [language]
 * @returns {string}
 */
export function renderResolved(sha, evidence, language) {
  const ev = Array.isArray(evidence) ? evidence : typeof evidence === 'string' && evidence !== '' ? [evidence] : [];
  const safe = ev.flatMap((e) => {
    try {
      return [`- ${sanitize(e)}`];
    } catch {
      return [];
    }
  });
  return `${L(language).resolved} ${plainSha(sha)}${safe.length ? `\n\n${safe.join('\n')}` : ''}\n`;
}

/**
 * Title and body (without markers) of a gate violation issue.
 * @param {{ rule_id: string, path: string, line?: number | null, message: string, fingerprint: string, count?: number }} v
 * @param {{ sha: string, language?: 'en' | 'zh' }} ctx
 * @returns {{ title: string, body: string }}
 */
export function renderGateIssue(v, ctx) {
  const t = L(ctx.language);
  const where = v.line === null || v.line === undefined ? `\`${v.path}\`` : `\`${v.path}:${v.line}\``;
  const extra = v.line === null || v.line === undefined ? ` (+${v.count ?? 1} ${t.overBaseline})` : '';
  // rule messages carry matched text: a secret-shaped one is never published
  const secret = looksSecret(String(v.message));
  const message = secret ? '`<redacted>`' : noMentions(String(v.message));
  const body = [`**${t.rule}:** \`${v.rule_id}\``, `**${t.where}:** ${where}${extra}`, `**${t.commit}:** \`${ctx.sha}\``, '', message, '', `${t.fingerprint}: \`${v.fingerprint}\``].join('\n');
  return { title: clip(noMentions(`${v.rule_id}: ${secret ? '<redacted>' : stripControls(String(v.message))}`), 240), body };
}

/**
 * Comment introducing a rule candidate on its review issue.
 * @param {string} ruleId
 * @param {string} body candidate comment (see renderCandidateComment)
 * @param {'en' | 'zh'} [language]
 * @returns {string}
 */
export function renderCandidateNote(ruleId, body, language) {
  return `${L(language).candidate(ruleId, 'square2:rule-candidate')}\n\n${body}`;
}

/**
 * The `square2:rule-candidate` comment body: rule, fixtures and replay result.
 * @param {{ candidate: { rule: { id: string }, ruleYaml: string, fixtures: { bad: { path: string, content: string }[], good: { path: string, content: string }[] } }, report: { commit: { sha: string } }, issue: number, language?: 'en' | 'zh' }} c
 * @returns {string}
 */
export function renderCandidateComment(c) {
  const zh = c.language === 'zh';
  const id = escapeMd(c.candidate.rule.id);
  const files = (/** @type {{ path: string, content: string }[]} */ list, /** @type {'bad' | 'good'} */ kind) =>
    list.map((f) => `${escapeMd(`.square2/fixtures/${c.candidate.rule.id}/${kind}/${f.path}`)}\n\n${preBlock(f.content)}`).join('\n\n');
  const sha = shaText(c.report.commit.sha.slice(0, 12));
  const lines = [
    `<!-- square2:rule-candidate:${c.candidate.rule.id.replace(/[^A-Za-z0-9_.-]/g, '')} -->`,
    zh
      ? `### 规则候选 ${id}（来自 #${Number(c.issue)}）\n\n回放：在 ${sha} 触发，在父提交上不触发。规则不会自动启用；提交下列文件到 .square2/ 后才会生效。`
      : `### Rule candidate ${id} (from #${Number(c.issue)})\n\nReplay: fires on ${sha}, not on its parent. It is not enabled automatically; it takes effect only after a human commits these files under .square2/.`,
    `${escapeMd(`.square2/rules/${c.candidate.rule.id.toLowerCase()}.yaml`)}\n\n${preBlock(c.candidate.ruleYaml)}`,
    files(c.candidate.fixtures.bad, 'bad'),
  ];
  if (c.candidate.fixtures.good.length > 0) lines.push(files(c.candidate.fixtures.good, 'good'));
  return `${lines.join('\n\n')}\n`;
}

/**
 * @typedef {object} Usage
 * @property {number} input input tokens (including cached)
 * @property {number} cached cached input tokens
 * @property {number} output output tokens
 */

/**
 * Estimated cost from a price table per million tokens.
 * @param {Usage} usage
 * @param {{ input: number, cached: number, output: number }} pricePerMillion
 * @returns {number}
 */
export function estimateCost(usage, pricePerMillion) {
  const uncached = Math.max(0, usage.input - usage.cached);
  const cost = (uncached * pricePerMillion.input + usage.cached * pricePerMillion.cached + usage.output * pricePerMillion.output) / 1_000_000;
  return Math.round(cost * 10_000) / 10_000;
}

/**
 * @typedef {object} Change
 * @property {'created' | 'reopened' | 'updated' | 'closed' | 'candidate'} action
 * @property {number} number
 * @property {string} url
 * @property {string} title
 * @property {string} label severity (review) or rule id (gate)
 * @property {string} commit
 */

/**
 * Optional review-run details shown in the digest.
 * @typedef {object} DigestExtras
 * @property {number} [demoted]
 * @property {number} [rejected] findings not published because of secret-shaped text
 * @property {Record<string, number>} [candidatesDropped] rule candidates not posted, by reason
 * @property {number} [capped] findings over the run cap (max_findings × 2)
 * @property {string[]} [questions]
 * @property {string[]} [suggestions]
 * @property {{ severity: string, path: string, line: number, title: string }[]} [notes] unanchored findings on files whose diff was not shown
 * @property {boolean} [sameFamily]
 * @property {Usage | null} [usage]
 * @property {{ amount: number, currency: string } | null} [cost]
 */

/**
 * @param {string} inputId
 * @returns {string}
 */
export function digestMarker(inputId) {
  return `<!-- square2:digest:${inputId} -->`;
}

/**
 * @param {string[]} xs
 * @returns {string[]}
 */
function safeList(xs) {
  return xs.flatMap((x) => {
    try {
      return [`- ${sanitize(capText(String(x), DIGEST_ITEM_CHARS)).replace(/\s+/g, ' ')}`];
    } catch {
      return [];
    }
  });
}

/**
 * The one digest comment of a run, posted on the state issue. Mentions the
 * `notify` logins (the only mentions square² ever writes) and lists every
 * affected issue. Template only.
 * @param {{ inputId: string, kind: 'gate' | 'review', branch: string, sha: string, changes: Change[], notify: string[], test?: boolean, language?: 'en' | 'zh', extras?: DigestExtras }} d
 * @returns {string}
 */
export function renderDigest(d) {
  const t = L(d.language);
  const safe = (/** @type {string} */ v) => {
    try {
      return escapeMd(v).replace(/\s+/g, ' ');
    } catch {
      return '…';
    }
  };
  const rows = d.changes.map((c) => `| ${c.action} | [#${Number(c.number)}](${c.url}) ${safe(c.title)} | ${safe(c.label)} | ${shaText(c.commit.slice(0, 12))} |`);
  const lines = [digestMarker(d.inputId), t.digestHead(d.kind, d.test === true, d.branch, d.sha.slice(0, 12), d.changes.length), '', t.table, '|---|---|---|---|', ...rows];
  const x = d.extras ?? {};
  if (x.demoted) lines.push('', `${t.demoted}: ${x.demoted}`);
  if (x.rejected) lines.push('', `${t.rejected}: ${x.rejected}`);
  if (x.capped) lines.push('', `${t.capped}: ${x.capped}`);
  for (const [why, n] of Object.entries(x.candidatesDropped ?? {}).sort()) if (n > 0) lines.push('', `${t.candidatesDropped(safe(why))}: ${n}`);
  if (x.sameFamily) lines.push('', t.sameFamily);
  // at most DIGEST_ITEMS questions, suggestions and notes together, each capped
  let room = DIGEST_ITEMS;
  const take = (/** @type {any[]} */ xs) => {
    const kept = xs.slice(0, Math.max(0, room));
    room -= kept.length;
    return kept;
  };
  const allItems = (x.questions?.length ?? 0) + (x.suggestions?.length ?? 0) + (x.notes?.length ?? 0);
  const qs = take(x.questions ?? []);
  const ss = take(x.suggestions ?? []);
  const ns = take(x.notes ?? []);
  if (qs.length > 0) lines.push('', `**${t.questions}**`, ...safeList(qs));
  if (ss.length > 0) lines.push('', `**${t.suggestions}**`, ...safeList(ss));
  if (ns.length > 0) {
    lines.push('', `**${t.notes}**`, ...ns.flatMap((n) => {
      try {
        return [`- ${sanitizeCode(String(n.severity))} ${sanitizeCode(`${n.path}:${n.line}`)}: ${escapeMd(capText(String(n.title).replace(/\s+/g, ' '), DIGEST_ITEM_CHARS))}`];
      } catch {
        return [];
      }
    }));
  }
  if (allItems > DIGEST_ITEMS) lines.push('', t.moreItems(allItems - DIGEST_ITEMS));
  if (x.usage) {
    const cost = x.cost ? `, ${t.cost} ${x.cost.amount} ${x.cost.currency}` : '';
    lines.push('', `${t.usage}: ${t.input} ${x.usage.input}, ${t.cached} ${x.usage.cached}, ${t.output} ${x.usage.output} ${t.tokens}${cost}`);
  }
  const logins = notifyLogins(d.notify);
  const tail = logins.length > 0 ? `\n${logins.map((l) => `@${l}`).join(' ')}\n` : '';
  let body = `${lines.join('\n')}\n`;
  if (body.length + tail.length >= MAX_DIGEST) {
    const note = `\n${t.digestTruncated(body.length)}\n`;
    body = `${body.slice(0, MAX_DIGEST - tail.length - note.length - 1).replace(/[^\n]*$/, '')}${note}`;
  }
  return body + tail;
}

/** Digest limits: per question/suggestion/note, their total, the whole comment. */
export const DIGEST_ITEM_CHARS = 1000;
export const DIGEST_ITEMS = 20;
export const MAX_DIGEST = 60000;

/**
 * @param {{ inputId: string, overflow: { label: string, title: string, key: string }[], cap: number, language?: 'en' | 'zh' }} o
 * @returns {string}
 */
export function renderOverflow(o) {
  return [
    `<!-- square2:overflow:${o.inputId} -->`,
    L(o.language).overflow(o.overflow.length, o.cap),
    '',
    ...o.overflow.map((f) => {
      let title;
      try {
        title = escapeMd(f.title).replace(/\s+/g, ' ');
      } catch {
        title = '…';
      }
      return `- ${escapeMd(f.label)}: ${title} (\`${f.key.slice(0, 16).replace(/[^0-9a-f]/g, '')}\`)`;
    }),
  ].join('\n') + '\n';
}

/**
 * Markdown step summary for a review run (also used for `review-error`).
 * @param {{ status: 'ok' | 'review-error' | 'skipped', reason?: string, published?: number, demoted?: number, duplicates?: number, rejected?: number, errors?: string[], usage?: Usage | null, cost?: { amount: number, currency: string } | null, sameFamily?: boolean }} s
 * @returns {string}
 */
export function renderStepSummary(s) {
  const lines = [`## square² review: ${s.status}`];
  if (s.reason) lines.push('', s.reason);
  if (s.status === 'ok') lines.push('', `- published: ${s.published ?? 0}`, `- demoted: ${s.demoted ?? 0}`, `- duplicates: ${s.duplicates ?? 0}`, `- rejected: ${s.rejected ?? 0}`);
  if (s.sameFamily) lines.push('- same-family');
  for (const e of s.errors ?? []) lines.push(`- error: ${e.replace(/\n/g, ' ')}`);
  if (s.usage) lines.push(`- usage: input ${s.usage.input}, cached ${s.usage.cached}, output ${s.usage.output}${s.cost ? `; estimated cost ${s.cost.amount} ${s.cost.currency}` : ''}`);
  return `${lines.join('\n')}\n`;
}
