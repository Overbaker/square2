// Workflow templates and square²'s own CI: structural lint (P19, YAML part) and CLI consistency.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { parseConfig } from '../src/cli/config.mjs';
import { budgetConfig } from '../src/issues/budget.mjs';
import { reviewConfig } from '../src/review/prepare.mjs';
import { REPO } from './cli-helpers.mjs';

const T = join(REPO, 'templates', 'consumer');
const read = (/** @type {string} */ p) => readFileSync(p, 'utf8');
const GATE = join(T, '.github', 'workflows', 'square2-gate.yml');
const REVIEW = join(T, '.github', 'workflows', 'square2-review.yml');
const CI = join(REPO, '.github', 'workflows', 'ci.yml');

/**
 * Minimal YAML reader for the subset these workflows use: block maps and
 * lists, `- key: v` list items, block scalars (`|`, `>-`), `[a, b]` and `{}`
 * flow values, quoted and plain scalars, comments.
 * @param {string} src
 * @returns {any}
 */
export function parseYaml(src) {
  const lines = src.split('\n');
  let i = 0;
  const indentOf = (/** @type {string} */ l) => l.length - l.trimStart().length;
  /** @param {string} l */
  const uncomment = (l) => {
    let q = '';
    for (let k = 0; k < l.length; k++) {
      const c = l[k];
      if (q) {
        if (c === q) q = '';
      } else if (c === '"' || c === "'") q = c;
      else if (c === '#' && (k === 0 || /\s/.test(l[k - 1]))) return l.slice(0, k).trimEnd();
    }
    return l.trimEnd();
  };
  const skip = () => {
    while (i < lines.length && uncomment(lines[i]).trim() === '') i++;
  };
  /** @param {string} v */
  const scalar = (v) => {
    const t = v.trim();
    if (t === '{}') return {};
    if (t === '[]') return [];
    if (t.startsWith('[') && t.endsWith(']')) return t.slice(1, -1).split(',').map((x) => scalar(x));
    if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))) return t.slice(1, -1);
    if (t === 'true' || t === 'false') return t === 'true';
    if (/^-?\d+$/.test(t)) return Number(t);
    return t;
  };
  /** @param {number} ind */
  const block = (ind) => {
    /** @type {string[]} */
    const out = [];
    let base = -1;
    while (i < lines.length && (lines[i].trim() === '' || indentOf(lines[i]) > ind)) {
      if (lines[i].trim() !== '' && base < 0) base = indentOf(lines[i]);
      out.push(lines[i].trim() === '' ? '' : lines[i].slice(base));
      i++;
    }
    return out.join('\n').replace(/\n*$/, '\n');
  };
  /** @param {number} ind @returns {any} */
  const node = (ind) => {
    skip();
    if (i >= lines.length) return null;
    const t = uncomment(lines[i]).trim();
    return t === '-' || t.startsWith('- ') ? list(ind) : map(ind);
  };
  /** @param {number} ind */
  const map = (ind) => {
    /** @type {Record<string, any>} */
    const out = {};
    for (;;) {
      skip();
      if (i >= lines.length || indentOf(lines[i]) !== ind) return out;
      const text = uncomment(lines[i]).trim();
      if (text.startsWith('- ')) return out;
      const m = /^("[^"]*"|'[^']*'|[^:]+?):(?:\s+(.*))?$/.exec(text);
      if (!m) throw new Error(`line ${i + 1}: cannot parse ${JSON.stringify(text)}`);
      const key = /** @type {string} */ (scalar(m[1]));
      const rest = (m[2] ?? '').trim();
      i++;
      if (rest === '|' || rest === '|-' || rest === '>' || rest === '>-') {
        const b = block(ind);
        out[key] = rest.startsWith('>') ? b.replace(/\n(?!$)/g, ' ').trim() : b;
      } else if (rest === '') {
        skip();
        out[key] = i < lines.length && indentOf(lines[i]) > ind ? node(indentOf(lines[i])) : null;
      } else out[key] = scalar(rest);
    }
  };
  /** @param {number} ind */
  const list = (ind) => {
    /** @type {any[]} */
    const out = [];
    for (;;) {
      skip();
      if (i >= lines.length || indentOf(lines[i]) !== ind) return out;
      const text = uncomment(lines[i]).trim();
      if (!(text === '-' || text.startsWith('- '))) return out;
      const content = text.slice(1).trim();
      if (content === '') {
        i++;
        skip();
        out.push(node(indentOf(lines[i])));
      } else if (/^("[^"]*"|'[^']*'|[^'"{[][^:]*?):(\s|$)/.test(content)) {
        lines[i] = ' '.repeat(ind + 2) + content;
        out.push(map(ind + 2));
      } else {
        out.push(scalar(content));
        i++;
      }
    }
  };
  return node(0);
}

