/**
 * Telling the server a thread has been read — and **keeping at it until it
 * lands** (issue #355).
 *
 * This used to be one effect inside `app/messages/[conversationId].tsx`, keyed
 * on the loaded message count and firing a single fire-and-forget POST whose
 * failure was swallowed. Three things were wrong with that, and they only bite
 * in combination:
 *
 * - **A count change was the only trigger.** Not focus, not the app coming back
 *   to the foreground — only a message arriving. Reading changed nothing.
 * - **A failed write was never retried**, on the reasoning that "the next open
 *   marks it again".
 * - **There is no next open.** A push tapped for a thread already on screen
 *   reuses the mounted screen (`router.navigate`, see notifications.md), and
 *   Expo Router keeps a thread mounted underneath its own info screen. Nothing
 *   remounts, so nothing re-fires. The only reliable remount is killing the app
 *   — which is exactly the workaround the bug report arrived with.
 *
 * The marker is not decoration: `send_pushes._should_drop` reads it to decide
 * whether to buzz a phone for a message already on its screen, and
 * `attach_read_receipts` reads it to draw the other person's second tick. A
 * write that silently never happens is a wrong push *and* a wrong tick.
 *
 * **Focus gates the write, but not the tray sweep.** The POST fires only while
 * the screen is focused — marking a thread read the reader has navigated away
 * from would claim a read receipt for messages they cannot see. Taking this
 * thread's notifications *back* has the opposite polarity: it destroys nothing
 * and is wanted the moment the app knows about a message, so it stays on a
 * plain effect exactly as before (#178). Focus-gating that too stranded "New
 * message from Ada" on the lock screen for anyone sitting on the thread's own
 * info screen.
 *
 * Its own module rather than another effect in the screen, for the reason
 * `usePushDismissals` is: a hook can be rendered by a test harness and driven
 * directly, and a closure buried in a 2,000-line screen can't.
 */

import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { AppState, type AppStateStatus } from 'react-native';

import { api } from '@/api';
import { dismissConversationNotifications } from '@/push';

/**
 * Retry schedule for a mark-read that didn't land: attempt *n* waits
 * `MARK_READ_RETRY_MS * n`, so 3s, 6s, 9s.
 *
 * Bounded rather than forever, because a write that has failed four times is
 * failing for a reason a fifth won't fix, and any fresh trigger — a new
 * message, re-focusing the thread, the app foregrounding — starts the schedule
 * over anyway. The old code's mistake was having no retry *and* no reliable
 * next trigger; either one alone would have been survivable.
 */
export const MARK_READ_RETRY_MS = 3000;
export const MARK_READ_MAX_ATTEMPTS = 4;

/**
 * Everything one mark-read from *inside a thread* implies for the cache.
 *
 * **Deliberately not `['conversation', id]`**, which the conversation list's
 * own mark-read (`(tabs)/messages.tsx`) does invalidate. The difference is
 * frequency, not principle: the list's is a one-shot swipe, where a header left
 * disagreeing with the row would read as a bug, while this fires on every
 * arriving message, every re-focus and every foreground. Invalidating the
 * heaviest per-thread payload — participants and every read marker — that often
 * would replace one polled fetch per 12s with one per message, and the reader is
 * already looking at the thread it would refresh.
 */
export function invalidateThreadRead(queryClient: QueryClient): void {
  queryClient.invalidateQueries({ queryKey: ['unreadMessages'] });
  queryClient.invalidateQueries({ queryKey: ['conversations'] });
}

/**
 * Mark `conversationId` read while its screen is focused.
 *
 * `ready` is the screen's own "the transcript is actually on screen" answer
 * (`readingMessages`), passed in rather than re-derived: asking the question a
 * second way here is how the two answers drift apart, which is the lesson of
 * #315/#321/#324. `messageCount` is the loaded message count — it is a
 * *trigger*, not an input, and the same goes for the app's foreground
 * transitions.
 */
