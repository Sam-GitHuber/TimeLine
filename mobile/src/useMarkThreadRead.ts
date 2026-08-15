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
 * **Focus is the gate, not merely mount.** The write fires whenever the screen
 * is focused and gains a reason to — which also means it no longer fires while
 * the thread sits mounted *behind* its info screen. That's a deliberate
 * tightening: the notification-claim effect beside it already treats "navigated
 * away" as not reading, and marking a thread read that the reader cannot see a
 * line of would tell the sender they'd read it.
 *
 * Its own module rather than another effect in the screen, for the reason
 * `usePushDismissals` is: a hook can be rendered by a test harness and driven
 * directly, and a closure buried in a 2,000-line screen can't.
 */

import { useQueryClient } from '@tanstack/react-query';
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
   * effect had no way to notice.
   *
   * It matters most in precisely the reported case: the phone was locked when
   * the message arrived, so `focusManager` had `refetchInterval` paused and no
   * count changed while it was away. Counting transitions rather than tracking
   * a boolean keeps this a plain trigger — every `active` is a fresh reason to
   * write, even if the last one also was.
   */
  useEffect(() => {
    const subscription = AppState.addEventListener(
      'change',
      (next: AppStateStatus) => {
        if (next === 'active') setForegrounds((n) => n + 1);
      }
    );
    return () => subscription.remove();
  }, []);

  useFocusEffect(
    useCallback(() => {
      if (!ready) return;
      // `messageCount` and `foregrounds` are **triggers**: the effect re-runs
      // when either changes, which is the whole reason they're in the
      // dependency list. Naming them keeps that list honest rather than
      // pretending the body reads them.
      void messageCount;
      void foregrounds;

      let cancelled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const attempt = (n: number): void => {
        api
          .markConversationRead(conversationId)
          .then(() => {
            if (cancelled) return;
            queryClient.invalidateQueries({ queryKey: ['unreadMessages'] });
            queryClient.invalidateQueries({ queryKey: ['conversations'] });
          })
          .catch(() => {
            // Caught, not swallowed. This fires exactly when the connection is
            // patchy, which is when it will reject — and an uncaught rejection
            // is a redbox in development for a write we intend to repeat.
            if (cancelled || n >= MARK_READ_MAX_ATTEMPTS) return;
            timer = setTimeout(() => attempt(n + 1), MARK_READ_RETRY_MS * n);
          });
      };

      // Take this thread's notifications back off the lock screen (#178).
      // Deliberately not chained onto the write: whether the server hears about
      // it doesn't change the fact the user has read it, and the shade is local.
      void dismissConversationNotifications([conversationId]);
      attempt(1);

      return () => {
        // A re-run (new message, re-focus, foreground) supersedes whatever the
        // last one was doing. The in-flight POST can't be recalled, but its
        // result is ignored and a fresh one goes out — and since the server
        // stamps `last_read_at` with its own clock, the later write is the one
        // that should win anyway.
        cancelled = true;
        if (timer) clearTimeout(timer);
      };
    }, [conversationId, ready, messageCount, foregrounds, queryClient])
  );
}
