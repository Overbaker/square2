import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { finalizeViolations } from '../core/violation.mjs';
import { EngineError, readText, ruleSelector } from '../cli/engine-util.mjs';

/**
 * @typedef {object} Comment
 * @property {string} text content without its delimiters
 * @property {number} line 1-based line where the comment starts
 * @property {number} pos offset of the comment in the source
 * @property {number} end offset just after the comment
 * @property {'line' | 'block'} kind
 * @property {string} tsLine what tsc matches: `//…` for line comments; for block comments the
 *   whole comment when single-line, else its last line (from after the last line break through the closing delimiter)
 * @property {boolean} leading no code token precedes it in the file
 * @property {boolean} [ownLine] Python: no code before it on its line
 * @typedef {{ name: string, codes: string[], rest: string, line?: number }} Directive
 * @typedef {{ subject: string, line: number, hasReason: boolean }} Suppression
 * @typedef {any} TypeScriptApi the consumer's `typescript` module (5.x JS API)
 */

const JS_EXT = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const PY_EXT = /\.(?:py|pyi)$/;

/** @type {Map<string, TypeScriptApi | null>} */
const tsCache = new Map();

/**
 * @param {string} from directory to resolve from
 * @returns {TypeScriptApi | null}
 */
function requireTypescript(from) {
  if (tsCache.has(from)) return tsCache.get(from);
  let ts = null;
  try {
    const req = createRequire(join(from, 'package.json'));
    const mod = req(req.resolve('typescript'));
    if (mod && typeof mod.createSourceFile === 'function' && typeof mod.getLeadingCommentRanges === 'function') ts = mod;
  } catch {
    ts = null;
  }
  tsCache.set(from, ts);
  return ts;
}

/**
 * The repository's own `typescript` (resolved from `<repoRoot>/package.json`).
 * `SQUARE2_TYPESCRIPT` (a directory containing a typescript package, used by
 * square²'s own tests) is consulted only when the repository has none.
 * @param {string} repoRoot
 * @param {Record<string, string | undefined>} [env]
 * @returns {TypeScriptApi | null}
 */
export function loadTypescript(repoRoot, env = process.env) {
  const own = requireTypescript(repoRoot);
  if (own) return own;
  const override = env.SQUARE2_TYPESCRIPT;
  if (override && existsSync(override)) return requireTypescript(override);
  return null;
}

/**
 * @param {TypeScriptApi} ts
 * @param {string} path
 * @returns {number}
 */