export function useMarkThreadRead(
  conversationId: number,
  ready: boolean,
  messageCount: number
): void {
  const queryClient = useQueryClient();
  const [foregrounds, setForegrounds] = useState(0);

  /**
   * Coming back to the app is a reason to re-assert the marker, and one the old
   * effect had no way to notice: the phone was locked when the message arrived,
   * so `focusManager` had `refetchInterval` paused and no count changed while
   * it was away.
   *
   * **The transcript is refetched first, and the counter only moves if that
   * succeeds.** The server stamps the marker `now()`, so firing against the
   * *cached* pages would claim "read" over every message that arrived while the
   * phone was locked — messages this client hasn't fetched and the reader has
   * never seen. That would bin their queued push (`_should_drop`) and draw the
   * sender a second tick for something nobody read: the #315/#321/#324 rule
   * broken through a door those guards don't cover, and worse than the bug this
   * hook fixes, because a lost push is silent. Refetching first means the
   * marker can only ever claim messages the client actually holds.
   */
  useEffect(() => {
    const queryKey = ['messages', conversationId];
    // **`background` → `active`, not merely `active`.** iOS emits
    // `inactive` → `active` for Control Centre, the notification shade, a
    // permission dialog, an incoming-call banner and the app switcher. Treating
    // those as a foreground would force a transcript refetch and a `read/` POST
    // every time someone glanced at Control Centre while a thread was open.
    let previous: AppStateStatus = AppState.currentState;
    const subscription = AppState.addEventListener(
      'change',
      (next: AppStateStatus) => {
        const returning = previous === 'background' && next === 'active';
        previous = next;
        if (!returning) return;
        queryClient
          .refetchQueries(
            { queryKey },
            {
              // `throwOnError` turns a *failed* fetch into a rejection, which
              // the `.catch` below swallows without claiming a read.
              throwOnError: true,
              // **Not cancelling.** `_layout.tsx` wires `focusManager` to the
              // same AppState event, so query-core is already refetching this
              // query — and `cancelRefetch` defaults to true, which would abort
              // that and replay every loaded page of an infinite query again.
              cancelRefetch: false,
            }
          )
          .then(() => {
            // **The promise alone is not proof.** `refetchQueries` returns
            // `Promise.resolve()` for a query the online manager *paused* — it
            // never attempted the fetch, so `throwOnError` has nothing to throw
            // (query-core `queryClient.js`: `fetchStatus === "paused" ?
            // Promise.resolve() : promise`). Unlocking with no signal is
            // exactly that case, and exactly the one this guard exists for, so
            // the cache has to be asked directly. `onlineManager` is unwired on
            // this client today (`_layout.tsx`), which makes the check dead
            // weight here and load-bearing the moment that lands — and its twin
            // needs it now, because the browser wires it by default.
            const current = queryClient.getQueryCache().findAll({ queryKey });
            const unfinished = current.some(
              (query) =>
                query.state.fetchStatus === 'paused' ||
                query.state.status === 'error'
            );
            if (unfinished) return;
            setForegrounds((n) => n + 1);
          })
          // A refetch we couldn't complete is precisely when we must *not*
          // claim a read. The screen's own poll will come round again.
          .catch(() => {});
      }
    );
    return () => subscription.remove();
  }, [conversationId, queryClient]);

  /**
   * Take this thread's notifications back off the lock screen (#178).
   *
   * A plain effect, deliberately **not** the focused one below: this is wanted
   * as soon as the app knows about a message, and the thread sitting behind its
   * own info screen is exactly when a push for it gets *filed* rather than
   * suppressed (blur clears `setOnScreenConversation`). Gating it on focus left
   * those notifications stranded until the reader happened to navigate back
   * through the thread itself.
   *
   * Not chained onto the write either: whether the server hears about the read
   * doesn't change the fact the user has read it, and the shade is local. It
   * deliberately does *not* re-run on `foregrounds` — `usePushDismissals`
   * already sweeps the whole tray on every foreground, and a second full
   * `getPresentedNotificationsAsync` beside it would be pure duplication.
   */
  useEffect(() => {
    if (!ready) return;
    void messageCount;
    void dismissConversationNotifications([conversationId]);
  }, [conversationId, ready, messageCount]);

  useFocusEffect(
    useCallback(() => {
      if (!ready) return;
      // `messageCount` and `foregrounds` are **triggers**: the effect re-runs
      // when either changes, which is the whole reason they're in the
      // dependency list. Naming them keeps that list honest rather than
      // pretending the body reads them. Unlike the web twin these are
      // load-bearing — the dep array sits on `useCallback`, which the lint rule
      // *does* police for unnecessary entries.
      void messageCount;
      void foregrounds;

      let cancelled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const attempt = (n: number): void => {
        api
          .markConversationRead(conversationId)
          .then(() => {
            // **Not gated on `cancelled`.** The write landed, so the badge and
            // the conversation list are wrong until something says so — and
            // these are global cache operations, safe long after this screen has
            // gone. Blur runs the cleanup below, so gating this left the tab
            // badge claiming mail the reader had just read whenever they tapped
            // Back inside the round trip: the exact symptom the hook exists to
            // remove.
            invalidateThreadRead(queryClient);
          })
          .catch(() => {
            // Caught, not swallowed. This fires exactly when the connection is
            // patchy, which is when it will reject — and an uncaught rejection
            // is a redbox in development for a write we intend to repeat.
            if (cancelled || n >= MARK_READ_MAX_ATTEMPTS) return;
            timer = setTimeout(() => attempt(n + 1), MARK_READ_RETRY_MS * n);
          });
      };

      attempt(1);

      return () => {
        // A re-run (new message, re-focus, foreground) supersedes whatever the
        // last one was doing. The in-flight POST can't be recalled, but a fresh
        // one goes out — and since the server stamps `last_read_at` with its own
        // clock, the later write is the one that should win anyway. Only the
        // *retry chain* is cancelled here; the invalidation is not.
        cancelled = true;
        if (timer) clearTimeout(timer);
      };
    }, [conversationId, ready, messageCount, foregrounds, queryClient])
  );
}
