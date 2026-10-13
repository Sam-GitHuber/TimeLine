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
 */
export function mergeNewestPage(
  cached: Transcript | undefined,
  fresh: Paginated<Message>
): Transcript | undefined {
  if (!cached?.pages.length) return cached;
  const [first, ...older] = cached.pages;
  const freshIds = new Set(fresh.results.map((m) => m.id));
  return {
    ...cached,
    pages: [
      {
        ...first,
        count: fresh.count,
        results: [
          ...fresh.results,
          ...first.results.filter((m) => !freshIds.has(m.id)),
        ],
      },
      ...older,
    ],
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
 * `refetching` is the transcript's `isRefetching`, and besides timing the sweep
 * it is here for one race. A whole-list refetch asks for page one *first* and
 * lands only when its last page does, so a newest-page poll that left after it
 * began can come back sooner carrying a message it doesn't have — and the
 * refetch then lands on top and takes that message off the screen until the
 * next tick. So the newest page is merged again when a refetch finishes, **but
 * only if it was fetched after that refetch started**. The condition is the
 * whole point: a refetch started by a write's invalidation is *newer* than
 * whatever this last fetched, and re-applying that would put back the very
 * message the write changed.
 *
 * Returns the query's `refetch`, for the one caller with a reason not to wait
 * for the tick: a push saying a message exists.
 */
export function useNewestMessagesPoll(
  conversationId: number,
  {
    enabled,
    refetching,
    sweep,
  }: { enabled: boolean; refetching: boolean; sweep: () => void }
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
  const wasRefetching = useRef(false);
  const wasEnabled = useRef(false);
  useEffect(() => {
    // Paging back is not a reason to sweep: the page that made this `enabled`
    // has only just been fetched, and the first has been polled all along.
    if ((refetching && !wasRefetching.current) || (enabled && !wasEnabled.current)) {
      sweptAt.current = Date.now();
    }
    wasRefetching.current = refetching;
    wasEnabled.current = enabled;
    if (!enabled || !data || dataUpdatedAt < sweptAt.current) return;
    queryClient.setQueryData<Transcript>(['messages', conversationId], (cached) =>
      mergeNewestPage(cached, data)
    );
    if (!refetching && Date.now() - sweptAt.current >= MESSAGE_HISTORY_POLL_MS) {
      sweep();
    }
  }, [queryClient, conversationId, enabled, refetching, sweep, data, dataUpdatedAt]);

  return useCallback(() => {
    void refetch();
  }, [refetch]);
}
