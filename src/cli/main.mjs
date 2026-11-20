import { appendFileSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  BaselineError,
  baselineSize,
  checkRatchet,
  emptyBaseline,
  grow,
  normalizeBaseline,
  parseApprovals,
  parseBaseline,
  serializeBaseline,
  shrink,
} from '../core/baseline.mjs';
import { canonicalDocument } from '../core/canonical-json.mjs';
import { ClockError, today as clockToday } from '../core/clock.mjs';
import { applyExceptions, detectMutations, parseExceptions, splitByExpiry, validateExceptions } from '../core/exceptions.mjs';
import { buildReport, classify, decide, githubAnnotations, markdownSummary, ruleStats, serializeReport } from '../core/report.mjs';
import { formatDiagnostic } from '../core/violation.mjs';
import { GitError, runGit, topLevel } from '../git/exec.mjs';
import { blobAt, blobText, resolveBase } from '../git/show.mjs';
import { runRules, selftest } from './engines.mjs';
import { globalExcludes, loadRepo, readOptional, selectRules } from './load.mjs';
import { ReplayError, replayCommit, replaySince } from './replay.mjs';
import { VendorError, vendor, verifyVendor } from './vendor.mjs';
import { VERSION } from './version.mjs';

export const USAGE = `square² (方方) ${VERSION}

Usage: square2 <command> [options]

Commands:
  check [--only <ids>] [--format text|github] [--report <path>] [--base <sha>]
                         self-test, then gate the repository (exit 0 pass, 1 violations, 2 cannot run)
  selftest [--only <ids>]
                         every enabled rule must fire on .square2/fixtures/<id>/bad/
  baseline show          print baseline counts per rule
  baseline shrink        drop baseline entries that are no longer observed
  baseline grow --approval <id>
                         add every current violation not covered by a live exception,
                         citing an entry of .square2/approvals.yaml
  exceptions lint [--base <sha>]
                         validate .square2/exceptions.yaml
  vendor --from <path|git-url> --ref <tag> [--into <dir>]
                         copy square² into the repository and write .square2/lock.json
  replay --rule <id> (--commit <sha> | --since <days>) [--out <file>]
                         run one rule against history in a temporary worktree

Common options:
  --root <dir>           repository root (default: the git top level of the current directory)
  --square2-dir <dir>    use this directory instead of <root>/.square2 (or env SQUARE2_DIR)
  --help                 show this help

<ids> is a comma-separated list of rule id globs, for example 'S2-DEP-*,S2-SUPPRESS-*'.
`;

/**
 * Process boundary: everything the CLI needs from outside.
 * @typedef {object} CliIO
 * @property {string} cwd
 * @property {Record<string, string | undefined>} env
 * @property {(text: string) => void} stdout
 * @property {(text: string) => void} stderr
 * @property {Date} [now]
 * @property {string} [toolRoot] directory of the running square² (default: this file's ../..)
 * @property {Record<string, import('./engine-util.mjs').EngineAdapter>} [adapters]
 * @property {import('./engine-util.mjs').Exec} [exec]
 * @property {(repoRoot: string, name: string, pkg: string) => string[]} [resolveBin]
 */

const OPTIONS = /** @type {const} */ ({
  only: { type: 'string' },
  format: { type: 'string' },
  report: { type: 'string' },
  base: { type: 'string' },
  approval: { type: 'string' },
  from: { type: 'string' },
  ref: { type: 'string' },
  into: { type: 'string' },
  rule: { type: 'string' },
  commit: { type: 'string' },
  since: { type: 'string' },
  out: { type: 'string' },
  root: { type: 'string' },
  'square2-dir': { type: 'string' },
  help: { type: 'boolean', short: 'h' },
});

class UsageError extends Error {}

/**
 * Real path of an existing directory (symlinks resolved), else the path as given.
 * @param {string} p
 * @returns {string}
 */
