import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Segmented } from "./Segmented";
import { daysInMonth, offsetLabel, partsIn, resolve, weekdayIndex, type Parts, type Zone } from "../lib/zoned";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const WEEKDAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const pad = (n: number) => String(n).padStart(2, "0");
const key = (p: { year: number; month: number; day: number }) => p.year * 10000 + p.month * 100 + p.day;
const ZONES: { value: Zone; label: string }[] = [
  { value: "Europe/Rome", label: "Rome" },
  { value: "UTC", label: "UTC" },
];

/**
 * A date and time picker of our own (not the browser's): a month calendar whose unavailable days are grey, hour and
 * minute fields, a Rome / UTC switch, and a slider for fine tuning. The value is an instant (a Date, UTC); the zone
 * only decides how it is read and typed. Days before `min` and after `max` cannot be chosen, and neither can times.
 */
export function DateTimePicker({ value, onChange, min, max, minNote }: { value: Date; onChange: (d: Date) => void; min: Date; max: Date; /** Why earlier days are unavailable, as a sentence. */ minNote?: string }) {
  const uid = useId();
  const [zone, setZone] = useState<Zone>("Europe/Rome");
  const p = partsIn(value, zone);
  const minP = partsIn(min, zone);
  const maxP = partsIn(max, zone);
  const [view, setView] = useState({ year: p.year, month: p.month });
  const [hourText, setHourText] = useState(pad(p.hour));
  const [minuteText, setMinuteText] = useState(pad(p.minute));
  const [notice, setNotice] = useState<string | null>(null);
  const [focusKey, setFocusKey] = useState<number | null>(null);
  const grid = useRef<HTMLDivElement>(null);

  // The fields and the month follow the value when something else than typing changes it (a day, the slider, the zone).
  const valueMs = value.getTime();
  useEffect(() => {
    const q = partsIn(new Date(valueMs), zone);
    setHourText(pad(q.hour));
    setMinuteText(pad(q.minute));
    setView({ year: q.year, month: q.month });
  }, [valueMs, zone]);

  useEffect(() => {
    if (focusKey === null) return;
    grid.current?.querySelector<HTMLElement>(`[data-day="${focusKey}"]`)?.focus();
    setFocusKey(null);
  }, [focusKey, view]);

  /** Takes a wall clock in the chosen zone, keeps it inside the allowed range, and reports it. */
  function commit(next: Parts) {
    const r = resolve(next, zone);
    let at = r.instant;
    let note: string | null = null;
    if (at < min) (at = min), (note = "That is before this database existed. The earliest time is used.");
    else if (at > max) (at = max), (note = "That is in the future. The latest time is used.");
    else if (!r.exists) note = `The clocks in Rome skip this time. ${pad(partsIn(at, zone).hour)}:${pad(partsIn(at, zone).minute)} is used.`;
    else if (r.ambiguous) note = "This time happens twice in Rome, when the clocks go back. The first one is used.";
    setNotice(note);
    onChange(at);
  }

  function typed(kind: "hour" | "minute", text: string) {
    const clean = text.replace(/\D/g, "").slice(0, 2);
    kind === "hour" ? setHourText(clean) : setMinuteText(clean);
    const h = kind === "hour" ? clean : hourText;
    const m = kind === "minute" ? clean : minuteText;
    if (h.length > 0 && m.length > 0 && Number(h) <= 23 && Number(m) <= 59) commit({ ...p, hour: Number(h), minute: Number(m) });
  }
  const settle = () => {
    setHourText(pad(p.hour));
    setMinuteText(pad(p.minute));
  };

  const dayOff = (year: number, month: number, day: number) => key({ year, month, day }) < key(minP) || key({ year, month, day }) > key(maxP);
  const monthOff = (delta: -1 | 1) => {
    const y = view.year + (view.month + delta > 12 ? 1 : view.month + delta < 1 ? -1 : 0);
    const m = ((view.month + delta + 11) % 12) + 1;
    return delta < 0 ? key({ year: y, month: m, day: daysInMonth(y, m) }) < key(minP) : key({ year: y, month: m, day: 1 }) > key(maxP);
  };
  const step = (delta: -1 | 1) => setView((v) => ({ year: v.year + (v.month + delta > 12 ? 1 : v.month + delta < 1 ? -1 : 0), month: ((v.month + delta + 11) % 12) + 1 }));

  function moveFocus(from: { year: number; month: number; day: number }, days: number) {
    const t = new Date(Date.UTC(from.year, from.month - 1, from.day + days));
    let to = { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() };
    if (key(to) < key(minP)) to = { year: minP.year, month: minP.month, day: minP.day };
    if (key(to) > key(maxP)) to = { year: maxP.year, month: maxP.month, day: maxP.day };
    setView({ year: to.year, month: to.month });
    setFocusKey(key(to));
  }
  function onDayKey(e: KeyboardEvent, d: number) {
    const from = { year: view.year, month: view.month, day: d };
    const by: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7, Home: -weekdayIndex(from.year, from.month, d), End: 6 - weekdayIndex(from.year, from.month, d) };
    if (e.key in by) (e.preventDefault(), moveFocus(from, by[e.key]));
    else if (e.key === "PageUp" || e.key === "PageDown") {
      e.preventDefault();
      const t = new Date(Date.UTC(from.year, from.month - 1 + (e.key === "PageUp" ? -1 : 1), 1));
      moveFocus({ year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: Math.min(d, daysInMonth(t.getUTCFullYear(), t.getUTCMonth() + 1)) }, 0);
    }
  }

  const first = weekdayIndex(view.year, view.month, 1);
  const count = daysInMonth(view.year, view.month);
  const prevCount = daysInMonth(view.month === 1 ? view.year - 1 : view.year, view.month === 1 ? 12 : view.month - 1);
  const cells = Math.ceil((first + count) / 7) * 7;
  const selectedKey = key(p);
  const todayKey = key(maxP);

  const zoneLine =
    zone === "Europe/Rome"
      ? `Europe/Rome, ${offsetLabel(value, zone)}. That is ${pad(partsIn(value, "UTC").hour)}:${pad(partsIn(value, "UTC").minute)} UTC.`
      : `UTC. That is ${pad(partsIn(value, "Europe/Rome").hour)}:${pad(partsIn(value, "Europe/Rome").minute)} in Rome (${offsetLabel(value, "Europe/Rome")}).`;
  const when = (d: Date) => {
    const q = partsIn(d, zone);
    return `${pad(q.hour)}:${pad(q.minute)}`;
  };
  const sameDay = key(minP) === key(maxP);
  const edge = (d: Date) => {
    const q = partsIn(d, zone);
    return sameDay ? when(d) : `${MONTHS[q.month - 1].slice(0, 3)} ${q.day}, ${when(d)}`;
  };
  const summaryDay = WEEKDAY_NAMES[weekdayIndex(p.year, p.month, p.day)];

  return (
    <div className="dt">
      <section className="dt-cal" aria-label="Date">
        <div className="dt-month">
          <span id={`${uid}-m`} className="dt-month-name" aria-live="polite">
            {MONTHS[view.month - 1]} {view.year}
          </span>
          <span className="dt-nav">
            <button type="button" className="icon-btn" aria-label="Previous month" disabled={monthOff(-1)} onClick={() => step(-1)}>
              <ChevronLeft size={16} strokeWidth={2} aria-hidden="true" />
            </button>
            <button type="button" className="icon-btn" aria-label="Next month" disabled={monthOff(1)} onClick={() => step(1)}>
              <ChevronRight size={16} strokeWidth={2} aria-hidden="true" />
            </button>
          </span>
        </div>
        <div className="dt-week" aria-hidden="true">
          {WEEKDAYS.map((d) => (
            <span key={d}>{d}</span>
          ))}
        </div>
        <div className="dt-grid" ref={grid} role="group" aria-labelledby={`${uid}-m`}>
          {Array.from({ length: cells }, (_, i) => {
            const day = i - first + 1;
            if (day < 1) return <span key={i} className="dt-day dt-fill" aria-hidden="true">{prevCount + day}</span>;
            if (day > count) return <span key={i} className="dt-day dt-fill" aria-hidden="true">{day - count}</span>;
            const k = key({ year: view.year, month: view.month, day });
            const off = dayOff(view.year, view.month, day);
            const sel = k === selectedKey;
            return (
              <button key={i} type="button" className="dt-day" data-day={k} data-today={k === todayKey || undefined} disabled={off} aria-pressed={sel} aria-label={`${MONTHS[view.month - 1]} ${day}, ${view.year}`} onKeyDown={(e) => onDayKey(e, day)} onClick={() => commit({ year: view.year, month: view.month, day, hour: p.hour, minute: p.minute })}>
                {day}
              </button>
            );
          })}
        </div>
        <p className="help">{minNote ?? "Grey days are outside the time this database can be restored to."}</p>
      </section>

      <section className="dt-time" aria-label="Time">
        <div className="dt-block">
          <span className="dt-label" id={`${uid}-t`}>
            Time
          </span>
          <div className="dt-clock" role="group" aria-labelledby={`${uid}-t`}>
            <input aria-label="Hour" className="mono dt-num" inputMode="numeric" autoComplete="off" value={hourText} onChange={(e) => typed("hour", e.target.value)} onBlur={settle} />
            <span aria-hidden="true" className="dt-colon">
              :
            </span>
            <input aria-label="Minute" className="mono dt-num" inputMode="numeric" autoComplete="off" value={minuteText} onChange={(e) => typed("minute", e.target.value)} onBlur={settle} />
            <Segmented label="Time zone" value={zone} options={ZONES} onChange={(z) => (setNotice(null), setZone(z))} />
          </div>
          <span className="help">{zoneLine}</span>
          {notice && (
            <p className="message-warning small" role="status">
              {notice}
            </p>
          )}
        </div>
        <div className="dt-block">
          <label className="dt-label" htmlFor={`${uid}-r`}>
            Fine tune
          </label>
          <input id={`${uid}-r`} type="range" className="dt-range" min={Math.ceil(min.getTime() / 60000)} max={Math.floor(max.getTime() / 60000)} step={1} value={Math.floor(valueMs / 60000)} aria-valuetext={`${edge(value)} ${zone === "UTC" ? "UTC" : "Rome"}`} onChange={(e) => (setNotice(null), onChange(new Date(Number(e.target.value) * 60000)))} />
          <div className="dt-ends mono">
            <span>{edge(min)}</span>
            <span>{edge(max)}</span>
          </div>
          <span className="help">From the creation of the database to now.</span>
        </div>
      </section>
      <p className="dt-summary" aria-live="polite">
        {summaryDay}, {MONTHS[p.month - 1].slice(0, 3)} {p.day}, {pad(p.hour)}:{pad(p.minute)} {zone === "UTC" ? "UTC" : "Rome"}
      </p>
    </div>
  );
}
