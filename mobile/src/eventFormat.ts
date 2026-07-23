/**
 * Event date/time formatting — the "voice of time" for events, ported from
 * `frontend/src/utils.js` (the `formatEvent*` / `parseEventDate` helpers).
 *
 * **This is a deliberate copy, not an import** — same reasoning as `utils.ts`:
 * the repo-layout decision in docs/phases/phase-9-iphone-app.md rejected a
 * shared web/mobile package. **If you fix a bug here, fix it in
 * `frontend/src/utils.js` too**, or an event's "when" reads differently on
 * phone and web.
 *
 * Why its own module rather than in `utils.ts`: these are event-specific and
 * parse *wall-clock* values (a `YYYY-MM-DD` date, an `HH:MM` time in the event's
 * own timezone), never an instant — quite unlike the post timestamps in
 * `utils.ts`, which format an ISO instant in the viewer's local zone. Keeping
 * them apart stops the two being reached for interchangeably.
 *
 * Dates are parsed from their numeric parts, **never** `new Date("2026-07-19")`
 * (which is UTC midnight and can slip a day west of Greenwich).
 */

import type { Event } from './types';

/** Parse a `YYYY-MM-DD` string into a local `Date` at midnight, or null. */
export function parseEventDate(dateStr: string | null | undefined): Date | null {
  if (!dateStr) return null;
  const [y, m, d] = dateStr.split('-').map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}

/**
 * "Sat 19 Jul" (adding the year only when it isn't the current one) — the value
 * on a set Date chip and the recap line.
 */
export function formatEventDate(
  dateStr: string | null | undefined,
  now: Date = new Date()
): string {
  const d = parseEventDate(dateStr);
  if (!d) return '';
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

/** "7:00pm" / "7pm" from an `HH:MM[:SS]` wall-clock string. */
export function formatEventTime(timeStr: string | null | undefined): string {
  if (!timeStr) return '';
  const [h, min] = timeStr.split(':').map(Number);
  if (Number.isNaN(h)) return '';
  const meridiem = h < 12 ? 'am' : 'pm';
  const hour = h % 12 || 12;
  return min
    ? `${hour}:${String(min).padStart(2, '0')}${meridiem}`
    : `${hour}${meridiem}`;
}

/**
 * The wall-clock time split so the meridiem can sit on its own line on the
 * timeline rail (like `formatClockTime`, but from an event's `HH:MM` wall clock
 * in its own timezone rather than an instant — so a past event's rail matches
 * the time in its body). Returns null when there's no time (an all-day event).
 */
export function formatEventTimeParts(
  timeStr: string | null | undefined
): { time: string; meridiem: string } | null {
  if (!timeStr) return null;
  const [h, min] = timeStr.split(':').map(Number);
  if (Number.isNaN(h)) return null;
  const meridiem = h < 12 ? 'am' : 'pm';
  const hour = h % 12 || 12;
  return {
    time: min ? `${hour}:${String(min).padStart(2, '0')}` : `${hour}`,
    meridiem,
  };
}

/**
 * The one-line "when" recap: "Sat 19 Jul · 7:00pm" (the time is omitted for a
 * date-only, all-day event). Used on the card summary and the past recap.
 */
export function formatEventWhen(
  event: Pick<Event, 'event_date' | 'start_time'>,
  now: Date = new Date()
): string {
  const date = formatEventDate(event.event_date, now);
  const time = formatEventTime(event.start_time);
  if (!date) return '';
  return time ? `${date} · ${time}` : date;
}
