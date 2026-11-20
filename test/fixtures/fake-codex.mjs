#!/usr/bin/env node
// Fake `codex exec` for tests: records what it was given next to itself and
// answers with a canned review (or a resolution answer).
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const get = (flag) => args[args.indexOf(flag) + 1];
const configs = args.flatMap((a, i) => (a === '-c' ? [args[i + 1]] : []));
const tree = get('-C');
const outFile = get('--output-last-message');
const model = get('-m');
const prompt = readFileSync(0, 'utf8');
const files = [];
const modes = [];
const walk = (d) => {
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    const st = statSync(p);
    modes.push(st.mode & 0o777);
    if (st.isDirectory()) walk(p);
    else files.push(relative(tree, p));
  }
};
walk(tree);
const record = { home: process.env.HOME, codexHome: process.env.CODEX_HOME, args, configs, cwd: process.cwd(), tree, model, sandbox: get('--sandbox'), envKeys: Object.keys(process.env).sort(), files: files.sort(), writable: modes.some((m) => (m & 0o222) !== 0), hasGit: existsSync(join(tree, '.git')), stdinPrompt: args.at(-1) === '-', resolution: prompt.includes('square² resolution check'), promptHasRangeMarker: prompt.includes('<!-- square2:range -->'), focus: /^## This call reviews group `([^`]+)` only/m.exec(prompt)?.[1] ?? null };
appendFileSync(join(dirname(fileURLToPath(import.meta.url)), 'observed.jsonl'), JSON.stringify(record) + '\n');
if (model === 'gpt-broken' || (model === 'gpt-broken-on-db' && record.focus?.includes('db'))) {
  process.stderr.write('deployment not found\n');
  process.exit(3);
}
process.stdout.write(JSON.stringify({ type: 'thread.started' }) + '\n');
let answer;
if (record.resolution) {
  answer = { status: 'present', evidence: [], resolving_commit: null };
} else {
  const groups = record.focus ? [record.focus] : [...prompt.matchAll(/^### \d+\. `([^`]+)`/gm)].map((m) => m[1]);
  const cache = groups.find((g) => g.includes('add-cache'));
  const finding = { severity: 'Major', path: 'src/cache.ts', line: 1, side: 'RIGHT', title: 'Cache key ignores the tenant', failure_case: 'two tenants with the same id read each other\'s cached rows', suggestion: 'include the tenant in the key', enclosing_symbol: 'cacheKey', mechanizable: true, evidence: ['src/db.ts:1 tenant column'] };
  const heading = /^### commit ([0-9a-f]{40}) /m.exec(prompt);
  if (heading) finding.commit = heading[1].slice(0, 12);
  const reverted = { ...finding, path: 'src/tmp.ts', title: 'Temporary file leaks', enclosing_symbol: '<file>', severity: 'Minor', mechanizable: false };
  answer = {
    language: 'en',
    groups: groups.map((id) => ({
      id,
      requirement: { status: 'pass', summary: 'clear', evidence: ['commit message'] },
      approach: { status: 'pass', summary: 'fine', evidence: ['design'] },
      code: id === cache ? { status: 'needs_changes', summary: 'one defect', findings: heading ? [finding, reverted, { ...reverted, path: 'src/elsewhere.ts', title: 'Elsewhere looks off' }] : [finding, reverted] } : { status: 'pass', summary: 'ok', findings: [] },
    })),
    questions: [],
    suggestions: ['consider a cache metrics counter'],
  };
}
if ((model === 'gpt-leak' || (model === 'gpt-leak-on-db' && record.focus?.includes('db'))) && answer.suggestions) answer.suggestions.push(`debug: ${Buffer.from(process.env.SQ2_AZURE_OPENAI_API_KEY ?? '').toString('base64')}`);
writeFileSync(outFile, '```json\n' + JSON.stringify(answer, null, 2) + '\n```\n');
process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1200, cached_input_tokens: 1000, output_tokens: 300 } }) + '\n');
