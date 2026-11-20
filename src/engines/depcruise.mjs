import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { finalizeViolations } from '../core/violation.mjs';
import { EngineError, globRoots, relativeToRoot, ruleSelector, toolVersion } from '../cli/engine-util.mjs';

const DEFAULT_CONFIGS = ['.dependency-cruiser.cjs', '.dependency-cruiser.js', '.dependency-cruiser.mjs', '.dependency-cruiser.json'];

/**
 * dependency-cruiser rule name for a square² rule: `options.rule`, else the
 * id after `S2-DEP-`, lowercased.
 * @param {import('../core/catalogue.mjs').Rule} rule
 * @returns {string}
 */
export function depcruiseRuleName(rule) {
  if (typeof rule.options.rule === 'string' && rule.options.rule !== '') return rule.options.rule;
  return rule.id.replace(/^S2-DEP-/, '').toLowerCase();
}

/**
 * Map `--output-type json` output to raw violations. The subject is the
 * module specifier as written (`unresolvedTo`), never the resolved file.
 * @param {string} root
 * @param {string} stdout
 * @param {import('../core/catalogue.mjs').Rule[]} rules
 * @param {string[]} excludes
 * @returns {import('../core/violation.mjs').RawViolation[]}
 */
export function mapDepcruiseOutput(root, stdout, rules, excludes) {
  let doc;
  try {
    doc = JSON.parse(stdout);
  } catch {
    throw new EngineError('S2-ENGINE-FAILED', 'dependency-cruiser did not print JSON', 'run `npx depcruise --output-type json <dir>` and fix the reported error');
  }
  const list = doc && doc.summary && Array.isArray(doc.summary.violations) ? doc.summary.violations : [];
  const byName = new Map(rules.map((r) => [depcruiseRuleName(r), { rule: r, select: ruleSelector(r, excludes) }]));
  /** @type {import('../core/violation.mjs').RawViolation[]} */
  const raws = [];
  for (const v of list) {
    if (!v || typeof v.from !== 'string' || typeof v.to !== 'string' || !v.rule || typeof v.rule.name !== 'string') continue;
    const hit = byName.get(v.rule.name);
    if (!hit) continue;
    const path = relativeToRoot(root, v.from);
    if (!hit.select(path)) continue;
    const specifier = typeof v.unresolvedTo === 'string' && v.unresolvedTo !== '' ? v.unresolvedTo : v.to;
    raws.push({ rule_id: hit.rule.id, path, subject: specifier, message: `imports ${specifier}` });
  }
  return raws;
}

/**
 * The repository's dependency-cruiser config file.
 * @param {import('../cli/engine-util.mjs').EngineContext} ctx
 * @returns {string}
 */
function configFile(ctx) {
  const configured = ctx.config.engines.depcruise?.config;
  const config = configured ? join(ctx.repoRoot, configured) : DEFAULT_CONFIGS.map((c) => join(ctx.repoRoot, c)).find((c) => existsSync(c));
  if (!config || !existsSync(config)) {
    throw new EngineError('S2-ENGINE-MISSING', 'no dependency-cruiser config found', 'add .dependency-cruiser.cjs to the repository root or set engines.depcruise.config');
  }
  return config;
}

/**
 * A temporary config that extends the repository's and pins `tsConfig` to an
 * absolute file, so the cruise can run with cwd = any tree (fixtures,
 * worktrees) while `from.path` anchors stay relative to that tree. The
 * tsconfig is taken from the scanned tree when it has one, else from the
 * repository root.
 * @param {string} config
 * @param {string} root
 * @returns {Promise<{ path: string, dispose: () => void }>}
 */
async function wrapperConfig(config, root) {
  /** @type {any} */
  let loaded;
  try {
    loaded = config.endsWith('.json') ? JSON.parse(readFileSync(config, 'utf8')) : await import(pathToFileURL(config).href).then((m) => m.default ?? m);
  } catch (err) {
    throw new EngineError('S2-ENGINE-FAILED', `cannot load ${config}: ${err instanceof Error ? err.message : 'unknown error'}`, 'make the dependency-cruiser config load on its own');
  }
  /** @type {Record<string, unknown>} */
  const options = {};
  const ts = loaded && loaded.options && loaded.options.tsConfig;
  if (ts && typeof ts === 'object' && typeof ts.fileName === 'string') {
    const inRoot = isAbsolute(ts.fileName) ? ts.fileName : join(root, ts.fileName);
    const inRepo = isAbsolute(ts.fileName) ? ts.fileName : join(dirname(config), ts.fileName);
    options.tsConfig = { ...ts, fileName: existsSync(inRoot) ? inRoot : inRepo };
  }
  const dir = mkdtempSync(join(tmpdir(), 'square2-depcruise-'));
  const path = join(dir, 'wrapper.cjs');
  writeFileSync(path, `module.exports = ${JSON.stringify({ extends: config, options })};\n`);
  return { path, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

/** @type {import('../cli/engine-util.mjs').EngineAdapter} */
export const adapter = {
  async run(ctx) {
    const bin = ctx.resolveBin('depcruise', 'dependency-cruiser');
    const config = configFile(ctx);
    const version = await toolVersion(ctx.exec, bin, ctx.repoRoot);
    const roots = globRoots(ctx.rules.flatMap((r) => r.scope)).filter((r) => existsSync(join(ctx.root, r)));
    if (roots.length === 0) return { violations: [], version };
    const wrapper = await wrapperConfig(config, ctx.root);
    try {
      const res = await ctx.exec([...bin, '--config', wrapper.path, '--output-type', 'json', '--', ...roots], { cwd: ctx.root });
      if (res.stdout.trim() === '') {
        const why = res.stderr.trim().split('\n').filter((l) => l.trim() !== '').slice(-1)[0] ?? '';
        throw new EngineError('S2-ENGINE-FAILED', `dependency-cruiser exited ${res.code} without output: ${why.trim()}`, 'run dependency-cruiser on its own and fix the reported error');
      }
      return { violations: finalizeViolations(mapDepcruiseOutput(ctx.root, res.stdout, ctx.rules, ctx.excludes)), version };
    } finally {
      wrapper.dispose();
    }
  },
};
