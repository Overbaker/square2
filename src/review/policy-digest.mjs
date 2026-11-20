import { canonicalStringify } from '../core/canonical-json.mjs';
import { sha256Hex } from '../core/fingerprint.mjs';

/**
 * Everything that shapes the fixed prompt prefix and the output contract.
 * @typedef {object} Policy
 * @property {string} template prompt template text
 * @property {string} schema output schema text
 * @property {string} reviewContext the repository's review-context.md ('' when absent)
 * @property {{ id: string, instead: string }[]} enforcedRules rules the gate already enforces
 * @property {string[]} triagePatterns known noise patterns
 * @property {string} version square² version
 * @property {Record<string, string>} [extraPrompts] other prompt templates (resolution, candidate)
 */

/**
 * sha256 over the canonical policy. Two runs with the same digest render the
 * same prompt prefix byte for byte.
 * @param {Policy} p
 * @returns {string}
 */
export function policyDigest(p) {
  return sha256Hex(canonicalStringify({
    template: p.template,
    schema: p.schema,
    review_context: p.reviewContext,
    enforced_rules: [...p.enforcedRules].map((r) => ({ id: r.id, instead: r.instead })).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    triage_patterns: [...p.triagePatterns],
    version: p.version,
    extra_prompts: p.extraPrompts ?? {},
  }));
}
