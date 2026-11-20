import { execFile } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { engineEnv } from '../cli/engine-util.mjs';
import { PathError, toPosixPath } from '../core/fingerprint.mjs';
import { looksSecret, normalizeForSecrets } from './render.mjs';

/** Provider name used in the codex `-c` overrides. */
export const PROVIDER = 'sq2azure';
export const KEY_VAR = 'SQ2_AZURE_OPENAI_API_KEY';
export const ENDPOINT_VAR = 'SQ2_AZURE_OPENAI_ENDPOINT';

export class RunError extends Error {
  /** @param {string} message @param {string} instead */
  constructor(message, instead) {
    super(message);
    this.name = 'RunError';
    this.instead = instead;
  }
}

/**
 * @param {Buffer} data
 * @returns {Record<string, string>}
 */
function parsePax(data) {
  /** @type {Record<string, string>} */
  const out = {};
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    if (sp < 0) break;
    const len = Number(data.subarray(i, sp).toString('utf8'));
    if (!Number.isInteger(len) || len <= 0) break;
    const record = data.subarray(sp + 1, i + len - 1).toString('utf8');
    const eq = record.indexOf('=');
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1);
    i += len;
  }
  return out;
}

/**
 * Extract a `git archive --format=tar` file into `dest`. Only regular files
 * and directories are written; absolute paths and `..` segments are
 * rejected; symlinks and hard links are skipped (they could point outside
 * the tree).
 * @param {string} tarPath
 * @param {string} dest
 * @returns {{ files: number, skipped: string[] }}
 */
export function extractTar(tarPath, dest) {
  const buf = readFileSync(tarPath);
  mkdirSync(dest, { recursive: true });
  /** @type {Record<string, string>} */
  let pax = {};
  let off = 0;
  let files = 0;
  /** @type {string[]} */
  const skipped = [];
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    /** @param {number} s @param {number} l */
    const field = (s, l) => { const raw = h.subarray(s, s + l); const z = raw.indexOf(0); return raw.subarray(0, z < 0 ? l : z).toString('utf8'); };
    const size = parseInt(field(124, 12).trim() || '0', 8);
    const mode = parseInt(field(100, 8).trim() || '0', 8);
    const type = h[156] === 0 ? '0' : String.fromCharCode(h[156]);
    const prefix = field(345, 155);
    let name = prefix ? `${prefix}/${field(0, 100)}` : field(0, 100);
    off += 512;
    const data = buf.subarray(off, off + size);
    off += Math.ceil(size / 512) * 512;
    if (type === 'x') { pax = parsePax(data); continue; }
    if (type === 'g') continue;
    if (pax.path) name = pax.path;
    pax = {};
    const clean = name.replace(/\/+$/, '');
    if (clean === '' || clean === '.') continue;
    let rel;
    try {
      rel = toPosixPath(clean);
    } catch (err) {
      if (err instanceof PathError) throw new RunError(`unsafe path in the tree archive: ${JSON.stringify(name)}`, 'prepare the archive with `square2 review prepare` (git archive)');
      throw err;
    }
    const target = join(dest, rel);
    if (type === '5') mkdirSync(target, { recursive: true });
    else if (type === '0' || type === '7') {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, data, { mode: mode & 0o111 ? 0o755 : 0o644 });
      files++;
    } else skipped.push(rel);
  }
  return { files, skipped };
}

/**
 * @param {string} dir
 * @param {(path: string, isDir: boolean, mode: number) => void} fn post-order
 */
function walk(dir, fn) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = lstatSync(p);
    if (st.isDirectory()) {
      walk(p, fn);
      fn(p, true, st.mode);
    } else fn(p, false, st.mode);
  }
}

/**
 * Remove write permission from every file and directory under `dir`.
 * @param {string} dir
 */
export function makeReadOnly(dir) {
  walk(dir, (p, isDir, mode) => chmodSync(p, isDir ? 0o555 : mode & 0o111 ? 0o555 : 0o444));
  chmodSync(dir, 0o555);
}

/**
 * Restore write permission so the tree can be deleted.
 * @param {string} dir
 */
function makeWritable(dir) {
  if (!existsSync(dir)) return;
  chmodSync(dir, 0o755);
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (lstatSync(p).isDirectory()) makeWritable(p);
    else chmodSync(p, 0o644);
  }
}

