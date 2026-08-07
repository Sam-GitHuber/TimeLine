/**
 * Root layout: the providers every screen needs, plus the auth gate.
 *
 * Expo Router renders this around every route, so it is the app's one entry
 * point — the equivalent of `main.jsx` + `App.jsx` in the web app.
 */

import {
  QueryClient,
  QueryClientProvider,
  focusManager,
} from '@tanstack/react-query';
import { Stack, router, useRootNavigationState, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import {
  ActivityIndicator,
  AppState,
  type AppStateStatus,
  StyleSheet,
  View,
} from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { KeyboardProvider } from 'react-native-keyboard-controller';

import { AuthProvider, useAuth } from '@/auth';
import { PreferencesProvider } from '@/preferences';
import {
  configureNotificationCategories,
  configureNotificationChannels,
  configureNotificationHandler,
  configureOnScreenDismissal,
} from '@/push';
import { useBadgeCount } from '@/useBadgeCount';
import { usePushDismissals } from '@/usePushDismissals';
import { usePushNotificationTaps } from '@/usePushTaps';
import { useSessionReset } from '@/useSessionReset';
import { colors } from '@/theme';

// Module scope, not an effect: the handler decides whether a notification that
// arrives while the app is foregrounded is shown at all, and it has to be set
// before any notification can be delivered.
configureNotificationHandler();
// Likewise at module scope, and for a closely related reason: the Reply action
// (Phase 9b M8) has to be registered with iOS before a notification carrying
// its category can arrive, which can be before anyone signs in on this launch.
configureNotificationCategories();
// And the Android notification channels (Phase 10), for the same reason again:
// a push naming a channel the device hasn't created yet is dropped silently
// rather than falling back to a default. No-op on iOS.
configureNotificationChannels();
// And, at module scope for the third time and the same reason, the listener that
// takes back a message push for the thread already on screen (#178). Android
// posts anything that banners to the shade whatever the handler says about the
// notification centre, so the arrival itself has to be the trigger there.
configureOnScreenDismissal();

/**
 * Created once at module scope, not inside the component: a QueryClient holds
 * the cache, so rebuilding it on a re-render would throw away every cached
 * response. Milestone C leans on this cache for the feed.
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // A 401 is handled by the refresh path in `api.ts`; if a request still
      // carries one after that, the server has refused the refresh token and the
      // session is genuinely gone, so retrying is pointless noise. Retry other
      // failures once — phones drop connections constantly.
      //
      // Since #245 that no longer means "every failure the refresh path
      // produces". A refresh that never reached the server rejects with
      // `status: 0` and keeps the session, so it lands in the retry-once branch
      // — which is what we want: the retry runs a second later on the still-good
      // token, and if signal came back in between the screen loads instead of
      // erroring. Bounded at one, so a connection that's still down can't loop.
      retry: (failureCount, error) =>
        (error as { status?: number })?.status === 401 ? false : failureCount < 1,
    },
  },
});

/**
 * Sends the user to the right place when their auth state changes.
 *
 * Redirecting from an effect (rather than rendering one tree or the other) is
 * the pattern Expo Router documents: the router owns the URL, so pushing it
 * around keeps deep links working — which matters a lot in Milestone D, where a
 * tapped push notification has to land on a real route even from a cold start.
 */
function AuthGate() {
  const { status } = useAuth();
  const segments = useSegments();
  // All three live here rather than in RootLayout because they read auth state,
  // and so must be inside AuthProvider (the dismissal reconcile and the badge
  // count also need the QueryClientProvider above it).
  usePushNotificationTaps();
  usePushDismissals();
  // The app icon's badge (#179). Here rather than on a screen so it holds
  // whichever tab is on top — and so that signing out clears it.
  useBadgeCount();
  // 🔒 Empties the query cache — the bulk of a session's data — whenever the
  // session ends (#191), so the next person to sign in on this phone starts
  // from nothing rather than from the previous person's cached screens.
  useSessionReset();
  // The router isn't ready to navigate on the very first render; navigating
  // before it is silently does nothing.
  const navigationState = useRootNavigationState();

  useEffect(() => {
    if (!navigationState?.key) return;
    if (status === 'loading') return;

    const onLoginScreen = segments[0] === 'login';

    if (status === 'signedOut' && !onLoginScreen) {
      router.replace('/login');
    } else if (status === 'signedIn' && onLoginScreen) {
      router.replace('/');
    }
  }, [status, segments, navigationState?.key]);

  if (status === 'loading') {
    return (
      <View style={styles.loading}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: colors.surface },
      }}
    >
      {/**
       * 🚫 **No swipe-back on a conversation** — the one screen in the app that
       * gives the gesture up, and the trade is deliberate.
       *
       * A rightward drag on a message bubble means *reply* there (see
       * `components/SwipeToReply`), and iOS's interactive pop gesture wants the
       * same drag. M3 shipped both and the navigator kept winning: you'd swipe a
       * bubble and land on the conversation list with no reply started. Two
       * responders legitimately claiming one drag is not a thing a threshold can
       * fix — one of them has to go, and on a messaging screen the reply is worth
       * more than the second way out.
       *
       * Nobody is stranded: the header's "← Back" is right there and always was,
       * and this is iOS-only anyway — `gestureEnabled` doesn't govern Android's
       * system back gesture, which is the OS's and still works. Set here rather
       * than from the screen so it holds from the first frame, before there's
       * anything to swipe.
       */}
      {/* Declared first and otherwise doing nothing, which is the point:
          expo-router puts explicitly declared screens ahead of the file-system
          ones, so naming only the conversation below would quietly make a
          *dynamic* route the stack's first — the fallback React Navigation
          seeds initial state from, with no `conversationId` to seed it with.
          The tab root is the app's real entry, and saying so costs a line. */}
      <Stack.Screen name="(tabs)" />
      <Stack.Screen
        name="messages/[conversationId]"
        options={{ gestureEnabled: false }}
      />
    </Stack>
  );
}