const gate = parseYaml(read(GATE));
const review = parseYaml(read(REVIEW));
const ci = parseYaml(read(CI));
const steps = (/** @type {any} */ job) => /** @type {any[]} */ (job.steps ?? []);
const text = (/** @type {any} */ v) => JSON.stringify(v);

test('the YAML reader handles the constructs the templates use', () => {
  const y = parseYaml("a: 1 # c\nb:\n  - x\n  - k: v\n    l: '#not'\nc: |\n  echo 1 # kept\n  two\nd: [p, q]\ne: {}\nf: >-\n  one\n  two\n");
  assert.deepEqual(y, { a: 1, b: ['x', { k: 'v', l: '#not' }], c: 'echo 1 # kept\ntwo\n', d: ['p', 'q'], e: {}, f: 'one two' });
  assert.equal(review.jobs.analyze.permissions && Object.keys(review.jobs.analyze.permissions).length, 0);
});

test('P19: the analyze job has permissions: {}, no checkout, no GitHub token; guard-env runs before the model', () => {
  const a = review.jobs.analyze;
  assert.deepEqual(a.permissions, {}, 'permissions: {}');
  assert.ok(!steps(a).some((s) => typeof s.uses === 'string' && s.uses.startsWith('actions/checkout@')), 'no checkout');
  assert.doesNotMatch(text(a), /GITHUB_TOKEN|GH_TOKEN|github\.token|ACTIONS_RUNTIME_TOKEN/, 'no GitHub token reference');
  const runs = steps(a).map((s) => String(s.run ?? ''));
  const guard = runs.findIndex((r) => /square2\.mjs review guard-env/.test(r));
  const model = runs.findIndex((r) => /square2\.mjs review run /.test(r));
  assert.ok(guard >= 0 && model > guard, 'guard-env before review run');
  assert.ok(runs.some((r) => /npm install --global --ignore-scripts @openai\/codex@0\.171\.0$/.test(r.trim())), 'pinned codex');
  const run = steps(a)[model];
  assert.deepEqual(Object.keys(run.env).sort(), ['SQ2_AZURE_OPENAI_API_KEY', 'SQ2_AZURE_OPENAI_ENDPOINT', 'SQ2_REVIEW_FALLBACK_MODEL', 'SQ2_REVIEW_MODEL']);
  assert.equal(run.env.SQ2_AZURE_OPENAI_API_KEY, '${{ secrets.SQ2_AZURE_OPENAI_API_KEY }}');
  assert.equal(run.env.SQ2_AZURE_OPENAI_ENDPOINT, '${{ vars.SQ2_AZURE_OPENAI_ENDPOINT }}');
  assert.equal(a.if, "needs.prepare.outputs.skip == 'false'");
  const upload = steps(a).find((s) => String(s.uses).startsWith('actions/upload-artifact@'));
  assert.deepEqual(upload.with.path.trim().split('\n').map((/** @type {string} */ p) => p.trim()), ['square2-analysis/result.json', 'square2-analysis/result.call-*.json', 'square2-analysis/resolutions.json', 'square2-analysis/candidates.json', 'square2-analysis/usage.json'], 'only the analysis files publish trusts');
});

