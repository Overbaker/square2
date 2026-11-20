/**
 * Minimal YAML subset: block maps, block lists, and scalars (plain or quoted
 * strings, integers, booleans, null). ISO dates stay strings. `[]` and `{}`
 * are accepted as empty collections. Everything else throws YamlError.
 */

/**
 * @typedef {null | boolean | number | string | YamlValue[] | { [key: string]: YamlValue }} YamlValue
 */

export class YamlError extends Error {
  /**
   * @param {string} message
   * @param {number} line 1-based, 0 when unknown
   */
  constructor(message, line) {
    super(line > 0 ? `line ${line}: ${message}` : message);
    this.name = 'YamlError';
    this.line = line;
  }
}

/**
 * Message of any thrown value, without calling toString on untrusted objects.
 * @param {unknown} err
 * @returns {string}
 */
export function errorMessage(err) {
  return err instanceof Error && typeof err.message === 'string' ? err.message : 'unknown parser error';
}

/** @typedef {{ indent: number, text: string, line: number }} Line */

export const MAX_DEPTH = 64;

/**
 * @param {string | undefined} ch
 * @returns {boolean}
 */
function isBlank(ch) {
  return ch === ' ' || ch === '\t';
}

/**
 * Strip a trailing `# comment` in one linear pass. A quote opens a quoted
 * scalar only as the first non-blank character of the line, of a list item
 * (after `-` and blanks), or of a value (after `:` and blanks).
 * @param {string} raw
 * @param {number} lineNo
 * @returns {string}
 */
function stripComment(raw, lineNo) {
  /** @type {string | null} */
  let quote = null;
  let canQuote = true;
  let onlyDashes = true;
  /** @type {string | undefined} */
  let prev;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (quote === '"') {
      if (ch === '\\') i++;
      else if (ch === '"') quote = null;
      prev = ch;
      continue;
    }
    if (quote === "'") {
      if (ch === "'") {
        if (raw[i + 1] === "'") i++;
        else quote = null;
      }
      prev = ch;
      continue;
    }
    if (ch === '#' && (i === 0 || isBlank(prev))) return raw.slice(0, i).trimEnd();
    if (isBlank(ch)) {
      if (prev === ':' || (prev === '-' && onlyDashes)) canQuote = true;
    } else if ((ch === '"' || ch === "'") && canQuote) {
      quote = ch;
      canQuote = false;
      onlyDashes = false;
    } else {
      canQuote = false;
      if (!(ch === '-' && onlyDashes && (i === 0 || isBlank(prev)))) onlyDashes = false;
    }
    prev = ch;
  }
  if (quote !== null) throw new YamlError('unterminated quoted string', lineNo);
  return raw.trimEnd();
}

/**
 * @param {string} text
 * @returns {Line[]}
 */
function toLines(text) {
  /** @type {Line[]} */
  const lines = [];
  const src = text.startsWith('\uFEFF') ? text.slice(1) : text;
  src.split(/\r?\n/).forEach((raw, idx) => {
    const lineNo = idx + 1;
    const content = stripComment(raw, lineNo);
    if (content.trim() === '') return;
    let indent = 0;
    while (indent < content.length && content[indent] === ' ') indent++;
    const body = content.slice(indent);
    if (body.startsWith('\t')) throw new YamlError('tab indentation is not supported', lineNo);
    if (indent === 0 && (body === '---' || body === '...' || body.startsWith('--- ') || body.startsWith('%'))) {
      throw new YamlError('documents and directives are not supported', lineNo);
    }
    lines.push({ indent, text: body, line: lineNo });
  });
  return lines;
}

/**
 * @param {string} text
 * @returns {boolean}
 */
function isListItem(text) {
  return text === '-' || text.startsWith('- ') || text.startsWith('-\t');
}

/**
 * @param {string} after text right after a key
 * @returns {boolean} whether it is `:` alone or `:` followed by a blank
 */
function isKeyColon(after) {
  return after === ':' || after.startsWith(': ') || after.startsWith(':\t');
}

/**
 * @param {string} text
 * @param {number} lineNo
 * @returns {{ key: string, rest: string } | null}
 */