/**
 * A TOML basic string (JSON escapes are valid TOML escapes).
 * @param {string} s
 * @returns {string}
 */
function tomlString(s) {
  return JSON.stringify(s);
}

/**
 * `codex exec` arguments: read-only sandbox in the extracted tree, the Azure
 * OpenAI Responses endpoint as a custom provider via `-c` TOML overrides,
 * JSON events on stdout, the final message to `outFile`, prompt on stdin.
 * @param {{ model: string, endpoint: string, tree: string, outFile: string }} o
 * @returns {string[]}
 */
export function codexArgs(o) {
  const baseUrl = `${o.endpoint.replace(/\/+$/, '')}/openai/v1`;
  return [
    'exec',
    '--json',
    '--sandbox', 'read-only',
    '--skip-git-repo-check',
    '--ignore-user-config',
    '--ignore-rules',
    '--ephemeral',
    '-C', o.tree,
    '--output-last-message', o.outFile,
    '-m', o.model,
    '-c', `model_provider=${tomlString(PROVIDER)}`,
    '-c', `model_providers.${PROVIDER}={ name = ${tomlString(PROVIDER)}, base_url = ${tomlString(baseUrl)}, env_key = ${tomlString(KEY_VAR)}, wire_api = "responses" }`,
    '-',
  ];
}

/**
 * Environment for codex: the engine allowlist (never GitHub credentials,
 * `ACTIONS_*`, other keys or `NODE_OPTIONS`), a fresh `CODEX_HOME` that is
 * also `HOME` (no user config, history or credentials), and only the LLM key
 * and endpoint.
 * @param {Record<string, string | undefined>} base
 * @param {{ endpoint: string, key: string, home: string }} llm
 * @returns {Record<string, string>}
 */
export function codexEnv(base, llm) {
  const env = engineEnv(base);
  for (const k of Object.keys(env)) if (/^(?:HOME|USERPROFILE|XDG_[A-Z_]+|APPDATA|LOCALAPPDATA)$/i.test(k)) delete env[k];
  env.HOME = llm.home;
  env.USERPROFILE = llm.home;
  env.CODEX_HOME = llm.home;
  env[KEY_VAR] = llm.key;
  env[ENDPOINT_VAR] = llm.endpoint;
  return env;
}

/**
 * Does `text` contain the LLM key in any common encoding, or a secret shape?
 * Checked on the text as written and fully normalised (NFKC, control and
 * format characters removed, then separators stripped).
 * @param {string} text
 * @param {string} key
 * @returns {boolean}
 */
export function leaksKey(text, key) {
  if (looksSecret(text)) return true;
  if (key.length < 8) return false;
  const bytes = Buffer.from(key, 'utf8');
  const forms = [
    key,
    bytes.toString('base64'),
    bytes.toString('base64').replace(/=+$/, ''),
    bytes.toString('base64url'),
    bytes.toString('hex'),
    bytes.toString('hex').toUpperCase(),
    encodeURIComponent(key),
    key.split('').reverse().join(''),
  ];
  const norm = normalizeForSecrets(text);
  if (forms.some((f) => f.length >= 8 && (text.includes(f) || norm.includes(f)))) return true;
  const squeezed = normalizeForLeak(norm);
  return forms.some((f) => {
    const n = normalizeForLeak(f);
    return n.length >= 8 && squeezed.includes(n);
  });
}

/**
 * Whitespace and common separators (`- _ . : /` and line breaks) removed,
 * so a key split across lines or dashed apart is still found.
 * @param {string} text
 * @returns {string}
 */
export function normalizeForLeak(text) {
  return text.replace(/[\s\-_.:/]+/g, '');
}

/**
 * Token usage from codex `--json` events (summed over `usage` objects), or null.
 * @param {string} stdout
 * @returns {{ input: number, cached: number, output: number } | null}
 */
export function parseUsage(stdout) {
  let input = 0;
  let cached = 0;
  let output = 0;
  let seen = false;
  for (const line of stdout.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    let ev;
    try {
      ev = JSON.parse(t);
    } catch {
      continue;
    }
    const u = ev && typeof ev === 'object' ? ev.usage ?? ev.msg?.usage ?? null : null;
    if (!u || typeof u !== 'object' || typeof u.input_tokens !== 'number') continue;
    seen = true;
    input += u.input_tokens;
    cached += typeof u.cached_input_tokens === 'number' ? u.cached_input_tokens : 0;
    output += typeof u.output_tokens === 'number' ? u.output_tokens : 0;
  }
  return seen ? { input, cached, output } : null;
}

