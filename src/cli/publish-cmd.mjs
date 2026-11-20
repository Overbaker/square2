import { appendFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { BaselineError, emptyBaseline, parseBaseline } from '../core/baseline.mjs';
import { formatDiagnostic } from '../core/violation.mjs';
import { topLevel } from '../git/exec.mjs';
import { notifyLogins } from '../review/render.mjs';
import { GitHubError, createGitHub } from '../issues/github.mjs';
import { DEFAULT_MAX_NEW_ISSUES, gateInputId, gateItems, publish } from '../issues/publish.mjs';
import { StateIssue } from '../issues/state.mjs';
import { budgetConfig, checkBudget } from '../issues/budget.mjs';
import { loadRepo, readOptional } from './load.mjs';
import { verifyVendor } from './vendor.mjs';

/**
 * Extra process boundary for the publish commands (tests inject fakes).
 * @typedef {object} PublishIO
 * @property {typeof fetch} [fetch] GitHub REST transport (default: global fetch)
 * @property {GitOps} [gitOps] freshness checks for review publish (default: the GitHub API)
 * @property {import('../review/candidate.mjs').Replay} [replay] rule-candidate replay (default: replay in this checkout)
 * @property {ReviewImpl} [review] review prepare/validate implementation (default: src/review/*.mjs)
 */

/**
 * @typedef {object} GitOps
 * @property {(repoRoot: string, branch: string) => Promise<string | null>} liveHead current head of the branch on the remote
 * @property {(repoRoot: string, ancestor: string, head: string) => Promise<boolean>} isAncestor ancestor-or-equal
 * @property {(repoRoot: string, pr: number) => Promise<string | null>} [pullHead] current head sha of a pull request (default: the GitHub API)
 */

/**
 * @typedef {object} ReviewImpl
 * @property {(opts: Record<string, unknown>) => Promise<any>} [prepare]
 * @property {(opts: Record<string, unknown>) => Promise<any>} [validate]
 */

/** @typedef {import('./main.mjs').CliIO & PublishIO} Io */

export const COMMON_OPTIONS = /** @type {const} */ ({
  root: { type: 'string' },
  'square2-dir': { type: 'string' },
  repo: { type: 'string' },
  branch: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
});

export class CommandError extends Error {
  /** @param {string} diagnostic one formatted diagnostic line @param {0 | 1 | 2} [code] */
  constructor(diagnostic, code = 2) {
    super(diagnostic);
    this.diagnostic = diagnostic;
    this.code = code;
  }
}

/** @param {string} p */
function real(p) {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * @template {Record<string, { type: 'string' | 'boolean', short?: string }>} O
 * @param {string[]} argv
 * @param {O} options
 */
export function parse(argv, options) {
  try {
    return parseArgs({ args: argv, options: { ...COMMON_OPTIONS, ...options }, allowPositionals: true, strict: true });
  } catch (e) {
    throw new CommandError(formatDiagnostic('S2-USAGE', e instanceof Error ? e.message : 'invalid arguments', 'run `square2 --help`'));
  }
}

/**
 * Resolve and load the repository (config only; rules are not needed to publish).
 * @param {{ root?: string, 'square2-dir'?: string }} values
 * @param {Io} io
 */
export async function openRepo(values, io) {
  const repoRoot = real(values.root ? resolve(io.cwd, values.root) : (await topLevel(io.cwd)) ?? io.cwd);
  const dirOverride = values['square2-dir'] ?? io.env.SQUARE2_DIR;
  const dir = real(dirOverride ? resolve(io.cwd, dirOverride) : join(repoRoot, '.square2'));
  const toolRoot = io.toolRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const tamper = verifyVendor({ root: repoRoot, dir }, toolRoot);
  if (tamper.status === 'tampered') throw new CommandError(tamper.line);
  const repo = loadRepo(repoRoot, { provenance: false, dir });
  if (repo.configDiagnostics.length > 0) throw new CommandError(repo.configDiagnostics.join('\n'));
  return repo;
}

/**
 * GitHub client from GITHUB_TOKEN and GITHUB_REPOSITORY (or --repo).
 * @param {Io} io
 * @param {{ repo?: string }} values
 */
export function github(io, values) {
  const token = io.env.GITHUB_TOKEN;
  if (!token) throw new CommandError(formatDiagnostic('S2-PUBLISH', 'GITHUB_TOKEN is not set', 'run this step with `env: GITHUB_TOKEN: ${{ github.token }}` and `issues: write`'));
  const repo = values.repo ?? io.env.GITHUB_REPOSITORY;
  if (!repo) throw new CommandError(formatDiagnostic('S2-PUBLISH', 'repository unknown', 'pass --repo owner/name or set GITHUB_REPOSITORY'));
  try {
    return createGitHub({ token, repo, fetch: io.fetch, apiUrl: io.env.GITHUB_API_URL });
  } catch (e) {
    if (e instanceof GitHubError) throw new CommandError(formatDiagnostic('S2-PUBLISH', e.message, 'pass --repo owner/name'));
    throw e;
  }
}

/**
 * Publishing settings from `.square2/config.yaml`.
 * @param {Record<string, unknown>} raw
 */
export function publishSettings(raw) {
  const capRaw = raw.max_new_issues_per_run;
  const cap = typeof capRaw === 'number' && Number.isInteger(capRaw) && capRaw >= 0 ? capRaw : DEFAULT_MAX_NEW_ISSUES;
  const branch = typeof raw.branch === 'string' && raw.branch.trim() !== '' ? raw.branch.trim() : null;
  const language = raw.language === 'zh' ? /** @type {const} */ ('zh') : /** @type {const} */ ('en');
  return { cap, notify: notifyLogins(raw.notify), branch, language };
}

/**
 * The configured branch: config `branch`, else the repository's default branch.
 * @param {import('../issues/github.mjs').GitHub} gh
 * @param {string | null} configured
 */
export async function configuredBranch(gh, configured) {
  return configured ?? (await gh.getRepo()).default_branch;
}

/**
 * @param {Io} io
 * @param {string} text
 */
export function stepSummary(io, text) {
  const path = io.env.GITHUB_STEP_SUMMARY;
  if (path) appendFileSync(path, text.endsWith('\n') ? text : text + '\n');
}

/**
 * @param {string} path
 * @param {string} what
 * @returns {any}
 */
export function readJson(path, what) {
  const text = readOptional(path);
  if (text === null) throw new CommandError(formatDiagnostic('S2-PUBLISH', `${what} not found at ${path}`, `pass the ${what} path produced by the previous step`));
  try {
    return JSON.parse(text);
  } catch {
    throw new CommandError(formatDiagnostic('S2-PUBLISH', `${what} at ${path} is not JSON`, `re-run the step that writes the ${what}`));
  }
}

/**
 * @param {(lines: string[]) => void} out
 * @param {import('../issues/publish.mjs').PublishResult} res
 */
export function printResult(out, res) {
  for (const c of res.changes) out([`${c.action} #${c.number} ${c.label} ${c.title}`]);
  if (res.overflow.length > 0) out([`overflow: ${res.overflow.length} finding(s) listed on the state issue`]);
  out([`published: ${res.changes.length} change(s), ${res.created} created, digest ${res.digest ? 'posted' : 'not posted'}`]);
}

/**
 * `square2 publish-gate [--report <path>] [--branch <ref>] [--test]`
 * @param {string[]} argv
 * @param {Io} io
 * @returns {Promise<0 | 1 | 2>}
 */
export async function publishGateCommand(argv, io) {
  /** @param {string[]} lines */
  const out = (lines) => { for (const l of lines) io.stdout(l + '\n'); };
  try {
    const { values } = parse(argv, { report: { type: 'string' }, test: { type: 'boolean' }, nonce: { type: 'string' } });
    const repo = await openRepo(values, io);
    const report = readJson(resolve(io.cwd, values.report ?? 'square2-report.json'), 'gate report');
    if (!report || typeof report !== 'object' || !Array.isArray(report.new_violations) || !Array.isArray(report.observed)) {
      throw new CommandError(formatDiagnostic('S2-PUBLISH', 'gate report is not a square2-report.json', 'pass the report written by `square2 check --report`'));
    }
    if (report.exit_code === 2) {
      out(['publish-gate: the gate could not run (exit_code 2); nothing published']);
      return 0;
    }
    const ref = values.branch ?? io.env.GITHUB_REF_NAME;
    if (!ref) throw new CommandError(formatDiagnostic('S2-USAGE', 'publish-gate needs the current branch', 'pass --branch <name> or set GITHUB_REF_NAME'));
    const test = values.test === true;
    const gh = github(io, values);
    const settings = publishSettings(repo.config.raw);
    const target = await configuredBranch(gh, settings.branch);
    if (!test && ref !== target) {
      out([`publish-gate: ${ref} is not the configured branch ${target}; nothing published (use --test for a test publication)`]);
      return 0;
    }
    const blText = readOptional(join(repo.dir, 'baseline.json'));
    let baseline = emptyBaseline();
    try {
      if (blText !== null) baseline = parseBaseline(blText);
    } catch (e) {
      if (e instanceof BaselineError) throw new CommandError(formatDiagnostic('S2-BASELINE-INVALID', `.square2/baseline.json: ${e.message}`, 'restore the baseline from git'));
      throw e;
    }
    const observed = new Set([...report.observed, ...(Array.isArray(report.excepted) ? report.excepted : [])].map((o) => String(o.fingerprint)));
    const head = String(report.head_sha ?? 'unknown');
    const nonce = test ? (values.nonce ?? io.env.GITHUB_RUN_ID ?? `${(io.now ?? new Date()).getTime()}`) : undefined;
    const inputId = gateInputId({ repo: gh.repo, branch: ref, head_sha: head, catalogue_digest: String(report.catalogue_digest ?? ''), test, nonce });
    const enabled = new Set(repo.catalogue.rules.filter((r) => r.enabled).map((r) => r.id));
    const state = new StateIssue(gh);
    const res = await publish({
      gh,
      state,
      run: { kind: 'gate', inputId, branch: ref, sha: head, test, language: settings.language },
      items: gateItems(report, { test, nonce, language: settings.language }),
      cap: settings.cap,
      notify: settings.notify,
      resolveGate: test ? undefined : { observed, baselined: new Set(baseline.entries.map((e) => e.fingerprint)), rules: new Set(Object.entries(report.rules ?? {}).filter(([id, st]) => enabled.has(id) && !(st && /** @type {any} */ (st).unknown === true)).map(([id]) => id)) },
    });
    printResult(out, res);
    stepSummary(io, `square² publish-gate: ${res.changes.length} issue change(s), ${res.created} created${res.overflow.length ? `, ${res.overflow.length} overflow` : ''}`);
    return 0;
  } catch (e) {
    if (e instanceof CommandError) {
      out([e.diagnostic]);
      return e.code;
    }
    if (e instanceof GitHubError) {
      out([formatDiagnostic('S2-PUBLISH', e.message, 're-run the publish step; it is idempotent')]);
      return 2;
    }
    throw e;
  }
}

/**
 * Freshness checks through the GitHub API with the publish token: no
 * `ls-remote`, no fetch, works with `persist-credentials: false`.
 * @param {import('../issues/github.mjs').GitHub} gh
 * @returns {GitOps}
 */
export function apiGitOps(gh) {
  return {
    liveHead: (_repoRoot, branch) => gh.branchHead(branch),
    pullHead: (_repoRoot, pr) => gh.pullHead(pr),
    async isAncestor(_repoRoot, ancestor, head) {
      if (ancestor === head) return true;
      const status = await gh.compareStatus(ancestor, head);
      return status === 'ahead' || status === 'identical';
    },
  };
}

/**
 * `square2 budget`: month-to-date minutes of the square² workflows, with a
 * warning on the state issue over the threshold. Missing permissions or a
 * missing workflow degrade to a note (exit 0).
 * @param {string[]} argv
 * @param {Io} io
 * @returns {Promise<0 | 1 | 2>}
 */
export async function budgetCommand(argv, io) {
  /** @param {string[]} lines */
  const out = (lines) => { for (const l of lines) io.stdout(l + '\n'); };
  try {
    const { values } = parse(argv, {});
    const repo = await openRepo(values, io);
    const gh = github(io, values);
    const b = budgetConfig(repo.config.raw);
    try {
      const r = await checkBudget({ gh, state: new StateIssue(gh), now: io.now ?? new Date(), monthly: b.monthly, workflows: b.workflows, jobs: b.jobs });
      out([`budget: ${r.minutes} minutes month-to-date, threshold ${Math.round(r.threshold * 10) / 10}${r.warned ? ' (warning posted)' : ''}`]);
      stepSummary(io, `square² budget: ${r.minutes} minutes month-to-date (threshold ${Math.round(r.threshold * 10) / 10})`);
    } catch (e) {
      if (!(e instanceof GitHubError) || ![403, 404].includes(e.status)) throw e;
      out([`note: budget check skipped (${e.status}): ${e.message}`]);
    }
    return 0;
  } catch (e) {
    if (e instanceof CommandError) {
      out([e.diagnostic]);
      return e.code;
    }
    if (e instanceof GitHubError) {
      out([formatDiagnostic('S2-PUBLISH', e.message, 'grant actions: read and issues: write to this step')]);
      return 2;
    }
    throw e;
  }
}
