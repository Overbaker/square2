import { canonicalStringify } from '../core/canonical-json.mjs';
import { sha256Hex } from '../core/fingerprint.mjs';

/**
 * @typedef {object} InputIdFields
 * @property {string | null} from_sha
 * @property {string} to_sha
 * @property {string} branch_or_pr `branch:<name>` or `pr:<number>`
 * @property {string} policy_digest
 * @property {string} reviewer_family
 * @property {string} model
 */

/**
 * sha256 of exactly the six fields that define a review input. Anything else
 * passed in (a moving PR base, timestamps) does not change it.
 * @param {InputIdFields & Record<string, unknown>} f
 * @returns {string}
 */
export function inputId(f) {
  const fields = [f.from_sha ?? null, f.to_sha, f.branch_or_pr, f.policy_digest, f.reviewer_family, f.model];
  for (const [i, v] of fields.entries()) {
    if (i === 0 ? !(v === null || typeof v === 'string') : typeof v !== 'string' || v === '') throw new TypeError('inputId: missing field');
  }
  return sha256Hex(canonicalStringify(fields));
}
