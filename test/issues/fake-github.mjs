/**
 * In-memory GitHub REST API for publisher tests: issues (paginated list with
 * label filter and state=all, create, update with state_reason, labels),
 * comments, repository, and Actions runs/jobs. Supports failure injection.
 */

/**
 * @typedef {{ number: number, title: string, body: string, state: 'open' | 'closed', state_reason: string | null, labels: string[], comments: { id: number, body: string, author?: string }[], pull_request?: boolean, author?: string }} FakeIssue
 */

export class FakeGitHub {
  /**
   * @param {{ repo?: string, pageSize?: number, defaultBranch?: string }} [opts]
   */
  constructor(opts = {}) {
    this.repo = opts.repo ?? 'octo/demo';
    this.pageSize = opts.pageSize ?? 3;
    this.defaultBranch = opts.defaultBranch ?? 'main';
    /** @type {FakeIssue[]} */
    this.issues = [];
    this.nextNumber = 1;
    this.nextComment = 1;
    this.calls = 0;
    /** @type {number | null} 1-based call index that fails with 500 */
    this.failAt = null;
    /** when true the failing call is applied first, then answers 500 (a lost response) */
    this.failAfter = false;
    /** @type {string[]} */
    this.log = [];
    /** @type {Record<string, { id: number, created_at: string, run_started_at: string | null, updated_at: string | null }[]>} */
    this.runs = {};
    /** @type {Record<number, { id: number, started_at: string | null, completed_at: string | null }[]>} */
    this.jobs = {};
    /** @type {Record<string, string>} branch name to head sha */
    this.branches = {};
    /** @type {string | null} login `GET /user` answers; null answers 403 (as for GITHUB_TOKEN, whose comments are by github-actions[bot]) */
    this.userLogin = null;
    /** @type {Record<number, string>} pull request number to head sha */
    this.pulls = {};
    /** @type {Set<string>} shas the compare API answers 404 for (rewritten away) */
    this.missing = new Set();
    /** @type {Set<string>} `base..head` pairs where base is an ancestor of head */
    this.ancestors = new Set();
    /** @type {Set<string>} authorization headers seen */
    this.tokens = new Set();
    this.fetch = this.fetch.bind(this);
  }

  /**
   * @param {Partial<FakeIssue> & { title: string }} i
   * @returns {FakeIssue}
   */
  seed(i) {
    const issue = { number: this.nextNumber++, body: '', state: /** @type {'open'} */ ('open'), state_reason: null, labels: [], comments: [], ...i };
    this.issues.push(issue);
    return issue;
  }

  /** Login of comments written through this fake (and of seeded comments without an author). */
  me() {
    return this.userLogin ?? 'github-actions[bot]';
  }

  /** Comparable snapshot of every issue and comment. */
  snapshot() {
    return this.issues.map((i) => ({ number: i.number, title: i.title, body: i.body, state: i.state, state_reason: i.state_reason, labels: [...i.labels].sort(), comments: i.comments.map((c) => c.body) }));
  }

  /** @param {number} n */
  issue(n) {
    return this.issues.find((i) => i.number === n);
  }

  /** @param {FakeIssue} i */
  view(i) {
    return { number: i.number, title: i.title, body: i.body, state: i.state, state_reason: i.state_reason, labels: i.labels.map((name) => ({ name })), html_url: `https://github.invalid/${this.repo}/issues/${i.number}`, user: { login: i.author ?? this.me() }, ...(i.pull_request ? { pull_request: {} } : {}) };
  }

  /**
   * @param {string | URL | Request} input
   * @param {RequestInit} [init]
   * @returns {Promise<Response>}
   */
  async fetch(input, init = {}) {
    this.calls++;
    const url = new URL(String(input));
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = /** @type {Record<string, string>} */ (init.headers ?? {});
    if (headers.authorization) this.tokens.add(headers.authorization);
    if (this.failAt !== null && this.calls === this.failAt) {
      if (!this.failAfter) return json(500, { message: 'injected failure' });
      await this.route(url, method, init);
      return json(500, { message: 'injected failure after apply' });
    }
    return this.route(url, method, init);
  }