function real(p) {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * @param {string[]} argv arguments after `square2`
 * @param {CliIO} io
 * @returns {Promise<0 | 1 | 2>}
 */
export async function main(argv, io) {
  /** @param {string[]} lines */
  const out = (lines) => { for (const l of lines) io.stdout(l + '\n'); };
  /** @param {string[]} lines */
  const err = (lines) => { for (const l of lines) io.stderr(l + '\n'); };
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (e) {
    err([formatDiagnostic('S2-USAGE', e instanceof Error ? e.message : 'invalid arguments', 'run `square2 --help`')]);
    return 2;
  }
  const { values, positionals } = parsed;
  const [command, sub] = positionals;
  if (values.help || command === undefined || command === 'help') {
    io.stdout(USAGE);
    return 0;
  }
  try {
    const repoRoot = real(values.root ? resolve(io.cwd, values.root) : (await topLevel(io.cwd)) ?? io.cwd);
    const toolRoot = io.toolRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
    const deps = { adapters: io.adapters, exec: io.exec, resolveBin: io.resolveBin };
    const dirOverride = values['square2-dir'] ?? io.env.SQUARE2_DIR;
    const dir = real(dirOverride ? resolve(io.cwd, dirOverride) : join(repoRoot, '.square2'));

    if (command === 'vendor') {
      if (!values.from || !values.ref) throw new UsageError('vendor needs --from and --ref');
      const res = await vendor({ repo: { root: repoRoot, dir }, cwd: io.cwd, from: values.from, ref: values.ref, into: values.into });
      out(res.lines);
      return 0;
    }

    const tamper = verifyVendor({ root: repoRoot, dir }, toolRoot);
    if (tamper.status === 'tampered') {
      out([tamper.line]);
      return 2;
    }

    const repo = loadRepo(repoRoot, { provenance: command !== 'replay', dir });
    const fatalLoad = [...repo.configDiagnostics, ...repo.catalogue.diagnostics];
    if (fatalLoad.length > 0) {
      out(fatalLoad);
      return 2;
    }
    const selected = selectRules(repo.catalogue.rules, values.only);
    if (values.only !== undefined && (values.only.trim() === '' || selected.length === 0)) {
      out([formatDiagnostic('S2-ONLY-EMPTY', `--only ${JSON.stringify(values.only)} matches no rule`, `use comma-separated id globs that match rules in .square2/rules/, for example ${repo.catalogue.rules[0]?.id ?? 'S2-DEP-*'}`)]);
      return 2;
    }
    let runDate;
    try {
      runDate = clockToday({ env: io.env, now: io.now });
    } catch (e) {
      if (e instanceof ClockError) {
        out([formatDiagnostic('S2-CONFIG', e.message, 'unset SQUARE2_TODAY or set it to YYYY-MM-DD')]);
        return 2;
      }
      throw e;
    }

    if (command === 'selftest') {
      const st = await selftest({ repoRoot, dir: repo.dir, rules: selected, config: repo.config, ...deps });
      err(st.warnings.map((w) => `warning: ${w}`));
      if (st.lines.length > 0) {
        out(st.lines);
        return 2;
      }
      out([`selftest: ${st.checked} rule(s) fired on their bad fixtures`]);
      return 0;
    }

    if (command === 'check') return await check({ io, values, repo, selected, runDate, deps, out, err });

    if (command === 'baseline') return await baselineCommand({ sub, values, repo, runDate, deps, out });

    if (command === 'exceptions') {
      if (sub !== 'lint') throw new UsageError('usage: square2 exceptions lint');
      const base = await checkBase(repo, values.base);
      if (typeof base === 'string') {
        out([base]);
        return 2;
      }
      const ex = await exceptionState(repo, base, runDate);
      const lines = [...ex.invalid, ...ex.mutated, ...ex.expiredLines];
      if (lines.length > 0) {
        out(lines);
        return 1;
      }
      out([`exceptions: ${ex.valid.length} valid, none expired`]);
      return 0;
    }

    if (command === 'replay') {
      if (!values.rule) throw new UsageError('replay needs --rule <id>');
      if ((values.commit === undefined) === (values.since === undefined)) throw new UsageError('replay needs exactly one of --commit <sha> or --since <days>');
      const rule = repo.catalogue.rules.find((r) => r.id === values.rule);
      if (!rule) throw new UsageError(`no rule ${values.rule} in .square2/rules/`);
      let report;
      if (values.commit !== undefined) {
        report = await replayCommit({ repoRoot, dir: repo.dir, rule, config: repo.config, commit: values.commit, ...deps });
      } else {
        const days = Number(values.since);
        if (!Number.isInteger(days) || days < 1) throw new UsageError('--since must be a positive number of days');
        report = await replaySince({ repoRoot, dir: repo.dir, rule, config: repo.config, sinceDays: days, now: io.now, ...deps });
      }
      const text = canonicalDocument(report);
      if (values.out) {
        const target = resolve(io.cwd, values.out);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, text);
        out([`replay report written to ${values.out}`]);
      } else io.stdout(text);
      return 0;
    }

    throw new UsageError(`unknown command ${command}`);
  } catch (e) {
    if (e instanceof UsageError) {
      err([formatDiagnostic('S2-USAGE', e.message, 'run `square2 --help`')]);
      return 2;
    }
    if (e instanceof VendorError) {
      out([e.diagnostic]);
      return 2;
    }
    if (e instanceof ReplayError) {
      out([formatDiagnostic('S2-REPLAY', e.message.split('\n')[0], 'fix the engine error above, then re-run replay'), ...e.message.split('\n').slice(1)]);
      return 2;
    }
    if (e instanceof GitError) {
      out([formatDiagnostic('S2-GIT', e.message, 'run square2 inside a git repository with the referenced commits fetched')]);
      return 2;
    }
    throw e;
  }
}

