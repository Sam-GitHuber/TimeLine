/**
 * Feed list-shaping, kept out of the route file.
 *
 * Expo Router treats everything under `src/app/` as routes, so helpers live here
 * rather than being exported alongside a screen component — it keeps route
 * modules to one job, and makes this directly testable.
 */

import type { Post } from './types';
import { dayHeading, dayKey } from './utils';

/** A day divider, or a post. Flattened so one `FlatList` renders both. */
export type FeedRow =
  | { kind: 'day'; key: string; label: string; sub: string | null }
  | { kind: 'post'; key: string; post: Post };

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

  for (const post of posts) {
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
