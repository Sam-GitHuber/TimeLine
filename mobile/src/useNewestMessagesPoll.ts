/**
 * The fast poll of an open thread **once its history is paged back** (#394).
 *
 * `['messages', id]` is an infinite query, and a refetch of one re-requests
 * every loaded page in sequence. With one page loaded that is one request and
 * nothing here runs. With five it was five, every `MESSAGE_POLL_MS`, and an
 * incoming message waited for the last — slower the further back you'd read,
 * for a message that can only ever be on the first. So past one page this asks
 * for the newest page alone on the fast cadence and merges it in, and the
 * whole-list refetch drops to once every `MESSAGE_HISTORY_POLL_MS`.
 *
 * **It writes through to the transcript's cache** rather than being drawn over
 * it at render. Everything else — the mark-read count, the unread divider, and
 * above all `writeMessage`, which puts a server's answer *into* a cached
 * message — reads and writes that one list, and a message that existed only in
 * an overlay couldn't be reacted to without the pill blinking off.
 *
 * **Keyed underneath `['messages', id]` on purpose.** Every write in the thread
 * ends by invalidating that prefix to cancel a poll that left before it (#393),
 * and this is exactly such a poll. Sitting under the prefix means those sites,
 * and any written later, cancel it without knowing it exists.
 */

import {
  type InfiniteData,
  replaceEqualDeep,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useCallback, useEffect, useRef } from 'react';

import { api, MESSAGE_HISTORY_POLL_MS, MESSAGE_POLL_MS } from '@/api';
import type { Message, Paginated } from '@/types';

type Transcript = InfiniteData<Paginated<Message>, string>;

export function newestMessagesKey(conversationId: number) {
  return ['messages', conversationId, 'newest'] as const;
}

/**
 * Lay a fresh copy of the newest page over a newest-first transcript.
 *
 * Not a replacement of page one: the endpoint pages by *number*, so each
 * message that arrives pushes the oldest one on this page onto the next, and
 * swapping the page would drop it from a list that still shows its neighbours
 * either side. What the fresh page no longer carries is kept, after it. The
 * page grows past its size until the next whole-list refetch squares it up,
 * which nothing downstream minds — `toThreadRows` reads results, not pages.
 *
 * `next` stays the cached one. It is only ever followed off the *last* page,
 * and this never runs with fewer than two.
 *
 * **Hands back `cached` itself when the fresh page changes nothing**, which is
 * most ticks. The caller skips the write then: a `setQueryData` is a manual
 * success on the transcript, and one every four seconds would clear a failed
 * sweep's error and stamp the whole list as just fetched when one page was.
 */
export function mergeNewestPage(
  cached: Transcript | undefined,
  fresh: Paginated<Message>
): Transcript | undefined {
  if (!cached?.pages.length) return cached;
  const [first, ...older] = cached.pages;
  const freshIds = new Set(fresh.results.map((m) => m.id));
  const results = replaceEqualDeep(first.results, [
    ...fresh.results,
    ...first.results.filter((m) => !freshIds.has(m.id)),
  ]);
  if (results === first.results && fresh.count === first.count) return cached;
  return {
    ...cached,
    pages: [{ ...first, count: fresh.count, results }, ...older],
  };
}

/**
 * Poll the newest page of `conversationId` while `enabled`, merging each answer
 * into `['messages', conversationId]`, and call `sweep` — the transcript's own
 * whole-list refetch — once every `MESSAGE_HISTORY_POLL_MS`.
 *
 * **The sweep is driven from here, not by a `refetchInterval` on the
 * transcript**, and it has to be. query-core restarts an observer's interval
 * timer on *every* update to its query (`onQueryUpdate` → `#updateTimers`), and
 * a `setQueryData` is an update — so a thirty-second interval on a query this
 * writes to every four seconds would be reset before it ever fired, and the
 * edits, deletes and reactions on older messages that the sweep exists to pick
 * up would never arrive. Counting from this poll's own answers also means it
 * pauses when this does, in the background.
 *
 * `refetching` is the transcript's `isRefetching` and times the sweep.
 * `fetching` is its `isFetching` — a refetch *or* a page of older history — and
 * is here for one race. Either kind of fetch builds its answer from what it
 * saw when it left: a sweep asks for page one first and lands when its last
 * page does, and `fetchNextPage` appends to a snapshot of the pages. So a
 * newest-page poll that left after one began can come back sooner carrying a
 * message it doesn't have — and the fetch then lands on top and takes that
 * message off the screen until the next tick. So the newest page is merged
 * again when a fetch finishes, **but only if it is the newer of the two**, and
 * two things can say it isn't:
 *
 *   - it was fetched before that fetch started; or
 *   - it has been **invalidated** since. A write's invalidation restarts a
 *     sweep already in flight without `isFetching` ever dropping, so the clock
 *     can't see it — but it marks this query too, being under the prefix, and
 *     that mark stays until its own refetch lands.
 *
 * Re-applying a page that fails either test would put back the very message a
 * write just changed.
 *
 * Returns the query's `refetch`, for the one caller with a reason not to wait
 * for the tick: a push saying a message exists.
 */
export function useNewestMessagesPoll(
  conversationId: number,
  {
    enabled,
    fetching,
    refetching,
    sweep,
  }: {
    enabled: boolean;
    fetching: boolean;
    refetching: boolean;
    sweep: () => void;
  }
): () => void {
  const queryClient = useQueryClient();
  const { data, dataUpdatedAt, refetch } = useQuery({
    queryKey: newestMessagesKey(conversationId),
    queryFn: () => api.getMessages(conversationId),
    refetchInterval: MESSAGE_POLL_MS,
    enabled,
    // Nothing reads this but the merge below, and a copy kept from the last
    // visit would be merged over a transcript fetched since.
    gcTime: 0,
  });

  /** When the whole list was last asked for — or, before that, when this began. */
  const sweptAt = useRef(0);
  /** When the transcript last started a fetch of any kind. */
  const fetchStartedAt = useRef(0);
  const was = useRef({ enabled: false, fetching: false, refetching: false });
  useEffect(() => {
    const now = Date.now();
    if (fetching && !was.current.fetching) fetchStartedAt.current = now;
    // Paging back is not a reason to sweep: the page that made this `enabled`
    // has only just been fetched, and the first has been polled all along.
    if (
      (refetching && !was.current.refetching) ||
      (enabled && !was.current.enabled)
    ) {
      sweptAt.current = now;
    }
    was.current = { enabled, fetching, refetching };
    if (!enabled || !data || dataUpdatedAt < fetchStartedAt.current) return;
    const key = newestMessagesKey(conversationId);
    if (queryClient.getQueryState(key)?.isInvalidated) return;
    const transcriptKey = ['messages', conversationId];
    const cached = queryClient.getQueryData<Transcript>(transcriptKey);
    const merged = mergeNewestPage(cached, data);
    if (merged !== cached) queryClient.setQueryData(transcriptKey, merged);
    if (!refetching && now - sweptAt.current >= MESSAGE_HISTORY_POLL_MS) sweep();
  }, [
    queryClient,
    conversationId,
    enabled,
    fetching,
    refetching,
    sweep,
    data,
    dataUpdatedAt,
  ]);

  return useCallback(() => {
    void refetch();
  }, [refetch]);
}
