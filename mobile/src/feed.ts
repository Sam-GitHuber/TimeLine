/**
 * Feed list-shaping, kept out of the route file.
 *
 * Expo Router treats everything under `src/app/` as routes, so helpers live here
 * rather than being exported alongside a screen component — it keeps route
 * modules to one job, and makes this directly testable.
 */

import type { InfiniteData } from '@tanstack/react-query';

import type { Paginated, Post } from './types';
import { dayHeading, dayKey } from './utils';

/** The shape TanStack keeps for the paginated feed query. */
export type FeedPages = InfiniteData<Paginated<Post>, string>;

/**
 * Drop every loaded page but the first.
 *
 * Used before a pull-to-refresh. `refetch()` on an infinite query refetches
 * **all** the pages currently loaded, one after another — so someone ten pages
 * deep would fire ten sequential requests over a phone connection and watch the
 * spinner for every one of them, when only the first page can hold anything
 * new. (TanStack v5 removed the old `refetchPage` option; trimming the cache
 * first is the documented replacement.)
 *
 * Returns the input unchanged when there's nothing to trim, so the cache entry
 * keeps its identity and no needless re-render is triggered.
 */
export function trimToFirstPage(data: FeedPages | undefined): FeedPages | undefined {
  if (!data || data.pages.length <= 1) return data;
  return {
    pages: data.pages.slice(0, 1),
    pageParams: data.pageParams.slice(0, 1),
  };
}

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
