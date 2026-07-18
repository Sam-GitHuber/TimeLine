/**
 * Timestamp helpers, ported from `frontend/src/utils.js`.
 *
 * **This is a deliberate copy, not an import.** The repo-layout decision in
 * docs/phases/phase-9-iphone-app.md weighed extracting a shared web/mobile
 * package for ~1k lines and rejected it: npm workspaces, a build step, and Metro
 * config is real permanent complexity for two consumers. These functions are the
 * bulk of what's genuinely shareable.
 *
 * **If you fix a bug here, fix it in `frontend/src/utils.js` too.** The two
 * clients must agree about what "2h" and "Yesterday" mean, or the same post
 * reads differently on phone and web. Only the helpers the app actually uses are
 * ported — the event ones land with Milestone E3.
 *
 * Kept dependency-free (no date library), same as the web app: we don't need one
 * yet, and it's a good habit not to reach for a package until a problem demands
 * it.
 */

/**
 * "just now", "5m", "3h", "2d" — the short relative style next to a post.
 * Falls back to an absolute date for anything older than a week.
 */
export function formatRelativeTime(isoString: string, now: Date = new Date()): string {
  const then = new Date(isoString);
  const seconds = Math.round((now.getTime() - then.getTime()) / 1000);

  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d`;

  return then.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/** A full, unambiguous timestamp — used where the exact time is the point. */
export function formatAbsoluteTime(isoString: string): string {
  return new Date(isoString).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * The clock time shown on the timeline rail, split so the meridiem can sit on
 * its own line under the time (e.g. `{ time: "2:10", meridiem: "pm" }`). This is
 * the "voice of time" — the one place the exact *when* is the point.
 */
export function formatClockTime(isoString: string): {
  time: string;
  meridiem: string;
} {
  const d = new Date(isoString);
  const meridiem = d.getHours() < 12 ? 'am' : 'pm';
  const hour = d.getHours() % 12 || 12;
  const minute = String(d.getMinutes()).padStart(2, '0');
  return { time: `${hour}:${minute}`, meridiem };
}

/**
 * A stable per-calendar-day key (local time), used to group consecutive posts
 * under a single day divider.
 */
export function dayKey(isoString: string): string {
  const d = new Date(isoString);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/**
 * The heading for a day divider: a friendly primary label plus, where it adds
 * information, a secondary date. "Today"/"Yesterday" for the obvious ones, the
 * weekday within the past week, else the full date stands on its own.
 */
export function dayHeading(
  isoString: string,
  now: Date = new Date()
): { label: string; sub: string | null } {
  const d = new Date(isoString);
  const key = dayKey(isoString);
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);

  const sameYear = d.getFullYear() === now.getFullYear();
  const full = d.toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
  });

  if (key === dayKey(now.toISOString())) return { label: 'Today', sub: full };
  if (key === dayKey(yesterday.toISOString()))
    return { label: 'Yesterday', sub: full };

  const withinWeek = now.getTime() - d.getTime() < 7 * 24 * 60 * 60 * 1000;
  if (withinWeek) {
    return {
      label: d.toLocaleDateString(undefined, { weekday: 'long' }),
      sub: full,
    };
  }
  return { label: full, sub: null };
}
