/**
 * Feed list-shaping, kept out of the route file.
 *
 * Expo Router treats everything under `src/app/` as routes, so helpers live here
 * rather than being exported alongside a screen component — it keeps route
 * modules to one job, and makes this directly testable.
 */

import type { InfiniteData } from '@tanstack/react-query';

import type { Event, Paginated, Post } from './types';
import { dayHeading, dayKey } from './utils';

// Pull-to-refresh trimming is generic and shared with the people/requests
// lists; re-exported here so the feed's existing call sites and tests keep
// importing it from `@/feed`.
export { trimToFirstPage } from './lists';

/** The shape TanStack keeps for the paginated feed query. */
export type FeedPages = InfiniteData<Paginated<Post>, string>;

/**
 * A day divider, a post, or a past event. Flattened so one `FlatList` renders
 * them all off the same spine. The `event` row appears only on a group timeline
 * (see `toGroupRows`) — a past event fallen into the line as a recap.
 */
export type FeedRow =
  | { kind: 'day'; key: string; label: string; sub: string | null }
  | { kind: 'post'; key: string; post: Post }
  | { kind: 'event'; key: string; event: Event };

/**
 * Insert a divider whenever the calendar day changes.
 *
 * **Order is preserved exactly** — this walks the list the server sent and never
 * sorts it. Reverse-chronological ordering is enforced server-side
 * (`Post.Meta.ordering`) and is the product's one non-negotiable principle, so
 * any client-side reordering here would be a bug, not a feature.
 *
 * Done here rather than with `SectionList` because the timeline spine has to run
 * *through* the dividers unbroken — sections would fight that.
 */
export function toRows(posts: Post[]): FeedRow[] {
  const rows: FeedRow[] = [];
  let lastDay: string | null = null;
  const seen = new Set<number>();

  for (const post of posts) {
    // Skip a post we've already placed.
    //
    // The API pages by page *number*, so the window shifts under us whenever a
    // post is created while someone is scrolling: page 2 then re-sends the post
    // that page 1 already showed. Two rows would share the key `post-<id>`,
    // which makes React warn and lets `FlatList` recycle the wrong row.
    //
    // Dropping the repeat rather than de-duplicating by position keeps the
    // server's order untouched — the reverse-chronological guarantee is not
    // ours to renegotiate.
    if (seen.has(post.id)) continue;
    seen.add(post.id);

    const day = dayKey(post.created_at);
    if (day !== lastDay) {
      const { label, sub } = dayHeading(post.created_at);
      rows.push({ kind: 'day', key: `day-${day}`, label, sub });
      lastDay = day;
    }
    rows.push({ kind: 'post', key: `post-${post.id}`, post });
  }
  return rows;
}

/**
 * Rows for a **group** timeline: posts merged with past events, newest-first,
 * with day dividers.
 *
 * "The calendar is the timeline's forward mirror" (events.md, decision 4): an
 * event whose time has passed **falls down into the group timeline among the
 * posts** as a quiet recap, so the same line carries a group's whole history.
 * (Upcoming events hang *above* the composer as cards — the group page renders
 * those separately; only past events thread the spine here.)
 *
 * Unlike `toRows`, this one **must sort** — posts arrive reverse-chronological
 * from the server, but a past event has to be slotted in by its own time
 * (`starts_at`). Sorting only ever *interleaves* the events with the already-
 * ordered posts; it never reorders the posts among themselves, so the
 * reverse-chronological guarantee still holds. Mirrors the web `Timeline`.
 *
 * `pastEvents` is the full bounded past-events list (the window isn't
 * paginated); it's merged with whatever posts have loaded. An event older than
 * the oldest loaded post therefore sits at the tail until more posts page in —
 * the same accepted behaviour as the web.
 */
export function toGroupRows(posts: Post[], pastEvents: Event[] = []): FeedRow[] {
  const seen = new Set<number>();
  const items: { time: number; row: FeedRow }[] = [];

  for (const post of posts) {
    if (seen.has(post.id)) continue;
    seen.add(post.id);
    items.push({
      time: new Date(post.created_at).getTime(),
      row: { kind: 'post', key: `post-${post.id}`, post },
    });
  }
  for (const event of pastEvents) {
    // An all-day event has no start_time; `starts_at` falls back to its date, so
    // it still sorts onto the right day.
    const when = event.starts_at ?? event.event_date;
    items.push({
      time: when ? new Date(when).getTime() : 0,
      row: { kind: 'event', key: `event-${event.id}`, event },
    });
  }

  // Newest-first. A stable sort keeps same-instant posts in server order.
  items.sort((a, b) => b.time - a.time);

  const rows: FeedRow[] = [];
  let lastDay: string | null = null;
  for (const { row } of items) {
    const iso =
      row.kind === 'post'
        ? row.post.created_at
        : row.kind === 'event'
          ? row.event.starts_at ?? row.event.event_date ?? row.event.created_at
          : null;
    if (iso) {
      const day = dayKey(iso);
      if (day !== lastDay) {
        const { label, sub } = dayHeading(iso);
        rows.push({ kind: 'day', key: `day-${day}`, label, sub });
        lastDay = day;
      }
    }
    rows.push(row);
  }
  return rows;
}