/**
 * Validate `--base`: undefined (no ratchet), a resolved commit, or a
 * diagnostic line when it does not resolve (exit 2).
 * @param {import('./load.mjs').Repo} repo
 * @param {string | undefined} base
 * @returns {Promise<{ kind: 'no-commit' } | { kind: 'commit', sha: string } | undefined | string>}
 */
async function checkBase(repo, base) {
  if (base === undefined) return undefined;
  const resolved = await resolveBase(repo.root, base);
  if (resolved === null) {
    return formatDiagnostic('S2-BASE-UNRESOLVED', `--base ${base} is not a commit in this repository`, 'fetch the base commit (actions/checkout with fetch-depth: 0), or pass the all-zero sha when there is no previous commit');
  }
  return resolved;
}

/**
 * The previous commit's copy of a file in the square² directory.
 * @param {import('./load.mjs').Repo} repo
 * @param {{ kind: 'no-commit' } | { kind: 'commit', sha: string }} base
 * @param {string} name file name inside the square² directory
 * @returns {Promise<import('../git/show.mjs').BlobAt>}
 */
async function previous(repo, base, name) {
  if (base.kind === 'no-commit' || repo.dirInRepo === null) return { kind: 'no-commit' };
  return blobAt(repo.root, base.sha, `${repo.dirInRepo}/${name}`);
}

/**
 * @param {import('./load.mjs').Repo} repo
 * @param {{ kind: 'no-commit' } | { kind: 'commit', sha: string } | undefined} base
 * @param {string} runDate
 */
async function exceptionState(repo, base, runDate) {
  const text = readOptional(join(repo.dir, 'exceptions.yaml'));
  const parsed = text === null ? { entries: [], diagnostics: [] } : parseExceptions(text);
  const validated = validateExceptions(parsed.entries, {
    ruleIds: repo.catalogue.rules.map((r) => r.id),
    today: runDate,
    maxTtlDays: repo.config.max_exception_ttl_days,
  });
  const expiry = splitByExpiry(validated.valid, runDate);
  const mutated = base === undefined ? [] : detectMutations(blobText(await previous(repo, base, 'exceptions.yaml')), parsed.entries);
  return {
    valid: validated.valid,
    invalid: [...parsed.diagnostics, ...validated.diagnostics],
    mutated,
    live: expiry.live,
    expired: expiry.expired,
    expiredLines: expiry.diagnostics,
  };
}

/**
 * @param {import('./load.mjs').Repo} repo
 * @returns {{ baseline: import('../core/baseline.mjs').Baseline } | { error: string }}
 */
function readBaseline(repo) {
  const text = readOptional(join(repo.dir, 'baseline.json'));
  if (text === null) return { baseline: emptyBaseline() };
  try {
    return { baseline: parseBaseline(text) };
  } catch (e) {
    if (e instanceof BaselineError) return { error: formatDiagnostic('S2-BASELINE-INVALID', `.square2/baseline.json: ${e.message}`, 'regenerate it with `square2 baseline shrink` or restore it from git') };
    throw e;
  }
}

