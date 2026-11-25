import { canonicalStringify } from '../core/canonical-json.mjs';
import { sha256Hex } from '../core/fingerprint.mjs';
import { SecretError, digestMarker, findingMarker, noMentions, parseTarget, renderCandidateNote, renderDigest, renderGateIssue, renderOverflow, renderReappeared, renderResolved, renderReviewIssue, renderSeenAgain, targetMarker } from '../review/render.mjs';
import { findingKey, normalizeTitle } from '../review/validate.mjs';

export const LABEL = 'square2';
export const GATE_LABEL = 'square2:gate';
export const REVIEW_LABEL = 'square2:review';
export const TEST_LABEL = 'square2:test';
export const CANDIDATE_LABEL = 'square2:rule-candidate';
export const DEFAULT_MAX_NEW_ISSUES = 10;
const SEVERITIES = ['Blocker', 'Major', 'Minor', 'Nit'];

/** @typedef {import('./github.mjs').GitHub} GitHub */
/** @typedef {import('./github.mjs').Issue} Issue */
/** @typedef {import('../review/render.mjs').Change} Change */

/**
 * One finding to publish as an issue.
 * @typedef {object} Item
 * @property {string} key
 * @property {'gate' | 'review'} kind
 * @property {string} title
 * @property {string} body issue text without markers
 * @property {string[]} labels
 * @property {string} label severity or rule id, for the digest
 * @property {string} commit
 * @property {string} seen comment added when an open review issue is seen again
 * @property {string} [rule_id] gate items: the rule, recorded in the body for auto-close
 * @property {string} [target] review items: anchor marker read back by the next run
 */

/**
 * @typedef {object} RunInfo
 * @property {'gate' | 'review'} kind
 * @property {string} inputId
 * @property {string} branch
 * @property {string} sha the head (gate) or to_sha (review)
 * @property {boolean} [test] label created issues square2:test and close them as not planned after the digest
 * @property {'en' | 'zh'} [language]
 */

/** @param {string} body @returns {string | null} */
export function parseKey(body) {
  const m = /<!-- square2:finding:([^\s>]+) -->/.exec(body);
  return m ? m[1] : null;
}

/** @param {string} body @returns {{ inputId: string, action: string } | null} */
export function parseRun(body) {
  const m = /<!-- square2:run:([^\s:>]+):([a-z]+) -->/.exec(body);
  return m ? { inputId: m[1], action: m[2] } : null;
}

/** @param {string} body @returns {string | null} */
export function parseRule(body) {
  const m = /<!-- square2:rule:([^\s>]+) -->/.exec(body);
  return m ? m[1] : null;
}

/**
 * The body with this run's marker in place of any previous one.
 * @param {string} body
 * @param {string} inputId
 * @param {string} action
 * @returns {string}
 */
export function withRunMarker(body, inputId, action) {
  const marker = `<!-- square2:run:${inputId}:${action} -->`;
  const stripped = body.replace(/<!-- square2:run:[^\s>]+ -->\n?/g, '');
  const m = /<!-- square2:finding:[^\s>]+ -->\n?/.exec(stripped);
  if (!m) return `${marker}\n${stripped}`;
  const at = m.index + m[0].length;
  return `${stripped.slice(0, at)}${m[0].endsWith('\n') ? '' : '\n'}${marker}\n${stripped.slice(at)}`;
}

/**
 * @param {Item} item
 * @param {string} inputId
 * @param {string} action
 * @returns {string}
 */
function renderBody(item, inputId, action) {
  const rule = item.rule_id ? `<!-- square2:rule:${item.rule_id} -->\n` : '';
  const target = item.target ? `${item.target}\n` : '';
  return withRunMarker(`${findingMarker(item.key)}\n${rule}${target}\n${noMentions(item.body)}`, inputId, action);
}

/**
 * Gate run identity: one per repository, branch, head and catalogue.
 * @param {{ repo: string, branch: string, head_sha: string, catalogue_digest: string, test: boolean, nonce?: string }} g
 * @returns {string}
 */
