export class ClockError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'ClockError';
  }
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

/**
 * @param {unknown} value
 * @returns {value is string}
 */
export function isIsoDate(value) {
  if (typeof value !== 'string') return false;
  const m = ISO_DATE.exec(value);
  if (!m) return false;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return new Date(ms).toISOString().slice(0, 10) === value;
}

/**
 * @param {string} date YYYY-MM-DD
 * @returns {number} UTC epoch day
 */
export function epochDay(date) {
  if (!isIsoDate(date)) throw new ClockError(`invalid ISO date: ${date}`);
  return Date.parse(date + 'T00:00:00Z') / DAY_MS;
}

/**
 * @param {string} from
 * @param {string} to
 * @returns {number} whole days from `from` to `to`
 */
export function daysBetween(from, to) {
  return epochDay(to) - epochDay(from);
}

/**
 * @param {string} date
 * @param {number} days
 * @returns {string}
 */
export function addDays(date, days) {
  return new Date((epochDay(date) + days) * DAY_MS).toISOString().slice(0, 10);
}

/**
 * @param {Date} instant
 * @returns {string} the UTC calendar date of the instant
 */
export function utcDate(instant) {
  const ms = instant.getTime();
  if (!Number.isFinite(ms)) throw new ClockError('invalid instant');
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * The run date: `SQUARE2_TODAY` (YYYY-MM-DD) when set, otherwise the UTC date of `now`.
 * @param {{ env?: Record<string, string | undefined>, now?: Date }} [io]
 * @returns {string}
 */
export function today(io = {}) {
  const env = io.env ?? /** @type {any} */ (globalThis).process?.env ?? {};
  const override = env.SQUARE2_TODAY;
  if (override !== undefined && override !== '') {
    if (!isIsoDate(override)) throw new ClockError(`SQUARE2_TODAY must be YYYY-MM-DD, got ${JSON.stringify(override)}`);
    return override;
  }
  return utcDate(io.now ?? new Date());
}
