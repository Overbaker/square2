import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { compareViolations, AdapterOutputError, formatDiagnostic } from '../core/violation.mjs';
import { adapter as command } from '../engines/command.mjs';
import { adapter as depcruise } from '../engines/depcruise.mjs';
import { adapter as eslint } from '../engines/eslint.mjs';
import { adapter as pattern } from '../engines/pattern.mjs';
import { adapter as ruff } from '../engines/ruff.mjs';
import { adapter as suppressions } from '../engines/suppressions.mjs';
import { EngineError, defaultExec, listFiles, mapConcurrent, resolveNodeBin } from './engine-util.mjs';

/** @type {Record<string, import('./engine-util.mjs').EngineAdapter>} */
export const ADAPTERS = Object.freeze({ command, depcruise, eslint, pattern, ruff, suppressions });

/**
 * Injectable engine dependencies.
 * @typedef {object} EngineDeps
 * @property {boolean} [failOnUnknown] a rule whose result is `unknown` (pattern timeout) is a fatal error (replay)
 * @property {Record<string, import('./engine-util.mjs').EngineAdapter>} [adapters]
 * @property {import('./engine-util.mjs').Exec} [exec]
 * @property {(repoRoot: string, name: string, pkg: string) => string[]} [resolveBin]
 */

/**
 * @typedef {object} RunResult
 * @property {import('../core/violation.mjs').Violation[]} violations
 * @property {Record<string, string>} versions engine name to version
 * @property {string[]} errors fatal diagnostics (`[S2-ENGINE-*]`, `[S2-ADAPTER-INVALID]`)
 * @property {string[]} warnings
 * @property {string[]} unknown rules whose result is unknown (they report no violations; never auto-close their issues)
 */

/**
 * @param {unknown} err
 * @returns {string}
 */
function fatal(err) {
  if (err instanceof EngineError || err instanceof AdapterOutputError) return err.diagnostic;
  throw err;
}

/**
 * @param {string} engine
 * @param {import('../core/catalogue.mjs').Rule[]} rules
 * @param {import('./engine-util.mjs').EngineResult} res
 */
function checkOwnRules(engine, rules, res) {
  const ids = new Set(rules.map((r) => r.id));
  for (const v of res.violations) {
    if (!ids.has(v.rule_id)) throw new AdapterOutputError(`engine ${engine} reported rule ${v.rule_id}, which it was not asked to run`);
  }
}

/**
 * Run the enabled rules on one tree: one adapter call per engine.
 * @param {{
 *   root: string,
 *   repoRoot: string,
 *   mode: 'repo' | 'fixture',
 *   rules: import('../core/catalogue.mjs').Rule[],
 *   config: import('./config.mjs').Config,
 *   excludes: string[],
 * } & EngineDeps} input
 * @returns {Promise<RunResult>}
 */
export async function runRules(input) {
  const adapters = input.adapters ?? ADAPTERS;
  const exec = input.exec ?? defaultExec;
  const resolveBin = input.resolveBin ?? resolveNodeBin;
  /** @type {string[]} */
  const warnings = [];
  const warn = (/** @type {string} */ m) => { if (!warnings.includes(m)) warnings.push(m); };
  /** @type {Promise<string[]> | null} */
  let fileCache = null;
  const files = () => (fileCache ??= listFiles(input.root, input.mode, warn));
  const groups = groupByEngine(input.rules);
  /** @type {import('../core/violation.mjs').Violation[]} */
  const violations = [];
  /** @type {Record<string, string>} */
  const versions = {};
  /** @type {string[]} */
  const errors = [];
  /** @type {string[]} */
  const unknown = [];
  for (const [engine, rules] of groups) {
    const adapter = adapters[engine];
    if (!adapter) {
      errors.push(formatDiagnostic('S2-ENGINE-MISSING', `no adapter for engine ${engine}`, `use one of ${Object.keys(adapters).sort().join(', ')}`));
      continue;
    }
    try {
      const res = await adapter.run({ root: input.root, repoRoot: input.repoRoot, mode: input.mode, rules, config: input.config, excludes: input.excludes, exec, resolveBin: (name, pkg) => resolveBin(input.repoRoot, name, pkg), files, warn });
      checkOwnRules(engine, rules, res);
      const own = new Set(rules.map((r) => r.id));
      const raw = /** @type {{ unknown?: unknown }} */ (res).unknown;
      const lost = (Array.isArray(raw) ? raw : []).filter((id) => typeof id === 'string' && own.has(id));
      unknown.push(...lost);
      if (input.failOnUnknown && lost.length > 0) errors.push(formatDiagnostic('S2-PATTERN-TIMEOUT', `result unknown for ${lost.join(', ')} (pattern timeout)`, 'simplify the pattern; a rule with an unknown result cannot be replayed'));
      violations.push(...res.violations.filter((v) => !lost.includes(v.rule_id)));
      versions[engine] = res.version;
    } catch (err) {
      errors.push(fatal(err));
    }
  }
  return { violations: violations.sort(compareViolations), versions, errors, warnings, unknown: unknown.sort() };
}