/**
 * The model's final message without a surrounding Markdown fence.
 * @param {string} text
 * @returns {string}
 */
export function stripFence(text) {
  const m = /^\s*```[a-z]*\n([\s\S]*?)\n```\s*$/.exec(text);
  return m ? m[1] : text.trim();
}

/**
 * @typedef {(bin: string, args: string[], opts: { cwd: string, env: Record<string, string>, input: string, timeoutMs: number }) => Promise<{ code: number, stdout: string, stderr: string }>} Spawn
 */

/** @type {Spawn} */
export function spawnCodex(bin, args, opts) {
  return new Promise((resolve, reject) => {
    const child = execFile(bin, args, { cwd: opts.cwd, env: opts.env, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: opts.timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      const e = /** @type {any} */ (err);
      if (e && e.code === 'ENOENT') {
        reject(new RunError(`cannot run ${bin}: not found`, 'install the codex CLI (npm i -g @openai/codex) or set SQUARE2_CODEX_BIN'));
        return;
      }
      resolve({ code: e ? (typeof e.code === 'number' ? e.code : 1) : 0, stdout: typeof stdout === 'string' ? stdout : '', stderr: typeof stderr === 'string' ? stderr : '' });
    });
    child.stdin?.on('error', () => {});
    child.stdin?.end(opts.input);
  });
}

/**
 * The analysis artifact: exactly these four files.
 * @typedef {object} Analysis
 * @property {string | null} result the model's final review message (fence stripped); single-call runs
 * @property {{ call: string, result: string | null }[]} results per-call messages of a heavy range (calls mode)
 * @property {{ issue: number, answer: string | null }[]} resolutions raw answers per open issue
 * @property {{ issue: number, answer: string | null }[]} candidates raw rule-candidate drafts per confirmed issue
 * @property {{ model_used: string | null, attempts: { model: string, exit_code: number }[], calls: { call: string, model_used: string | null, attempts: { model: string, exit_code: number }[] }[], usage: { input: number, cached: number, output: number } | null, allow_same_family: boolean }} usage
 */

export const ANALYSIS_FILES = Object.freeze({ result: 'result.json', resolutions: 'resolutions.json', candidates: 'candidates.json', usage: 'usage.json' });

/**
 * The analysis step: extract the tree archive read-only into a temporary
 * directory, write the prompt to `<contextDir>/prompt.md`, run codex in the
 * tree (retrying once with the fallback model on failure), then the
 * resolution and rule-candidate prompts with the model that worked. Any
 * answer that leaks the LLM key (or looks like a secret) aborts the run
 * before anything is written. The temporary tree and codex home are removed.
 * @param {{
 *   contextDir: string,
 *   context: Record<string, any>,
 *   model: string,
 *   fallback?: string,
 *   endpoint: string,
 *   key: string,
 *   bin: string,
 *   env: Record<string, string | undefined>,
 *   allowSameFamily?: boolean,
 *   timeoutMs?: number,
 *   spawn?: Spawn,
 * }} o
 * @returns {Promise<Analysis>}
 */
