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
 * above is the reason: an unused copy is pure maintenance cost, so
 * `formatRelativeTime` / `formatAbsoluteTime` were removed again after C1 turned
 * out to use neither (the timeline rail shows a clock time, not "2h ago"). The
 * event helpers land with Milestone E3, when there's a screen calling them.
 *
 * Kept dependency-free (no date library), same as the web app: we don't need one
 * yet, and it's a good habit not to reach for a package until a problem demands
 * it.
 */

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
