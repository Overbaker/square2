import { isAbsolute, join } from 'node:path';
import { finalizeViolations } from '../core/violation.mjs';
import { EngineError, relativeToRoot, ruleSelector, toolVersion } from '../cli/engine-util.mjs';

const PY = /\.(?:py|pyi)$/;
const BATCH = 400;

/**
 * @param {unknown} v
 * @returns {string[]}
 */
function list(v) {
  if (typeof v === 'string') return v.split(',').map((s) => s.trim()).filter((s) => s !== '');
  if (Array.isArray(v)) return v.filter((s) => typeof s === 'string');
  return [];
}

/**
 * Does a ruff selector cover a code? `ALL` covers everything; otherwise the
 * letter family must be identical and the code's digits must start with the
 * selector's digits (`E5` covers `E501`; `B` covers `B006` but not `BLE001`).
 * @param {string} selector
 * @param {string} code
 * @returns {boolean}
 */
export function selectorCovers(selector, code) {
  if (selector === 'ALL') return true;
  const s = /^([A-Z]+)(\d*)$/.exec(selector);
  const c = /^([A-Z]+)(\d+)$/.exec(code);
  if (!s || !c) return selector === code;
  return s[1] === c[1] && c[2].startsWith(s[2]);
}

/**
 * The effective ruff selection of a rule: `select` (null = ruff's default
 * selection), `ignore`, and extra args.
 * @param {import('../core/catalogue.mjs').Rule} rule
 * @returns {{ select: string[] | null, ignore: string[], args: string[] }}
 */
export function selection(rule) {
  const select = list(rule.options.select);
  return { select: select.length > 0 ? [...new Set(select)].sort() : null, ignore: [...new Set(list(rule.options.ignore))].sort(), args: list(rule.options.args) };
}

/**
 * Map `ruff check --output-format json` output to raw violations of one rule.
 * @param {string} root
 * @param {string} stdout
 * @param {import('../core/catalogue.mjs').Rule} rule
 * @param {string[]} excludes
 * @returns {import('../core/violation.mjs').RawViolation[]}
 */
export function mapRuffOutput(root, stdout, rule, excludes) {
  let doc;
  try {
    doc = JSON.parse(stdout);
  } catch {
    throw new EngineError('S2-ENGINE-FAILED', 'ruff did not print JSON', 'run `ruff check --output-format json <file>` and fix the reported error');
  }
  if (!Array.isArray(doc)) throw new EngineError('S2-ENGINE-FAILED', 'ruff JSON is not a list', 'check the ruff version');
  return mapDiagnostics(root, doc, rule, excludes);
}

/**
 * @param {string} root
 * @param {any[]} doc
 * @param {import('../core/catalogue.mjs').Rule} rule
 * @param {string[]} excludes
 * @returns {import('../core/violation.mjs').RawViolation[]}
 */
function mapDiagnostics(root, doc, rule, excludes) {
  const { select: codes, ignore } = selection(rule);
  const select = ruleSelector(rule, excludes);
  /** @type {import('../core/violation.mjs').RawViolation[]} */
  const raws = [];
  for (const d of doc) {
    if (!d || typeof d.filename !== 'string' || typeof d.message !== 'string') continue;
    const code = typeof d.code === 'string' ? d.code : '';
    if (codes !== null && !codes.some((c) => selectorCovers(c, code))) continue;
    if (ignore.some((c) => selectorCovers(c, code))) continue;
    const path = relativeToRoot(root, d.filename);
    if (!select(path)) continue;
    const loc = d.location && typeof d.location === 'object' ? d.location : {};
    raws.push({ rule_id: rule.id, path, line: loc.row, column: loc.column, subject: `${code} ${d.message}`, message: `${code} ${d.message}` });
  }
  return raws;
}

/**
 * The configured ruff command; a relative executable path (`python/.venv/bin/ruff`)
 * is resolved against the repository root.
 * @param {{ repoRoot: string, config: import('../cli/config.mjs').Config }} ctx
 * @returns {string[]}
 */
