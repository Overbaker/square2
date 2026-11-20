import { Worker } from 'node:worker_threads';
import { finalizeViolations, formatDiagnostic } from '../core/violation.mjs';
import { patternOptionsProblem } from '../core/catalogue.mjs';
import { EngineError, readText, ruleSelector } from '../cli/engine-util.mjs';
import { sha256Hex } from '../core/fingerprint.mjs';
import { looksSecret } from '../review/render.mjs';

export const MAX_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_MATCHES_PER_FILE = 100;
/** Hard limit per (rule, file) regex evaluation; the worker thread is terminated when it is hit. */
export const PATTERN_TIMEOUTS = { perFileMs: 2000 };

/**
 * Regex evaluation runs in this worker (CommonJS, eval) so a pathological
 * pattern can be stopped by terminating the thread.
 */
const WORKER_SOURCE = `
const { parentPort } = require('node:worker_threads');
parentPort.on('message', (m) => {
  const out = [];
  for (const r of m.rules) {
    const t0 = Date.now();
    const matches = [];
    const absent = r.absent === null ? null : new RegExp(r.absent, r.flags);
    if (!(absent && absent.test(m.text))) {
      let n = 0;
      for (const x of m.text.matchAll(new RegExp(r.pattern, r.flags + 'g'))) {
        if (++n > m.max) break;
        matches.push([x.index || 0, x[0]]);
      }
    }
    out.push({ idx: r.idx, matches, ms: Date.now() - t0 });
  }
  parentPort.postMessage({ id: m.id, out });
});
`;

/**
 * @param {import('../core/catalogue.mjs').Rule} rule
 * @returns {{ pattern: string, flags: string, absent: string | null }}
 */
function compile(rule) {
  const problem = patternOptionsProblem(rule.options);
  if (problem) throw new EngineError('S2-ENGINE-FAILED', `rule ${rule.id}: ${problem}`, 'fix options.pattern (a JavaScript regex, flags imsu, no nested quantifiers)');
  const flags = typeof rule.options.flags === 'string' ? rule.options.flags : '';
  const pattern = /** @type {string} */ (rule.options.pattern);
  new RegExp(pattern, `${flags}g`);
  const absent = typeof rule.options.require_absent === 'string' ? rule.options.require_absent : null;
  if (absent !== null) new RegExp(absent, flags);
  return { pattern, flags, absent };
}

/**
 * One evaluation thread, restarted after a timeout.
 */
class Evaluator {
  constructor() {
    /** @type {Worker | null} */
    this.worker = null;
    this.next = 1;
  }

  /**
   * @param {{ text: string, rules: { idx: number, pattern: string, flags: string, absent: string | null }[] }} job
   * @param {number} timeoutMs
   * @returns {Promise<{ idx: number, matches: [number, string][], ms: number }[] | 'timeout'>}
   */
  run(job, timeoutMs) {
    if (!this.worker) this.worker = new Worker(WORKER_SOURCE, { eval: true });
    const worker = this.worker;
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const done = (/** @type {() => void} */ f) => {
        clearTimeout(timer);
        worker.off('message', onMessage);
        worker.off('error', onError);
        f();
      };
      const onMessage = (/** @type {any} */ m) => { if (m && m.id === id) done(() => resolve(m.out)); };
      const onError = (/** @type {unknown} */ e) => done(() => {
        this.worker = null;
        reject(e);
      });
      const timer = setTimeout(() => done(() => {
        this.worker = null;
        void worker.terminate();
        resolve('timeout');
      }), timeoutMs);
      worker.on('message', onMessage);
      worker.on('error', onError);
      worker.postMessage({ id, text: job.text, rules: job.rules, max: MAX_MATCHES_PER_FILE });
    });
  }

  async close() {
    const w = this.worker;
    this.worker = null;
    if (w) await w.terminate();
  }
}

