/**
 * Minimal GitHub REST client over `fetch`. The token is passed in by the
 * publish commands; nothing here reads the environment.
 */

/** Author of comments written with the workflow's GITHUB_TOKEN. */
export const GITHUB_ACTIONS_LOGIN = 'github-actions[bot]';

export class GitHubError extends Error {
  /**
   * @param {string} message
   * @param {number} status HTTP status, 0 for network errors
   */
  constructor(message, status) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
  }
}

/**
 * @typedef {object} Issue
 * @property {number} number
 * @property {string} title
 * @property {string} body
 * @property {'open' | 'closed'} state
 * @property {string | null} state_reason
 * @property {string[]} labels
 * @property {string} html_url
 * @property {string | null} [author] login of the issue's author
 */

/**
 * @typedef {object} Comment
 * @property {number} id
 * @property {string} body
 * @property {string | null} author login of the comment's author
 */

/**
 * @typedef {object} GitHub
 * @property {string} repo `owner/name`
 * @property {(labels: string) => Promise<Issue[]>} listIssues open and closed issues carrying every label (comma-separated)
 * @property {(input: { title: string, body: string, labels: string[] }) => Promise<Issue>} createIssue
 * @property {(number: number, patch: { title?: string, body?: string, state?: 'open' | 'closed', state_reason?: string, labels?: string[] }) => Promise<Issue>} updateIssue
 * @property {(number: number) => Promise<Comment[]>} listComments
 * @property {(number: number, body: string) => Promise<Comment>} addComment
 * @property {(number: number, labels: string[]) => Promise<void>} addLabels
 * @property {() => Promise<string>} selfLogin the token's own login (`GET /user` once; `github-actions[bot]` when that is refused, as for GITHUB_TOKEN)
 * @property {() => Promise<{ default_branch: string }>} getRepo
 * @property {(branch: string) => Promise<string | null>} branchHead head sha of a branch, null when the branch does not exist
 * @property {(pr: number) => Promise<string | null>} pullHead head sha of a pull request, null when it does not exist
 * @property {(base: string, head: string) => Promise<string>} compareStatus `identical`, `ahead`, `behind` or `diverged` of head relative to base
 * @property {(createdSince: string) => Promise<WorkflowRun[]>} listRuns every workflow run of the repository created on or after the date (YYYY-MM-DD), one paginated call
 */

/** @typedef {{ id: number, run_started_at: string | null, updated_at: string | null, created_at: string, path?: string | null }} WorkflowRun */
/** @typedef {{ id: number, started_at: string | null, completed_at: string | null }} Job */

/**
 * @param {unknown} raw
 * @returns {Issue}
 */
function toIssue(raw) {
  const r = /** @type {any} */ (raw);
  return {
    number: r.number,
    title: typeof r.title === 'string' ? r.title : '',
    body: typeof r.body === 'string' ? r.body : '',
    state: r.state === 'closed' ? 'closed' : 'open',
    state_reason: typeof r.state_reason === 'string' ? r.state_reason : null,
    labels: Array.isArray(r.labels) ? r.labels.map((/** @type {any} */ l) => (typeof l === 'string' ? l : l?.name)).filter((/** @type {unknown} */ n) => typeof n === 'string') : [],
    html_url: typeof r.html_url === 'string' ? r.html_url : '',
    author: typeof r?.user?.login === 'string' ? r.user.login : null,
  };
}

/**
 * @param {string | null} link
 * @returns {string | null}
 */
function nextLink(link) {
  if (!link) return null;
  for (const part of link.split(',')) {
    const m = /<([^>]+)>\s*;\s*rel="?next"?/.exec(part);
    if (m) return m[1];
  }
  return null;
}

/**
 * @param {{ token: string, repo: string, fetch?: typeof fetch, apiUrl?: string }} opts
 * @returns {GitHub}
 */
