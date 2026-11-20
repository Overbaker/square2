import { canonicalStringify, compareStrings } from './canonical-json.mjs';
import { PathError, sha256Hex, toPosixPath } from './fingerprint.mjs';
import { RULE_ID_PATTERN, formatDiagnostic } from './violation.mjs';
import { YamlError, errorMessage, parseYaml } from './yaml.mjs';

export const ENGINES = Object.freeze(['command', 'depcruise', 'eslint', 'ruff', 'suppressions']);
const REQUIRED = /** @type {const} */ (['id', 'dune_rule', 'engine', 'scope', 'instead', 'owner']);
const ALLOWED = new Set([...REQUIRED, 'description', 'enabled', 'exclude', 'options']);
export const CATALOGUE_EXIT_CODE = 2;

/**
 * @typedef {object} Rule
 * @property {string} id
 * @property {number} dune_rule 1..5
 * @property {string} engine
 * @property {string[]} scope
 * @property {string[]} exclude
 * @property {string} instead
 * @property {string} owner
 * @property {boolean} enabled
 * @property {string} [description]
 * @property {Record<string, import('./yaml.mjs').YamlValue>} options
 * @property {string} file the rule file it came from
 */

/**
 * @typedef {object} CatalogueResult
 * @property {boolean} ok
 * @property {Rule[]} rules sorted by id
 * @property {string[]} diagnostics `[S2-CATALOGUE] …` lines
 * @property {number} exitCode 0 or 2
 * @property {string} digest sha256 of the canonical rule list
 */

/**
 * @param {string} file
 * @param {string} detail
 * @param {string} instead
 * @returns {string}
 */
function diag(file, detail, instead) {
  return formatDiagnostic('S2-CATALOGUE', `${file}: ${detail}`, instead);
}

/**
 * @param {unknown} v
 * @returns {v is string}
 */
function nonEmptyString(v) {
  return typeof v === 'string' && v.trim() !== '';
}

/**
 * @param {unknown} v
 * @returns {string[] | null}
 */
function stringList(v) {
  if (nonEmptyString(v)) return [v];
  if (Array.isArray(v) && v.length > 0 && v.every(nonEmptyString)) return /** @type {string[]} */ (v);
  return null;
}

/**
 * Globs normalized like paths (NFC, POSIX, no absolute or `..`), or null.
 * @param {unknown} v
 * @returns {string[] | null}
 */
function globList(v) {
  const list = stringList(v);
  if (!list) return null;
  try {
    return list.map((g) => toPosixPath(g.trim()));
  } catch (err) {
    if (err instanceof PathError) return null;
    throw err;
  }
}

/**
 * @param {string} p
 * @returns {string}
 */
function displayPath(p) {
  if (typeof p !== 'string') return '<non-string path>';
  return p.normalize('NFC').replace(/\\/g, '/');
}

/**
 * Validate rule files. I/O is injected: `fixtureDirExists(id)` reports
 * whether `.square2/fixtures/<id>/bad/` exists.
 * @param {{ path: string, text: string }[]} files
 * @param {{ fixtureDirExists: (ruleId: string) => boolean }} io
 * @returns {CatalogueResult}
 */
export function validateCatalogue(files, io) {
  /** @type {string[]} */
  const diagnostics = [];
  /** @type {Rule[]} */
  const rules = [];
  /** @type {Map<string, string>} */
  const seen = new Map();
  const sorted = files.slice().sort((a, b) => compareStrings(displayPath(a.path), displayPath(b.path)));
  for (const f of sorted) {
    const file = displayPath(f.path);
    let doc;
    try {
      doc = parseYaml(f.text);
    } catch (err) {
      const what = err instanceof YamlError ? 'invalid YAML' : 'unreadable rule file';
      diagnostics.push(diag(file, `${what} (${errorMessage(err)})`, 'use block maps, block lists and plain or quoted scalars only'));
      continue;
    }
    if (doc === null || typeof doc !== 'object' || Array.isArray(doc) || !Array.isArray(doc.rules)) {
      diagnostics.push(diag(file, 'expected a top-level "rules" list', 'write `rules:` followed by a list of rule maps'));
      continue;
    }
    for (const extra of Object.keys(doc)) {
      if (extra !== 'rules') diagnostics.push(diag(file, `unknown top-level key ${extra}`, 'keep only `rules:` in rule files'));
    }
    doc.rules.forEach((entry, index) => {
      const rule = validateRule(file, entry, index, io, diagnostics);
      if (!rule) return;
      const prev = seen.get(rule.id);
      if (prev !== undefined) {
        diagnostics.push(diag(file, `rule ${rule.id} duplicate id (also in ${prev})`, 'give every rule a unique stable id'));
        return;
      }
      seen.set(rule.id, file);
      rules.push(rule);
    });
  }
  rules.sort((a, b) => compareStrings(a.id, b.id));
  const ok = diagnostics.length === 0;
  return { ok, rules, diagnostics, exitCode: ok ? 0 : CATALOGUE_EXIT_CODE, digest: catalogueDigest(rules) };
}

