export const STATE_LABEL = 'square2-state';
export const STATE_TITLE = 'square² state';
export const MAX_INPUT_IDS = 50;

/**
 * @typedef {{ last_reviewed_sha: string | null, published_input_ids: string[] }} State
 */

/** @returns {State} */
export function emptyState() {
  return { last_reviewed_sha: null, published_input_ids: [] };
}

/**
 * Parse the state issue body (JSON, optionally inside a ``` fence). Anything
 * unreadable is the empty state.
 * @param {string} body
 * @returns {State}
 */
export function parseState(body) {
  const fenced = /```(?:json)?\s*\n([\s\S]*?)\n```/.exec(body);
  let doc;
  try {
    doc = JSON.parse(fenced ? fenced[1] : body);
  } catch {
    return emptyState();
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return emptyState();
  const sha = typeof doc.last_reviewed_sha === 'string' && doc.last_reviewed_sha !== '' ? doc.last_reviewed_sha : null;
  const ids = Array.isArray(doc.published_input_ids) ? doc.published_input_ids.filter((/** @type {unknown} */ x) => typeof x === 'string') : [];
  return { last_reviewed_sha: sha, published_input_ids: ids.slice(0, MAX_INPUT_IDS) };
}

/**
 * @param {State} state
 * @returns {string}
 */
export function serializeState(state) {
  return JSON.stringify({ last_reviewed_sha: state.last_reviewed_sha, published_input_ids: state.published_input_ids.slice(0, MAX_INPUT_IDS) }, null, 2) + '\n';
}

/**
 * State after a successful publish: newest input id first, at most 50, no duplicates.
 * @param {State} state
 * @param {{ input_id: string, last_reviewed_sha?: string | null }} run
 * @returns {State}
 */
export function advanceState(state, run) {
  const ids = [run.input_id, ...state.published_input_ids.filter((x) => x !== run.input_id)].slice(0, MAX_INPUT_IDS);
  return { last_reviewed_sha: run.last_reviewed_sha === undefined ? state.last_reviewed_sha : run.last_reviewed_sha, published_input_ids: ids };
}

/**
 * Lazily finds (or creates) the single state issue.
 */
export class StateIssue {
  /**
   * @param {import('./github.mjs').GitHub} gh
   * @param {{ bodyWriter?: boolean }} [opts] `bodyWriter: false` (gate): comments only, the body is never written
   */
  constructor(gh, opts = {}) {
    this.gh = gh;
    this.bodyWriter = opts.bodyWriter !== false;
    /** @type {import('./github.mjs').Issue | null | undefined} */
    this.issue = undefined;
    /** @type {import('./github.mjs').Comment[] | undefined} */
    this.comments = undefined;
  }

  /**
   * The existing state issue (lowest number, open preferred), or null.
   * @returns {Promise<import('./github.mjs').Issue | null>}
   */
  async find() {
    if (this.issue !== undefined) return this.issue;
    const all = await this.gh.listIssues(STATE_LABEL);
    all.sort((a, b) => (a.state === b.state ? a.number - b.number : a.state === 'open' ? -1 : 1));
    this.issue = all[0] ?? null;
    return this.issue;
  }

  /**
   * The state as it is on GitHub now (drops the cached issue): call right
   * before writing. Only the review publish job writes the body (its
   * workflow runs in one concurrency group, so writes never interleave); the
   * gate only comments.
   * @returns {Promise<State>}
   */
  async reread() {
    this.issue = undefined;
    return this.read();
  }

  /** @returns {Promise<State>} */
  async read() {
    const issue = await this.find();
    return issue ? parseState(issue.body) : emptyState();
  }

  /** @returns {Promise<import('./github.mjs').Issue>} */
  async ensure() {
    const found = await this.find();
    if (found) return found;
    const created = await this.gh.createIssue({ title: STATE_TITLE, body: serializeState(emptyState()), labels: [STATE_LABEL] });
    // a concurrent first run (gate and review are in different groups) may have created one too:
    // everyone adopts the lowest-numbered state issue
    this.issue = undefined;
    const adopted = (await this.find()) ?? created;
    this.issue = adopted;
    this.comments = adopted.number === created.number ? [] : undefined;
    return adopted;
  }

  /** @param {State} state */
  async write(state) {
    if (!this.bodyWriter) throw new Error('this state handle may not write the state issue body (gate publishing only comments)');
    const issue = await this.ensure();
    const body = serializeState(state);
    if (issue.body === body) return;
    this.issue = await this.gh.updateIssue(issue.number, { body });
  }

  /**
   * Post a comment on the state issue unless one carrying `marker` exists.
   * @param {string} marker an HTML comment unique to this post
   * @param {string} body must contain the marker
   * @returns {Promise<boolean>} true when posted now
   */
  async commentOnce(marker, body) {
    const issue = await this.ensure();
    if (this.comments === undefined) this.comments = await this.gh.listComments(issue.number);
    const me = await this.gh.selfLogin();
    if (this.comments.some((c) => c.author === me && c.body.includes(marker))) return false;
    const c = await this.gh.addComment(issue.number, body);
    this.comments.push(c);
    return true;
  }
}