/**
 * Built-in, non-executing text rule: report every match of `options.pattern`
 * in files within scope, unless `options.require_absent` matches the same
 * file. The subject is the matched text, so fingerprints survive line moves;
 * a secret-shaped match is redacted (`<redacted>` plus a short hash).
 * Regexes run in a worker thread; each (rule, file) evaluation has its own
 * PATTERN_TIMEOUTS.perFileMs. A rule that times out on any file has an
 * `unknown` result for the run: no violations, listed in `unknown`, with an
 * `S2-PATTERN-TIMEOUT` diagnostic. Other rules are never affected.
 * @type {import('../cli/engine-util.mjs').EngineAdapter}
 */
export const adapter = {
  async run(ctx) {
    const compiled = ctx.rules.map((rule, idx) => ({ rule, idx, select: ruleSelector(rule, ctx.excludes), ...compile(rule) }));
    /** @type {Map<number, import('../core/violation.mjs').RawViolation[]>} */
    const raws = new Map(compiled.map((c) => [c.idx, []]));
    /** @type {Set<number>} */
    const timedOut = new Set();
    const evaluator = new Evaluator();
    const budget = PATTERN_TIMEOUTS.perFileMs;
    /** @param {number} i @param {string} path */
    const stop = (i, path) => {
      if (timedOut.has(i)) return;
      timedOut.add(i);
      raws.set(i, []);
      ctx.warn(formatDiagnostic('S2-PATTERN-TIMEOUT', `rule ${compiled[i].rule.id}: over ${budget} ms on ${path}; result unknown for this run (no violations, its issues are not auto-closed)`, 'simplify options.pattern (anchor it, avoid overlapping alternatives) or narrow its scope'));
    };
    try {
      for (const path of await ctx.files()) {
        const wanted = compiled.filter((c) => !timedOut.has(c.idx) && c.select(path));
        if (wanted.length === 0) continue;
        let text;
        try {
          text = readText(ctx.root, path);
        } catch {
          continue;
        }
        if (text.length > MAX_FILE_BYTES || text.includes('\0')) continue;
        const job = (/** @type {typeof wanted} */ cs) => ({ text, rules: cs.map((c) => ({ idx: c.idx, pattern: c.pattern, flags: c.flags, absent: c.absent })) });
        /** @type {{ idx: number, matches: [number, string][], ms: number }[]} */
        let res = [];
        const batch = await evaluator.run(job(wanted), budget * wanted.length);
        /** @type {typeof wanted} */
        let retry = wanted;
        if (batch !== 'timeout') {
          res = batch.filter((r) => r.ms <= budget);
          retry = wanted.length === 1 ? [] : wanted.filter((c) => batch.some((r) => r.idx === c.idx && r.ms > budget));
          for (const r of batch) if (r.ms > budget && wanted.length === 1) stop(r.idx, path);
        }
        if (batch === 'timeout' && wanted.length === 1) {
          stop(wanted[0].idx, path);
          retry = [];
        }
        for (const c of retry) {
          // each rule alone, with its own budget: a slow rule never takes a fast one down with it
          const one = await evaluator.run(job([c]), budget);
          if (one === 'timeout' || one.some((r) => r.ms > budget)) stop(c.idx, path);
          else res.push(...one);
        }
        for (const r of res) {
          if (timedOut.has(r.idx)) continue;
          const c = compiled[r.idx];
          const list = /** @type {import('../core/violation.mjs').RawViolation[]} */ (raws.get(r.idx));
          for (const [at, match] of r.matches) {
            const line = text.slice(0, at).split('\n').length;
            const raw = match.replace(/\s+/g, ' ').trim().slice(0, 200);
            const subject = raw === '' ? c.rule.id : looksSecret(raw) ? `<redacted ${sha256Hex(raw).slice(0, 12)}>` : raw;
            const own = typeof c.rule.options.message === 'string' ? c.rule.options.message : null;
            const message = own !== null ? (looksSecret(own) ? '<redacted>' : own) : `matches ${looksSecret(raw) ? '<redacted>' : subject}`;
            list.push({ rule_id: c.rule.id, path, line, subject, message });
          }
        }
      }
    } finally {
      await evaluator.close();
    }
    return { violations: finalizeViolations([...raws.values()].flat()), version: 'builtin', unknown: [...timedOut].map((i) => compiled[i].rule.id).sort() };
  },
};
