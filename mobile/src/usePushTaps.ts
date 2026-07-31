/**
 * What happens when you act on a push notification (Phase 9, D; Phase 9b M8).
 *
 * Its own module rather than living in `_layout.tsx` so it can be tested
 * directly — the cold-start path is the one the plan singles out as easy to
 * get wrong, and it is not something a manual pass reliably catches.
 *
 * `useLastNotificationResponse` covers **both** cases in one API: a tap that
 * launched the app from cold, and one that arrives while it is already
 * running. The listener-only approach
 * (`addNotificationResponseReceivedListener`) misses the cold start entirely —
 * the response fires before any listener is mounted — which is the classic way
 * this ships broken.
 *
 * **Two kinds of response now** (Phase 9b M8). A plain tap opens a screen, as it
 * always has. A **Reply** — typed into the notification itself, without the app
 * coming to the foreground — sends a message and navigates nowhere: opening the
 * thread would defeat the point of answering without leaving what you were
 * doing.
 */

import * as Notifications from 'expo-notifications';
import { router, useRootNavigationState } from 'expo-router';
import { useEffect, useRef } from 'react';

import { api } from '@/api';
import { useAuth } from '@/auth';
import { newOutgoing, updateOutbox } from '@/outbox';
import { conversationIdFromUrl, REPLY_ACTION, routeForNotification } from '@/push';

export function usePushNotificationTaps(): void {
  const { status } = useAuth();
  const response = Notifications.useLastNotificationResponse();
  const navigationState = useRootNavigationState();
  const handled = useRef<string | null>(null);

  useEffect(() => {
    // Three reasons to hold off, all of which resolve later:
    //  - no response yet;
    //  - not signed in — a cold-start tap resolves before the token check
    //    does, and navigating now would race the auth gate's redirect to
    //    /login and lose the deep link;
    //  - the router isn't ready, where navigation silently no-ops.
    //
    // The router guard applies to a *reply* too, even though it navigates
    // nowhere. Waiting costs nothing (the response is still here on the next
    // render) and it keeps one definition of "the app is ready to act on this",
    // rather than two that can disagree about a half-started app.
    if (!response || status !== 'signedIn' || !navigationState?.key) return;

    const { identifier } = response.notification.request;
    // The hook keeps returning the *same* response on later re-renders, so
    // without this it would re-navigate every time anything else changed.
    if (handled.current === identifier) return;
    handled.current = identifier;

    const data = response.notification.request.content.data as {
      url?: string;
      // Explicitly nullable: a message push (issue #118) has no activity-centre
      // row behind it and sends `null` here. The truthiness guard below is what
      // keeps that from becoming a request to /notifications/null/addressed/.
      notificationId?: number | null;
    };

    // Replied to from the notification (Phase 9b M8) — send it and stop. No
    // navigation: the whole value of answering from the lock screen is that you
    // don't end up in the app.
    if (response.actionIdentifier === REPLY_ACTION) {
      const text = response.userText?.trim();
      const conversationId = conversationIdFromUrl(data?.url);
      if (text && conversationId) sendReply(conversationId, text);
      return;
    }

    // **`navigate`, not `push`** (#177). `push` appends a screen unconditionally,
    // with no regard for what's already on top — so a push for the thread you are
    // already reading stacked a second copy of it, and Back walked through the
    // duplicates one at a time instead of returning to the list. Three pushes
    // opened on top of each other meant three back-taps.
    //
    // `navigate` replaces the top screen in place when the route name *and* its
    // path params match (expo-router compares `getSingularId`), and pushes
    // normally for a genuinely different target. For the identical target it
    // reuses the existing screen's key, so nothing remounts — a tap on a push for
    // where you already are is the no-op it looks like. The tab targets ('/',
    // '/people', '/groups') were already fine because expo-router downgrades
    // `PUSH` to `NAVIGATE` outside a stack; this gives the stack routes the same
    // behaviour.
    //
    // Not `dismissTo`, which pops back to a match anywhere in the stack: without
    // `dangerouslySingular` (nothing here sets it) its router matches by route
    // *name* only, so a push for conversation 5 tapped while reading
    // conversation 9 would pop 9 off and reuse its screen — losing where you
    // were. Matching on the params is the whole point.
    router.navigate(routeForNotification(data?.url));

    // Tapping a push counts as dealing with it, exactly as clicking a row in
    // the web dropdown does — so the activity centre and the badge stay in
    // step across devices. Best-effort: a failure here must not undo the
    // navigation the user actually asked for.
    if (data?.notificationId) {
      api.markNotificationAddressed(data.notificationId).catch(() => {});
    }
  }, [response, status, navigationState?.key]);
}

/**
 * Send a reply typed into a notification, and **keep it if it doesn't land**.
 *
 * The failure path is the interesting half. There is no screen to report on: by
 * construction the app isn't in front of anyone, and a second notification
 * saying "couldn't send" would be a poor apology for having eaten what they
 * wrote. So a failed reply goes into the same outbox an in-app send uses, where
 * it shows up as a failed bubble with Retry the next time the thread is opened —
 * exactly what happens to a message that fails while you're looking at it. The
 * promise the outbox exists to keep is "we never drop text you typed", and text
 * typed into a notification is no different.
 *
 * Not marked read: sending marks the thread read server-side, which is the right
 * answer and needs nothing from here. Nothing is invalidated either — the app
 * refetches on foreground.
 */
function sendReply(conversationId: number, text: string) {
  api.sendMessage(conversationId, text).catch(() => {
    updateOutbox(conversationId, (entries) => [
      ...entries,
      { ...newOutgoing({ text }), status: 'failed' as const },
    ]);
  });
}