/**
 * @param {{
 *   io: CliIO,
 *   values: Record<string, string | boolean | undefined>,
 *   repo: import('./load.mjs').Repo,
 *   selected: import('../core/catalogue.mjs').Rule[],
 *   runDate: string,
 *   deps: import('./engines.mjs').EngineDeps,
 *   out: (lines: string[]) => void,
 *   err: (lines: string[]) => void,
 * }} a
 * @returns {Promise<0 | 1 | 2>}
 */
async function check(a) {
  const { io, values, repo, selected, runDate, deps, out, err } = a;
  const format = typeof values.format === 'string' ? values.format : 'text';
  if (format !== 'text' && format !== 'github') throw new UsageError('--format must be text or github');
  const base = await checkBase(repo, typeof values.base === 'string' ? values.base : undefined);
  if (typeof base === 'string') {
    out([base]);
    return 2;
  }

  const st = await selftest({ repoRoot: repo.root, dir: repo.dir, rules: selected, config: repo.config, ...deps });
  err(st.warnings.map((w) => `warning: ${w}`));
  if (st.lines.length > 0) {
    out(st.lines);
    return 2;
  }
  const run = await runRules({ root: repo.root, repoRoot: repo.root, mode: 'repo', rules: selected, config: repo.config, excludes: globalExcludes(repo), ...deps });
  err(run.warnings.map((w) => `warning: ${w}`));
  if (run.errors.length > 0) {
    out(run.errors);
    return 2;
  }
  const bl = readBaseline(repo);
  if ('error' in bl) {
    out([bl.error]);
    return 2;
  }
  const ex = await exceptionState(repo, base, runDate);
  /** @type {{ diagnostics: string[], notes: string[] } | undefined} */
  let ratchet;
  if (base !== undefined) {
    ratchet = checkRatchet({
      previousBaseline: await previous(repo, base, 'baseline.json'),
      currentBaseline: bl.baseline,
      previousApprovalsText: blobText(await previous(repo, base, 'approvals.yaml')),
      currentApprovalsText: readOptional(join(repo.dir, 'approvals.yaml')),
      approvers: repo.config.approvers,
    });
  }
  const classification = classify({ violations: run.violations, baseline: bl.baseline, live: ex.live, expired: ex.expired });
  const instead = new Map(repo.catalogue.rules.map((r) => [r.id, r.instead]));
  const decision = decide({
    classification,
    instead,
    invalidExceptions: ex.invalid,
    mutatedExceptions: ex.mutated,
    expiredExceptions: ex.expiredLines,
    ratchet,
  });
  out(decision.lines);
  if (format === 'github') {
    out(githubAnnotations(classification, instead));
    const summaryPath = io.env.GITHUB_STEP_SUMMARY;
    if (summaryPath) appendFileSync(summaryPath, markdownSummary({ decision, stats: ruleStats(classification, selected.map((r) => r.id)) }));
  }
  err(decision.notes.map((n) => `note: ${n}`));
  const head = await runGit(repo.root, ['rev-parse', 'HEAD']).catch(() => null);
  const report = buildReport({
    repo: io.env.GITHUB_REPOSITORY ?? basename(repo.root),
    head_sha: head && head.code === 0 ? head.stdout.trim() : 'unknown',
    runner_version: VERSION,
    catalogue_digest: repo.catalogue.digest,
    engine_versions: run.versions,
    rule_ids: selected.map((r) => r.id),
    classification,
    exit_code: decision.exitCode,
    today: runDate,
  });
  const reportPath = resolve(io.cwd, typeof values.report === 'string' ? values.report : 'square2-report.json');
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, serializeReport(report));
  if (decision.exitCode === 0) out([`square2: ok (${selected.filter((r) => r.enabled).length} rules, ${run.violations.length} violations all baselined or excepted)`]);
  return decision.exitCode;
}