  /**
   * @param {URL} url
   * @param {string} method
   * @param {RequestInit} init
   * @returns {Promise<Response>}
   */
  async route(url, method, init) {
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    const prefix = `/repos/${this.repo}`;
    if (url.pathname === '/user' && method === 'GET') {
      this.log.push('get user');
      return this.userLogin ? json(200, { login: this.userLogin }) : json(403, { message: 'Resource not accessible by integration' });
    }
    if (!url.pathname.startsWith(prefix)) return json(404, { message: 'not found' });
    const path = url.pathname.slice(prefix.length);
    let m;
    if (path === '' && method === 'GET') return json(200, { default_branch: this.defaultBranch });
    if ((m = /^\/branches\/(.+)$/.exec(path)) && method === 'GET') {
      const sha = this.branches[decodeURIComponent(m[1])];
      return sha ? json(200, { name: decodeURIComponent(m[1]), commit: { sha } }) : json(404, { message: 'Branch not found' });
    }
    if ((m = /^\/compare\/([^.]+)\.\.\.(.+)$/.exec(path)) && method === 'GET') {
      const [a, b] = [decodeURIComponent(m[1]), decodeURIComponent(m[2])];
      if (this.missing.has(a) || this.missing.has(b)) return json(404, { message: 'Not Found' });
      const status = a === b ? 'identical' : this.ancestors.has(`${a}..${b}`) ? 'ahead' : this.ancestors.has(`${b}..${a}`) ? 'behind' : 'diverged';
      return json(200, { status });
    }
    if (path === '/issues' && method === 'GET') {
      const labels = (url.searchParams.get('labels') ?? '').split(',').filter(Boolean);
      const state = url.searchParams.get('state') ?? 'open';
      const all = this.issues.filter((i) => labels.every((l) => i.labels.includes(l)) && (state === 'all' || i.state === state)).sort((a, b) => b.number - a.number);
      return this.page(url, all.map((i) => this.view(i)));
    }
    if (path === '/issues' && method === 'POST') {
      this.log.push(`create ${body.title}`);
      const issue = this.seed({ title: body.title, body: body.body ?? '', labels: [...(body.labels ?? [])] });
      return json(201, this.view(issue));
    }
    if ((m = /^\/issues\/(\d+)$/.exec(path)) && method === 'PATCH') {
      const issue = this.issue(Number(m[1]));
      if (!issue) return json(404, { message: 'not found' });
      this.log.push(`update #${issue.number} ${Object.keys(body).sort().join(',')}`);
      if (body.title !== undefined) issue.title = body.title;
      if (body.body !== undefined) issue.body = body.body;
      if (body.labels !== undefined) issue.labels = [...body.labels];
      if (body.state === 'closed') {
        issue.state = 'closed';
        issue.state_reason = body.state_reason ?? 'completed';
      } else if (body.state === 'open') {
        issue.state = 'open';
        issue.state_reason = 'reopened';
      }
      return json(200, this.view(issue));
    }
    if ((m = /^\/issues\/(\d+)\/comments$/.exec(path))) {
      const issue = this.issue(Number(m[1]));
      if (!issue) return json(404, { message: 'not found' });
      if (method === 'GET') return this.page(url, issue.comments.map((c) => ({ id: c.id, body: c.body, user: { login: c.author ?? this.me() } })));
      this.log.push(`comment #${issue.number}`);
      const c = { id: this.nextComment++, body: body.body, author: this.me() };
      issue.comments.push(c);
      return json(201, { id: c.id, body: c.body, user: { login: c.author } });
    }
    if ((m = /^\/issues\/(\d+)\/labels$/.exec(path)) && method === 'POST') {
      const issue = this.issue(Number(m[1]));
      if (!issue) return json(404, { message: 'not found' });
      this.log.push(`label #${issue.number}`);
      for (const l of body.labels) if (!issue.labels.includes(l)) issue.labels.push(l);
      return json(200, issue.labels.map((name) => ({ name })));
    }
    if (path === '/actions/runs' && method === 'GET') {
      this.log.push('list runs');
      const since = (url.searchParams.get('created') ?? '>=1970-01-01').replace(/^>=/, '');
      const runs = Object.entries(this.runs).flatMap(([wf, list]) => list.map((r) => ({ path: `.github/workflows/${wf}`, ...r }))).filter((r) => r.created_at >= since);
      return this.page(url, runs, (items) => ({ total_count: runs.length, workflow_runs: items }));
    }
    if ((m = /^\/pulls\/(\d+)$/.exec(path)) && method === 'GET') {
      const sha = this.pulls[Number(m[1])];
      return sha ? json(200, { number: Number(m[1]), head: { sha } }) : json(404, { message: 'Not Found' });
    }
    if ((m = /^\/actions\/workflows\/([^/]+)\/runs$/.exec(path))) {
      const since = (url.searchParams.get('created') ?? '>=1970-01-01').replace(/^>=/, '');
      const runs = (this.runs[decodeURIComponent(m[1])] ?? []).filter((r) => r.created_at >= since);
      return this.page(url, runs, (items) => ({ total_count: runs.length, workflow_runs: items }));
    }
    if ((m = /^\/actions\/runs\/(\d+)\/jobs$/.exec(path))) {
      const jobs = this.jobs[Number(m[1])] ?? [];
      return this.page(url, jobs, (items) => ({ total_count: jobs.length, jobs: items }));
    }
    return json(404, { message: `no route ${method} ${path}` });
  }

  /**
   * @param {URL} url
   * @param {unknown[]} items
   * @param {(items: unknown[]) => unknown} [wrap]
   */
  page(url, items, wrap = (x) => x) {
    const page = Number(url.searchParams.get('page') ?? '1');
    const slice = items.slice((page - 1) * this.pageSize, page * this.pageSize);
    /** @type {Record<string, string>} */
    const extra = {};
    if (page * this.pageSize < items.length) {
      const next = new URL(url);
      next.searchParams.set('page', String(page + 1));
      extra.link = `<${next.href}>; rel="next"`;
    }
    return json(200, wrap(slice), extra);
  }
}

/**
 * @param {number} status
 * @param {unknown} data
 * @param {Record<string, string>} [headers]
 */
function json(status, data, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });
}
