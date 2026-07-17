// Small helpers for timestamps.
//
// Posts carry an ISO 8601 `created_at` string from the API. These helpers turn
// that into something readable. Kept dependency-free (no date library) — we
// don't need one yet, and it's a good habit not to reach for a package until a
// problem actually demands it.
//
// The reverse-chronological ordering that is TimeLine's whole point is now
// enforced by the backend (Post's default ordering + the feed query), so there
// is no client-side sort to keep in sync — the frontend renders posts in the
// order the API returns them.

// "just now", "5m", "3h", "2d" — the short relative style you see next to a
// post. Falls back to an absolute date for anything older than a week.
export function formatRelativeTime(isoString, now = new Date()) {
  const then = new Date(isoString);
  const seconds = Math.round((now - then) / 1000);

  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d`;

  return then.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

// A full, unambiguous timestamp for hover titles and profile pages.
export function formatAbsoluteTime(isoString) {
  return new Date(isoString).toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// The clock time shown on the timeline rail, split so the meridiem can sit on
// its own line under the time (e.g. { time: "2:10", meridiem: "pm" }). This is
// the "voice of time" — the one place the exact *when* is the point.
export function formatClockTime(isoString) {
  const d = new Date(isoString);
  const meridiem = d.getHours() < 12 ? "am" : "pm";
  const hour = d.getHours() % 12 || 12;
  const minute = String(d.getMinutes()).padStart(2, "0");
  return { time: `${hour}:${minute}`, meridiem };
}

// A stable per-calendar-day key (local time) used to group consecutive posts
// under a single day divider.
export function dayKey(isoString) {
  const d = new Date(isoString);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

// The heading for a day divider: a friendly primary label plus, where it adds
// information, a mono secondary date. "Today"/"Yesterday" for the obvious ones,
// the weekday within the past week, else the full date stands on its own.
export function dayHeading(isoString, now = new Date()) {
  const d = new Date(isoString);
  const key = dayKey(isoString);
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);

  const sameYear = d.getFullYear() === now.getFullYear();
  const full = d.toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
  });

  if (key === dayKey(now)) return { label: "Today", sub: full };
  if (key === dayKey(yesterday)) return { label: "Yesterday", sub: full };

  const withinWeek = now - d < 7 * 24 * 60 * 60 * 1000;
  if (withinWeek) {
    return { label: d.toLocaleDateString(undefined, { weekday: "long" }), sub: full };
  }
  return { label: full, sub: null };
}

// --- Event date/time formatting (Phase 8b) --------------------------------
//
// Events carry a plain calendar `event_date` ("YYYY-MM-DD") and `start_time`
// ("HH:MM:SS"), *not* an ISO datetime — so we parse them as local wall-clock
// values, never through `new Date("2026-07-19")` (which is UTC midnight and can
// slip a day in a western timezone). These are the "voice of time" the card
// renders in IBM Plex Mono.

// Parse an "YYYY-MM-DD" string into a local Date at midnight, or null.
export function parseEventDate(dateStr) {
  if (!dateStr) return null;
  const [y, m, d] = dateStr.split("-").map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}

// "Sat 19 Jul" (adds the year only when it isn't the current one). The value
// shown on a set Date chip and the recap line.
export function formatEventDate(dateStr, now = new Date()) {
  const d = parseEventDate(dateStr);
  if (!d) return "";
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

// "7:00pm" / "7pm" from an "HH:MM[:SS]" time string.
export function formatEventTime(timeStr) {
  if (!timeStr) return "";
  const [h, min] = timeStr.split(":").map(Number);
  if (Number.isNaN(h)) return "";
  const meridiem = h < 12 ? "am" : "pm";
  const hour = h % 12 || 12;
  return min
    ? `${hour}:${String(min).padStart(2, "0")}${meridiem}`
    : `${hour}${meridiem}`;
}

// The same wall-clock time, split so the meridiem can sit on its own line on the
// timeline rail (like `formatClockTime`, but from an event's "HH:MM" *wall clock*
// rather than an instant — so a past event's rail matches the time in its body,
// both in the event's own timezone). Returns null when there's no time.
export function formatEventTimeParts(timeStr) {
  if (!timeStr) return null;
  const [h, min] = timeStr.split(":").map(Number);
  if (Number.isNaN(h)) return null;
  const meridiem = h < 12 ? "am" : "pm";
  const hour = h % 12 || 12;
  return { time: min ? `${hour}:${String(min).padStart(2, "0")}` : `${hour}`, meridiem };
}

// The one-line "when" recap: "Sat 19 Jul · 7:00pm" (time part omitted when a
// date-only, all-day event). Used on the card summary and the past recap card.
export function formatEventWhen(event, now = new Date()) {
  const date = formatEventDate(event.event_date, now);
  const time = formatEventTime(event.start_time);
  if (!date) return "";
  return time ? `${date} · ${time}` : date;
}
