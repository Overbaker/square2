export const DEFAULT_MONTHLY_MINUTES = 600;
export const DEFAULT_WORKFLOWS = Object.freeze(['square2-gate.yml', 'square2-review.yml']);

/**
 * @param {Date} now
 * @returns {{ monthStart: string, day: number, daysInMonth: number, month: string }}
 */
export function monthOf(now) {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const month = `${y}-${String(m + 1).padStart(2, '0')}`;
  return { monthStart: `${month}-01`, day: now.getUTCDate(), daysInMonth: new Date(Date.UTC(y, m + 1, 0)).getUTCDate(), month };
}

/**
 * Pro-rata threshold: monthly × day / days_in_month × 1.2.
 * @param {{ monthly: number, day: number, daysInMonth: number }} t
 * @returns {number}
 */
export function threshold(t) {
  return (t.monthly * t.day / t.daysInMonth) * 1.2;
}

/**
 * Billed minutes of an interval, rounded up (0 for missing or negative).
 * @param {string | null | undefined} start
 * @param {string | null | undefined} end
 * @returns {number}
 */
export function billedMinutes(start, end) {
  if (!start || !end) return 0;
  const ms = Date.parse(end) - Date.parse(start);
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.ceil(ms / 60000);
}

/** Jobs per run of the default workflows (the gate has one job, the review three). */
export const DEFAULT_JOBS = Object.freeze({ 'square2-gate.yml': 1, 'square2-review.yml': 3 });

/**
 * Workflow file name of a run (`.github/workflows/<name>`, an `@ref` suffix ignored).
 * @param {{ path?: string | null }} run
 * @returns {string | null}
 */
export function workflowFile(run) {
  const m = /(?:^|\/)\.github\/workflows\/([^/@]+)(?:@.*)?$/.exec(String(run.path ?? ''));
  return m ? m[1] : null;
}

/**
 * Month-to-date minutes of the named workflows, from one paginated
 * `GET /actions/runs?created=>=<month start>`: per run
 * `ceil((updated_at - run_started_at) / 60s)` times the workflow's jobs per
 * run. No per-run job calls; a workflow without runs counts 0.
 * @param {{ gh: import('./github.mjs').GitHub, workflows: readonly string[], now: Date, jobs?: Record<string, number> }} a
 * @returns {Promise<number>}
 */
export async function monthToDateMinutes(a) {
  const { monthStart } = monthOf(a.now);
  const startMs = Date.parse(`${monthStart}T00:00:00Z`);
  const jobs = /** @type {Record<string, number>} */ ({ ...DEFAULT_JOBS, ...(a.jobs ?? {}) });
  const wanted = new Set(a.workflows);
  let total = 0;
  for (const run of await a.gh.listRuns(monthStart)) {
    const wf = workflowFile(run);
    if (wf === null || !wanted.has(wf)) continue;
    if (Date.parse(run.created_at) < startMs) continue;
    total += billedMinutes(run.run_started_at, run.updated_at) * (Number.isInteger(jobs[wf]) && jobs[wf] > 0 ? jobs[wf] : 1);
  }
  return total;
}

/**
 * Budget settings from config `budget: {monthly_minutes, workflows, jobs}`
 * (`jobs`: jobs per run by workflow file; defaults gate 1, review 3, else 1).
 * @param {Record<string, unknown>} raw
 * @returns {{ monthly: number, workflows: string[], jobs: Record<string, number> }}
 */
export function budgetConfig(raw) {
  const b = /** @type {any} */ (raw.budget);
  const monthly = b && Number.isFinite(b.monthly_minutes) && b.monthly_minutes > 0 ? Number(b.monthly_minutes) : DEFAULT_MONTHLY_MINUTES;
  const workflows = b && Array.isArray(b.workflows) && b.workflows.every((/** @type {unknown} */ w) => typeof w === 'string') && b.workflows.length > 0 ? b.workflows : [...DEFAULT_WORKFLOWS];
  /** @type {Record<string, number>} */
  const jobs = {};
  if (b && b.jobs && typeof b.jobs === 'object') for (const [k, v] of Object.entries(b.jobs)) if (Number.isInteger(v) && Number(v) > 0) jobs[k] = Number(v);
  return { monthly, workflows, jobs };
}

/**
 * Compute usage and, when over the pro-rata threshold, post one warning per
 * day on the state issue.
 * @param {{ gh: import('./github.mjs').GitHub, state: import('./state.mjs').StateIssue, now: Date, monthly: number, workflows: readonly string[], jobs?: Record<string, number> }} a
 * @returns {Promise<{ minutes: number, threshold: number, warned: boolean }>}
 */
export async function checkBudget(a) {
  const minutes = await monthToDateMinutes(a);
  const m = monthOf(a.now);
  const limit = threshold({ monthly: a.monthly, day: m.day, daysInMonth: m.daysInMonth });
  if (minutes <= limit) return { minutes, threshold: limit, warned: false };
  const day = `${m.month}-${String(m.day).padStart(2, '0')}`;
  const marker = `<!-- square2:budget:${day} -->`;
  const shown = Math.round(limit * 10) / 10;
  await a.state.commentOnce(marker, `${marker}\nsquare² budget warning: ${minutes} billed minutes month-to-date (${a.workflows.join(', ')}) exceed the pro-rata threshold ${shown} (${a.monthly} minutes/month, day ${m.day} of ${m.daysInMonth}).\n`);
  return { minutes, threshold: limit, warned: true };
}
