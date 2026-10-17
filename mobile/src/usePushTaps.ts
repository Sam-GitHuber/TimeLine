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
import {
  router,
  useNavigationContainerRef,
  useRootNavigationState,
} from 'expo-router';
import { useEffect, useRef } from 'react';

import { api } from '@/api';
import { useAuth, useOnLoginScreen } from '@/auth';
import { newOutgoing, updateOutbox } from '@/outbox';
import { isAnyScreenHeld } from '@/writeHold';
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
  // Read at tap time, not subscribed to: only a message push needs to know
  // what's on screen (#398), and depending on the state itself would re-run
  // this effect on every navigation for the rest of the session.
  const container = useNavigationContainerRef();
  // Shared with AuthGate, which is the effect this one has to sequence itself
  // against — see `useOnLoginScreen` for why it's one definition and not two.
  const onLoginScreen = useOnLoginScreen();
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
    // The last one is the *warm* half of the race the sign-in guard covers, and
    // `status === 'signedIn'` cannot see it. Tap a push while signed out and you
    // land on /login with the response held here. Sign in, and the status flips
    // while /login is still the top screen — so in one render flush this effect
    // navigates to the target and then AuthGate's own effect, seeing
    // `signedIn && onLoginScreen`, calls `router.replace('/')` over the top of
    // it. `handled.current` is set by then, so the deep link is gone for good:
    // you asked for Ada's thread and arrived at the feed, with nothing saying
    // why. Waiting for the login screen to go away means we act *after* that
    // redirect rather than in front of it, and the target survives.
    //
    // The two guards are a pair, not alternatives. A cold start with no stored
    // token *does* reach `['login']` — `loading` (Stack unmounted, no segments)
    // → `signedOut` → Stack mounts → AuthGate redirects to /login — at which
    // point it simply *is* the warm case above. What makes cold start safe is
    // that the sign-in guard holds throughout the part where segments are still
    // empty, and this one takes over from there. Neither covers it alone.
    //
    // All four apply to a *reply* too, even though it navigates nowhere.
    // Waiting costs nothing (the response is still here on the next render) and
    // it keeps one definition of "the app is ready to act on this", rather than
    // two that can disagree about a half-started app.
    if (
      !response ||
      status !== 'signedIn' ||
      !navigationState?.key ||
      onLoginScreen
    ) {
      return;
    }

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

    // A message opens over the Messages list, not over wherever you were (#398).
    const conversationId = conversationIdFromUrl(data?.url);
    if (conversationId) {
      openConversationOverList(conversationId, container.getRootState());
    } else {
      // **`navigate`, not `push`** (#177). `push` appends a screen
      // unconditionally, with no regard for what's already on top — so a push
      // for the thread you are already reading stacked a second copy of it, and
      // Back walked through the duplicates one at a time instead of returning
      // to the list. `navigate` replaces the top screen in place when the route
      // name *and* its path params match, and pushes normally for a different
      // target. Why that verb and not `dismissTo`, and what it does **not**
      // cover, are in notifications.md — read it before changing this line.
      router.navigate(routeForNotification(data?.url));
    }

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
  }, [
    response,
    status,
    navigationState?.key,
    onLoginScreen,
    queryClient,
    container,
  ]);
}

/** The slice of a navigator's state that `openConversationOverList` reads. */
type NavState = {
  index?: number;
  routes?: { name: string; params?: object; state?: NavState }[];
};

/**
 * The app's root **stack** — `app/_layout.tsx`'s `<Stack>` — inside the
 * container's state.
 *
 * Not the container's top level: expo-router wraps the whole app in a navigator
 * of its own whose one route is `__root`, and the stack is that route's nested
 * state. (`useRootNavigationState` returns that wrapper too, despite its name.)
 * Reading the wrapper as if it were the stack sees one route called `__root`
 * forever — never a thread on top, never anything to pop — and the code
 * below would quietly fall back to doing nothing useful.
 */
function rootStack(state: NavState | undefined): NavState | undefined {
  let current = state;
  while (current) {
    const routes = current.routes ?? [];
    const top = routes[current.index ?? routes.length - 1];
    if (top?.name !== '__root' || !top.state) return current;
    current = top.state;
  }
  return undefined;
}

/**
 * Open a thread from a push so that **Back lands on the Messages list** (#398).
 *
 * Back in a thread pops the root stack, so where it lands is decided by what
 * the thread was opened *over*. From the Messages tab that's the list. A push,
 * though, is tapped from anywhere — the feed, a post, someone's profile — and a
 * plain `navigate` stacked the thread over that, so Back (and iOS's swipe-back,
 * which is the same pop) dropped you somewhere with nothing to do with
 * messaging. WhatsApp and iMessage both go to the list.
 *
 * So the stack is rebuilt as *tabs on Messages → thread* first: pop the root
 * stack to the tabs, switch to the Messages tab, then open the thread. Fixing
 * it here rather than in the thread's Back keeps the button and the swipe in
 * agreement, because neither has to know where the thread came from. The one
 * place a thread is deliberately opened over something else is a profile's
 * Message button, where Back returning to that profile is the point.
 *
 * **The thread already on top is left alone** (#177): popping it would remount
 * the screen you're reading and throw away where you'd scrolled to. `navigate`
 * collapses onto it exactly as it did before. Neither is a screen holding a
 * write open — see below. The three router calls run in
 * order against the state each one leaves (expo-router queues them), and the
 * last is `navigate` rather than `push` so nothing in this path can stack a
 * duplicate either.
 */
export function openConversationOverList(
  conversationId: number,
  containerState: NavState | undefined
): void {
  const href = `/messages/${conversationId}` as const;
  const stack = rootStack(containerState);
  const routes = stack?.routes ?? [];
  const top = routes[stack?.index ?? routes.length - 1];
  const params = top?.params as { conversationId?: string } | undefined;
  if (
    top?.name === 'messages/[conversationId]' &&
    params?.conversationId === String(conversationId)
  ) {
    router.navigate(href);
    return;
  }
  // **A screen holding a write open is never popped from under it** (#256,
  // #257, #259): those screens keep themselves mounted until a save answers,
  // because they're the only thing that can show a refusal. Then the thread is
  // stacked on top as it always was, and the held screen is still there when
  // you come back — Back lands on it rather than the list, which is the lesser
  // loss.
  if (isAnyScreenHeld()) {
    router.navigate(href);
    return;
  }
  // POP_TO_TOP on a stack that's already at its root is an unhandled action,
  // which React Navigation warns about — so only when there's something to pop.
  if (routes.length > 1) router.dismissAll();
  router.navigate('/messages');
  router.navigate(href);
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
