/**
 * Dates in a named time zone (Europe/Rome or UTC) without a library: the browser's Intl knows the rules, including
 * the days the clocks change. Everything is an instant (a Date, UTC) underneath; the zone only decides how it reads.
 */
export type Zone = "Europe/Rome" | "UTC";

export interface Parts {
  year: number;
  month: number; // 1 to 12
  day: number;
  hour: number;
  minute: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(zone: Zone) {
  let f = formatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-GB", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" });
    formatters.set(zone, f);
  }
  return f;
}

/** The wall clock of an instant in a zone. */
export function partsIn(instant: Date, zone: Zone): Parts {
  const out: Record<string, number> = {};
  for (const p of formatter(zone).formatToParts(instant)) if (p.type !== "literal") out[p.type] = Number(p.value);
  return { year: out.year, month: out.month, day: out.day, hour: out.hour % 24, minute: out.minute };
}

/** Minutes the zone is ahead of UTC at an instant (60 or 120 in Rome, 0 in UTC). */
export function offsetMinutes(instant: Date, zone: Zone): number {
  const p = partsIn(instant, zone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  return Math.round((asUtc - Math.floor(instant.getTime() / 60000) * 60000) / 60000);
}

/** "UTC+1", "UTC+2" or "UTC". */
export function offsetLabel(instant: Date, zone: Zone): string {
  const m = offsetMinutes(instant, zone);
  if (m === 0) return "UTC";
  const h = Math.floor(Math.abs(m) / 60);
  const r = Math.abs(m) % 60;
  return `UTC${m > 0 ? "+" : "-"}${h}${r ? `:${String(r).padStart(2, "0")}` : ""}`;
}

export interface Resolved {
  instant: Date;
  /** False when the clock never showed this time (the hour skipped at the spring change): the instant is the next valid minute. */
  exists: boolean;
  /** True when the clock showed this time twice (the hour repeated at the autumn change): the earlier one is used. */
  ambiguous: boolean;
}

/** The instant at which a zone's wall clock reads these parts. */
export function resolve(p: Parts, zone: Zone): Resolved {
  const naive = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  if (zone === "UTC") return { instant: new Date(naive), exists: true, ambiguous: false };
  // Both offsets the zone may have around that day: an instant matches when the clock there shows the wanted time.
  const candidates = new Set<number>();
  for (const probe of [naive - 86400000, naive, naive + 86400000]) candidates.add(offsetMinutes(new Date(probe), zone));
  const matches = [...candidates]
    .map((off) => new Date(naive - off * 60000))
    .filter((d) => {
      const q = partsIn(d, zone);
      return q.year === p.year && q.month === p.month && q.day === p.day && q.hour === p.hour && q.minute === p.minute;
    })
    .sort((a, b) => a.getTime() - b.getTime());
  if (matches.length > 0) return { instant: matches[0], exists: true, ambiguous: matches.length > 1 };
  // The skipped hour: the clock jumped over it. Use the offset from before the jump, which lands just after it.
  const before = offsetMinutes(new Date(naive - 86400000), zone);
  return { instant: new Date(naive - before * 60000), exists: false, ambiguous: false };
}

/** Days in a month (month 1 to 12). */
export const daysInMonth = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();

/** 0 for Monday to 6 for Sunday: the column of a date in a week that starts on Monday. */
export const weekdayIndex = (year: number, month: number, day: number) => (new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7;

/** "2026-10-30T17:05:00Z": what the API takes (seconds are always 00). */
export const toApiTime = (instant: Date) => `${instant.toISOString().slice(0, 16)}:00Z`;