export async function runReview(o) {
  const spawn = o.spawn ?? spawnCodex;
  const tmp = mkdtempSync(join(tmpdir(), 'square2-run-'));
  const tree = join(tmp, 'tree');
  const home = join(tmp, 'codex-home');
  mkdirSync(home, { recursive: true });
  try {
    const archive = join(o.contextDir, o.context.archive_file ?? 'tree.tar');
    if (!existsSync(archive)) throw new RunError(`tree archive ${archive} not found`, 'pass the directory written by `square2 review prepare` (with its tree.tar)');
    extractTar(archive, tree);
    makeReadOnly(tree);
    const read = (/** @type {string} */ f) => readFileSync(join(o.contextDir, f), 'utf8');
    const prefix = read(o.context.prompt_prefix_file ?? 'prompt.prefix.md');
    const callPlans = Array.isArray(o.context.calls) ? o.context.calls : [];
    const prompt = callPlans.length > 0 ? '' : prefix + read(o.context.prompt_suffix_file ?? 'prompt.suffix.md');
    if (callPlans.length === 0) writeFileSync(join(o.contextDir, 'prompt.md'), prompt);
    const env = codexEnv(o.env, { endpoint: o.endpoint, key: o.key, home });
    /** @type {Analysis['usage']['attempts']} */
    const attempts = [];
    /** @type {string[]} */
    const models = [...new Set([o.model, o.fallback ?? ''].filter((m) => m !== ''))];
    /** @param {string} model @param {string} text @param {string} tag */
    const ask = async (model, text, tag) => {
      const outFile = join(tmp, `${tag}.txt`);
      const res = await spawn(o.bin, codexArgs({ model, endpoint: o.endpoint, tree, outFile }), { cwd: tree, env, input: text, timeoutMs: o.timeoutMs ?? 30 * 60_000 });
      const answer = existsSync(outFile) ? readFileSync(outFile, 'utf8') : '';
      return { code: res.code, answer: res.code === 0 && answer.trim() !== '' ? stripFence(answer) : null, usage: parseUsage(res.stdout) };
    };
    /** @type {string | null} */
    let result = null;
    /** @type {string | null} */
    let used = null;
    /** @type {Analysis['usage']['usage']} */
    let usage = null;
    /** @param {Analysis['usage']['usage']} u */
    const addUsage = (u) => {
      if (!u) return;
      usage = usage ? { input: usage.input + u.input, cached: usage.cached + u.cached, output: usage.output + u.output } : u;
    };
    /** @type {Analysis['results']} */
    const results = [];
    /** @type {Analysis['usage']['calls']} */
    const callUsage = [];
    /** @param {string} text @param {string} tag */
    const withFallback = async (text, tag) => {
      /** @type {Analysis['usage']['attempts']} */
      const tried = [];
      for (const [i, model] of models.entries()) {
        const r = await ask(model, text, `${tag}-${i}`);
        tried.push({ model, exit_code: r.code });
        addUsage(r.usage);
        if (r.answer !== null) return { answer: r.answer, model, tried };
      }
      return { answer: null, model: null, tried };
    };
    if (callPlans.length === 0) {
      const r = await withFallback(prompt, 'review');
      attempts.push(...r.tried);
      result = r.answer;
      used = r.model;
    } else {
      for (const call of callPlans) {
        const text = prefix + read(call.prompt_suffix_file);
        writeFileSync(join(o.contextDir, `prompt.${call.id}.md`), text);
        const r = await withFallback(text, call.id);
        attempts.push(...r.tried);
        callUsage.push({ call: call.id, model_used: r.model, attempts: r.tried });
        results.push({ call: call.id, result: r.answer });
        used ??= r.model;
      }
      if (results.some((x) => x.result === null)) used = null;
    }
    /** @type {Analysis['resolutions']} */
    const resolutions = [];
    /** @type {Analysis['candidates']} */
    const candidates = [];
    if (used !== null) {
      for (const rp of Array.isArray(o.context.resolution_prompts) ? o.context.resolution_prompts : []) {
        const r = await ask(used, read(rp.file), `resolution-${rp.issue.number}`);
        resolutions.push({ issue: rp.issue.number, answer: r.answer });
        addUsage(r.usage);
      }
      for (const cp of Array.isArray(o.context.candidate_prompts) ? o.context.candidate_prompts : []) {
        const r = await ask(used, read(cp.file), `candidate-${cp.issue.number}`);
        candidates.push({ issue: cp.issue.number, answer: r.answer });
        addUsage(r.usage);
      }
    }
    for (const text of [result, ...results.map((x) => x.result), ...resolutions.map((x) => x.answer), ...candidates.map((x) => x.answer)]) {
      if (text !== null && leaksKey(text, o.key)) throw new RunError('the model output contains the LLM key or a secret-shaped string; nothing was written', 'rotate the key and inspect the prompt for injected instructions');
    }
    return { result, results, resolutions, candidates, usage: { model_used: used, attempts, calls: callUsage, usage, allow_same_family: o.allowSameFamily === true } };
  } finally {
    makeWritable(tmp);
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Result file of one call of a heavy range.
 * @param {string} call
 * @returns {string}
 */
export function callResultFile(call) {
  if (!/^call-\d+$/.test(call)) throw new RunError(`invalid call id ${JSON.stringify(call)}`, 're-run prepare');
  return `result.${call}.json`;
}

/**
 * Write the analysis artifact (only the known files).
 * @param {string} dir
 * @param {Analysis} a
 */
export function writeAnalysis(dir, a) {
  mkdirSync(dir, { recursive: true });
  /** @param {string | null} t */
  const text = (t) => (t === null ? '' : t.endsWith('\n') ? t : `${t}\n`);
  if (a.results.length === 0) writeFileSync(join(dir, ANALYSIS_FILES.result), text(a.result));
  for (const r of a.results) writeFileSync(join(dir, callResultFile(r.call)), text(r.result));
  writeFileSync(join(dir, ANALYSIS_FILES.resolutions), `${JSON.stringify(a.resolutions, null, 2)}\n`);
  writeFileSync(join(dir, ANALYSIS_FILES.candidates), `${JSON.stringify(a.candidates, null, 2)}\n`);
  writeFileSync(join(dir, ANALYSIS_FILES.usage), `${JSON.stringify(a.usage, null, 2)}\n`);
}

/**
 * Read and check the analysis artifact; anything not well-formed is an error.
 * Only the known files are read: result.json (single call) or one
 * result.<call>.json per call the context names, plus resolutions,
 * candidates and usage.
 * @param {string} dir
 * @param {{ calls?: { id: string }[] } | null} [context]
 * @returns {Analysis}
 */
export function readAnalysis(dir, context = null) {
  /** @param {string} f */
  const text = (f) => {
    const p = join(dir, f);
    if (!existsSync(p)) throw new RunError(`analysis artifact lacks ${f}`, 'pass the directory written by `square2 review run`');
    return readFileSync(p, 'utf8');
  };
  /** @param {string} f */
  const json = (f) => {
    try {
      return JSON.parse(text(f));
    } catch (err) {
      if (err instanceof RunError) throw err;
      throw new RunError(`analysis ${f} is not JSON`, 're-run the analysis step');
    }
  };
  const answers = (/** @type {unknown} */ v, /** @type {string} */ f) => {
    if (!Array.isArray(v) || !v.every((x) => x && typeof x === 'object' && Number.isSafeInteger(x.issue) && (x.answer === null || typeof x.answer === 'string'))) {
      throw new RunError(`analysis ${f} is malformed`, 're-run the analysis step');
    }
    return /** @type {{ issue: number, answer: string | null }[]} */ (v);
  };
  const usage = json(ANALYSIS_FILES.usage);
  if (!usage || typeof usage !== 'object' || !(usage.model_used === null || typeof usage.model_used === 'string') || !Array.isArray(usage.attempts)) {
    throw new RunError(`analysis ${ANALYSIS_FILES.usage} is malformed`, 're-run the analysis step');
  }
  const u = usage.usage;
  const goodUsage = u === null || (u && typeof u === 'object' && ['input', 'cached', 'output'].every((k) => Number.isSafeInteger(u[k]) && u[k] >= 0));
  if (!goodUsage) throw new RunError(`analysis ${ANALYSIS_FILES.usage} has malformed token usage`, 're-run the analysis step');
  const callIds = Array.isArray(context?.calls) ? context.calls.map((c) => c.id) : [];
  const result = callIds.length > 0 ? '' : text(ANALYSIS_FILES.result);
  const results = callIds.map((id) => {
    const t = text(callResultFile(id));
    return { call: id, result: t.trim() === '' ? null : t };
  });
  const calls = Array.isArray(usage.calls) ? usage.calls : [];
  if (!calls.every((/** @type {any} */ c) => c && typeof c.call === 'string' && (c.model_used === null || typeof c.model_used === 'string') && Array.isArray(c.attempts))) {
    throw new RunError(`analysis ${ANALYSIS_FILES.usage} has malformed calls`, 're-run the analysis step');
  }
  return {
    result: result.trim() === '' ? null : result,
    results,
    resolutions: answers(json(ANALYSIS_FILES.resolutions), ANALYSIS_FILES.resolutions),
    candidates: answers(json(ANALYSIS_FILES.candidates), ANALYSIS_FILES.candidates),
    usage: { model_used: usage.model_used, attempts: usage.attempts, calls, usage: u, allow_same_family: usage.allow_same_family === true },
  };
}