export function createGitHub(opts) {
  if (!/^[^/\s]+\/[^/\s]+$/.test(opts.repo)) throw new GitHubError(`repository must be owner/name, got ${JSON.stringify(opts.repo)}`, 0);
  const doFetch = opts.fetch ?? globalThis.fetch;
  const api = (opts.apiUrl ?? 'https://api.github.com').replace(/\/+$/, '');
  const base = `${api}/repos/${opts.repo}`;
  /** @type {Promise<string> | null} */
  let self = null;
  /** @returns {Promise<string>} the token's login, asked once */
  const ownLogin = () => (self ??= (async () => {
    try {
      const { data } = await request('GET', `${api}/user`);
      if (typeof data?.login === 'string' && data.login !== '') return data.login;
    } catch (e) {
      // an installation token (GITHUB_TOKEN) may not read /user; anything else is a real failure
      if (!(e instanceof GitHubError) || ![401, 403, 404].includes(e.status)) {
        self = null;
        throw e;
      }
    }
    return GITHUB_ACTIONS_LOGIN;
  })());

  /**
   * @param {string} method
   * @param {string} url absolute
   * @param {unknown} [body]
   * @returns {Promise<{ data: any, link: string | null }>}
   */
  async function request(method, url, body) {
    /** @type {Record<string, string>} */
    const headers = {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'square2',
      authorization: `Bearer ${opts.token}`,
    };
    if (body !== undefined) headers['content-type'] = 'application/json';
    let res;
    try {
      res = await doFetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch (e) {
      throw new GitHubError(`${method} ${url.replace(api, '')}: ${e instanceof Error ? e.message : String(e)}`, 0);
    }
    const text = await res.text();
    if (!res.ok) throw new GitHubError(`${method} ${url.replace(api, '')} returned ${res.status}: ${text.slice(0, 200).replace(/\s+/g, ' ')}`, res.status);
    let data = null;
    if (text !== '') {
      try {
        data = JSON.parse(text);
      } catch {
        throw new GitHubError(`${method} ${url.replace(api, '')}: response is not JSON`, res.status);
      }
    }
    return { data, link: res.headers.get('link') };
  }

  /**
   * @param {string} url first page
   * @param {(data: any) => unknown[]} pick
   * @returns {Promise<any[]>}
   */
  async function paginate(url, pick) {
    /** @type {any[]} */
    const all = [];
    /** @type {string | null} */
    let next = url;
    let pages = 0;
    while (next !== null) {
      if (++pages > 1000) throw new GitHubError(`pagination did not terminate for ${url.replace(api, '')}`, 0);
      const { data, link } = await request('GET', next);
      all.push(...pick(data));
      next = nextLink(link);
    }
    return all;
  }

  return {
    repo: opts.repo,
    async listIssues(labels) {
      const items = await paginate(`${base}/issues?labels=${encodeURIComponent(labels)}&state=all&per_page=100`, (d) => (Array.isArray(d) ? d : []));
      return items.filter((i) => !i.pull_request).map(toIssue);
    },
    async createIssue(input) {
      return toIssue((await request('POST', `${base}/issues`, input)).data);
    },
    async updateIssue(number, patch) {
      return toIssue((await request('PATCH', `${base}/issues/${number}`, patch)).data);
    },
    async listComments(number) {
      const items = await paginate(`${base}/issues/${number}/comments?per_page=100`, (d) => (Array.isArray(d) ? d : []));
      return items.map((c) => ({ id: c.id, body: typeof c.body === 'string' ? c.body : '', author: typeof c?.user?.login === 'string' ? c.user.login : null }));
    },
    async addComment(number, body) {
      const { data } = await request('POST', `${base}/issues/${number}/comments`, { body });
      return { id: data?.id, body: typeof data?.body === 'string' ? data.body : body, author: typeof data?.user?.login === 'string' ? data.user.login : await ownLogin() };
    },
    selfLogin: ownLogin,
    async addLabels(number, labels) {
      await request('POST', `${base}/issues/${number}/labels`, { labels });
    },
    async getRepo() {
      const { data } = await request('GET', base);
      return { default_branch: String(data?.default_branch ?? '') };
    },
    async branchHead(branch) {
      try {
        const { data } = await request('GET', `${base}/branches/${encodeURIComponent(branch)}`);
        const sha = data?.commit?.sha;
        return typeof sha === 'string' && /^[0-9a-f]{40,64}$/.test(sha) ? sha : null;
      } catch (e) {
        if (e instanceof GitHubError && e.status === 404) return null;
        throw e;
      }
    },
    async pullHead(pr) {
      try {
        const { data } = await request('GET', `${base}/pulls/${Number(pr)}`);
        const sha = data?.head?.sha;
        return typeof sha === 'string' && /^[0-9a-f]{40,64}$/.test(sha) ? sha : null;
      } catch (e) {
        if (e instanceof GitHubError && e.status === 404) return null;
        throw e;
      }
    },
    async compareStatus(baseSha, headSha) {
      const { data } = await request('GET', `${base}/compare/${encodeURIComponent(baseSha)}...${encodeURIComponent(headSha)}`);
      return String(data?.status ?? '');
    },
    async listRuns(createdSince) {
      return paginate(`${base}/actions/runs?created=${encodeURIComponent(`>=${createdSince}`)}&per_page=100`, (d) => (Array.isArray(d?.workflow_runs) ? d.workflow_runs : []));
    },
  };
}
