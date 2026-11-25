import { globMatch } from '../core/exceptions.mjs';
import { parseTrailers } from '../git/trailers.mjs';
import { validChangeId } from '../review/group.mjs';
import { REDACTED, commitTextSecret, noMentions, renderCredited, renderEscapeIssue } from '../review/render.mjs';
import { GATE_LABEL, LABEL, REVIEW_LABEL, TEST_LABEL } from './publish.mjs';

export const ESCAPE_LABEL = 'square2:escape';
/** Classification labels (`layer:<name>`), set by a human or the process owner, never by square². */
export const LAYER_PREFIX = 'layer:';
/** The one trailer recorded on every escape besides the configured author and change-id trailers. */
export const FIXES_COMMIT = 'Fixes-Commit';

const FIX_SUBJECT = /^(fix|hotfix|revert)(\(|:|\s)/i;
const FIX_WORD = /\b(regression|hotfix|revert)\b/i;
const INTRODUCING = /^[0-9a-f]{7,40}$/i;
const FIX_SHA = /^[0-9a-f]{7,64}$/i;
/** GitHub closing keywords followed, after spaces or tabs only, by a same-repository reference. */
const CLOSING = /(?<![\w-])(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)[ \t]+#(\d+)(?![\w-])/gi;
/** What code is replaced by before references are parsed: a token of its own, never glue. */
export const CODE_PLACEHOLDER = ' \u2039code\u203a ';

/**
 * A fix commit found in the reviewed range: what escaped every earlier layer.
 * @typedef {object} Escape
 * @property {string} fix_sha
 * @property {string} subject
 * @property {string} introducing lowercase sha from a valid `Fixes-Commit`, else `unknown`
 * @property {string[]} files changed files outside the review excludes
 * @property {{ key: string, value: string }[]} trailers the allow-listed trailers of the fix commit
 * @property {number[]} refs issues it closes (`Closes|Fixes|Resolves #<n>`), sorted, unique
 */

/** @param {string} body @returns {string | null} */
export function parseEscapeMarker(body) {
  const m = /<!-- square2:escape:([0-9a-f]{7,64}) -->/i.exec(body);
  return m ? m[1].toLowerCase() : null;
}

/** @param {string} sha @returns {string} */
export function escapeMarker(sha) {
  return `<!-- square2:escape:${sha.toLowerCase()} -->`;
}

/** @param {string} sha @returns {string} the credit comment marker: records that this fix was credited, not an escape */
export function creditMarker(sha) {
  return `<!-- square2:credited:${sha.toLowerCase()} -->`;
}

/** @param {string} message @returns {string} */
const plain = (message) => message.replace(/\r/g, '');

/**
 * The introducing sha of a valid `Fixes-Commit` trailer (7 to 40 hex), lowercase, or null.
 * @param {string} message
 * @returns {string | null}
 */
export function fixesCommit(message) {
  const t = parseTrailers(plain(message)).find((x) => x.key.toLowerCase() === 'fixes-commit' && INTRODUCING.test(x.value));
  return t ? t.value.toLowerCase() : null;
}

/**
 * True when the commit message marks a fix: the subject matches the fix
 * pattern, or it carries a valid `Fixes-Commit` trailer.
 * @param {string} message
 * @returns {boolean}
 */
export function isFixCommit(message) {
  const subject = plain(message).split('\n')[0];
  if (FIX_SUBJECT.test(subject) || FIX_WORD.test(subject)) return true;
  return fixesCommit(message) !== null;
}

/**
 * Container prefixes a block can sit in: a blockquote marker (one optional
 * space after it), or a list marker followed by 1 to 4 spaces; when the
 * first space or tab is followed by four more columns (four spaces or a
 * tab), only it belongs to the marker and the rest starts indented code,
 * as in CommonMark.
 */
const CONTAINER = /^[ \t]*(?:>[ \t]?|(?:[-*+]|\d{1,9}[.)])(?:[ \t](?= {4}|\t)|[ \t]{1,4}|$))/;

/** @param {string} line @returns {string} the line without its blockquote and list prefixes */
function containerContent(line) {
  let rest = line;
  for (let i = 0; i < 32; i++) {
    const m = CONTAINER.exec(rest);
    if (!m || m[0] === '') break;
    rest = rest.slice(m[0].length);
  }
  return rest;
}

/**
 * Inline code spans: a run of n backticks up to the next run of exactly n
 * (CommonMark), each span replaced by CODE_PLACEHOLDER. A backslash-escaped
 * backtick outside a span is literal; an unmatched run is literal.
 * @param {string} text
 * @returns {string}
 */