/**
 * @param {string} file
 * @param {unknown} entry
 * @param {number} index
 * @param {{ fixtureDirExists: (ruleId: string) => boolean }} io
 * @param {string[]} diagnostics
 * @returns {Rule | null}
 */
function validateRule(file, entry, index, io, diagnostics) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    diagnostics.push(diag(file, `rule #${index + 1} is not a mapping`, 'write each rule as a map of fields'));
    return null;
  }
  const r = /** @type {Record<string, unknown>} */ (entry);
  const label = nonEmptyString(r.id) ? r.id : `#${index + 1}`;
  const before = diagnostics.length;
  /** @param {string} detail @param {string} instead */
  const fail = (detail, instead) => diagnostics.push(diag(file, `rule ${label} ${detail}`, instead));

  for (const key of REQUIRED) {
    if (r[key] === undefined || r[key] === null || r[key] === '') fail(`missing ${key}`, `add a non-empty ${key}`);
  }
  if (r.id !== undefined && r.id !== null && r.id !== '' && !(typeof r.id === 'string' && RULE_ID_PATTERN.test(r.id))) {
    fail('invalid id', 'use an id matching ^[A-Z0-9]+(-[A-Z0-9]+)+$');
  }
  if (r.dune_rule !== undefined && r.dune_rule !== null && r.dune_rule !== '' &&
      !(typeof r.dune_rule === 'number' && Number.isInteger(r.dune_rule) && r.dune_rule >= 1 && r.dune_rule <= 5)) {
    fail('invalid dune_rule', 'set dune_rule to an integer from 1 to 5');
  }
  if (r.engine !== undefined && r.engine !== null && r.engine !== '' && !(typeof r.engine === 'string' && ENGINES.includes(r.engine))) {
    fail('unknown engine', `use one of ${ENGINES.join(', ')}`);
  }
  if (r.scope !== undefined && r.scope !== null && r.scope !== '' && globList(r.scope) === null) {
    fail('invalid scope', 'set scope to a non-empty repo-relative glob or list of globs');
  }
  if (r.instead !== undefined && r.instead !== null && r.instead !== '' && !nonEmptyString(r.instead)) {
    fail('missing instead', 'add a non-empty instead text that names the fix');
  }
  if (r.owner !== undefined && r.owner !== null && r.owner !== '' && !nonEmptyString(r.owner)) {
    fail('invalid owner', 'set owner to a non-empty string');
  }
  if (r.enabled !== undefined && typeof r.enabled !== 'boolean') fail('invalid enabled', 'set enabled to true or false');
  if (r.exclude !== undefined && !(Array.isArray(r.exclude) && r.exclude.length === 0) && globList(r.exclude) === null) {
    fail('invalid exclude', 'set exclude to a repo-relative glob or list of globs');
  }
  if (r.description !== undefined && typeof r.description !== 'string') fail('invalid description', 'set description to a string');
  if (r.options !== undefined && (r.options === null || typeof r.options !== 'object' || Array.isArray(r.options))) {
    fail('invalid options', 'set options to a map');
  }
  for (const key of Object.keys(r)) {
    if (!ALLOWED.has(key)) fail(`unknown field ${key}`, `use only ${[...ALLOWED].join(', ')}`);
  }
  if (typeof r.id === 'string' && RULE_ID_PATTERN.test(r.id) && !io.fixtureDirExists(r.id)) {
    fail(`missing fixture .square2/fixtures/${r.id}/bad/`, `add a negative fixture under .square2/fixtures/${r.id}/bad/ that the rule must flag`);
  }
  if (diagnostics.length !== before) return null;
  /** @type {Rule} */
  const rule = {
    id: /** @type {string} */ (r.id),
    dune_rule: /** @type {number} */ (r.dune_rule),
    engine: /** @type {string} */ (r.engine),
    scope: /** @type {string[]} */ (globList(r.scope)),
    exclude: r.exclude === undefined || (Array.isArray(r.exclude) && r.exclude.length === 0) ? [] : /** @type {string[]} */ (globList(r.exclude)),
    instead: /** @type {string} */ (r.instead).trim(),
    owner: /** @type {string} */ (r.owner),
    enabled: r.enabled === undefined ? true : /** @type {boolean} */ (r.enabled),
    options: r.options === undefined ? {} : /** @type {Record<string, import('./yaml.mjs').YamlValue>} */ (r.options),
    file,
  };
  if (typeof r.description === 'string') rule.description = r.description;
  return rule;
}

/**
 * @param {Rule[]} rules
 * @returns {string}
 */
export function catalogueDigest(rules) {
  const sorted = rules
    .slice()
    .sort((a, b) => compareStrings(a.id, b.id))
    .map(({ file: _file, ...rest }) => rest);
  return sha256Hex(canonicalStringify(sorted));
}
