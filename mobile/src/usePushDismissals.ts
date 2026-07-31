/**
 * Clearing stale notifications when the app comes back to the foreground
 * (#178, case E).
 *
 * The rest of the dismissal work in this release is driven by something the
 * user does *on this phone* — open a thread, open the activity centre, reply
 * from the lock screen. This covers the other way a notification goes stale:
 * you read the message **somewhere else**, on the web or a second device, and
 * this phone was never told.
 *
 * Doing that properly needs the server to reach a phone that isn't running the
 * app, and there is no APNs/FCM "unsend" — only a silent push, which iOS
 * budgets and throttles at its own discretion and Android may not deliver at
 * all from a stopped state. That's issue #178's case D, deliberately parked
 * until Phase 10b's background-delivery spike says what those paths can
 * actually promise.
 *
 * This is the cheap 80% of it, and it's honest about which 80%: it doesn't
 * clean the shade *before* you pick the phone up, but it means a phone that sat
 * next to a laptop all afternoon isn't a wall of already-read notifications the
 * moment you look at it.
 *
 * Its own module rather than another effect in `_layout.tsx` for the reason
 * `usePushTaps` is: a hook can be rendered by a test harness and driven
 * directly, and an AppState listener buried in the root layout can't.
 */

import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { AppState, type AppStateStatus } from 'react-native';

import { api } from '@/api';
import { useAuth } from '@/auth';
import {
  dismissConversationNotifications,
  presentedConversationIds,
} from '@/push';

export function usePushDismissals(): void {
  const { status } = useAuth();
  const queryClient = useQueryClient();

  useEffect(() => {
    // Nothing to reconcile against while signed out, and the fetch would 401.
    if (status !== 'signedIn') return;

    const subscription = AppState.addEventListener(
      'change',
      (next: AppStateStatus) => {
        if (next === 'active') void reconcile(queryClient);
      }
    );
    return () => subscription.remove();
  }, [status, queryClient]);
}

/**
 * Drop delivered notifications for conversations that are no longer unread.
 *
 * **The tray is consulted first, and an empty one costs nothing.** That order
 * matters more than it looks: the overwhelmingly common foreground has no
 * notifications waiting at all, and this must not add a request to every one of
 * them.
 *
 * `fetchQuery` rather than a bare `api.getConversations()` so the answer lands
 * in the same `['conversations']` cache the messages tab reads — the app is
 * refetching this on foreground anyway when that tab is mounted, and going
 * through the client means the two share one in-flight request instead of
 * racing two.
 *
 * Only the **first page** of conversations is examined, which is the safe
 * direction to be wrong in: a thread too far down the list to appear simply
 * doesn't get dismissed, which is exactly what happened before any of this
 * existed. Conversations sort by most-recent-activity, so a thread with a
 * delivered notification is near the top by definition.
 */
async function reconcile(queryClient: QueryClient): Promise<void> {
  try {
    const waiting = await presentedConversationIds();
    if (!waiting.size) return;

    const conversations = await queryClient.fetchQuery({
      queryKey: ['conversations'],
      queryFn: api.getConversations,
    });

    const read = conversations.results
      .filter((convo) => waiting.has(convo.id) && convo.unread_count === 0)
      .map((convo) => convo.id);
    await dismissConversationNotifications(read);
  } catch {
    // Best-effort, like every dismissal path: a failed reconcile leaves the
    // notification where it was, which is the behaviour this replaced.
  }
}