export function gateInputId(g) {
  return sha256Hex(canonicalStringify({ kind: 'gate', repo: g.repo, branch: g.branch, head_sha: g.head_sha, catalogue_digest: g.catalogue_digest, test: g.test, nonce: g.nonce ?? null }));
}

/**
 * Key of a gate violation: its fingerprint, or for a test publication a key
 * unique to the test run, so repeated tests publish again and never touch
 * the real issue of the same fingerprint.
 * @param {string} fingerprint
 * @param {string | undefined} testNonce
 * @returns {string}
 */
export function gateKey(fingerprint, testNonce) {
  return testNonce ? sha256Hex(`test\0${testNonce}\0${fingerprint}`) : fingerprint;
}

/**
 * Items for every new violation of a gate report (unique by fingerprint).
 * @param {any} report square2-report.json
 * @param {{ test?: boolean, nonce?: string, language?: 'en' | 'zh' }} [opts]
 * @returns {Item[]}
 */
export function gateItems(report, opts = {}) {
  /** @type {Item[]} */
  const items = [];
  const seen = new Set();
  const sha = String(report.head_sha ?? 'unknown');
  for (const v of Array.isArray(report.new_violations) ? report.new_violations : []) {
    if (seen.has(v.fingerprint)) continue;
    seen.add(v.fingerprint);
    const text = renderGateIssue(v, { sha, language: opts.language });
    items.push({
      key: gateKey(v.fingerprint, opts.test ? opts.nonce ?? 'test' : undefined),
      kind: 'gate',
      title: text.title,
      body: text.body,
      labels: [LABEL, GATE_LABEL, ...(opts.test ? [TEST_LABEL] : [])],
      label: String(v.rule_id),
      commit: sha,
      seen: '',
      rule_id: String(v.rule_id),
    });
  }
  return items;
}

/**
 * Findings of a validated review result: `published` (anchored), else `findings`, else the
 * code-stage findings of every group.
 * @param {any} review
 * @returns {any[]}
 */
export function reviewFindings(review) {
  if (Array.isArray(review?.published)) return review.published;
  if (Array.isArray(review?.findings)) return review.findings;
  /** @type {any[]} */
  const out = [];
  for (const g of Array.isArray(review?.groups) ? review.groups : []) {
    const code = g?.stages?.code ?? g?.code;
    if (Array.isArray(code?.findings)) out.push(...code.findings);
  }
  return out;
}

/**
 * Items for review findings, Blocker first, then by key. Findings whose text
 * is secret-shaped are not published (counted in `rejected`).
 * @param {any} review validated review result
 * @returns {Item[] & { rejected?: number }}
 */
