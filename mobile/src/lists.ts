/**
 * Small, generic helpers for the paginated infinite lists in the app (feed,
 * people, requests). Kept out of any route/screen file so they're directly
 * unit-testable and shared rather than re-derived per screen.
 */

import type { InfiniteData } from '@tanstack/react-query';

import type { Paginated } from './types';

/**
 * Drop repeated ids while preserving order.
 *
 * The API pages by page *number*, so the window shifts whenever the underlying
 * set changes mid-scroll (someone posts, or connects): the next page re-sends a
 * row the previous page already showed. Two rows then share a key, which makes
 * React warn and lets `FlatList` recycle the wrong one. Dropping the repeat
 * rather than de-duplicating by position keeps the server's order untouched —
 * on the feed that order is the product's one non-negotiable guarantee.
 */
export function dedupeById<T extends { id: number }>(items: T[]): T[] {
  const seen = new Set<number>();
  const out: T[] = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

/**
 * Drop every loaded page but the first.
 *
 * Used before a pull-to-refresh. `refetch()` on an infinite query refetches
 * **all** the pages currently loaded, one after another — so someone ten pages
 * deep would fire ten sequential requests over a phone connection and watch the
 * spinner for every one, when only the first page can hold anything new.
 * (TanStack v5 removed the old `refetchPage` option; trimming the cache first is
 * the documented replacement.)
 *
 * Returns the input unchanged when there's nothing to trim, so the cache entry
 * keeps its identity and no needless re-render is triggered.
 */
export function trimToFirstPage<T>(
  data: InfiniteData<Paginated<T>, string> | undefined
): InfiniteData<Paginated<T>, string> | undefined {
  if (!data || data.pages.length <= 1) return data;
  return {
    pages: data.pages.slice(0, 1),
    pageParams: data.pageParams.slice(0, 1),
  };
}
