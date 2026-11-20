import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { canonicalDocument } from '../core/canonical-json.mjs';
import { PathError, sha256Hex, toPosixPath } from '../core/fingerprint.mjs';
import { formatDiagnostic } from '../core/violation.mjs';
import { git } from '../git/exec.mjs';
import { parseConfig } from './config.mjs';
import { readLock, readOptional, vendorPath } from './load.mjs';

export const VENDORED = Object.freeze(['bin', 'src', 'prompts', 'schemas', 'LICENSE']);
/** Written into every vendored copy; its presence makes the lock mandatory. */
export const MARKER = '.square2-vendored';

export class TreeError extends Error {}

/**
 * File bytes for hashing: text files (no NUL byte) with CRLF normalised to LF,
 * so a checkout with `core.autocrlf` hashes the same.
 * @param {Buffer} bytes
 * @returns {Buffer}
 */
function normalized(bytes) {
  if (bytes.includes(0)) return bytes;
  return Buffer.from(bytes.toString('latin1').replace(/\r\n/g, '\n'), 'latin1');
}

/**
 * sha256 of the sorted `path\0sha256(file)\n` lines of every file under `dir`
 * (design D3). Symlinks are refused (TreeError).
 * @param {string} dir
 * @returns {string}
 */
export function treeSha256(dir) {
  const lines = walkAll(dir).map((p) => `${p}\0${sha256Hex(normalized(readFileSync(join(dir, p))))}\n`);
  return sha256Hex(lines.join(''));
}

/**
 * Every regular file under dir, sorted. Symlinks throw TreeError.
 * @param {string} dir
 * @returns {string[]}
 */
function walkAll(dir) {
  /** @type {string[]} */
  const out = [];
  /** @param {string} sub */
  const walk = (sub) => {
    for (const name of readdirSync(join(dir, sub))) {
      const rel = sub === '' ? name : `${sub}/${name}`;
      const st = lstatSync(join(dir, rel));
      if (st.isSymbolicLink()) throw new TreeError(`symlink ${rel} inside the vendored tree`);
      if (st.isDirectory()) walk(rel);
      else if (st.isFile()) out.push(rel);
      else throw new TreeError(`special file ${rel} inside the vendored tree`);
    }
  };
  walk('');
  return out.sort();
}

/**
 * @typedef {{ status: 'ok' | 'not-vendored' } | { status: 'tampered', line: string }} VendorCheck
 */

const TAMPER_INSTEAD = 'never edit the vendored copy or its lock; re-run `square2 vendor --from <source> --ref <tag>` to update it';

/**
 * Vendor verification. It is mandatory when any of these holds: the config
 * declares `vendored_path`, `.square2/lock.json` exists, or the running copy
 * carries the vendor marker. Then the lock must be valid, its `path` a
 * normalized repo-relative path (agreeing with `vendored_path` and with the
 * running copy when it is the vendored one), and the tree at that path must
 * hash to `tree_sha256`. This detects accidental edits of the vendored copy;
 * it is not a defence against a committer, who can always change policy.
 * @param {{ root: string, dir: string }} repo
 * @param {string} toolRoot directory of the running square² (contains bin/ and src/)
 * @returns {VendorCheck}
 */
export function verifyVendor(repo, toolRoot) {
  const lock = readLock(repo.dir);
  const marker = existsSync(join(toolRoot, MARKER));
  const declared = parseConfig(readOptional(join(repo.dir, 'config.yaml'))).config.vendored_path;
  if (!marker && lock === null && declared === null) return { status: 'not-vendored' };
  /** @param {string} why */
  const tampered = (why) => ({ status: /** @type {const} */ ('tampered'), line: formatDiagnostic('S2-VENDOR-TAMPERED', why, TAMPER_INSTEAD) });
  if (lock === null) return tampered(`${marker ? 'this runner is a vendored copy' : `config declares vendored_path ${declared}`} but .square2/lock.json is missing`);
  if (lock === 'invalid' || typeof lock.tree_sha256 !== 'string' || typeof lock.path !== 'string') {
    return tampered('.square2/lock.json is unreadable or lacks path and tree_sha256');
  }
  const path = vendorPath(lock);
  if (path === null) return tampered(`.square2/lock.json path ${JSON.stringify(lock.path)} is not a normalized repo-relative path`);
  if (declared !== null && declared !== path) return tampered(`.square2/lock.json names ${path}, but config vendored_path is ${declared}`);
  if (marker) {
    let here;
    try {
      here = toPosixPath(relative(realpathSync(repo.root), realpathSync(toolRoot)));
    } catch {
      here = null;
    }
    if (here === null || here !== path) return tampered(`.square2/lock.json names ${path}, but this runner is ${here ?? 'outside the repository'}`);
  }
  const target = join(repo.root, path);
  if (!existsSync(target)) return tampered(`${path} named by .square2/lock.json does not exist`);
  let actual;
  try {
    actual = treeSha256(target);
  } catch (err) {
    if (err instanceof TreeError) return tampered(`${path}: ${err.message}`);
    throw err;
  }
  if (actual !== lock.tree_sha256) return tampered(`${path} tree_sha256 ${actual} does not match .square2/lock.json ${lock.tree_sha256}`);
  return { status: 'ok' };
}

