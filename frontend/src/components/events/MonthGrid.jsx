import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { parseEventDate, formatEventTime } from "../../utils.js";

// The practical planner: a conventional month grid in the design tokens (line
// hairlines, warm surface, mono numerals, a Bricolage month label). Each event
// sits **in its day cell** as a small titled chip — accent when scheduled, muted
// when it's already happened, struck through when cancelled; today is ringed. A
// busy day shows the first few and a "+N more" that expands the full list below.
//
// `events` is the group/personal calendar window (dated events only). It fetches
// nothing itself — the page hands it the events.
const MAX_PER_DAY = 3;

export default function MonthGrid({ events = [] }) {
  const [cursor, setCursor] = useState(() => startOfMonth(firstEventDate(events)));
  const [openDay, setOpenDay] = useState(null);

  const byDay = useMemo(() => groupByDay(events), [events]);
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
          const shown = dayEvents.slice(0, MAX_PER_DAY);
          const extra = dayEvents.length - shown.length;
          const isToday = key === todayKey;
          return (
            <div
              key={i}
              className={`ev-day ${isToday ? "ev-day--today" : ""}`}
            >
              <span className="ev-day-num font-mono">{day.getDate()}</span>
              {dayEvents.length > 0 && (
                <div className="ev-day-events">
                  {shown.map((e) => (
                    <Link
                      key={e.id}
                      to={`/g/${e.group.id}/events/${e.id}`}
                      className={`ev-day-event ${eventChipClass(e)}`}
                      title={eventTitle(e)}
                    >
                      {formatEventTime(e.start_time) && (
                        <span className="ev-day-event-time">
                          {formatEventTime(e.start_time)}
                        </span>
                      )}
                      <span className="ev-day-event-title">{e.title}</span>
                    </Link>
                  ))}
                  {extra > 0 && (
                    <button
                      type="button"
                      className="ev-day-more"
                      onClick={() => setOpenDay(openDay === key ? null : key)}
                    >
                      +{extra} more
                    </button>
                  )}
                </div>
              )}
            </div>
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

function eventChipClass(e) {
  if (e.status === "cancelled") return "ev-day-event--off";
  if (e.is_past) return "ev-day-event--past";
  return "ev-day-event--scheduled";
}

function eventTitle(e) {
  const t = formatEventTime(e.start_time);
  return t ? `${t} · ${e.title}` : e.title;
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
