// Small formatting helpers for timestamps.
//
// Posts store an ISO 8601 string in `createdAt`. These helpers turn that into
// something readable. Kept dependency-free (no date library) — the wireframe
// doesn't need one, and it's a good habit not to reach for a package until a
// problem actually demands it.

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