/**
 * Copy `bin/ src/ prompts/ schemas/ LICENSE` of `<from>@<ref>` into `<root>/<into>`
 * (symlinks dereferenced), add the marker, and write the lock.
 * @param {{ repo: { root: string, dir: string }, cwd: string, from: string, ref: string, into?: string }} input
 * @returns {Promise<{ lock: { version: string, commit_sha: string, tree_sha256: string, path: string }, lines: string[] }>}
 */
export async function vendor(input) {
  if (input.ref.startsWith('-') || input.ref.trim() === '') throw new VendorError(`invalid ref ${JSON.stringify(input.ref)}`);
  let into;
  try {
    into = toPosixPath(input.into ?? 'tools/square2');
  } catch (err) {
    if (err instanceof PathError) throw new VendorError(`--into must be a repo-relative path: ${err.message}`);
    throw err;
  }
  if (into === '.git' || into.startsWith('.git/') || into === '.square2' || into.startsWith('.square2/')) throw new VendorError(`--into ${into} is reserved`);
  const isUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(input.from) || /^[^/\s]+@[^:\s]+:/.test(input.from);
  const source = isUrl ? input.from : isAbsolute(input.from) ? input.from : resolve(input.cwd, input.from);
  if (source.startsWith('-')) throw new VendorError(`invalid --from ${JSON.stringify(input.from)}`);
  const tmp = mkdtempSync(join(tmpdir(), 'square2-vendor-'));
  try {
    const clone = join(tmp, 'src');
    await git(tmp, ['clone', '--quiet', '--no-checkout', '--', source, clone]);
    await git(clone, ['checkout', '--quiet', '--detach', input.ref]);
    const commit = (await git(clone, ['rev-parse', 'HEAD'])).trim();
    for (const required of ['bin', 'src']) {
      if (!existsSync(join(clone, required))) throw new VendorError(`${input.from}@${input.ref} has no ${required}/`);
    }
    const target = join(input.repo.root, into);
    rmSync(target, { recursive: true, force: true });
    mkdirSync(target, { recursive: true });
    for (const name of VENDORED) {
      const p = join(clone, name);
      if (existsSync(p) || isLink(p)) copyDereferenced(p, join(target, name), name);
    }
    writeFileSync(join(target, MARKER), 'Vendored by `square2 vendor`. Do not edit: .square2/lock.json pins this tree.\n');
    let tree;
    try {
      tree = treeSha256(target);
    } catch (err) {
      if (err instanceof TreeError) throw new VendorError(err.message);
      throw err;
    }
    const lock = { version: input.ref, commit_sha: commit, tree_sha256: tree, path: into };
    mkdirSync(input.repo.dir, { recursive: true });
    writeFileSync(join(input.repo.dir, 'lock.json'), canonicalDocument(lock));
    return { lock, lines: [`vendored ${input.ref} (${commit}) into ${into}`, `tree_sha256 ${lock.tree_sha256}`] };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * @param {string} p
 * @returns {boolean}
 */
function isLink(p) {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Copy a file or directory tree, replacing every symlink with the real file
 * it points to. A dangling link is a VendorError.
 * @param {string} from
 * @param {string} to
 * @param {string} label repo-relative name for messages
 */
function copyDereferenced(from, to, label) {
  let st;
  try {
    st = statSync(from);
  } catch {
    throw new VendorError(`cannot copy ${label}: dangling symlink`);
  }
  if (st.isDirectory()) {
    mkdirSync(to, { recursive: true });
    for (const name of readdirSync(from).sort()) copyDereferenced(join(from, name), join(to, name), `${label}/${name}`);
  } else if (st.isFile()) {
    writeFileSync(to, readFileSync(from), { mode: st.mode & 0o777 });
  } else {
    throw new VendorError(`cannot copy ${label}: not a regular file`);
  }
}

export class VendorError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'VendorError';
  }

  /** @returns {string} */
  get diagnostic() {
    return formatDiagnostic('S2-VENDOR', this.message, 'pass --from <path or git url> and --ref <tag or sha> of a square² release');
  }
}