export function reviewItems(review) {
  const range = { from_sha: review?.range?.from_sha ?? review?.from_sha ?? null, to_sha: String(review?.range?.to_sha ?? review?.to_sha ?? '') };
  const language = review?.language === 'zh' ? 'zh' : 'en';
  /** @type {Item[] & { rejected?: number }} */
  const items = [];
  let rejected = 0;
  const seen = new Set();
  for (const f of reviewFindings(review)) {
    const key = typeof f.key === 'string' && f.key !== '' ? f.key : findingKey(f);
    if (seen.has(key)) continue;
    seen.add(key);
    const severity = SEVERITIES.includes(f.severity) ? f.severity : 'Minor';
    const commit = typeof f.commit === 'string' && f.commit !== '' ? f.commit : range.to_sha;
    let text;
    let again;
    try {
      text = renderReviewIssue({ ...f, severity, commit }, { language, range });
      again = renderSeenAgain(f, { language, range, commit });
    } catch (e) {
      if (!(e instanceof SecretError)) throw e;
      rejected++;
      continue;
    }
    items.push({
      key,
      kind: 'review',
      title: text.title,
      body: text.body,
      labels: text.labels,
      label: severity,
      commit,
      seen: again,
      target: targetMarker({ ...f, title: text.title, commit: 'born_from' in f ? (typeof f.born_from === 'string' ? f.born_from : undefined) : commit }),
    });
  }
  const rank = (/** @type {Item} */ i) => SEVERITIES.indexOf(i.label);
  items.sort((a, b) => rank(a) - rank(b) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  items.rejected = rejected;
  return items;
}

/**
 * A `labels` patch that replaces a stale `sev:*` label with the item's, or
 * nothing when the labels already agree.
 * @param {Issue} existing
 * @param {Item} item
 * @returns {{ labels?: string[] }}
 */
function syncedLabels(existing, item) {
  const want = item.labels.find((l) => l.startsWith('sev:'));
  if (!want) return {};
  const have = existing.labels.filter((l) => l.startsWith('sev:'));
  if (have.length === 1 && have[0] === want) return {};
  return { labels: [...existing.labels.filter((l) => !l.startsWith('sev:')), want] };
}

/**
 * Comment on a finding issue unless a comment of our own (author = the
 * token's login) carrying the marker exists; others' comments never count.
 * @param {GitHub} gh
 * @param {Map<number, import('./github.mjs').Comment[]>} cache
 * @param {number} number
 * @param {string} marker
 * @param {string} body
 * @returns {Promise<string | null>} the existing comment's body, or null when posted now
 */
async function commentOnce(gh, cache, number, marker, body) {
  let list = cache.get(number);
  if (!list) {
    list = await gh.listComments(number);
    cache.set(number, list);
  }
  const me = await gh.selfLogin();
  const hit = list.find((c) => c.author === me && c.body.includes(marker));
  if (hit) return hit.body;
  list.push(await gh.addComment(number, `${marker}\n${noMentions(body)}`));
  return null;
}

/**
 * @typedef {object} PublishInput
 * @property {GitHub} gh
 * @property {import('./state.mjs').StateIssue} state
 * @property {RunInfo} run
 * @property {Item[]} items in priority order (overflow is the tail)
 * @property {number} [cap] max_new_issues_per_run
 * @property {string[]} notify logins mentioned in the digest only
 * @property {{ observed: Set<string>, baselined: Set<string>, rules: Set<string> }} [resolveGate] close open gate issues not observed and not baselined (configured branch only)
 * @property {{ key: string, commit: string, evidence?: string | string[] }[]} [resolved] review issues the resolution pass found resolved
 * @property {{ key: string, rule_id: string, body: string, fires_born_from: boolean, fires_parent: boolean }[]} [candidates] rule candidates for closed review issues
 * @property {import('../review/render.mjs').DigestExtras} [extras] review details for the digest
 * @property {{ key: string, path: string }[]} [retarget] open review issues whose file was renamed: their target marker moves to the new path
 * @property {number} [configuredCap] the configured max_new_issues_per_run when `cap` is what remained of it (shown separately in the overflow note)
 * @property {{ key: string, title: string, label: string }[]} [overflowFirst] items the caller could not file under the shared cap (escapes), listed first in the overflow note
 */

/**
 * @typedef {object} PublishResult
 * @property {Change[]} changes
 * @property {{ key: string, title: string, label: string }[]} overflow
 * @property {number} created issues created by this run (including on an earlier attempt)
 * @property {boolean} digest a digest was posted now
 */

/**
 * Idempotent publish of one run. Every write carries a marker naming the
 * run, so a retry after a partial failure recognises its own earlier writes
 * instead of repeating them.
 * @param {PublishInput} input
 * @returns {Promise<PublishResult>}
 */
export async function publish(input) {
  const { gh, run } = input;
  const cap = input.cap ?? DEFAULT_MAX_NEW_ISSUES;
  const test = run.test === true;
  /** @type {Map<number, import('./github.mjs').Comment[]>} */
  const comments = new Map();
  /** @type {Map<string, Issue>} */
  const index = new Map();
  const all = (await gh.listIssues(LABEL)).slice().sort((a, b) => a.number - b.number);
  for (const issue of all) {
    if (issue.labels.includes(TEST_LABEL) !== test) continue;
    const key = parseKey(issue.body);
    if (key !== null && !index.has(key)) index.set(key, issue);
  }
  /** @type {Change[]} */
  const changes = [];
  /** @type {PublishResult['overflow']} */
  const overflow = [...(input.overflowFirst ?? [])];
  let created = 0;
  /**
   * @param {Change['action']} action
   * @param {Issue} issue
   * @param {string} label
   * @param {string} commit
   */
  const note = (action, issue, label, commit) => changes.push({ action, number: issue.number, url: issue.html_url, title: issue.title, label, commit });
  /** @param {Issue} issue @returns {Change['action'] | null} */
  const recovered = (issue) => {
    const r = parseRun(issue.body);
    return r && r.inputId === run.inputId && ['created', 'reopened', 'updated', 'closed'].includes(r.action) ? /** @type {Change['action']} */ (r.action) : null;
  };

  // open review issues whose file was renamed: target moved to the new path first
  /** @type {Map<string, Issue>} old key -> retargeted issue */
  const moved = new Map();
  for (const t of input.retarget ?? []) {
    const issue = index.get(t.key);
    if (!issue || issue.state !== 'open' || !issue.labels.includes(REVIEW_LABEL)) continue;
    const target = parseTarget(issue.body);
    if (!target) continue;
    if (target.path !== t.path) {
      const body = issue.body.replace(/<!-- square2:target:[A-Za-z0-9_-]+ -->/, targetMarker({ ...target, path: t.path, commit: target.commit ?? undefined }));
      const updated = await gh.updateIssue(issue.number, { body });
      index.set(t.key, updated);
      moved.set(t.key, updated);
    } else moved.set(t.key, issue);
  }
  /** @param {Item} item @returns {[string, Issue] | null} a retargeted issue for the same finding on the new path */
  const renamedMatch = (item) => {
    const want = item.target ? parseTarget(item.target) : null;
    if (!want) return null;
    const digest = (/** @type {string} */ t) => sha256Hex(normalizeTitle(t));
    for (const [oldKey, issue] of moved) {
      const have = parseTarget(issue.body);
      if (have && have.path === want.path && have.enclosing_symbol === want.enclosing_symbol && digest(have.title) === digest(want.title)) return [oldKey, issue];
    }
    return null;
  };

  /** @type {Set<string>} */
  const done = new Set();
  for (const item of input.items) {
    if (done.has(item.key)) continue;
    done.add(item.key);
    let existing = index.get(item.key);
    if (!existing && item.kind === 'review') {
      const hit = renamedMatch(item);
      if (hit) {
        // same finding on the renamed file: update that issue and re-key it (renderBody writes the new key marker)
        const [oldKey, issue] = hit;
        moved.delete(oldKey);
        index.delete(oldKey);
        index.set(item.key, issue);
        done.add(oldKey);
        existing = issue;
      }
    }
    if (existing) {
      const again = recovered(existing);
      if (again) {
        if (again === 'created') created++;
        note(again, existing, item.label, item.commit);
        continue;
      }
    }
    if (!existing) {
      if (created >= cap) {
        overflow.push({ key: item.key, title: item.title, label: item.label });
        continue;
      }
      const issue = await gh.createIssue({ title: item.title, body: renderBody(item, run.inputId, 'created'), labels: item.labels });
      index.set(item.key, issue);
      created++;
      note('created', issue, item.label, item.commit);
      continue;
    }
    if (existing.state === 'open') {
      if (item.kind === 'gate') continue;
      await commentOnce(gh, comments, existing.number, `<!-- square2:seen:${run.inputId} -->`, item.seen);
      const issue = await gh.updateIssue(existing.number, { title: item.title, body: renderBody(item, run.inputId, 'updated'), ...syncedLabels(existing, item) });
      index.set(item.key, issue);
      note('updated', issue, item.label, item.commit);
      continue;
    }
    if (existing.state_reason === 'not_planned' || existing.state_reason === 'duplicate') continue;
    await commentOnce(gh, comments, existing.number, `<!-- square2:reopen:${run.inputId} -->`, renderReappeared(item.commit, run.language));
    const issue = await gh.updateIssue(existing.number, { state: 'open', body: renderBody(item, run.inputId, 'reopened'), ...syncedLabels(existing, item) });
    index.set(item.key, issue);
    note('reopened', issue, item.label, item.commit);
  }

  /**
   * @param {string} key
   * @param {Issue} issue
   * @param {string} label
   * @param {string} commit
   * @param {string} text
   */
  const closeResolved = async (key, issue, label, commit, text) => {
    await commentOnce(gh, comments, issue.number, `<!-- square2:resolved:${run.inputId} -->`, text);
    const closed = await gh.updateIssue(issue.number, { state: 'closed', state_reason: 'completed', body: withRunMarker(issue.body, run.inputId, 'closed') });
    index.set(key, closed);
    note('closed', closed, label, commit);
  };

  if (input.resolveGate && !test) {
    const { observed, baselined, rules } = input.resolveGate;
    for (const [key, issue] of [...index].sort((a, b) => a[1].number - b[1].number)) {
      if (done.has(key) || !issue.labels.includes(GATE_LABEL)) continue;
      const rule = parseRule(issue.body) ?? '';
      if (recovered(issue) === 'closed') {
        note('closed', issue, rule, run.sha);
        continue;
      }
      if (issue.state !== 'open' || observed.has(key) || baselined.has(key) || !rules.has(rule)) continue;
      await closeResolved(key, issue, rule, run.sha, renderResolved(run.sha, undefined, run.language));
    }
  }

  for (const r of input.resolved ?? []) {
    if (done.has(r.key)) continue;
    done.add(r.key);
    const issue = index.get(r.key);
    if (!issue || !issue.labels.includes(REVIEW_LABEL)) continue;
    const label = issue.labels.find((l) => l.startsWith('sev:'))?.slice(4) ?? 'review';
    if (recovered(issue) === 'closed') {
      note('closed', issue, label, r.commit);
      continue;
    }
    if (issue.state !== 'open') continue;
    await closeResolved(r.key, issue, label, r.commit, renderResolved(r.commit, r.evidence, run.language));
  }

  for (const c of input.candidates ?? []) {
    if (!(c.fires_born_from === true && c.fires_parent === false)) continue;
    const issue = index.get(c.key);
    if (!issue || !issue.labels.includes(REVIEW_LABEL)) continue;
    const marker = `<!-- square2:candidate:${c.rule_id} -->`;
    const prior = await commentOnce(gh, comments, issue.number, marker, `<!-- square2:candidate-run:${run.inputId} -->\n${renderCandidateNote(c.rule_id, c.body, run.language)}`);
    if (!issue.labels.includes(CANDIDATE_LABEL)) {
      await gh.addLabels(issue.number, [CANDIDATE_LABEL]);
      issue.labels = [...issue.labels, CANDIDATE_LABEL];
    }
    if (prior === null || prior.includes(`<!-- square2:candidate-run:${run.inputId} -->`)) note('candidate', issue, c.rule_id, run.sha);
  }

  if (overflow.length > 0) {
    await input.state.commentOnce(`<!-- square2:overflow:${run.inputId} -->`, renderOverflow({ inputId: run.inputId, overflow, cap: input.configuredCap ?? cap, remaining: cap, language: run.language }));
  }
  const asks = (input.extras?.questions?.length ?? 0) + (input.extras?.suggestions?.length ?? 0) + (input.extras?.notes?.length ?? 0) + (input.extras?.escapes?.length ?? 0);
  const wantDigest = run.kind === 'gate' ? changes.some((c) => c.action === 'created' || c.action === 'reopened') : changes.length > 0 || asks > 0;
  let digest = false;
  if (wantDigest) {
    digest = await input.state.commentOnce(digestMarker(run.inputId), renderDigest({ inputId: run.inputId, kind: run.kind, branch: run.branch, sha: run.sha, changes, notify: input.notify, test, language: run.language, extras: input.extras }));
  }
  if (test) {
    for (const c of changes) {
      if (c.action !== 'created' && c.action !== 'reopened') continue;
      const issue = [...index.values()].find((i) => i.number === c.number);
      if (issue && issue.state === 'open') {
        const closed = await gh.updateIssue(issue.number, { state: 'closed', state_reason: 'not_planned' });
        for (const [k, v] of index) if (v.number === closed.number) index.set(k, closed);
      }
    }
  }
  return { changes, overflow, created, digest };
}
