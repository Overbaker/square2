import { finalizeViolations } from '../core/violation.mjs';
import { EngineError, relativeToRoot, ruleSelector } from '../cli/engine-util.mjs';

/**
 * Parse the command protocol: one JSON object per line,
 * `{"path": "...", "line": 12, "subject": "..."}` (`line` optional).
 * Lines that are not such objects are ignored.
 * @param {string} stdout
 * @returns {{ path: string, line?: number, subject: string }[]}
 */
export function parseCommandOutput(stdout) {
  /** @type {{ path: string, line?: number, subject: string }[]} */
  const out = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const t = raw.trim();
    if (!t.startsWith('{')) continue;
    let o;
    try {
      o = JSON.parse(t);
    } catch {
      continue;
    }
    if (!o || typeof o !== 'object' || Array.isArray(o) || typeof o.path !== 'string' || typeof o.subject !== 'string') continue;
    if (o.path.trim() === '' || o.subject.trim() === '') continue;
    /** @type {{ path: string, line?: number, subject: string }} */
    const item = { path: o.path, subject: o.subject };
    if (typeof o.line === 'number' && Number.isInteger(o.line) && o.line > 0) item.line = o.line;
    out.push(item);
  }
  return out;
}

/**
 * `options.argv` with `{root}` and `{repo}` substituted; a leading `node` runs the current Node.
 * @param {import('../core/catalogue.mjs').Rule} rule
 * @param {string} root
 * @param {string} repoRoot
 * @returns {string[]}
 */
export function commandArgv(rule, root, repoRoot) {
  const argv = rule.options.argv;
  if (!Array.isArray(argv) || argv.length === 0 || !argv.every((a) => typeof a === 'string' && a !== '')) {
    throw new EngineError('S2-ENGINE-FAILED', `rule ${rule.id} has no options.argv`, 'set options.argv to the command as a block list, one `- item` per line, for example node, then scripts/check.mjs, then "{root}"');
  }
  const out = /** @type {string[]} */ (argv).map((a) => a.replaceAll('{root}', root).replaceAll('{repo}', repoRoot));
  if (out[0] === 'node') out[0] = process.execPath;
  return out;
}

/**
 * @param {string} text
 * @returns {string}
 */
function tail(text) {
  const lines = text.trim().split('\n').filter((l) => l.trim() !== '');
  return lines.slice(-3).map((l) => l.trim()).join(' | ');
}

/** @type {import('../cli/engine-util.mjs').EngineAdapter} */
export const adapter = {
  async run(ctx) {
    /** @type {import('../core/violation.mjs').RawViolation[]} */
    const raws = [];
    for (const rule of ctx.rules) {
      const argv = commandArgv(rule, ctx.root, ctx.repoRoot);
      const res = await ctx.exec(argv, { cwd: ctx.repoRoot, env: { SQUARE2_ROOT: ctx.root } });
      const parsed = parseCommandOutput(res.stdout);
      if (res.code !== 0 && parsed.length === 0) {
        throw new EngineError('S2-ENGINE-FAILED', `rule ${rule.id}: command exited ${res.code} without violation lines: ${tail(res.stderr) || tail(res.stdout)}`, 'make the command print one JSON object per violation, {"path": ..., "line": ..., "subject": ...}, or fix the error it reports');
      }
      const select = ruleSelector(rule, ctx.excludes);
      for (const p of parsed) {
        const path = relativeToRoot(ctx.root, p.path);
        if (!select(path)) continue;
        raws.push({ rule_id: rule.id, path, line: p.line, subject: p.subject, message: p.subject });
      }
    }
    return { violations: finalizeViolations(raws), version: 'command' };
  },
};
