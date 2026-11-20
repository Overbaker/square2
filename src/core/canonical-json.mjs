/**
 * @typedef {null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }} JsonValue
 */

/**
 * @typedef {object} CanonicalOptions
 * @property {number} [indent] spaces per level; 0 means compact
 * @property {boolean} [sortArrays] sort array elements by their canonical form
 */

/**
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function compareStrings(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * @param {unknown} value
 * @param {CanonicalOptions} [options]
 * @returns {string}
 */
export function canonicalStringify(value, options = {}) {
  const indent = options.indent ?? 0;
  const sortArrays = options.sortArrays ?? false;
  return render(value, '', indent, sortArrays);
}

/**
 * @param {unknown} value
 * @param {string} pad
 * @param {number} indent
 * @param {boolean} sortArrays
 * @returns {string}
 */
function render(value, pad, indent, sortArrays) {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonical JSON: non-finite number');
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  const inner = indent > 0 ? pad + ' '.repeat(indent) : '';
  const nl = indent > 0 ? '\n' : '';
  const colon = indent > 0 ? ': ' : ':';
  if (Array.isArray(value)) {
    let elements = value;
    if (sortArrays) {
      elements = value
        .map((v) => ({ key: render(v, '', 0, true), v }))
        .sort((x, y) => compareStrings(x.key, y.key))
        .map((p) => p.v);
    }
    const items = elements.map((v) => render(v, inner, indent, sortArrays));
    if (items.length === 0) return '[]';
    return '[' + nl + items.map((s) => inner + s).join(',' + nl) + nl + pad + ']';
  }
  if (typeof value === 'object') {
    const obj = /** @type {Record<string, unknown>} */ (value);
    const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort(compareStrings);
    if (keys.length === 0) return '{}';
    const parts = keys.map((k) => inner + JSON.stringify(k) + colon + render(obj[k], inner, indent, sortArrays));
    return '{' + nl + parts.join(',' + nl) + nl + pad + '}';
  }
  throw new TypeError(`canonical JSON: unsupported type ${typeof value}`);
}

/**
 * Canonical document form: 2-space indent, sorted keys, trailing newline.
 * @param {unknown} value
 * @param {{ sortArrays?: boolean }} [options]
 * @returns {string}
 */
export function canonicalDocument(value, options = {}) {
  return canonicalStringify(value, { indent: 2, sortArrays: options.sortArrays ?? false }) + '\n';
}
