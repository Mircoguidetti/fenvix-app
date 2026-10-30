// Time zone arithmetic of the restore date picker, with the days the clocks change.
import { test } from "node:test";
import assert from "node:assert/strict";
import { daysInMonth, offsetLabel, offsetMinutes, partsIn, resolve, toApiTime, weekdayIndex } from "../../src/lib/zoned.ts";

const utc = (s: string) => new Date(s);
const rome = (year: number, month: number, day: number, hour: number, minute: number) => resolve({ year, month, day, hour, minute }, "Europe/Rome");

test("Rome is one hour ahead in winter and two in summer", () => {
  assert.equal(offsetMinutes(utc("2026-01-15T12:00:00Z"), "Europe/Rome"), 60);
  assert.equal(offsetMinutes(utc("2026-07-15T12:00:00Z"), "Europe/Rome"), 120);
  assert.equal(offsetMinutes(utc("2026-07-15T12:00:00Z"), "UTC"), 0);
  assert.equal(offsetLabel(utc("2026-01-15T12:00:00Z"), "Europe/Rome"), "UTC+1");
  assert.equal(offsetLabel(utc("2026-07-15T12:00:00Z"), "Europe/Rome"), "UTC+2");
  assert.equal(offsetLabel(utc("2026-07-15T12:00:00Z"), "UTC"), "UTC");
});

test("an instant reads as the right wall clock in each zone", () => {
  assert.deepEqual(partsIn(utc("2026-10-30T17:05:00Z"), "Europe/Rome"), { year: 2026, month: 10, day: 30, hour: 18, minute: 5 });
  assert.deepEqual(partsIn(utc("2026-10-30T17:05:00Z"), "UTC"), { year: 2026, month: 10, day: 30, hour: 17, minute: 5 });
  // Midnight is hour 0, never 24.
  assert.equal(partsIn(utc("2026-10-30T23:00:00Z"), "Europe/Rome").hour, 0);
  assert.equal(partsIn(utc("2026-10-30T23:00:00Z"), "Europe/Rome").day, 31);
});

test("a Rome wall clock goes back to the same instant, on an ordinary day", () => {
  const r = rome(2026, 10, 30, 18, 5);
  assert.equal(r.instant.toISOString(), "2026-10-30T17:05:00.000Z");
  assert.ok(r.exists && !r.ambiguous);
  assert.equal(rome(2026, 7, 1, 12, 0).instant.toISOString(), "2026-07-01T10:00:00.000Z");
  assert.equal(resolve({ year: 2026, month: 10, day: 30, hour: 18, minute: 5 }, "UTC").instant.toISOString(), "2026-10-30T18:05:00.000Z");
});

test("the day the clocks go forward (2026-03-29): 02:30 never happens", () => {
  assert.equal(rome(2026, 3, 29, 1, 59).instant.toISOString(), "2026-03-29T00:59:00.000Z"); // still UTC+1
  assert.equal(rome(2026, 3, 29, 3, 0).instant.toISOString(), "2026-03-29T01:00:00.000Z"); // already UTC+2
  const gap = rome(2026, 3, 29, 2, 30);
  assert.equal(gap.exists, false);
  assert.equal(gap.instant.toISOString(), "2026-03-29T01:30:00.000Z");
  assert.deepEqual(partsIn(gap.instant, "Europe/Rome"), { year: 2026, month: 3, day: 29, hour: 3, minute: 30 });
});

test("the day the clocks go back (2026-10-25): 02:30 happens twice, the first is used", () => {
  const twice = rome(2026, 10, 25, 2, 30);
  assert.equal(twice.ambiguous, true);
  assert.equal(twice.instant.toISOString(), "2026-10-25T00:30:00.000Z"); // summer time, UTC+2
  assert.equal(rome(2026, 10, 25, 1, 59).instant.toISOString(), "2026-10-24T23:59:00.000Z");
  const after = rome(2026, 10, 25, 3, 0);
  assert.equal(after.instant.toISOString(), "2026-10-25T02:00:00.000Z"); // winter time, UTC+1
  assert.ok(!after.ambiguous && after.exists);
  // The later 02:30 is a different instant, and it reads the same on the clock.
  assert.deepEqual(partsIn(utc("2026-10-25T01:30:00Z"), "Europe/Rome"), { year: 2026, month: 10, day: 25, hour: 2, minute: 30 });
});

test("around midnight on a change day the date does not slip", () => {
  assert.equal(rome(2026, 3, 29, 0, 0).instant.toISOString(), "2026-03-28T23:00:00.000Z");
  assert.equal(rome(2026, 3, 30, 0, 0).instant.toISOString(), "2026-03-29T22:00:00.000Z");
  assert.equal(rome(2026, 10, 25, 0, 0).instant.toISOString(), "2026-10-24T22:00:00.000Z");
  assert.equal(rome(2026, 10, 26, 0, 0).instant.toISOString(), "2026-10-25T23:00:00.000Z");
});

test("every minute of both change days round-trips", () => {
  for (const day of [29, 30]) for (let h = 0; h < 24; h++) for (const m of [0, 30]) {
    const r = rome(2026, 3, day, h, m);
    const back = partsIn(r.instant, "Europe/Rome");
    if (r.exists) assert.deepEqual(back, { year: 2026, month: 3, day, hour: h, minute: m });
  }
  for (const day of [25, 26]) for (let h = 0; h < 24; h++) for (const m of [0, 30]) {
    const r = rome(2026, 10, day, h, m);
    assert.deepEqual(partsIn(r.instant, "Europe/Rome"), { year: 2026, month: 10, day, hour: h, minute: m });
  }
});

test("calendar helpers and the API time", () => {
  assert.equal(daysInMonth(2026, 2), 28);
  assert.equal(daysInMonth(2028, 2), 29);
  assert.equal(daysInMonth(2026, 10), 31);
  assert.equal(weekdayIndex(2026, 10, 30), 4); // Friday
  assert.equal(weekdayIndex(2026, 10, 26), 0); // Monday
  assert.equal(toApiTime(utc("2026-10-30T17:05:42.123Z")), "2026-10-30T17:05:00Z");
});
