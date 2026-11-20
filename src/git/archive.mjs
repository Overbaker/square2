import { mkdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { sha256Hex } from '../core/fingerprint.mjs';
import { readFileSync } from 'node:fs';
import { git } from './exec.mjs';

/**
 * Write `git archive --format=tar <sha>` to `outPath`: the full tree at that
 * commit, without `.git` and without any credentials, for a read-only
 * analysis step.
 * @param {string} dir
 * @param {string} sha
 * @param {string} outPath
 * @returns {Promise<{ path: string, sha: string, bytes: number, sha256: string }>}
 */
export async function archiveTree(dir, sha, outPath) {
  if (sha.startsWith('-')) throw new Error(`invalid commit ${sha}`);
  mkdirSync(dirname(outPath), { recursive: true });
  await git(dir, ['archive', '--format=tar', `--output=${outPath}`, sha]);
  return { path: outPath, sha, bytes: statSync(outPath).size, sha256: sha256Hex(readFileSync(outPath)) };
}