/**
 * @param {import('../core/catalogue.mjs').Rule[]} rules
 * @returns {[string, import('../core/catalogue.mjs').Rule[]][]}
 */
function groupByEngine(rules) {
  /** @type {Map<string, import('../core/catalogue.mjs').Rule[]>} */
  const groups = new Map();
  for (const r of rules) {
    if (!r.enabled) continue;
    const list = groups.get(r.engine);
    if (list) list.push(r);
    else groups.set(r.engine, [r]);
  }
  return [...groups].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/**
 * Self-test: each enabled rule must fire on `<dir>/fixtures/<id>/bad/` and
 * stay silent on `good/` when present. Per engine, all fixtures go through
 * one batched tool invocation when the adapter supports it (`runMany`), else
 * they run in parallel (concurrency = CPU count).
 * @param {{
 *   repoRoot: string,
 *   dir: string,
 *   rules: import('../core/catalogue.mjs').Rule[],
 *   config: import('./config.mjs').Config,
 * } & EngineDeps} input
 * @returns {Promise<{ lines: string[], checked: number, warnings: string[] }>}
 */
export async function selftest(input) {
  const adapters = input.adapters ?? ADAPTERS;
  const exec = input.exec ?? defaultExec;
  const resolveBin = input.resolveBin ?? resolveNodeBin;
  const excludes = ['node_modules/**', '**/node_modules/**'];
  /** @type {string[]} */
  const warnings = [];
  const warn = (/** @type {string} */ m) => { if (!warnings.includes(m)) warnings.push(m); };
  /** @type {Map<string, string[]>} rule id -> failure lines */
  const failures = new Map();
  let checked = 0;
  for (const [engine, rules] of groupByEngine(input.rules)) {
    checked += rules.length;
    const adapter = adapters[engine];
    if (!adapter) {
      for (const r of rules) failures.set(r.id, [formatDiagnostic('S2-ENGINE-MISSING', `no adapter for engine ${engine}`, `use one of ${Object.keys(adapters).sort().join(', ')}`)]);
      continue;
    }
    /** @type {{ rule: import('../core/catalogue.mjs').Rule, kind: 'bad' | 'good', target: import('./engine-util.mjs').Target }[]} */
    const plan = [];
    for (const rule of rules) {
      for (const kind of /** @type {const} */ (['bad', 'good'])) {
        const root = join(input.dir, 'fixtures', rule.id, kind);
        if (kind === 'good' && !existsSync(root)) continue;
        /** @type {Promise<string[]> | null} */
        let cache = null;
        plan.push({ rule, kind, target: { root, rules: [rule], files: () => (cache ??= listFiles(root, 'fixture', warn)) } });
      }
    }
    const base = { repoRoot: input.repoRoot, mode: /** @type {const} */ ('fixture'), config: input.config, excludes, exec, resolveBin: (/** @type {string} */ name, /** @type {string} */ pkg) => resolveBin(input.repoRoot, name, pkg), warn };
    /** @type {({ ok: import('./engine-util.mjs').EngineResult } | { error: string })[]} */
    let results;
    if (adapter.runMany) {
      try {
        const many = await adapter.runMany(base, plan.map((p) => p.target));
        results = many.map((ok) => ({ ok }));
      } catch (err) {
        const line = fatal(err);
        results = plan.map(() => ({ error: line }));
      }
    } else {
      results = await mapConcurrent(plan, async (p) => {
        try {
          return { ok: await adapter.run({ ...base, root: p.target.root, rules: p.target.rules, files: p.target.files }) };
        } catch (err) {
          return { error: fatal(err) };
        }
      });
    }
    plan.forEach((p, i) => {
      const r = results[i];
      const add = (/** @type {string} */ line) => {
        const list = failures.get(p.rule.id) ?? [];
        if (!list.includes(line)) list.push(line);
        failures.set(p.rule.id, list);
      };
      if ('error' in r) return add(r.error);
      try {
        checkOwnRules(engine, [p.rule], r.ok);
      } catch (err) {
        return add(fatal(err));
      }
      const hits = r.ok.violations.filter((v) => v.rule_id === p.rule.id);
      if (p.kind === 'bad' && hits.length === 0) {
        add(formatDiagnostic('S2-SELFTEST', `${p.rule.id} did not fire on .square2/fixtures/${p.rule.id}/bad/`, 'fix the rule, its engine settings or the fixture so the bad fixture is flagged'));
      }
      if (p.kind === 'good' && hits.length > 0) {
        add(formatDiagnostic('S2-SELFTEST', `${p.rule.id} fired on .square2/fixtures/${p.rule.id}/good/ (${hits[0].path}${hits[0].line ? ':' + hits[0].line : ''} ${hits[0].subject})`, 'narrow the rule so the good fixture stays clean, or fix the fixture'));
      }
    });
  }
  const lines = [...failures.keys()].sort().flatMap((id) => /** @type {string[]} */ (failures.get(id)));
  return { lines: [...new Set(lines)], checked, warnings };
}
