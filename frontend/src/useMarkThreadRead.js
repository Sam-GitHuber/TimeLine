/**
 * Telling the server a thread has been read, and **keeping at it until it
 * lands** (issue #355).
 *
 * This was an effect inside `ConversationThreadView`, keyed on the loaded
 * message count, firing one fire-and-forget POST whose failure was swallowed on
 * the reasoning that "the next open marks it again". Two things were wrong with
 * that, and the phone hit them harder than the browser does — but the marker is
 * one shared piece of state, so both clients have to be able to write it:
 *
 * - **A failed write was never retried.** It fires exactly when the connection
 *   is patchy, which is when it rejects, and nothing was scheduled to correct
 *   it.
 * - **Only a new message re-triggered it.** Reading changed nothing, and
 *   neither did coming back to a tab that had been in the background for an
 *   hour — the one moment the marker is most likely to be stale.
 *
 * The marker isn't cosmetic: `send_pushes._should_drop` reads it to decide
 * whether to buzz a phone for a message already on someone's screen, and
 * `attach_read_receipts` reads it to draw the other person's second tick. A
 * write that silently never happens is a stray push *and* a wrong tick.
 *
 * The mobile twin is `mobile/src/useMarkThreadRead.ts`. Two differences, both
 * platform-forced: it must also cope with a screen that never remounts, and it
 * carries a notification-tray sweep (#178) that a browser has no equivalent of.
 * The retry schedule and the invalidation set are meant to stay identical.
 */

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { api } from "./api.js";

/**
 * Retry schedule for a mark-read that didn't land: attempt *n* waits
 * `MARK_READ_RETRY_MS * n`, so 3s, 6s, 9s.
 *
 * Bounded rather than forever, because a write that has failed four times is
 * failing for a reason a fifth won't fix — and any fresh trigger (a new
 * message, the tab becoming visible) starts the schedule over anyway.
 */
export const MARK_READ_RETRY_MS = 3000;
export const MARK_READ_MAX_ATTEMPTS = 4;

/**
 * Everything one mark-read from *inside a thread* implies for the cache.
 *
 * **Deliberately not `["conversation", id]`**, which `ConversationListView`'s
 * own mark-read does invalidate. The difference is frequency, not principle:
 * the list's is a one-shot menu action, where a header left disagreeing with
 * the row would read as a bug, while this fires on every arriving message and
 * every return to the tab. Invalidating the heaviest per-thread payload that
 * often would replace one polled fetch per 12s with one per message, and the
 * reader is already looking at the thread it would refresh.
 */
export function invalidateThreadRead(queryClient) {
  queryClient.invalidateQueries({ queryKey: ["unreadMessages"] });
  queryClient.invalidateQueries({ queryKey: ["conversations"] });
}

/**
 * Mark `conversationId` read while its transcript is on screen.
 *
 * `ready` is the caller's own "the messages are actually showing" answer
 * (`!isPending && readingMessages`), passed in rather than re-derived: asking
 * that question a second way here is exactly how the two answers drift apart,
 * which is the lesson of #315/#321/#324. `messageCount` is a *trigger*, not an
 * input, and so are the tab's visibility changes.
 */
export function useMarkThreadRead(conversationId, ready, messageCount) {
  const queryClient = useQueryClient();
  const [visibleAgain, setVisibleAgain] = useState(0);

  /**
   * Coming back to the tab is a reason to re-assert the marker. A background tab
   * is throttled and may have been away for hours, so this is both the likeliest
   * moment for the marker to be stale and the likeliest moment for the last
   * attempt to have failed.
   *
   * **The transcript is refetched first, and the counter only moves if that
   * succeeds.** The server stamps the marker `now()`, so firing against a stale
   * cached transcript would claim "read" over messages this tab hasn't fetched
   * and nobody has seen — binning their queued push (`_should_drop`) and drawing
   * the sender a second tick for something never read. Refetching first means
   * the marker can only claim messages the client actually holds.
   */
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState !== "visible") return;
      queryClient
        // **`throwOnError` is load-bearing.** `refetchQueries` resolves even
        // when the fetch failed (query-core swallows per-query errors by
        // default), so without it the `.then` below runs on exactly the offline
        // return the guard exists to catch, and the `.catch` is dead code.
        .refetchQueries(
          { queryKey: ["messages", conversationId] },
          { throwOnError: true },
        )
        .then(() => setVisibleAgain((n) => n + 1))
        // A refetch we couldn't complete is precisely when we must *not* claim
        // a read. The thread's own poll will come round again.
        .catch(() => {});
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [conversationId, queryClient]);

  useEffect(() => {
    if (!ready) return undefined;

    let cancelled = false;
    let timer;

    const attempt = (n) => {
      api
        .markConversationRead(conversationId)
        .then(() => {
          // **Not gated on `cancelled`.** The write landed, so the badge and the
          // conversation list are wrong until something says so — and these are
          // global cache operations, safe long after this view has unmounted.
          // Gating them left the nav badge claiming mail the reader had just
          // read whenever they closed the drawer inside the round trip.
          invalidateThreadRead(queryClient);
        })
        .catch(() => {
          // Caught, not swallowed: an unhandled rejection is noise, but a
          // *dropped* write is the bug. Scheduling the next go is the
          // difference.
          if (cancelled || n >= MARK_READ_MAX_ATTEMPTS) return;
          timer = setTimeout(() => attempt(n + 1), MARK_READ_RETRY_MS * n);
        });
    };

    attempt(1);

    return () => {
      // A re-run supersedes whatever the last one was doing. The in-flight POST
      // can't be recalled, but a fresh one goes out — and since the server
      // stamps `last_read_at` with its own clock, the later write is the one
      // that should win anyway. Only the *retry chain* is cancelled here.
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // `messageCount` and `visibleAgain` are triggers rather than inputs: the
    // effect re-runs when either changes, which is the whole reason they are
    // listed.
  }, [conversationId, ready, messageCount, visibleAgain, queryClient]);
}