/**
 * @param {{
 *   sub: string | undefined,
 *   values: Record<string, string | boolean | undefined>,
 *   repo: import('./load.mjs').Repo,
 *   runDate: string,
 *   deps: import('./engines.mjs').EngineDeps,
 *   out: (lines: string[]) => void,
 * }} a
 * @returns {Promise<0 | 1 | 2>}
 */
async function baselineCommand(a) {
  const { sub, values, repo, runDate, deps, out } = a;
  const bl = readBaseline(repo);
  if ('error' in bl) {
    out([bl.error]);
    return 2;
  }
  if (sub === 'show') {
    /** @type {Map<string, number>} */
    const perRule = new Map();
    for (const e of bl.baseline.entries) perRule.set(e.rule_id, (perRule.get(e.rule_id) ?? 0) + e.count);
    out([...[...perRule].sort((x, y) => (x[0] < y[0] ? -1 : 1)).map(([id, n]) => `${id} ${n}`), `total ${baselineSize(bl.baseline)}`]);
    return 0;
  }
  if (sub !== 'shrink' && sub !== 'grow') throw new UsageError('usage: square2 baseline show|shrink|grow --approval <id>');
  const st = await selftest({ repoRoot: repo.root, dir: repo.dir, rules: repo.catalogue.rules, config: repo.config, ...deps });
  if (st.lines.length > 0) {
    out([...st.lines, formatDiagnostic('S2-BASELINE-REFUSED', `baseline ${sub} refused while the self-test fails`, 'fix the rules or engines until `square2 selftest` passes')]);
    return 2;
  }
  const ex = await exceptionState(repo, undefined, runDate);
  if (ex.invalid.length > 0) {
    out([...ex.invalid, formatDiagnostic('S2-BASELINE-REFUSED', `baseline ${sub} refused while .square2/exceptions.yaml is invalid`, 'fix the exceptions first (`square2 exceptions lint`)')]);
    return 1;
  }
  const run = await runRules({ root: repo.root, repoRoot: repo.root, mode: 'repo', rules: repo.catalogue.rules, config: repo.config, excludes: globalExcludes(repo), ...deps });
  if (run.errors.length > 0) {
    out(run.errors);
    return 2;
  }
  const path = join(repo.dir, 'baseline.json');
  if (sub === 'shrink') {
    const enabled = new Set(repo.catalogue.rules.filter((r) => r.enabled).map((r) => r.id));
    const disabled = new Set(repo.catalogue.rules.filter((r) => !r.enabled).map((r) => r.id));
    const kept = bl.baseline.entries.filter((e) => disabled.has(e.rule_id));
    const active = { ...bl.baseline, entries: bl.baseline.entries.filter((e) => enabled.has(e.rule_id)) };
    const next = normalizeBaseline([...shrink(active, run.violations).entries, ...kept]);
    writeFileSync(path, serializeBaseline(next));
    out([`baseline: ${baselineSize(bl.baseline)} -> ${baselineSize(next)} entries`]);
    return 0;
  }
  if (typeof values.approval !== 'string') throw new UsageError('baseline grow needs --approval <id>');
  let approvals;
  try {
    approvals = parseApprovals(readOptional(join(repo.dir, 'approvals.yaml')));
  } catch (e) {
    if (e instanceof BaselineError) {
      out([formatDiagnostic('S2-BASELINE-GREW', e.message, 'fix .square2/approvals.yaml')]);
      return 1;
    }
    throw e;
  }
  const approval = approvals.find((x) => x && typeof x === 'object' && 'id' in x && x.id === values.approval);
  try {
    const uncovered = applyExceptions(run.violations, ex.live).remaining;
    const next = grow(bl.baseline, uncovered, { approval: /** @type {any} */ (approval ?? null), approvers: repo.config.approvers });
    writeFileSync(path, serializeBaseline(next));
    out([`baseline: ${baselineSize(bl.baseline)} -> ${baselineSize(next)} entries (approval ${values.approval})`]);
    return 0;
  } catch (e) {
    if (e instanceof BaselineError) {
      out([formatDiagnostic('S2-BASELINE-GREW', `${approval ? '' : `no approval ${values.approval} in .square2/approvals.yaml; `}${e.message}`, 'add {id, approver, date, reason, adr} to .square2/approvals.yaml with an approver listed in config approvers')]);
      return 1;
    }
    throw e;
  }
}