/**
 * Tell TanStack Query when the app comes back to the foreground.
 *
 * Query's built-in refetch-on-focus listens for the browser's `visibilitychange`
 * event, which does not exist in React Native — so without this, **nothing ever
 * counts as a refocus** and a backgrounded app shows whatever it last fetched
 * until the user pulls to refresh.
 *
 * That matters more on a phone than on the web: people background an app for
 * hours and expect the feed to be current when they come back. It was visible
 * in testing — a post made while the app was backgrounded stayed missing after
 * reopening it.
 *
 * (Network reconnection is the sibling case, and needs `onlineManager` wired to
 * NetInfo. Deferred: it's another dependency, and v1 is deliberately online-only.
 * Note before wiring it: leaving it unwired is what makes an offline mutation
 * *reject*. Wired, React Query's default `networkMode: 'online'` **pauses** it
 * instead, and anything awaiting `mutateAsync` — or waiting on `onError` — to
 * report a failure would hang there instead, silently, since the `catch` or
 * callback that says so never runs. Five components depend on that today:
 *
 *   - `components/events/PollTally.tsx` — rolls its optimistic tick back.
 *   - `components/events/RsvpBar.tsx` — shows that your guests/note didn't save.
 *   - `components/BlockButton.tsx` and `components/ConnectButton.tsx` (#236) —
 *     say that a block/connect didn't land. **These two are the sharp ones:**
 *     they hold `DisconnectWarningModal` open while the write is in flight, and
 *     that dialog refuses Cancel, the backdrop, and Android back while busy. A
 *     paused mutation never settles, so the user is sealed inside a "Working…"
 *     dialog with no way out — worse than the silence #236 fixed.
 *   - `components/MessageButton.tsx` (#236) — alerts from `onError`; paused, the
 *     button sticks on "Opening…" forever.
 *   - `app/events/[eventId].tsx` (#237) — seven of the organiser's writes
 *     (`finalise`, `openPoll`, `closePoll`, `reopenPoll`, `deletePoll`, `cancel`,
 *     `remove`) report *only* from `onError`. Paused, every one of them is
 *     silent again, which is the whole bug #237 fixed — and `cancel` is the one
 *     that leaves you believing everyone who RSVP'd was told.
 *
 * **And, as of #256/#257/#259, every form that holds itself open while its
 * write is in flight** — `src/writeHold.tsx` and its callers. These are the
 * same shape as the `DisconnectWarningModal` case above and just as sharp:
 * a paused mutation never settles, so the hold never lets go and the form
 * refuses its Cancel, the screen's Back, Android's back and iOS's swipe
 * *forever*. That is a screen with no way out at all, reached by pressing Save
 * with no signal — the single most likely way any of this is used. Fourteen
 * forms across nine screens; grep `useHoldOpen` / `useHoldScreen` for the
 * current list rather than trusting a copy here, and note that three of the
 * event screen's own writes (`rsvp`, `vote`, `editPoll`) join the seven listed
 * above for a second reason.
 *
 * Check all of it before wiring it — and if it is wired, these holds need a
 * bypass, because "offline" stops being a rejection they can report.)
 */
function useRefetchOnForeground() {
  useEffect(() => {
    const subscription = AppState.addEventListener(
      'change',
      (status: AppStateStatus) => focusManager.setFocused(status === 'active')
    );
    return () => subscription.remove();
  }, []);
}

export default function RootLayout() {
  useRefetchOnForeground();

  return (
    // GestureHandlerRootView must wrap the app for react-native-gesture-handler
    // to work (the avatar cropper's pinch/pan). It also re-roots inside its own
    // Modal, but wrapping here is the documented baseline and covers any future
    // gesture surface.
    <GestureHandlerRootView style={styles.root}>
      {/* Tracks the keyboard's insets and feeds every `KeyboardAvoider` in the
          app. It has to be above the navigator, because the thing it measures
          is the window — and without it the avoiders render but never move,
          which looks exactly like the Android bug they were added to fix.
          No `statusBarTranslucent`/`navigationBarTranslucent` needed: those are
          for apps that make the bars translucent by hand, whereas Expo's
          edge-to-edge already does it and the library detects the same
          `edgeToEdgeEnabled` build flag we set. */}
      <KeyboardProvider>
        <QueryClientProvider client={queryClient}>
          <AuthProvider>
            <PreferencesProvider>
              <StatusBar style="dark" />
              <AuthGate />
            </PreferencesProvider>
          </AuthProvider>
        </QueryClientProvider>
      </KeyboardProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  loading: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
  },
});