test('secrets are referenced only in the analyze job (and CI\'s word list); tokens only where issues are read or written', () => {
  for (const [name, wf] of /** @type {[string, any][]} */ ([['gate', gate], ['review', review], ['ci', ci]])) {
    for (const [id, job] of Object.entries(wf.jobs)) {
      const t = text(job);
      if (name === 'ci') assert.doesNotMatch(t, /secrets\.(?!SQ2_FORBIDDEN_PATTERN\b)/, 'ci uses only the word-list secret');
      else if (!(name === 'review' && id === 'analyze')) assert.doesNotMatch(t, /secrets\./, `${name}.${id} references no secret`);
      const token = /github\.token|GITHUB_TOKEN|secrets\.GITHUB_TOKEN/.test(t);
      const may = (name === 'gate' && id === 'publish') || (name === 'review' && (id === 'prepare' || id === 'publish'));
      if (!may) assert.ok(!token, `${name}.${id} has no GitHub token`);
    }
  }
  const tokenSteps = steps(gate.jobs.publish).filter((s) => text(s).includes('GITHUB_TOKEN'));
  assert.equal(tokenSteps.length, 1, 'the gate token is in the publish-gate step only');
  assert.match(String(tokenSteps[0].run), /publish-gate/);
  assert.doesNotMatch(read(REVIEW).replace(/^\s*#.*$/gm, ''), /secrets\.(?!SQ2_AZURE_OPENAI_API_KEY\b)/);
});

test('permissions per job: check read-only, publish jobs issues: write, review prepare issues: read', () => {
  assert.deepEqual(gate.permissions, {});
  assert.deepEqual(review.permissions, {});
  assert.deepEqual(gate.jobs.check.permissions, { contents: 'read' });
  assert.deepEqual(gate.jobs.publish.permissions, { contents: 'read', issues: 'write' });
  assert.deepEqual(review.jobs.prepare.permissions, { contents: 'read', issues: 'read' });
  assert.deepEqual(review.jobs.publish.permissions, { contents: 'read', issues: 'write', actions: 'read' });
  for (const job of [gate.jobs.check, gate.jobs.publish, review.jobs.prepare, review.jobs.publish]) {
    for (const s of steps(job).filter((x) => String(x.uses).startsWith('actions/checkout@'))) assert.equal(s.with['persist-credentials'], false);
  }
  assert.equal(steps(gate.jobs.check).find((s) => String(s.uses).startsWith('actions/checkout@')).with['fetch-depth'], 0);
  assert.equal(steps(review.jobs.prepare).find((s) => String(s.uses).startsWith('actions/checkout@')).with['fetch-depth'], 0);
  assert.equal(steps(review.jobs.publish).find((s) => String(s.uses).startsWith('actions/checkout@')).with['fetch-depth'], 0);
});

test('every uses: is pinned to a full commit SHA with a version comment (commented examples too)', () => {
  for (const file of [GATE, REVIEW, CI]) {
    const uses = read(file).split('\n').filter((l) => /^\s*#?\s*-?\s*uses:/.test(l));
    assert.ok(uses.length > 0, file);
    for (const l of uses) assert.match(l, /uses: [\w.-]+\/[\w.-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/, `${file}: ${l.trim()}`);
  }
});

test('concurrency: gate checks cancel per ref; gate publications and reviews each run one at a time, never cancelled', () => {
  assert.equal(gate.concurrency, undefined, 'no workflow-level group: cancelling a check must not cancel a publication');
  assert.deepEqual(gate.jobs.check.concurrency, { group: 'square2-gate-${{ github.ref }}', 'cancel-in-progress': true });
  assert.deepEqual(gate.jobs.publish.concurrency, { group: 'square2-gate-publish-${{ github.repository }}', 'cancel-in-progress': false });
  assert.equal(gate.jobs.publish.needs, 'check');
  assert.deepEqual(review.concurrency, { group: 'square2-review-${{ github.repository }}', 'cancel-in-progress': false }, 'the review: the only writer of the state body');
  for (const job of Object.values(review.jobs)) assert.equal(/** @type {any} */ (job).concurrency, undefined, 'no job-level group inside the review (it would wait on itself)');
  assert.notEqual(gate.jobs.publish.concurrency.group, review.concurrency.group, 'gate publications never queue behind a review');
});

test('no ${{ inputs.* }} or event text is interpolated into a run script; dispatch range inputs go together', () => {
  for (const [name, wf] of /** @type {[string, any][]} */ ([['gate', gate], ['review', review], ['ci', ci]])) {
    for (const [id, job] of Object.entries(wf.jobs)) {
      for (const st of steps(job)) {
        if (typeof st.run === 'string') assert.doesNotMatch(st.run, /\$\{\{/, `${name}.${id}: ${st.name ?? st.run.slice(0, 40)} uses env, not expressions`);
      }
    }
  }
  const prep = String(steps(review.jobs.prepare).find((s) => s.id === 'prepare').run);
  for (const line of ['if [ -n "$FROM" ] && [ -n "$TO" ]; then', 'set -- "$@" --from "$FROM" --to "$TO"', 'elif [ -n "$FROM" ] || [ -n "$TO" ]; then', 'echo "::error::the inputs from and to go together: give both for an explicit range, or neither"']) {
    assert.ok(prep.includes(line), line);
  }
  assert.ok(prep.indexOf('exit 1') > prep.indexOf('elif') && prep.indexOf('exit 1') < prep.indexOf('node tools/square2'), 'one input alone fails before prepare runs');
  const env = steps(review.jobs.prepare).find((s) => s.id === 'prepare').env;
  assert.equal(env.FROM, '${{ inputs.from }}');
  assert.equal(env.TO, '${{ inputs.to }}');
});

test('the review reviews the configured branch: prepare resolves it with config get, publish checks it out', () => {
  assert.equal(review.jobs.prepare.if, "github.event_name == 'workflow_dispatch' || vars.SQ2_REVIEW_ENABLED == 'true'", 'dispatch works while disabled (pilot); the schedule needs the variable');
  const branch = steps(review.jobs.prepare).find((s) => s.id === 'branch');
  assert.match(branch.run, /node tools\/square2\/bin\/square2\.mjs config get branch/);
  assert.match(branch.run, /git check-ref-format --branch "\$branch"/);
  assert.match(branch.run, /git checkout --quiet --detach "refs\/remotes\/origin\/\$branch"/);
  const ids = steps(review.jobs.prepare).map((s) => s.id ?? s.uses ?? s.name);
  assert.ok(ids.indexOf('branch') < ids.indexOf('prepare'));
  assert.equal(steps(review.jobs.prepare).find((s) => s.id === 'prepare').env.BRANCH, '${{ steps.branch.outputs.branch }}');
  assert.equal(review.jobs.prepare.outputs.branch, '${{ steps.branch.outputs.branch }}');
  assert.equal(steps(review.jobs.publish).find((s) => String(s.uses).startsWith('actions/checkout@')).with.ref, '${{ needs.prepare.outputs.branch }}');
});

test('CONSUMER examples: full pnpm install with the store cache, pinned setup-uv, ruff pinned in the config, expected minutes', () => {
  const g = read(GATE);
  assert.match(g, /# - run: pnpm install --frozen-lockfile\n/);
  assert.match(g, /#     cache: pnpm/);
  assert.match(g, /# - run: pnpm -r build/);
  assert.match(g, /# - uses: astral-sh\/setup-uv@[0-9a-f]{40} # v\d+\.\d+\.\d+/);
  assert.match(g, /#         - uvx\n\s+#         - ruff==<version>/);
  assert.doesNotMatch(g, /uv sync/, 'no full workspace sync for ruff');
  assert.match(g, /Expected minutes:/);
});

test('P19: gate publishing is guarded by push (to the configured branch) or the test input; checks run everywhere', () => {
  const on = gate.on;
  assert.deepEqual(on.push['paths-ignore'], ['docs/**', 'openspec/**', 'ref/**', '**/*.md']);
  assert.deepEqual(on.pull_request['paths-ignore'], on.push['paths-ignore']);
  assert.equal(on.workflow_dispatch.inputs.test.type, 'boolean');
  assert.equal(gate.jobs.check.if, "vars.SQ2_GATE_ENABLED == 'true'");
  assert.equal(gate.jobs.check['timeout-minutes'], 6);
  const guard = gate.jobs.publish.if;
  assert.match(guard, /vars\.SQ2_GATE_ENABLED == 'true'/);
  assert.match(guard, /\(github\.event_name == 'push' \|\| \(github\.event_name == 'workflow_dispatch' && inputs\.test\)\)/);
  assert.doesNotMatch(guard, /pull_request/, 'pull requests never publish');
  const publish = String(steps(gate.jobs.publish).find((s) => /publish-gate/.test(String(s.run))).run);
  assert.match(publish, /if \[ "\$TEST" = true \]; then\n\s+node tools\/square2\/bin\/square2\.mjs publish-gate --report square2-report\.json --branch "\$BRANCH" --test --nonce "\$RUN_ID"/);
  const check = String(steps(gate.jobs.check).find((s) => s.id === 'gate').run);
  assert.match(check, /check --format=github --base "\$base" --report square2-report\.json/);
  assert.match(check, /git merge-base "\$PR_BASE" HEAD/);
  assert.doesNotMatch(text(gate.jobs.check), /\$\{\{ (?:github\.event\.(?!before|pull_request\.base\.sha)|inputs\.)/, 'no untrusted expression interpolated into run scripts');
});

test('review workflow: schedule, dispatch range, skip wiring, publish downloads the context from prepare', () => {
  assert.deepEqual(review.on.schedule, [{ cron: '0 1 * * *' }]);
  assert.deepEqual(Object.keys(review.on.workflow_dispatch.inputs), ['from', 'to']);
  assert.equal(review.jobs.prepare.outputs.skip, '${{ steps.prepare.outputs.skip }}');
  const up = steps(review.jobs.prepare).find((s) => String(s.uses).startsWith('actions/upload-artifact@'));
  assert.equal(up.with.name, 'square2-review');
  assert.deepEqual(up.with.path.trim().split('\n').map((/** @type {string} */ p) => p.trim()), ['square2-review/', 'tools/square2/'], 'the vendored runner travels with the context');
  assert.deepEqual(review.jobs.publish.needs, ['prepare', 'analyze']);
  const dl = steps(review.jobs.publish).filter((s) => String(s.uses).startsWith('actions/download-artifact@')).map((s) => s.with);
  assert.deepEqual(dl.map((w) => [w.name, w.path]), [['square2-review', 'prepared'], ['square2-analysis', 'square2-analysis']]);
  const runs = steps(review.jobs.publish).map((s) => String(s.run ?? ''));
  assert.ok(runs.some((r) => r.trim() === 'node tools/square2/bin/square2.mjs review publish --context prepared/square2-review --analysis square2-analysis'));
  assert.ok(runs.some((r) => r.trim() === 'node tools/square2/bin/square2.mjs budget'));
  assert.ok(dl.every((w) => typeof w.path === 'string' && w.path !== '.' && w.path !== ''), 'artifacts never land over the checkout: publish runs its own checkout\'s runner');
});

test('every square2 command in the templates and the hook exists in the CLI', () => {
  const usage = read(join(REPO, 'src', 'cli', 'main.mjs'));
  const sources = [read(GATE), read(REVIEW), read(join(T, '.githooks', 'pre-push'))];
  const calls = sources.flatMap((s) => [...s.matchAll(/square2\.mjs ((?:review )?[a-z-]+)/g)].map((m) => m[1]));
  assert.ok(calls.length >= 8, calls.join(', '));
  for (const c of new Set(calls)) assert.ok(new RegExp(`^  ${c}\\b`, 'm').test(usage), `square2 ${c} is a command`);
  const flags = sources.flatMap((s) => [...s.matchAll(/square2\.mjs [^\n]*/g)].flatMap((m) => [...m[0].matchAll(/ (--[a-z-]+)/g)].map((f) => f[1])));
  for (const f of new Set(flags)) assert.ok(usage.includes(`${f} `) || usage.includes(`${f}]`) || usage.includes(`${f}=`) || /--nonce/.test(f), `flag ${f}`);
  assert.match(read(join(REPO, 'src', 'cli', 'publish-cmd.mjs')), /nonce: \{ type: 'string' \}/, 'publish-gate --nonce');
});

test('consumer templates: config parses, pre-push hook is executable and aborts on failure, README states advisory', () => {
  const cfg = parseConfig(read(join(T, '.square2', 'config.yaml')));
  assert.deepEqual(cfg.diagnostics, []);
  assert.deepEqual(reviewConfig(cfg.config.raw).errors, []);
  assert.deepEqual(budgetConfig(cfg.config.raw).jobs, {}, 'one job per run by default');
  const hook = join(T, '.githooks', 'pre-push');
  assert.ok((statSync(hook).mode & 0o111) !== 0, 'executable');
  const h = read(hook);
  assert.match(h, /^#!\/bin\/sh\n/);
  assert.match(h, /while read -r local_ref local_sha remote_ref remote_sha; do/);
  assert.match(h, /check --rev "\$local_sha" --base "\$base"/);
  assert.doesNotMatch(h, /--report/, 'the hook writes no report');
  assert.match(h, /if \[ "\$status" -ne 0 \]; then[\s\S]*exit 1/);
  const readme = read(join(T, '.square2', 'README.md'));
  for (const w of ['advisory', '--no-verify', 'Threat model']) assert.ok(readme.includes(w), w);
  assert.ok(read(join(T, '.square2', 'review-context.md')).length > 0);
});

test('square²\'s own CI: node 22, npm ci, typecheck, test, agnosticism grep from a masked secret', () => {
  const job = ci.jobs.test;
  const runs = steps(job).map((s) => String(s.run ?? '').trim());
  for (const r of ['npm ci', 'npm run typecheck', 'npm test']) assert.ok(runs.includes(r), r);
  assert.equal(steps(job).find((s) => String(s.uses).startsWith('actions/setup-node@')).with['node-version'], 22);
  const grep = steps(job).find((s) => s.name === 'agnosticism grep');
  assert.equal(grep.env.FORBIDDEN, '${{ secrets.SQ2_FORBIDDEN_PATTERN }}');
  assert.equal(grep.if, "env.HAS_FORBIDDEN_PATTERN == 'true'", 'skipped when the secret is empty (forks)');
  assert.equal(job.env.HAS_FORBIDDEN_PATTERN, "${{ secrets.SQ2_FORBIDDEN_PATTERN != '' }}");
  assert.match(grep.run, /case "\$status" in\n\s+1\)[^\n]*;;\n\s+0\)[\s\S]*exit 1[\s\S]*\*\)[\s\S]*exit 1/, '1 = clean, 0 = match fails, anything else fails');
  // the decision table itself, with a real git grep
  const sh = (/** @type {string} */ pattern) => spawnSync('bash', ['-c', `${grep.run}`], { cwd: REPO, encoding: 'utf8', env: { ...process.env, FORBIDDEN: pattern } }).status;
  assert.equal(sh('zq{3}k[0-9]{2}w'), 0, 'no match passes');
  assert.equal(sh('square'), 1, 'a match fails');
  assert.equal(sh('('), 1, 'an invalid pattern fails');
  assert.deepEqual(ci.permissions, { contents: 'read' });
});