function splitKey(text, lineNo) {
  if (text.startsWith('"') || text.startsWith("'")) {
    const end = quotedEnd(text, lineNo);
    const after = text.slice(end);
    if (!isKeyColon(after)) return null;
    return { key: /** @type {string} */ (parseQuoted(text.slice(0, end), lineNo)), rest: after.slice(1).trim() };
  }
  const idx = plainKeyColon(text);
  if (idx < 0) return null;
  return checkPlainKey(text.slice(0, idx), text.slice(idx + 1).trim(), lineNo);
}

/**
 * Index of the first `:` followed by a blank or the end of the text, or -1.
 * A `:` inside a plain scalar (`a:b`, `http://x`) does not end the key.
 * @param {string} text
 * @returns {number}
 */
function plainKeyColon(text) {
  for (let i = 0; i < text.length; i++) {
    if (text[i] === ':' && (i + 1 === text.length || isBlank(text[i + 1]))) return i;
  }
  return -1;
}

/**
 * @param {string} key
 * @param {string} rest
 * @param {number} lineNo
 * @returns {{ key: string, rest: string }}
 */
function checkPlainKey(key, rest, lineNo) {
  const k = key.trim();
  if (k === '' || /^[-?:,[\]{}#&*!|>'"%@`]/.test(k)) throw new YamlError(`unsupported key ${JSON.stringify(k)}`, lineNo);
  return { key: k, rest };
}

/**
 * @param {string} text starts with a quote
 * @param {number} lineNo
 * @returns {number} index just after the closing quote
 */
function quotedEnd(text, lineNo) {
  const q = text[0];
  for (let i = 1; i < text.length; i++) {
    if (q === '"' && text[i] === '\\') { i++; continue; }
    if (text[i] === q) {
      if (q === "'" && text[i + 1] === "'") { i++; continue; }
      return i + 1;
    }
  }
  throw new YamlError('unterminated quoted string', lineNo);
}

/**
 * @param {string} text a complete quoted scalar
 * @param {number} lineNo
 * @returns {string}
 */
function parseQuoted(text, lineNo) {
  if (text.startsWith("'")) return text.slice(1, -1).replace(/''/g, "'");
  try {
    const v = JSON.parse(text);
    if (typeof v !== 'string') throw new Error('not a string');
    return v;
  } catch {
    throw new YamlError('unsupported escape in double-quoted string', lineNo);
  }
}

/**
 * @param {string} text
 * @param {number} lineNo
 * @returns {YamlValue}
 */
function parseScalar(text, lineNo) {
  if (text === '[]') return [];
  if (text === '{}') return {};
  if (text.startsWith('"') || text.startsWith("'")) {
    const end = quotedEnd(text, lineNo);
    if (end !== text.length) throw new YamlError('unexpected text after quoted string', lineNo);
    return parseQuoted(text, lineNo);
  }
  if (/^[[\]{}&*!|>%@`,?]/.test(text) || isListItem(text)) {
    throw new YamlError(`unsupported YAML construct ${JSON.stringify(text)}`, lineNo);
  }
  if (plainKeyColon(text) >= 0) throw new YamlError('nested mapping on one line is not supported', lineNo);
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (text === 'null' || text === '~') return null;
  if (/^[-+]?\d+$/.test(text)) {
    const n = Number(text);
    if (!Number.isSafeInteger(n)) throw new YamlError('integer out of range', lineNo);
    return n;
  }
  return text;
}

/**
 * @param {Line[]} lines
 * @param {number} i
 * @param {number} indent
 * @param {number} depth nesting level of the collection being parsed
 * @returns {[YamlValue, number]}
 */
function parseNode(lines, i, indent, depth) {
  if (depth > MAX_DEPTH) throw new YamlError(`nesting too deep (more than ${MAX_DEPTH} levels)`, lines[i].line);
  return isListItem(lines[i].text) ? parseList(lines, i, indent, depth) : parseMap(lines, i, indent, depth);
}

/**
 * @param {Line[]} lines
 * @param {number} i
 * @param {number} indent
 * @param {number} depth
 * @returns {[YamlValue[], number]}
 */
function parseList(lines, i, indent, depth) {
  if (depth > MAX_DEPTH) throw new YamlError(`nesting too deep (more than ${MAX_DEPTH} levels)`, lines[i].line);
  /** @type {YamlValue[]} */
  const out = [];
  while (i < lines.length && lines[i].indent === indent && isListItem(lines[i].text)) {
    const cur = lines[i];
    const rest = cur.text.slice(1);
    const trimmed = rest.trimStart();
    if (trimmed === '') {
      if (i + 1 < lines.length && lines[i + 1].indent > indent) {
        const [v, next] = parseNode(lines, i + 1, lines[i + 1].indent, depth + 1);
        out.push(v);
        i = next;
      } else {
        out.push(null);
        i++;
      }
      continue;
    }
    const innerIndent = indent + 1 + (rest.length - trimmed.length);
    if (isListItem(trimmed) || looksLikeMapEntry(trimmed, cur.line)) {
      lines[i] = { indent: innerIndent, text: trimmed, line: cur.line };
      const [v, next] = parseNode(lines, i, innerIndent, depth + 1);
      out.push(v);
      i = next;
      continue;
    }
    out.push(parseScalar(trimmed, cur.line));
    i++;
  }
  if (i < lines.length && lines[i].indent > indent) throw new YamlError('bad indentation', lines[i].line);
  return [out, i];
}

/**
 * @param {string} text
 * @param {number} lineNo
 * @returns {boolean}
 */
function looksLikeMapEntry(text, lineNo) {
  if (text.startsWith('"') || text.startsWith("'")) {
    const end = quotedEnd(text, lineNo);
    const after = text.slice(end);
    return isKeyColon(after);
  }
  return plainKeyColon(text) >= 0;
}

/**
 * @param {Line[]} lines
 * @param {number} i
 * @param {number} indent
 * @param {number} depth
 * @returns {[{ [key: string]: YamlValue }, number]}
 */
function parseMap(lines, i, indent, depth) {
  if (depth > MAX_DEPTH) throw new YamlError(`nesting too deep (more than ${MAX_DEPTH} levels)`, lines[i].line);
  /** @type {{ [key: string]: YamlValue }} */
  const out = Object.create(null);
  while (i < lines.length && lines[i].indent === indent) {
    const cur = lines[i];
    if (isListItem(cur.text)) throw new YamlError('list item where a mapping key was expected', cur.line);
    const kv = splitKey(cur.text, cur.line);
    if (!kv) throw new YamlError(`expected "key: value", got ${JSON.stringify(cur.text)}`, cur.line);
    if (Object.prototype.hasOwnProperty.call(out, kv.key)) throw new YamlError(`duplicate key ${JSON.stringify(kv.key)}`, cur.line);
    if (kv.key === '__proto__') throw new YamlError('reserved key "__proto__"', cur.line);
    i++;
    if (kv.rest !== '') {
      out[kv.key] = parseScalar(kv.rest, cur.line);
    } else if (i < lines.length && lines[i].indent > indent) {
      const [v, next] = parseNode(lines, i, lines[i].indent, depth + 1);
      out[kv.key] = v;
      i = next;
    } else if (i < lines.length && lines[i].indent === indent && isListItem(lines[i].text)) {
      const [v, next] = parseList(lines, i, indent, depth + 1);
      out[kv.key] = v;
      i = next;
    } else {
      out[kv.key] = null;
    }
  }
  if (i < lines.length && lines[i].indent > indent) throw new YamlError('bad indentation', lines[i].line);
  return [{ ...out }, i];
}

/**
 * Parse a YAML document in the supported subset. An empty document is `null`.
 * @param {string} text
 * @returns {YamlValue}
 */
export function parseYaml(text) {
  if (typeof text !== 'string') throw new YamlError('input must be a string', 0);
  const lines = toLines(text);
  if (lines.length === 0) return null;
  if (lines[0].indent !== 0) throw new YamlError('document must start at column 0', lines[0].line);
  const first = lines[0];
  /** @type {YamlValue} */
  let value;
  let next;
  if (!isListItem(first.text) && !looksLikeMapEntry(first.text, first.line)) {
    value = parseScalar(first.text, first.line);
    next = 1;
  } else {
    [value, next] = parseNode(lines, 0, 0, 1);
  }
  if (next < lines.length) throw new YamlError('unexpected content', lines[next].line);
  return value;
}