function scriptKind(ts, path) {
  if (/\.tsx$/.test(path)) return ts.ScriptKind.TSX;
  if (/\.jsx$/.test(path)) return ts.ScriptKind.JSX;
  if (/\.(?:js|mjs|cjs)$/.test(path)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/**
 * Comments of a JS/TS source as TypeScript sees them: every leading and
 * trailing comment range of every token, skipping JSX text and JSDoc nodes,
 * from a real parse (so regexes, templates and JSX never confuse it).
 * @param {TypeScriptApi} ts
 * @param {string} path
 * @param {string} src
 * @returns {{ comments: Comment[], sourceFile: any }}
 */
export function tsComments(ts, path, src) {
  const sf = ts.createSourceFile(path, src, ts.ScriptTarget.Latest, false, scriptKind(ts, path));
  /** @type {Map<number, { pos: number, end: number, kind: number }>} */
  const ranges = new Map();
  let firstCode = src.length;
  const jsx = new Set([ts.SyntaxKind.JsxText, ts.SyntaxKind.JsxTextAllWhiteSpaces]);
  /** @param {{ pos: number, end: number, kind: number }[] | undefined} list */
  const add = (list) => { for (const r of list ?? []) if (!ranges.has(r.pos)) ranges.set(r.pos, r); };
  /** @param {any} node */
  const isJsDoc = (node) => node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode;
  /** @param {any} node */
  const visit = (node) => {
    if (isJsDoc(node)) return;
    const children = node.getChildren(sf).filter((/** @type {any} */ c) => !isJsDoc(c));
    if (children.length > 0) {
      for (const c of children) visit(c);
      return;
    }
    if (jsx.has(node.kind)) return;
    if (node.kind !== ts.SyntaxKind.EndOfFileToken) firstCode = Math.min(firstCode, node.getStart(sf));
    add(ts.getLeadingCommentRanges(src, node.getFullStart()));
    add(ts.getTrailingCommentRanges(src, node.getEnd()));
  };
  visit(sf);
  /** @type {Comment[]} */
  const comments = [...ranges.values()]
    .sort((a, b) => a.pos - b.pos)
    .map((r) => {
      const raw = src.slice(r.pos, r.end);
      const block = r.kind === ts.SyntaxKind.MultiLineCommentTrivia;
      const lastBreak = raw.lastIndexOf('\n');
      return {
        text: block ? raw.slice(2, raw.endsWith('*/') ? -2 : undefined) : raw.slice(2),
        line: sf.getLineAndCharacterOfPosition(r.pos).line + 1,
        pos: r.pos,
        end: r.end,
        kind: block ? 'block' : 'line',
        tsLine: block && lastBreak >= 0 ? raw.slice(lastBreak + 1) : raw,
        leading: r.pos < firstCode,
      };
    });
  return { comments, sourceFile: sf };
}

/**
 * Comments of a Python source, skipping all string forms (prefixes,
 * triple-quoted strings and docstrings, raw strings, backslash-newlines).
 * @param {string} src
 * @returns {Comment[]}
 */
export function pyComments(src) {
  /** @type {Comment[]} */
  const out = [];
  let i = 0;
  let line = 1;
  let sawCode = false;
  let lineHasCode = false;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    if (ch === '\n') { line++; i++; lineHasCode = false; continue; }
    if (ch === '#') {
      let j = i + 1;
      while (j < n && src[j] !== '\n') j++;
      out.push({ text: src.slice(i + 1, j), line, pos: i, end: j, kind: 'line', tsLine: '', leading: !sawCode, ownLine: !lineHasCode });
      i = j;
      continue;
    }
    if (ch === '\\' && src[i + 1] === '\n') { line++; i += 2; continue; }
    if (!/\s/.test(ch)) { sawCode = true; lineHasCode = true; }
    if (ch === '"' || ch === "'") {
      const triple = src.slice(i, i + 3) === ch.repeat(3);
      let j = i + (triple ? 3 : 1);
      while (j < n) {
        if (src[j] === '\\') {
          if (src[j + 1] === '\n') line++;
          else if (src[j + 1] === '\r' && src[j + 2] === '\n') { line++; j++; }
          j += 2;
          continue;
        }
        if (src[j] === '\n') {
          if (!triple) break;
          line++;
        }
        if (triple ? src.slice(j, j + 3) === ch.repeat(3) : src[j] === ch) { j += triple ? 3 : 1; break; }
        j++;
      }
      i = j;
      continue;
    }
    i++;
  }
  return out;
}

/**
 * Split `a, b c` style code lists until a reason separator.
 * @param {string} text
 * @returns {{ codes: string[], rest: string }}
 */
function eslintCodes(text) {
  /** @type {string[]} */
  const codes = [];
  let rest = text;
  for (;;) {
    const m = /^[\s,]*([^\s,]+)/.exec(rest);
    if (!m) break;
    let tok = m[1];
    if (tok === '-' || tok.startsWith('--') || /^because$/i.test(tok) || tok.startsWith(':') || tok === '*/' || tok.startsWith('@ts-')) break;
    rest = rest.slice(m[0].length);
    if (tok.endsWith(':')) {
      tok = tok.slice(0, -1);
      rest = ':' + rest;
      if (tok !== '') codes.push(tok);
      break;
    }
    codes.push(tok);
  }
  return { codes, rest };
}

const PY_CODES = /^\s*:\s*([A-Z]+[0-9]+(?:\s*,\s*[A-Z]+[0-9]+)*)/;
const TS_LINE = /^\/\/\/?\s*@(ts-expect-error|ts-ignore)/;
const TS_BLOCK = /^\s*(?:\/|\*)*\s*@(ts-expect-error|ts-ignore)/;
const TS_NOCHECK = /^\/\/\/?\s*@ts-nocheck/;

/**
 * Text after a TS directive marker in a comment (its reason, if any).
 * @param {Comment} c
 * @param {string} name
 * @returns {string}
 */
function afterMarker(c, name) {
  const i = c.tsLine.indexOf(name);
  const rest = i >= 0 ? c.tsLine.slice(i + name.length).replace(/^[a-z-]*/, '') : '';
  return c.kind === 'block' ? rest.replace(/\*\/\s*$/, '') : rest;
}

/**
 * TypeScript directives per comment, as the repository's own TypeScript
 * records them while parsing (`commentDirectives`, `checkJsDirective`), so
 * the answer matches that tsc version exactly. Falls back to the documented
 * rules when those fields are absent.
 * @param {any} sf
 * @param {Comment[]} comments
 * @returns {Map<Comment, Directive[]>}
 */
function tsDirectives(sf, comments) {
  /** @type {Map<Comment, Directive[]>} */
  const out = new Map();
  /** @param {number} pos */
  const owner = (pos) => comments.find((c) => c.pos <= pos && pos < c.end);
  /** @param {Comment} c @param {Directive} d */
  const push = (c, d) => out.set(c, [...(out.get(c) ?? []), d]);
  const native = Array.isArray(sf.commentDirectives);
  if (native) {
    for (const d of sf.commentDirectives) {
      const c = owner(d.range.pos);
      if (!c) continue;
      const name = d.type === 0 ? '@ts-expect-error' : '@ts-ignore';
      push(c, { name, codes: [], rest: afterMarker(c, name), line: sf.getLineAndCharacterOfPosition(d.range.pos).line + 1 });
    }
    const nocheck = sf.checkJsDirective;
    if (nocheck && nocheck.enabled === false) {
      const c = owner(nocheck.pos);
      if (c) push(c, { name: '@ts-nocheck', codes: [], rest: afterMarker(c, '@ts-nocheck') });
    }
    return out;
  }
  for (const c of comments) {
    const m = (c.kind === 'line' ? TS_LINE : TS_BLOCK).exec(c.tsLine);
    if (m) push(c, { name: `@${m[1]}`, codes: [], rest: afterMarker(c, `@${m[1]}`) });
    else if (c.kind === 'line' && c.leading && TS_NOCHECK.test(c.tsLine)) push(c, { name: '@ts-nocheck', codes: [], rest: afterMarker(c, '@ts-nocheck') });
  }
  return out;
}

/**
 * ESLint and Python directives in one comment's text (every directive, not
 * just the first).
 * @param {string} text comment content
 * @param {'js' | 'py'} lang
 * @returns {Directive[]}
 */
export function directives(text, lang) {
  /** @type {Directive[]} */
  const out = [];
  if (lang === 'js') {
    const t = text.replace(/^\s+/, '');
    const es = /^eslint-disable(?:-next-line|-line)?(?=$|\s)/.exec(t);
    if (es) {
      const { codes, rest } = eslintCodes(t.slice(es[0].length));
      out.push({ name: es[0], codes, rest });
    }
    return out;
  }
  for (const seg of text.split('#')) {
    const t = seg.trim();
    let m;
    if ((m = /^noqa\b/i.exec(t))) {
      const after = t.slice(m[0].length);
      const c = PY_CODES.exec(after);
      out.push({ name: 'noqa', codes: c ? c[1].split(/\s*,\s*/) : [], rest: c ? after.slice(c[0].length) : after });
    } else if ((m = /^(ruff|flake8)\s*:\s*noqa\b/i.exec(t))) {
      const after = t.slice(m[0].length);
      const c = PY_CODES.exec(after);
      out.push({ name: `${m[1].toLowerCase()}: noqa`, codes: c ? c[1].split(/\s*,\s*/) : [], rest: c ? after.slice(c[0].length) : after });
    } else if ((m = /^type\s*:\s*ignore\b(?:\[([^\]]*)\])?/.exec(t))) {
      out.push({ name: 'type: ignore', codes: m[1] ? m[1].split(/\s*,\s*/).filter((x) => x !== '') : [], rest: t.slice(m[0].length) });
    }
  }
  return out;
}

