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
 * clients must agree about what "Yesterday" means, or the same post reads
 * differently on phone and web.
 *
 * **Only port a helper when a screen actually needs it.** The sync obligation
 * above is the reason: an unused copy is pure maintenance cost. C1 shipped
 * `formatRelativeTime` and `formatAbsoluteTime` before anything called them and
 * both were removed; C3's comment timestamps then genuinely needed the first, so
 * it came back. `formatAbsoluteTime` stays out — on the web it fills a hover
 * tooltip, and a phone has no hover. The event helpers land with Milestone E3.
 *
 * Kept dependency-free (no date library), same as the web app: we don't need one
 * yet, and it's a good habit not to reach for a package until a problem demands
 * it.
 */

/**
 * "just now", "5m", "3h", "2d" — the short relative style next to a comment.
 * Falls back to an absolute date for anything older than a week.
 *
 * Posts don't use this (the timeline rail shows their exact clock time, which is
 * the whole point of the design); comments do, where the precise minute matters
 * less than the sense of how recent the exchange is.
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
 * The clock time on a chat bubble — "14:32", or "2:32 pm" where that's the
 * local convention (Phase 9b M5).
 *
 * **A chat wants the clock, not "3h ago".** The transcript already carries a day
 * separator above each day's messages, so the date is answered; what a bubble
 * has to answer is *when in that day*, which is how anyone reads back a
 * conversation ("you said that at half twelve"). Relative time is right on the
 * conversation *list*, where the question really is "how recent is this", and
 * that's why `formatRelativeTime` stays in use there.
 *
 * Deliberately locale-driven rather than hard-coded 24-hour: the hour format is
 * the most obviously *wrong-looking* thing you can impose on someone, and the
 * platform already knows their answer.
 */
export function formatMessageTime(isoString: string): string {
  const formatted = new Date(isoString).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });
  // The two clocks want opposite things about a leading zero, and the platform
  // won't give both from one set of options: "9:02 am" is right where a
  // meridiem does the disambiguating, and "09:02" is right where nothing else
  // does. So the presence of a meridiem is the signal for which convention
  // we're in — and it's lowercased on the way past, because the design system's
  // voice is lowercase throughout (see `formatClockTime`) and a shouted AM/PM
  // beside 11px type reads as an abbreviation gone wrong.
  const meridiem = /[AP]M$/i.test(formatted);
  if (meridiem) {
    return formatted.replace(/\s?([AP])M$/i, (_m, half) => ` ${half.toLowerCase()}m`);
  }
  return formatted.replace(/^(\d):/, '0$1:');
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
