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
 * The mobile twin is `mobile/src/useMarkThreadRead.ts`, which additionally has
 * to cope with a screen that never remounts. See notifications.md.
 */

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { api } from "./api";

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
   * Coming back to the tab is a reason to re-assert the marker.
   *
   * A background tab is throttled and may have been away for hours, so this is
   * both the likeliest moment for the marker to be stale and the likeliest
   * moment for the last attempt to have failed. Counting transitions rather
   * than tracking a boolean keeps it a plain trigger: every return is a fresh
   * reason to write, even if the last one also was.
   */
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        setVisibleAgain((n) => n + 1);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  useEffect(() => {
    if (!ready) return undefined;
    // `messageCount` and `visibleAgain` are **triggers**: this effect re-runs
    // when either changes, which is the whole reason they're in the dependency
    // list. Naming them keeps that list honest rather than pretending the body
    // reads them.
    void messageCount;
    void visibleAgain;

    let cancelled = false;
    let timer;

    const attempt = (n) => {
      api
        .markConversationRead(conversationId)
        .then(() => {
          if (cancelled) return;
          queryClient.invalidateQueries({ queryKey: ["unreadMessages"] });
          queryClient.invalidateQueries({ queryKey: ["conversations"] });
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
      // can't be recalled, but its result is ignored and a fresh one goes out —
      // and since the server stamps `last_read_at` with its own clock, the later
      // write is the one that should win anyway.
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [conversationId, ready, messageCount, visibleAgain, queryClient]);
}