/**
 * Reason text: introduced by `--`, `-`, `:` or `because` right after the codes.
 * @param {string} rest
 * @returns {boolean}
 */
export function hasReasonText(rest) {
  const t = rest.replace(/\*\/\s*$/, '').trim();
  return /^(?:--|-|:)\s*\S/.test(t) || /^because\s+\S/i.test(t);
}

/**
 * All suppressions in a file. JS/TS files need the repository's TypeScript.
 * @param {string} path
 * @param {string} src
 * @param {TypeScriptApi | null} [ts]
 * @returns {Suppression[]}
 */
export function scanSuppressions(path, src, ts = null) {
  const lang = JS_EXT.test(path) ? 'js' : PY_EXT.test(path) ? 'py' : null;
  if (lang === null) return [];
  /** @type {Comment[]} */
  let comments;
  /** @type {Map<Comment, Directive[]>} */
  let tsByComment = new Map();
  if (lang === 'js') {
    if (!ts) throw new EngineError('S2-ENGINE-MISSING', 'suppressions needs typescript', "add typescript to the repo's devDependencies");
    const parsed = tsComments(ts, path, src);
    comments = parsed.comments;
    tsByComment = tsDirectives(parsed.sourceFile, comments);
  } else {
    comments = pyComments(src);
  }
  /** @type {Set<number>} */
  const reasonLines = new Set();
  for (const c of comments) if (/^\s*reason\s*:\s*\S/i.test(c.text)) reasonLines.add(c.line);
  /** @type {Suppression[]} */
  const out = [];
  for (const c of comments) {
    const found = [...directives(c.text, lang), ...(tsByComment.get(c) ?? [])];
    // ruff and flake8 honour file-level `ruff: noqa` / `flake8: noqa` only on a line of their own
    for (const d of found.filter((x) => !(lang === 'py' && c.ownLine === false && /^(?:ruff|flake8): noqa$/.test(x.name)))) {
      out.push({
        subject: d.codes.length > 0 ? `${d.name} ${d.codes.join(',')}` : d.name,
        line: d.line ?? c.line,
        hasReason: hasReasonText(d.rest) || reasonLines.has(c.line - 1),
      });
    }
  }
  return out.sort((a, b) => a.line - b.line || (a.subject < b.subject ? -1 : a.subject > b.subject ? 1 : 0));
}

