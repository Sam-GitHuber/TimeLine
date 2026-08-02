/**
 * Small, generic helpers for the paginated infinite lists in the app (feed,
 * people, requests), plus the one hook that walks such a list to its end. Kept
 * out of any route/screen file so they're directly unit-testable and shared
 * rather than re-derived per screen — which for `useFetchAllPages` is the whole
 * point, since the three screens that had their own copy of it all had the same
 * bug (#248).
 */

import type { InfiniteData } from '@tanstack/react-query';
import { useEffect } from 'react';

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

/** The four fields of an infinite query the walk below reads. */
type PagedQuery = {
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  isError: boolean;
  fetchNextPage: () => unknown;
};

/**
 * Walk an infinite query to the end, pulling each remaining page as soon as the
 * one before it lands. For the handful of lists bounded by something real (your
 * connections; the replies to one message) and so wanted whole, as opposed to
 * the unbounded ones that page on scroll from `onEndReached`.
 *
 * **`isError` is load-bearing, not defensive.** Without it a *failed* page fetch
 * re-arms this effect the instant it fails: `hasNextPage` stays true, because
 * the server never said there was no more, while `isFetchingNextPage` flips back
 * to false — which is exactly the condition below. So a 500 or a dropped signal
 * on page 2 doesn't stop the walk, it restarts it, one request per render commit
 * for as long as the screen stays mounted, with TanStack's own three retries
 * stacked on each attempt. That hammers an endpoint that is by definition
 * already unhealthy, from a phone whose connection has just dropped — so it
 * spins the radio flat at the exact moment there's least to gain (#248, and
 * #214 for the web twin).
 *
 * Stopping instead leaves a partial list and hands the transient case to the
 * query's own retry/backoff. Recovery is automatic: any later fetch that
 * succeeds (a poll, a refocus) clears `isError` and the remaining pages resume
 * from where they stopped.
 *
 * ⚠️ **A caller of this hook owes the viewer an `isError` branch**, because a
 * list that stops short looks exactly like a list that ended. That's the cost of
 * not looping, and it's only paid if it's rendered: a picker missing the person
 * you're looking for reads as "they aren't in your connections", which is a
 * wrong answer, not a missing one. Note that a `ListEmptyComponent` alone
 * doesn't discharge it — the partial case is precisely the one where the list
 * isn't empty.
 *
 * One place, so the next screen that wants every page can't reintroduce the
 * loop. The web's equivalent is `useFetchAllPages` in `frontend/src/hooks.js`.
 */
export function useFetchAllPages(query: PagedQuery): void {
  const { hasNextPage, isFetchingNextPage, isError, fetchNextPage } = query;
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage && !isError) fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, isError, fetchNextPage]);
}
