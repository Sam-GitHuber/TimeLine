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

import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import * as Notifications from 'expo-notifications';
import { router, useRootNavigationState, useSegments } from 'expo-router';
import { useEffect, useRef } from 'react';

import { api } from '@/api';
import { useAuth } from '@/auth';
import { newOutgoing, updateOutbox } from '@/outbox';
import {
  conversationIdFromUrl,
  dismissConversationNotifications,
  REPLY_ACTION,
  routeForNotification,
} from '@/push';

export function usePushNotificationTaps(): void {
  const { status } = useAuth();
  const response = Notifications.useLastNotificationResponse();
  const navigationState = useRootNavigationState();
  // A boolean, not the array: `useSegments` hands back a fresh array on every
  // render, and depending on that would re-run the effect for every unrelated
  // re-render in the app.
  const onLoginScreen = useSegments()[0] === 'login';
  const handled = useRef<string | null>(null);
  // Both branches below deal with something that was waiting, so both move a
  // count `useBadgeCount` is watching (#179).
  const queryClient = useQueryClient();

  useEffect(() => {
    // Four reasons to hold off, all of which resolve later:
    //  - no response yet;
    //  - not signed in — a cold-start tap resolves before the token check
    //    does, and navigating now would race the auth gate's redirect to
    //    /login and lose the deep link;
    //  - the router isn't ready, where navigation silently no-ops;
    //  - the login screen is still on top (#220 §1).
    //
    // That last one is the *warm* half of the same race the sign-in guard
    // covers, and `status === 'signedIn'` is not enough to see it. Tap a push
    // while signed out and you land on /login with the response held here.
    // Sign in, and the status flips while /login is still the top screen — so
    // in one render flush this effect navigates to the target and then
    // AuthGate's own effect, seeing `signedIn && onLoginScreen`, calls
    // `router.replace('/')` over the top of it. `handled.current` is set by
    // then, so the deep link is gone for good: you asked for Ada's thread and
    // arrived at the feed, with nothing saying why. Waiting for the login
    // screen to go away means we act *after* that redirect rather than before
    // it, and the target survives. (The cold-start path never sees this — the
    // Stack isn't mounted during `loading`, so segments never say `login`.)
    //
    // The router guard applies to a *reply* too, even though it navigates
    // nowhere. Waiting costs nothing (the response is still here on the next
    // render) and it keeps one definition of "the app is ready to act on this",
    // rather than two that can disagree about a half-started app.
    if (!response || status !== 'signedIn' || !navigationState?.key) return;
    if (onLoginScreen) return;

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
      if (text && conversationId) sendReply(conversationId, text, queryClient);
      return;
    }

    // **`navigate`, not `push`** (#177). `push` appends a screen unconditionally,
    // with no regard for what's already on top — so a push for the thread you are
    // already reading stacked a second copy of it, and Back walked through the
    // duplicates one at a time instead of returning to the list. `navigate`
    // replaces the top screen in place when the route name *and* its path params
    // match, and pushes normally for a different target. Why that verb and not
    // `dismissTo`, and what it does **not** cover, are in notifications.md — read
    // it before changing this line.
    router.navigate(routeForNotification(data?.url));

    // Tapping a push counts as dealing with it, exactly as clicking a row in
    // the web dropdown does — so the activity centre and the badge stay in
    // step across devices. Best-effort: a failure here must not undo the
    // navigation the user actually asked for.
    //
    // **Addressed implies seen** (`NotificationAddressedView` sets `seen_at`
    // too), so this drops the unread count — which means the bell and the app
    // icon (#179) are both now wrong until something refetches. Invalidating
    // the same two keys the activity centre's own click-through invalidates is
    // what keeps in-app and push click-through agreeing about the number, the
    // way the comment above already claims they agree about everything else.
    if (data?.notificationId) {
      api
        .markNotificationAddressed(data.notificationId)
        .then(() => {
          queryClient.invalidateQueries({ queryKey: ['notificationsUnread'] });
          queryClient.invalidateQueries({ queryKey: ['notifications'] });
        })
        .catch(() => {});
    }
  }, [response, status, navigationState?.key, onLoginScreen, queryClient]);
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
 * answer and needs nothing from here.
 *
 * **The unread count is invalidated, though** (#179), and that's a change of
 * mind rather than an oversight corrected. "The app refetches on foreground"
 * was a fine answer while nothing outside the app showed a count: by the time
 * you looked, you were looking at the app. The icon badge broke that — this is
 * the one path that deals with a message while the app is deliberately *not* in
 * front of anyone, so the next thing the user sees is the home screen, and an
 * icon still claiming an unread message they just answered is the most visible
 * possible version of this being wrong. One cheap GET, on the success path only
 * (see below), and a failure to complete it leaves the badge exactly where it
 * would have been anyway.
 *
 * A **landed** reply also clears that thread's other notifications (#178) —
 * answering deals with the whole conversation, not just the one notification
 * that was pulled down. This is the only dismissal path that runs with the app
 * deliberately *not* in the foreground, which `opensAppToForeground: false`
 * makes fine.
 *
 * On the success path only, and that ordering is the point. A reply that failed
 * has changed nothing server-side — the read marker moves inside the send's
 * transaction, so the thread is still unread — and with no screen in front of
 * anyone, that notification is the only remaining trace that something is
 * waiting. Dismissing first would take away the prompt and leave the sender
 * with no answer.
 */
function sendReply(
  conversationId: number,
  text: string,
  queryClient: QueryClient
) {
  api.sendMessage(conversationId, text).then(
    () => {
      void dismissConversationNotifications([conversationId]);
      // Same success-only rule as the dismissal it sits beside: a reply that
      // failed moved no read marker, so the thread is still unread and the
      // badge is still right.
      void queryClient.invalidateQueries({ queryKey: ['unreadMessages'] });
      void queryClient.invalidateQueries({ queryKey: ['conversations'] });
    },
    () => {
      updateOutbox(conversationId, (entries) => [
        ...entries,
        { ...newOutgoing({ text }), status: 'failed' as const },
      ]);
    }
  );
}