function maskInline(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\' && text[i + 1] === '`') {
      out += '\\`';
      i += 2;
      continue;
    }
    if (ch !== '`') {
      out += ch;
      i++;
      continue;
    }
    let j = i;
    while (text[j] === '`') j++;
    const n = j - i;
    let k = j;
    let close = -1;
    while (k < text.length) {
      if (text[k] !== '`') {
        k++;
        continue;
      }
      let m = k;
      while (text[m] === '`') m++;
      if (m - k === n) {
        close = k;
        break;
      }
      k = m;
    }
    if (close < 0) {
      out += text.slice(i, j);
      i = j;
      continue;
    }
    out += CODE_PLACEHOLDER;
    i = close + n;
  }
  return out;
}

/**
 * The message with all code replaced by CODE_PLACEHOLDER (a token of its
 * own, so masking never joins the words around it), CommonMark-lite:
 * fenced blocks (``` or ~~~, any indentation, also inside blockquotes and
 * list items; unclosed fences run to the end), indented code lines (four
 * spaces or a tab after the container prefixes), and inline code spans with
 * matching backtick-run lengths.
 * @param {string} message
 * @returns {string}
 */
export function maskCode(message) {
  /** @type {string[]} */
  const kept = [];
  /** @type {{ char: string, len: number } | null} */
  let fence = null;
  for (const line of plain(message).split('\n')) {
    const content = containerContent(line);
    const f = /^[ \t]*(`{3,}|~{3,})(.*)$/.exec(content);
    if (fence !== null) {
      if (f && f[1][0] === fence.char && f[1].length >= fence.len && f[2].trim() === '') fence = null;
      kept.push(CODE_PLACEHOLDER);
      continue;
    }
    if (f && !(f[1][0] === '`' && f[2].includes('`'))) {
      fence = { char: f[1][0], len: f[1].length };
      kept.push(CODE_PLACEHOLDER);
      continue;
    }
    kept.push(/^( {4}|\t)/.test(content) ? CODE_PLACEHOLDER : line);
  }
  return maskInline(kept.join('\n'));
}

/**
 * Issues a commit message closes with a GitHub closing keyword (`Closes #42`,
 * `fixes: #7`), outside code; bare mentions and `owner/repo#n` never count.
 * @param {string} message
 * @returns {number[]}
 */
export function closingRefs(message) {
  return [...new Set([...maskCode(message).matchAll(CLOSING)].map((m) => Number(m[1])).filter((n) => Number.isSafeInteger(n) && n > 0))].sort((a, b) => a - b);
}

/**
 * The trailers recorded on an escape: those whose key (case-insensitively)
 * is allow-listed, plus `Fixes-Commit`.
 * @param {{ key: string, value: string }[]} trailers
 * @param {readonly string[]} allowed
 */
export function allowedTrailers(trailers, allowed) {
  const keys = new Set([...allowed, FIXES_COMMIT].map((k) => k.toLowerCase()));
  return trailers.filter((t) => keys.has(t.key.toLowerCase()));
}

/**
 * Trailers as they may be stored or shown: allow-listed, change-id trailers
 * only with a valid change id, secret-shaped values replaced by `<redacted>`.
 * @param {{ key: string, value: string }[]} trailers
 * @param {readonly string[]} allowed
 * @param {readonly string[]} [changeIds] the change-id trailer keys
 */
export function safeTrailers(trailers, allowed, changeIds = []) {
  const ids = new Set(changeIds.map((k) => k.toLowerCase()));
  return allowedTrailers(trailers, allowed)
    .filter((t) => !ids.has(t.key.toLowerCase()) || validChangeId(t.value))
    .map((t) => ({ key: t.key, value: t.value === REDACTED || commitTextSecret(t.value, t.key) ? REDACTED : t.value.replace(/\r/g, '') }));
}

/**
 * A commit message whose trailer values that look like secrets are replaced
 * by `<redacted>` (what the prepare context may store).
 * @param {string} message
 * @returns {string}
 */
export function redactTrailerValues(message) {
  const text = plain(message);
  const at = text.search(/\n\s*\n(?![\s\S]*\n\s*\n)/);
  if (at < 0) return text;
  const head = text.slice(0, at);
  const tail = text.slice(at).replace(/^([ \t]*)([A-Za-z0-9][A-Za-z0-9-]*)([ \t]*:[ \t]*)(.+)$/gm, (m, ind, key, sep, value) => (commitTextSecret(value.trim(), key) ? `${ind}${key}${sep}${REDACTED}` : m));
  return head + tail;
}

/**
 * Fix commits of the range, oldest first. Pure: no model call, no network.
 * Merge commits and commits touching only excluded paths are ignored.
 * Trailers are allow-listed and redacted here, before anything is written.
 * @param {{ commits: { sha: string, parents: string[], message: string, paths: string[] }[], excludes: readonly string[], trailers?: readonly string[], changeIdTrailers?: readonly string[] }} input
 * `trailers`: the configured author, change-id and provenance trailer keys; `changeIdTrailers`: the change-id ones
 * @returns {Escape[]}
 */
export function detectEscapes(input) {
  /** @type {Escape[]} */
  const out = [];
  const seen = new Set();
  for (const c of input.commits) {
    const key = c.sha.toLowerCase();
    if (c.parents.length > 1 || seen.has(key) || !isFixCommit(c.message)) continue;
    const files = c.paths.filter((p) => !input.excludes.some((g) => globMatch(g, p))).sort();
    if (files.length === 0) continue;
    seen.add(key);
    const message = plain(c.message);
    out.push({
      fix_sha: c.sha.toLowerCase(),
      subject: commitTextSecret(message.split('\n')[0]) ? REDACTED : message.split('\n')[0],
      introducing: fixesCommit(message) ?? 'unknown',
      files,
      trailers: safeTrailers(parseTrailers(message), input.trailers ?? [], input.changeIdTrailers ?? []),
      refs: closingRefs(message),
    });
  }
  return out;
}

/**
 * The escapes recorded in a prepare context, shape-checked (anything else is
 * dropped); trailers filtered to the allow-list again.
 * @param {unknown} context
 * @param {readonly string[]} [trailers] the configured author, change-id and provenance trailer keys
 * @returns {Escape[]}
 */
export function contextEscapes(context, trailers = []) {
  const list = /** @type {any} */ (context)?.escapes;
  if (!Array.isArray(list)) return [];
  /** @type {Escape[]} */
  const out = [];
  for (const e of list) {
    if (!e || typeof e !== 'object' || typeof e.fix_sha !== 'string' || !FIX_SHA.test(e.fix_sha)) continue;
    const strs = (/** @type {unknown} */ v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
    const raw = Array.isArray(e.trailers) ? e.trailers.filter((/** @type {any} */ t) => t && typeof t.key === 'string' && typeof t.value === 'string').map((/** @type {any} */ t) => ({ key: t.key, value: t.value })) : [];
    out.push({
      fix_sha: e.fix_sha.toLowerCase(),
      subject: typeof e.subject === 'string' ? e.subject.replace(/\r/g, '') : '',
      introducing: typeof e.introducing === 'string' && INTRODUCING.test(e.introducing) ? e.introducing.toLowerCase() : 'unknown',
      files: strs(e.files),
      trailers: safeTrailers(raw, trailers),
      refs: Array.isArray(e.refs) ? [...new Set(e.refs.filter((/** @type {unknown} */ n) => Number.isSafeInteger(n) && /** @type {number} */ (n) > 0))].sort((a, b) => a - b) : [],
    });
  }
  return out;
}

/**
 * @typedef {object} EscapeResult
 * @property {import('./github.mjs').Issue[]} created escape issues created now
 * @property {number} counted every issue this run created (findings and escapes, now or on an earlier attempt)
 * @property {number} escapesCounted the escape issues among them: what the findings' allowance is reduced by
 * @property {{ key: string, title: string, label: string }[]} overflow escapes not filed because the cap was reached
 * @property {{ number: number, sha: string }[]} credited gate/review issues credited with a fix
 * @property {import('./github.mjs').Issue[]} unclassified open escape issues without a `layer:*` label
 */

/**
 * Every issue the token can list (one paginated listing without a label
 * filter, plus the escape label), by number: escape markers and credit
 * targets are found whatever their labels are now.
 * @param {import('./github.mjs').GitHub} gh
 */
async function listedIssues(gh) {
  /** @type {Map<number, import('./github.mjs').Issue>} */
  const all = new Map();
  for (const label of ['', ESCAPE_LABEL]) for (const i of await gh.listIssues(label)) all.set(i.number, i);
  return [...all.values()].sort((a, b) => a.number - b.number);
}

/**
 * A gate or review issue square² itself opened, not a test issue, not closed as not planned or duplicate.
 * @param {import('./github.mjs').Issue} i
 * @param {string} me the token's login
 */
const creditable = (i, me) => i.author === me && (i.labels.includes(GATE_LABEL) || i.labels.includes(REVIEW_LABEL)) && !i.labels.includes(TEST_LABEL)
  && !(i.state === 'closed' && (i.state_reason === 'not_planned' || i.state_reason === 'duplicate'));

/**
 * Publish escape records idempotently. Each fix sha is decided once and the
 * decision is frozen in a marker: an escape issue (`square2:escape:<sha>`)
 * or a credit comment (`square2:credited:<sha>`) on an issue it closes. Only
 * issues and comments by the token's own login count (labels never matter),
 * so a marker pasted by anyone else is ignored. A retry follows the recorded
 * decision even if the target issue changed since. New escapes count against
 * `cap` (the run's max_new_issues_per_run, shared with findings; escapes go
 * first), after every issue this run (`inputId`) created on an earlier
 * attempt, findings included. Never sets a `layer:*` label.
 * @param {{ gh: import('./github.mjs').GitHub, escapes: Escape[], inputId: string, cap: number, trailers?: readonly string[], language?: 'en' | 'zh' }} input
 * @returns {Promise<EscapeResult>}
 */
export async function publishEscapes(input) {
  const { gh } = input;
  const all = await listedIssues(gh);
  const byNumber = new Map(all.map((i) => [i.number, i]));
  const me = await gh.selfLogin();
  const own = all.filter((i) => i.author === me);
  const runMarker = `<!-- square2:run:${input.inputId}:created -->`;
  /** @type {Map<string, import('./github.mjs').Issue>} */
  const recorded = new Map();
  for (const issue of own) {
    const sha = parseEscapeMarker(issue.body);
    if (sha && !recorded.has(sha)) recorded.set(sha, issue);
  }
  // everything this run created on an earlier attempt (findings and escapes) uses up the shared cap before any decision
  const earlier = own.filter((i) => i.body.includes(runMarker));
  let counted = earlier.length;
  let escapesCounted = earlier.filter((i) => parseEscapeMarker(i.body) !== null).length;
  /** @param {import('./github.mjs').Issue} issue @param {string[]} want */
  const relabel = async (issue, want) => {
    const missing = want.filter((l) => !issue.labels.includes(l));
    if (missing.length === 0) return;
    await gh.addLabels(issue.number, missing);
    issue.labels = [...issue.labels, ...missing];
  };
  /** @type {Map<number, import('./github.mjs').Comment[]>} */
  const commentCache = new Map();
  /** @param {number} n */
  const commentsOf = async (n) => {
    let list = commentCache.get(n);
    if (!list) {
      list = await gh.listComments(n);
      commentCache.set(n, list);
    }
    return list;
  };
  /** @param {import('./github.mjs').Issue} issue @param {string} sha */
  const hasCredit = async (issue, sha) => (await commentsOf(issue.number)).some((c) => c.author === me && c.body.toLowerCase().includes(creditMarker(sha)));
  /** @type {import('./github.mjs').Issue[]} */
  const created = [];
  /** @type {EscapeResult['overflow']} */
  const overflow = [];
  /** @type {EscapeResult['credited']} */
  const credited = [];
  const done = new Set();
  for (const raw of input.escapes) {
    const e = { ...raw, fix_sha: raw.fix_sha.toLowerCase() };
    if (done.has(e.fix_sha)) continue;
    done.add(e.fix_sha);
    const existing = recorded.get(e.fix_sha);
    if (existing) {
      await relabel(existing, [LABEL, ESCAPE_LABEL]);
      continue;
    }
    const targets = /** @type {import('./github.mjs').Issue[]} */ ([...new Set(e.refs)].map((n) => byNumber.get(n)).filter((i) => i !== undefined));
    /** @type {import('./github.mjs').Issue[]} */
    const frozen = [];
    for (const t of targets) if (await hasCredit(t, e.fix_sha)) frozen.push(t);
    const fresh = targets.filter((t) => !frozen.includes(t) && creditable(t, me));
    if (frozen.length > 0 || fresh.length > 0) {
      for (const issue of [...frozen, ...fresh]) {
        if (!frozen.includes(issue)) {
          const c = await gh.addComment(issue.number, `${creditMarker(e.fix_sha)}\n${noMentions(renderCredited(e.fix_sha, input.language))}`);
          (await commentsOf(issue.number)).push(c);
        }
        await relabel(issue, [LABEL]);
        credited.push({ number: issue.number, sha: e.fix_sha });
      }
      continue;
    }
    const text = renderEscapeIssue({ ...e, trailers: safeTrailers(e.trailers, input.trailers ?? []) }, input.language);
    if (counted >= input.cap) {
      overflow.push({ key: e.fix_sha, title: text.title, label: 'escape' });
      continue;
    }
    const issue = await gh.createIssue({ title: text.title, body: `${escapeMarker(e.fix_sha)}\n${runMarker}\n\n${noMentions(text.body)}`, labels: [LABEL, ESCAPE_LABEL] });
    recorded.set(e.fix_sha, issue);
    created.push(issue);
    own.push(issue);
    counted++;
    escapesCounted++;
  }
  const unclassified = own.filter((i) => i.state === 'open' && i.labels.includes(ESCAPE_LABEL) && !i.labels.includes(TEST_LABEL) && !i.labels.some((l) => l.startsWith(LAYER_PREFIX)));
  return { created, counted, escapesCounted, overflow, credited, unclassified };
}
