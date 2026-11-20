import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { inputId } from '../../src/review/input-id.mjs';

export const POLICY = 'p'.repeat(64);
export const MODEL = 'gpt-test';

/**
 * A minimal prepare context plus the four-file analysis artifact, for
 * driving `review validate|publish` with a stubbed validator.
 * @param {string} base directory to write into
 * @param {{ from_sha: string, to_sha: string, branch?: string, result?: string, model?: string, context?: Record<string, unknown> }} o
 * @returns {{ context: string, analysis: string, inputId: string }}
 */
export function writeRunArtifacts(base, o) {
  const model = o.model ?? MODEL;
  const branch = o.branch ?? 'dev';
  const range = { from_sha: o.from_sha, to_sha: o.to_sha, branch_or_pr: `branch:${branch}` };
  const context = { range, branch, policy_digest: POLICY, reviewer: { family: 'openai', model }, reviewers: [{ family: 'openai', model }], groups: [{ id: 'g1' }], changed_lines: {}, commits: [], language: 'en', ...(o.context ?? {}) };
  const ctxDir = join(base, 'ctx');
  const anaDir = join(base, 'analysis');
  mkdirSync(ctxDir, { recursive: true });
  mkdirSync(anaDir, { recursive: true });
  writeFileSync(join(ctxDir, 'context.json'), JSON.stringify(context));
  writeFileSync(join(anaDir, 'result.json'), o.result ?? '{"language":"en","groups":[],"questions":[],"suggestions":[]}\n');
  writeFileSync(join(anaDir, 'resolutions.json'), '[]\n');
  writeFileSync(join(anaDir, 'candidates.json'), '[]\n');
  writeFileSync(join(anaDir, 'usage.json'), JSON.stringify({ model_used: model, attempts: [{ model, exit_code: 0 }], usage: null }));
  return { context: ctxDir, analysis: anaDir, inputId: inputId({ ...range, policy_digest: POLICY, reviewer_family: 'openai', model }) };
}