/**
 * @param {string} path
 * @returns {boolean}
 */
export function isSourceFile(path) {
  return JS_EXT.test(path) || PY_EXT.test(path);
}

/** @type {import('../cli/engine-util.mjs').EngineAdapter} */
export const adapter = {
  async run(ctx) {
    const files = (await ctx.files()).filter(isSourceFile);
    const selectors = ctx.rules.map((rule) => ({ rule, select: ruleSelector(rule, ctx.excludes) }));
    const wantedFiles = files.map((path) => ({ path, wanted: selectors.filter((s) => s.select(path)) })).filter((f) => f.wanted.length > 0);
    const ts = wantedFiles.some((f) => JS_EXT.test(f.path)) ? loadTypescript(ctx.repoRoot) : null;
    /** @type {import('../core/violation.mjs').RawViolation[]} */
    const raws = [];
    for (const { path, wanted } of wantedFiles) {
      const found = scanSuppressions(path, readText(ctx.root, path), ts);
      for (const { rule } of wanted) {
        for (const s of found) {
          if (rule.require_reason && s.hasReason) continue;
          raws.push({
            rule_id: rule.id,
            path,
            line: s.line,
            subject: s.subject,
            message: rule.require_reason ? `has suppression ${s.subject} without a reason` : `has suppression ${s.subject}`,
          });
        }
      }
    }
    return { violations: finalizeViolations(raws), version: ts ? `typescript ${ts.version}` : 'builtin' };
  },
};