export function ruffCommand(ctx) {
  const cmd = [...(ctx.config.engines.ruff?.command ?? ['ruff'])];
  if (/[\\/]/.test(cmd[0]) && !isAbsolute(cmd[0])) cmd[0] = join(ctx.repoRoot, cmd[0]);
  return cmd;
}

const MISSING_INSTEAD = 'install ruff on PATH or set engines.ruff.command in .square2/config.yaml as a block list, for example the items uv, run, --project, python, ruff (one `- item` per line), or python/.venv/bin/ruff';

/**
 * @type {NonNullable<import('../cli/engine-util.mjs').EngineAdapter['runMany']>}
 */
async function runMany(ctx, targets) {
  const cmd = ruffCommand(ctx);
  const version = await toolVersion(ctx.exec, cmd, ctx.repoRoot).catch((err) => {
    if (err instanceof EngineError) throw new EngineError('S2-ENGINE-MISSING', `cannot run ${cmd.join(' ')}`, MISSING_INSTEAD);
    throw err;
  });
  /** @type {import('../core/violation.mjs').RawViolation[][]} */
  const raws = targets.map(() => []);
  /** @type {Map<string, { sel: ReturnType<typeof selection>, items: { t: number, rule: import('../core/catalogue.mjs').Rule, files: string[] }[] }>} */
  const groups = new Map();
  for (const [t, target] of targets.entries()) {
    const all = (await target.files()).filter((p) => PY.test(p));
    for (const rule of target.rules) {
      const sel = selection(rule);
      const key = JSON.stringify(sel);
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { sel, items: [] }));
      g.items.push({ t, rule, files: all.filter(ruleSelector(rule, ctx.excludes)).map((p) => join(target.root, p)) });
    }
  }
  for (const g of groups.values()) {
    const files = [...new Set(g.items.flatMap((i) => i.files))];
    if (files.length === 0) continue;
    const select = [...(g.sel.select ? ['--select', g.sel.select.join(',')] : []), ...(g.sel.ignore.length > 0 ? ['--ignore', g.sel.ignore.join(',')] : [])];
    /** @type {any[]} */
    const diags = [];
    for (let i = 0; i < files.length; i += BATCH) {
      const res = await ctx.exec([...cmd, 'check', '--output-format', 'json', '--no-cache', '--exit-zero', ...select, ...g.sel.args, '--', ...files.slice(i, i + BATCH)], { cwd: ctx.repoRoot });
      if (res.code !== 0) {
        const why = res.stderr.trim().split('\n').filter((l) => l.trim() !== '')[0] ?? '';
        throw new EngineError('S2-ENGINE-FAILED', `ruff exited ${res.code}: ${why.trim()}`, 'run ruff on its own and fix the configuration error');
      }
      let doc;
      try {
        doc = JSON.parse(res.stdout);
      } catch {
        throw new EngineError('S2-ENGINE-FAILED', 'ruff did not print JSON', 'run `ruff check --output-format json <file>` and fix the reported error');
      }
      if (Array.isArray(doc)) diags.push(...doc);
    }
    for (const item of g.items) {
      const mine = new Set(item.files);
      const root = targets[item.t].root;
      const own = diags.filter((d) => d && typeof d.filename === 'string' && (mine.has(d.filename) || mine.has(join(root, relativeToRoot(root, d.filename)))));
      raws[item.t].push(...mapDiagnostics(root, own, item.rule, ctx.excludes));
    }
  }
  return raws.map((r) => ({ violations: finalizeViolations(r), version }));
}

/** @type {import('../cli/engine-util.mjs').EngineAdapter} */
export const adapter = {
  async run(ctx) {
    const [result] = await runMany(ctx, [{ root: ctx.root, rules: ctx.rules, files: ctx.files }]);
    return result;
  },
  runMany,
};
