import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { parseEventDate, formatEventTime } from "../../utils.js";

// The practical planner: a conventional month grid in the design tokens (line
// hairlines, warm surface, mono numerals, a Bricolage month label). Day dots
// encode state — filled accent = scheduled, hollow ring = a poll's candidate
// date, spine-grey = already happened; today is ringed. Tapping a day reveals
// its events. Best for spotting date clusters while a date poll is open.
//
// `events` is the group/personal calendar window (dated events only). It fetches
// nothing itself — the page hands it the events and (optionally) candidate poll
// dates to ring.
export default function MonthGrid({ events = [], candidateDates = [] }) {
  const [cursor, setCursor] = useState(() => startOfMonth(firstEventDate(events)));
  const [openDay, setOpenDay] = useState(null);

  const byDay = useMemo(() => groupByDay(events), [events]);
  const candidates = useMemo(() => new Set(candidateDates), [candidateDates]);
  const todayKey = dayKeyLocal(new Date());

  const weeks = useMemo(() => monthMatrix(cursor), [cursor]);
  const monthLabel = cursor.toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
  });

  return (
    <div className="ev-month">
      <div className="mb-3 flex items-center justify-between">
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => setCursor(addMonths(cursor, -1))}
          aria-label="Previous month"
        >
          ←
        </button>
        <h3 className="font-display text-lg font-semibold text-ink">{monthLabel}</h3>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => setCursor(addMonths(cursor, 1))}
          aria-label="Next month"
        >
          →
        </button>
      </div>

      <div className="ev-month-head">
        {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
          <span key={d}>{d}</span>
        ))}
      </div>

      <div className="ev-month-grid">
        {weeks.flat().map((day, i) => {
          if (!day) return <div key={i} className="ev-day ev-day--blank" />;
          const key = dayKeyLocal(day);
          const dayEvents = byDay.get(key) || [];
          const scheduled = dayEvents.some((e) => !e.is_past && e.status !== "cancelled");
          const past = dayEvents.length > 0 && dayEvents.every((e) => e.is_past);
          const isCandidate = candidates.has(isoDate(day));
          const isToday = key === todayKey;
          const cls = [
            "ev-day",
            isToday ? "ev-day--today" : "",
            scheduled ? "ev-day--scheduled" : "",
            past ? "ev-day--past" : "",
            isCandidate ? "ev-day--candidate" : "",
          ]
            .filter(Boolean)
            .join(" ");
          return (
            <button
              key={i}
              type="button"
              className={cls}
              onClick={() => setOpenDay(openDay === key ? null : key)}
              aria-label={`${day.getDate()} — ${dayEvents.length} event${dayEvents.length === 1 ? "" : "s"}`}
            >
              <span className="ev-day-num font-mono">{day.getDate()}</span>
              {dayEvents.length > 0 && <span className="ev-day-dot" aria-hidden="true" />}
            </button>
          );
        })}
      </div>

      {openDay && (byDay.get(openDay) || []).length > 0 && (
        <ul className="mt-3 space-y-1 border-t border-line pt-3">
          {(byDay.get(openDay) || []).map((e) => (
            <li key={e.id}>
              <Link
                to={`/g/${e.group.id}/events/${e.id}`}
                className="flex items-baseline gap-2 rounded-md px-2 py-1 hover:bg-accent-tint"
              >
                <span className="font-mono text-xs text-ink-faint">
                  {formatEventTime(e.start_time) || "all day"}
                </span>
                <span className="text-sm text-ink">{e.title}</span>
                <span className="text-xs italic text-ink-faint">{e.group.name}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function groupByDay(events) {
  const map = new Map();
  for (const e of events) {
    const d = parseEventDate(e.event_date);
    if (!d) continue;
    const key = dayKeyLocal(d);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(e);
  }
  return map;
}

function firstEventDate(events) {
  const upcoming = events.find((e) => !e.is_past);
  const d = parseEventDate((upcoming || events[0])?.event_date);
  return d || new Date();
}

function startOfMonth(d) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function addMonths(d, n) {
  return new Date(d.getFullYear(), d.getMonth() + n, 1);
}

// A Monday-first month matrix of Date cells (null for padding).
function monthMatrix(monthStart) {
  const year = monthStart.getFullYear();
  const month = monthStart.getMonth();
  const first = new Date(year, month, 1);
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const lead = (first.getDay() + 6) % 7; // Monday = 0
  const cells = [];
  for (let i = 0; i < lead; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(new Date(year, month, d));
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

function dayKeyLocal(d) {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}
