import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import { addDays, today } from '../src/core/clock.mjs';
import { isExpired, splitByExpiry, validateExceptions } from '../src/core/exceptions.mjs';

const DAY = 86_400_000;
const RULES = ['S2-R-A', 'S2-R-B'];

/** @param {number} ms */
const refUtcDate = (ms) => new Date(Math.floor(ms / DAY) * DAY).toISOString().slice(0, 10);

/** @param {number} minutes signed offset */
function offsetText(minutes) {
  const sign = minutes < 0 ? '-' : '+';
  const a = Math.abs(minutes);
  return `${sign}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
}

/** P6 body; runs in-process and in child processes with a different TZ. */
export function runP6() {
  const start = Date.UTC(2026, 0, 1);
  fc.assert(
    fc.property(
      fc.integer({ min: 0, max: 3 * 365 * 24 * 60 }),
      fc.integer({ min: -14 * 60, max: 14 * 60 }),
      fc.integer({ min: -1, max: 1 }),
      (minuteOfRange, tzMinutes, delta) => {
        const instant = start + minuteOfRange * 60_000;
        const wall = new Date(instant + tzMinutes * 60_000).toISOString().slice(0, 16);
        const local = new Date(`${wall}:00${offsetText(tzMinutes)}`);
        assert.equal(local.getTime(), instant);

        const runDate = today({ env: {}, now: local });
        assert.equal(runDate, refUtcDate(instant));

        const expires = addDays(runDate, delta);
        const exc = { id: 'E-1', rule_id: 'S2-R-A', scope: 'src/x.ts', reason: 'r', owner: 'o', adr: 'a', created_at: addDays(expires, -30), expires_at: expires };
        const expired = isExpired(exc, runDate);
        assert.equal(expired, delta === -1);
        const { live, diagnostics } = splitByExpiry(validateExceptions([exc], { ruleIds: RULES, today: runDate }).valid, runDate);
        assert.equal(live.length, delta === -1 ? 0 : 1);
        assert.equal(diagnostics.length, delta === -1 ? 1 : 0);
        if (expired) assert.ok(diagnostics[0].startsWith('[S2-EXC-EXPIRED] E-1 '));

        assert.equal(today({ env: { SQUARE2_TODAY: expires }, now: local }), expires);
      },
    ),
    { numRuns: 300 },
  );
}


if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runP6();
  process.stdout.write(`ok offset=${new Date(Date.UTC(2026, 5, 1)).getTimezoneOffset()}\n`);
}
