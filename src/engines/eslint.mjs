import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { finalizeViolations } from '../core/violation.mjs';
import { EngineError, globRoots, mapConcurrent, relativeToRoot, ruleSelector, toolVersion } from '../cli/engine-util.mjs';

const LINTABLE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const BATCH = 400;
const DEFAULT_CONFIGS = ['eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', 'eslint.config.ts', 'eslint.config.mts', 'eslint.config.cts'];

/**
 * Map `--format json` output to raw violations. Each square² rule names its
 * ESLint rule in `options.rule`.
 * @param {string} root
 * @param {string} stdout
 * @param {import('../core/catalogue.mjs').Rule[]} rules
 * @param {string[]} excludes
 * @returns {import('../core/violation.mjs').RawViolation[]}
 */
export function mapEslintOutput(root, stdout, rules, excludes) {
  let doc;
  try {
    doc = JSON.parse(stdout);
  } catch {
    throw new EngineError('S2-ENGINE-FAILED', 'eslint did not print JSON', 'run `npx eslint --format json <file>` and fix the reported error');
  }
  if (!Array.isArray(doc)) throw new EngineError('S2-ENGINE-FAILED', 'eslint JSON is not a list of results', 'check the eslint version and formatter');
  const wanted = rules.map((r) => ({ rule: r, name: typeof r.options.rule === 'string' ? r.options.rule : '', select: ruleSelector(r, excludes) }));
  /** @type {import('../core/violation.mjs').RawViolation[]} */
  const raws = [];
  for (const file of doc) {
    if (!file || typeof file.filePath !== 'string' || !Array.isArray(file.messages)) continue;
    const path = relativeToRoot(root, file.filePath);
    for (const m of file.messages) {
      if (!m || typeof m.ruleId !== 'string' || typeof m.message !== 'string') continue;
      for (const w of wanted) {
        if (w.name !== m.ruleId || !w.select(path)) continue;
        raws.push({ rule_id: w.rule.id, path, line: m.line, column: m.column, subject: m.message, message: m.message });
      }
    }
  }
  return raws;
}

/**
 * @param {import('../core/catalogue.mjs').Rule[]} rules
 */
function checkRules(rules) {
  for (const r of rules) {
    if (typeof r.options.rule !== 'string' || r.options.rule === '') {
      throw new EngineError('S2-ENGINE-FAILED', `rule ${r.id} has no options.rule`, 'set options.rule to the ESLint rule id, for example no-restricted-imports');
    }
  }
}

/**
 * The repository's root ESLint config from the main checkout, always passed explicitly.
 * @param {{ repoRoot: string, config: import('../cli/config.mjs').Config }} ctx
 * @returns {string}
 */
function configFile(ctx) {
  const configured = ctx.config.engines.eslint?.config;
  const file = configured ? join(ctx.repoRoot, configured) : DEFAULT_CONFIGS.map((c) => join(ctx.repoRoot, c)).find((c) => existsSync(c));
  if (!file || !existsSync(file)) {
    throw new EngineError('S2-ENGINE-MISSING', 'no ESLint config found in the repository root', 'add eslint.config.mjs to the repository root or set engines.eslint.config');
  }
  return file;
}

/**
 * Where a fixture file is presented to ESLint: inside the rule's first scope
 * glob, under `__square2_fixture__/`, so the repository's `files` globs and
 * base path apply even when the fixtures live outside the repository.
 * @param {import('../core/catalogue.mjs').Rule} rule
 * @param {string} rel fixture-relative path
 * @returns {string} repo-relative virtual path
 */
export function fixtureVirtualPath(rule, rel) {
  const root = globRoots([rule.scope[0]])[0];
  return root === '.' ? `__square2_fixture__/${rel}` : `${root}/__square2_fixture__/${rel}`;
}

/**
 * @param {any[]} results
 * @param {import('../cli/engine-util.mjs').Target} target
 * @param {(filePath: string) => string | null} toRel
 * @param {string[]} excludes
 * @returns {import('../core/violation.mjs').RawViolation[]}
 */
function mapResults(results, target, toRel, excludes) {
  /** @type {any[]} */
  const own = [];
  for (const r of results) {
    if (!r || typeof r.filePath !== 'string') continue;
    const rel = toRel(r.filePath);
    if (rel !== null) own.push({ ...r, filePath: rel });
  }
  return mapEslintOutput(target.root, JSON.stringify(own), target.rules, excludes);
}

