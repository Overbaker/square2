import { ttlCapFromConfig } from '../core/exceptions.mjs';
import { PathError, toPosixPath } from '../core/fingerprint.mjs';
import { formatDiagnostic } from '../core/violation.mjs';
import { errorMessage, parseYaml } from '../core/yaml.mjs';

/**
 * @typedef {object} Config
 * @property {string[]} approvers
 * @property {number} max_exception_ttl_days
 * @property {boolean} require_provenance
 * @property {string[]} generated globs excluded from every engine
 * @property {string | null} vendored_path where the repository vendors square² (verification becomes mandatory)
 * @property {{ ruff?: { command?: string[] }, depcruise?: { config?: string }, eslint?: { config?: string } }} engines
 * @property {{ enabled: boolean }} escapes escape records (`escapes.enabled`, experimental, default false)
 * @property {Record<string, unknown>} raw the whole parsed document (other keys belong to later features)
 */

/** Keys of the `review` map in `.square2/config.yaml`. */
export const REVIEW_KEYS = Object.freeze(['author_trailers', 'change_id_trailers', 'provenance_trailers']);

/**
 * The valid `review` key closest to a misspelt one (edit distance).
 * @param {string} key
 * @returns {string}
 */
export function closestReviewKey(key) {
  /** @param {string} a @param {string} b */
  const dist = (a, b) => {
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
    return prev[b.length];
  };
  return [...REVIEW_KEYS].sort((x, y) => dist(key.toLowerCase(), x) - dist(key.toLowerCase(), y))[0];
}

/**
 * Problems of the `review` map: not a mapping, or unknown keys.
 * @param {unknown} review
 * @returns {{ detail: string, instead: string }[]}
 */
export function reviewMapProblems(review) {
  if (review === undefined || review === null) return [];
  if (typeof review !== 'object' || Array.isArray(review)) return [{ detail: 'review must be a mapping', instead: `write review as a block map with ${REVIEW_KEYS.join(', ')}` }];
  return Object.keys(review).filter((k) => !REVIEW_KEYS.includes(k)).sort().map((k) => ({ detail: `unknown setting review.${k}`, instead: `use review.${closestReviewKey(k)}` }));
}

/** @returns {Config} */
export function defaultConfig() {
  return { approvers: [], max_exception_ttl_days: 90, require_provenance: false, generated: [], vendored_path: null, engines: {}, escapes: { enabled: false }, raw: {} };
}

/**
 * Parse `.square2/config.yaml` (null text means no file: defaults).
 * @param {string | null} text
 * @returns {{ config: Config, diagnostics: string[] }}
 */
export function parseConfig(text) {
  const config = defaultConfig();
  /** @type {string[]} */
  const diagnostics = [];
  /** @param {string} detail @param {string} instead */
  const fail = (detail, instead) => diagnostics.push(formatDiagnostic('S2-CONFIG', `.square2/config.yaml: ${detail}`, instead));
  if (text === null) return { config, diagnostics };
  let doc;
  try {
    doc = parseYaml(text);
  } catch (err) {
    fail(`invalid YAML (${errorMessage(err)})`, 'use block maps, block lists and plain or quoted scalars only');
    return { config, diagnostics };
  }
  if (doc === null) return { config, diagnostics };
  if (typeof doc !== 'object' || Array.isArray(doc)) {
    fail('must be a mapping', 'write config keys at the top level');
    return { config, diagnostics };
  }
  config.raw = doc;
  /** @param {unknown} v */
  const strings = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string' && x.trim() !== '');
  if (doc.approvers !== undefined) {
    if (doc.approvers === null) config.approvers = [];
    else if (strings(doc.approvers)) config.approvers = /** @type {string[]} */ (doc.approvers);
    else fail('approvers must be a list of logins', 'write approvers as a block list of strings');
  }
  try {
    config.max_exception_ttl_days = ttlCapFromConfig(doc);
  } catch {
    fail('max_exception_ttl_days must be a positive integer', 'set max_exception_ttl_days: 90');
  }
  if (doc.require_provenance !== undefined) {
    if (typeof doc.require_provenance === 'boolean') config.require_provenance = doc.require_provenance;
    else fail('require_provenance must be true or false', 'set require_provenance: true or false');
  }
  if (doc.generated !== undefined && doc.generated !== null) {
    if (!strings(doc.generated)) fail('generated must be a list of globs', 'write generated as a block list of repo-relative globs');
    else {
      try {
        config.generated = /** @type {string[]} */ (doc.generated).map((g) => toPosixPath(g.trim()));
      } catch (err) {
        if (!(err instanceof PathError)) throw err;
        fail(`generated: ${err.message}`, 'use repo-relative globs');
      }
    }
  }
  if (doc.vendored_path !== undefined && doc.vendored_path !== null) {
    /** @type {string | null} */
    let p = null;
    if (typeof doc.vendored_path === 'string') {
      try {
        p = toPosixPath(doc.vendored_path.trim());
      } catch (err) {
        if (!(err instanceof PathError)) throw err;
      }
    }
    if (p === null) fail('vendored_path must be a repo-relative path', 'set vendored_path to the directory written by `square2 vendor`, for example tools/square2');
    else config.vendored_path = p;
  }
  for (const p of reviewMapProblems(doc.review)) fail(p.detail, p.instead);
  if (doc.escapes !== undefined && doc.escapes !== null) {
    const e = doc.escapes;
    if (typeof e !== 'object' || Array.isArray(e)) fail('escapes must be a mapping', 'write escapes as a block map with enabled: true or false');
    else {
      for (const k of Object.keys(e).sort()) if (k !== 'enabled') fail(`unknown setting escapes.${k}`, 'use escapes.enabled');
      const v = /** @type {Record<string, unknown>} */ (e).enabled;
      if (v !== undefined && v !== null && typeof v !== 'boolean') fail('escapes.enabled must be true or false', 'set escapes.enabled: false (the default) or true');
      else config.escapes = { enabled: v === true };
    }
  }
  if (doc.engines !== undefined && doc.engines !== null) {
    const e = doc.engines;
    if (typeof e !== 'object' || Array.isArray(e)) fail('engines must be a mapping', 'write engines as a map of engine name to settings');
    else {
      for (const [name, v] of Object.entries(e)) {
        if (!['ruff', 'depcruise', 'eslint'].includes(name)) {
          fail(`unknown engine settings ${name}`, 'configure only ruff, depcruise or eslint');
          continue;
        }
        if (v === null || typeof v !== 'object' || Array.isArray(v)) {
          fail(`engines.${name} must be a mapping`, 'write engine settings as a map');
          continue;
        }
        const settings = /** @type {Record<string, unknown>} */ (v);
        if (name === 'ruff') {
          if (settings.command !== undefined && !(strings(settings.command) && /** @type {string[]} */ (settings.command).length > 0)) {
            fail('engines.ruff.command must be a non-empty list', 'write command as a block list, one `- item` per line, for example uv, run, --project, python, ruff');
          } else config.engines.ruff = { command: /** @type {string[] | undefined} */ (settings.command) };
        } else if (settings.config !== undefined) {
          /** @type {string | null} */
          let rel = null;
          if (typeof settings.config === 'string') {
            try {
              rel = toPosixPath(settings.config.trim());
            } catch (err) {
              if (!(err instanceof PathError)) throw err;
            }
          }
          if (rel === null) fail(`engines.${name}.config must be a repo-relative path`, 'set config to a path inside the repository, without .. or a leading /');
          else config.engines[/** @type {'depcruise' | 'eslint'} */ (name)] = { config: rel };
        }
      }
    }
  }
  return { config, diagnostics };
}