/**
 * @param {string} stdout
 * @returns {any[]}
 */
function parseResults(stdout) {
  try {
    const doc = JSON.parse(stdout);
    return Array.isArray(doc) ? doc : [];
  } catch {
    throw new EngineError('S2-ENGINE-FAILED', 'eslint did not print JSON', 'run `npx eslint --format json <file>` and fix the reported error');
  }
}

/**
 * Repository and worktree runs lint the files in place (batched, files after
 * `--`); fixture runs feed each fixture file through `--stdin` under a
 * virtual path inside the rule's scope (in parallel).
 * @type {NonNullable<import('../cli/engine-util.mjs').EngineAdapter['runMany']>}
 */
async function runMany(ctx, targets) {
  for (const t of targets) checkRules(t.rules);
  const bin = ctx.resolveBin('eslint', 'eslint');
  const config = configFile(ctx);
  const version = await toolVersion(ctx.exec, bin, ctx.repoRoot);
  const flags = ['--format', 'json', '--no-warn-ignored', '--config', config];
  /** @type {import('../core/violation.mjs').RawViolation[][]} */
  const raws = targets.map(() => []);
  if (ctx.mode === 'fixture') {
    /** @type {{ t: number, rel: string, virtualRel: string }[]} */
    const jobs = [];
    for (const [t, target] of targets.entries()) {
      const selectors = target.rules.map((r) => ruleSelector(r, ctx.excludes));
      for (const rel of await target.files()) {
        if (!LINTABLE.test(rel)) continue;
        const virtualRel = fixtureVirtualPath(target.rules[0], rel);
        if (selectors.some((s) => s(virtualRel))) jobs.push({ t, rel, virtualRel });
      }
    }
    const outs = await mapConcurrent(jobs, async ({ t, rel, virtualRel }) => {
      const virtual = join(ctx.repoRoot, virtualRel);
      const res = await ctx.exec([...bin, ...flags, '--no-ignore', '--stdin', '--stdin-filename', virtual], { cwd: ctx.repoRoot, input: readFileSync(join(targets[t].root, rel), 'utf8') });
      check(res);
      return { t, rel, virtual, virtualRel, results: parseResults(res.stdout) };
    });
    for (const o of outs) {
      const mapped = mapResults(o.results, targets[o.t], (fp) => (fp === o.virtual || relativeToRoot(ctx.repoRoot, fp) === o.virtualRel ? o.virtualRel : null), ctx.excludes);
      raws[o.t].push(...mapped.map((v) => ({ ...v, path: o.rel })));
    }
    return raws.map((r) => ({ violations: finalizeViolations(r), version }));
  }
  for (const [t, target] of targets.entries()) {
    const selectors = target.rules.map((r) => ruleSelector(r, ctx.excludes));
    const files = (await target.files()).filter((p) => LINTABLE.test(p) && selectors.some((s) => s(p)));
    for (let i = 0; i < files.length; i += BATCH) {
      const res = await ctx.exec([...bin, ...flags, '--', ...files.slice(i, i + BATCH).map((p) => join(target.root, p))], { cwd: target.root });
      check(res);
      raws[t].push(...mapResults(parseResults(res.stdout), target, (fp) => relativeToRoot(target.root, fp), ctx.excludes));
    }
  }
  return raws.map((r) => ({ violations: finalizeViolations(r), version }));
}

/**
 * @param {import('../cli/engine-util.mjs').ExecResult} res
 */
function check(res) {
  if (res.code !== 0 && res.code !== 1) {
    const why = res.stderr.trim().split('\n').filter((l) => l.trim() !== '')[0] ?? '';
    throw new EngineError('S2-ENGINE-FAILED', `eslint exited ${res.code}: ${why.trim()}`, 'run eslint on its own and fix the configuration error');
  }
}

/** @type {import('../cli/engine-util.mjs').EngineAdapter} */
export const adapter = {
  async run(ctx) {
    const [result] = await runMany(ctx, [{ root: ctx.root, rules: ctx.rules, files: ctx.files }]);
    return result;
  },
  runMany,
};

