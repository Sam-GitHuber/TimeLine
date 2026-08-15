/**
 * What the app does when a render throws (issue #299) — the mobile half.
 *
 * ## What Expo Router does on its own: nothing
 *
 * The issue asked someone to check the default before writing anything, on the
 * suspicion that the mobile failure mode might already be gentler than the
 * web's blank page. It isn't, and it's worth writing down because the framework
 * *looks* like it handles this:
 *
 * `expo-router` ships a `Try` component and a ready-made `ErrorBoundary` view,
 * but `useScreens.fromImport` only wraps a route in `Try` **if that route's
 * module exports an `ErrorBoundary`** — otherwise the route component is
 * mounted bare. Nothing installs the default for you, at any level, in dev or
 * in production. So before this file the app had exactly React's behaviour: an
 * uncaught render error unmounts the tree and leaves a blank screen, on a
 * device where there is no address bar to retype and no reload button.
 *
 * The framework's own `ErrorBoundary` view is also not what we'd want if it
 * were automatic: black background, `Error: <raw message>` shown to whoever is
 * holding the phone, a `Retry` button, and a `/_sitemap` link in dev. Fine for
 * a developer, wrong for someone's mum.
 *
 * ## How the two boundaries here differ
 *
 * `ErrorBoundary` is the per-route one and does the useful work: exported from
 * a screen file, `Try` wraps *that screen's component*, which sits inside the
 * navigator — so the tab bar and the stack survive, and the reader can leave
 * under their own steam. That is the mobile spelling of the web's boundary
 * around the router outlet, and it's why this is exported from every screen
 * rather than only from the root layout.
 *
 * `RootErrorBoundary` is the last line, exported from `app/_layout.tsx`. `Try`
 * wraps the root layout itself, which means its fallback renders **outside**
 * every provider that layout mounts — no `QueryClientProvider`, and the
 * navigator may be the thing that died. So it must not call `useQueryClient`
 * or `router`, and all it can honestly offer is "try again".
 *
 * Keeping the wording and the shape close to `frontend/src/components/
 * ErrorBoundary.jsx` is deliberate: the two clients should agree about what a
 * crash looks like (the rule #216/#227 bought).
 */

import type { ErrorBoundaryProps } from 'expo-router';
import { router } from 'expo-router';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { colors, fonts, fontSize, radius, spacing } from '@/theme';

/**
 * Report the caught error, in every build.
 *
 * **This has to be here, because nothing else does it.** The catching class is
 * expo-router's `Try`, which implements `getDerivedStateFromError` and nothing
 * else — no `componentDidCatch`, no logging. So before this the mobile app
 * caught a render crash, showed a generic apology, and discarded the error
 * completely in a release build: nothing on screen, nothing in the console,
 * nothing in device logs. That is strictly *less* than the pre-#299 behaviour,
 * where React at least reported it — the exact downgrade the web boundary's
 * `componentDidCatch` was written to avoid, and which the docs claimed held for
 * both clients when it only held for one.
 *
 * Tagged like `push.ts`'s warnings so a maintainer reading a device log can tell
 * where it came from.
 */
function useReportCrash(error: Error) {
  useEffect(() => {
    console.error('[crash] render error caught by ErrorBoundary:', error);
  }, [error]);
}

/**
 * Drop the cached responses that most plausibly caused the crash.
 *
 * **`type: 'inactive'` is the load-bearing part.** By the time a fallback is on
 * screen the crashed screen has unmounted, so *its* queries are the inactive
 * ones — which makes "inactive" a precise name for "the data that just killed a
 * screen". The previous unfiltered `resetQueries()` reset the whole cache, which
 * on a phone is worse than it sounds: React Navigation keeps the tabs and the
 * stack beneath mounted, so recovering one crashed screen also blanked the three
 * tab badges, dropped every mounted sibling to its loading state, and threw away
 * every page of every `useInfiniteQuery` — so a reader who had paged months back
 * through a conversation lost the lot to fix an unrelated screen, and the app
 * fired a dozen refetches at once to rebuild it.
 */
function resetCrashedQueries(queryClient: QueryClient) {
  queryClient.resetQueries({ type: 'inactive' });
}

/**
 * The message and stack, in development only.
 *
 * Shown *under* the apology rather than instead of it, so a developer sees the
 * same screen a tester would plus the detail. Never in production: a stack
 * trace means nothing to a family member and reads as "this is really broken",
 * which is the impression the boundary exists to avoid. (`__DEV__` is React
 * Native's build-time flag, so this whole branch is stripped from a release
 * bundle rather than merely skipped.)
 */
function DevDetails({ error }: { error: Error }) {
  if (!__DEV__) return null;
  return (
    <Text style={styles.devDetails} selectable numberOfLines={12}>
      {error?.stack || String(error)}
    </Text>
  );
}

function Button({
  label,
  onPress,
  variant = 'filled',
}: {
  label: string;
  onPress: () => void;
  variant?: 'filled' | 'ghost';
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        variant === 'filled' ? styles.filled : styles.ghost,
        pressed && styles.pressed,
      ]}
    >
      <Text
        style={[
          styles.buttonLabel,
          variant === 'filled' ? styles.filledLabel : styles.ghostLabel,
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/**
 * The per-route fallback. Export it from a screen file and expo-router wraps
 * that screen in it:
 *
 *     export { ErrorBoundary } from '@/components/ErrorBoundary';
 *
 * **Why both actions reset the query cache first.** The likeliest cause of a
 * render error here is one unexpected shape in a cached response — a null where
 * a list was assumed, a field a new server version stopped sending. Retrying
 * onto that same cached object throws again immediately, so the button looks
 * broken. Nothing unsent is dropped: drafts and the outbox have their own
 * storage, and this only clears server data that refetches.
 *
 * "Back to the feed" needs it just as much, which the first version missed: on
 * the feed tab itself `router.replace('/')` targets the route already on screen,
 * so the *only* thing that button did was `retry()` against an untouched cache —
 * a guaranteed re-crash, with no visible response, on the app's most-used
 * screen.
 */
export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  const queryClient = useQueryClient();
  useReportCrash(error);

  return (
    <SafeAreaView style={styles.screen}>
      <View style={styles.centre}>
        <Text style={styles.title}>Something went wrong on this screen</Text>
        <Text style={styles.body}>
          Nothing you did caused this, and nothing you’ve posted is affected.
          Try again, or go back to your feed.
        </Text>
        <View style={styles.actions}>
          <Button
            label="Try again"
            onPress={() => {
              resetCrashedQueries(queryClient);
              retry();
            }}
          />
          <Button
            label="Back to the feed"
            variant="ghost"
            onPress={() => {
              // `replace`, not `back`: the screen we're standing on is broken,
              // and `back` on a cold-start deep link (a tapped notification —
              // the most common way anyone lands deep in this app) has nowhere
              // to go and silently does nothing. The reset matters as much as
              // the navigation — see the note above. `retry()` last, so this
              // screen isn't still in its fallback state if the reader comes
              // back to it.
              resetCrashedQueries(queryClient);
              router.replace('/');
              retry();
            }}
          />
        </View>
        <DevDetails error={error} />
      </View>
    </SafeAreaView>
  );
}

/**
 * The last line, for `app/_layout.tsx`: a crash in the root layout itself, in
 * one of the providers it mounts, or in the navigator.
 *
 * Deliberately hook-free and router-free — see the note at the top of the file:
 * this renders outside everything the root layout provides, so reaching for a
 * query client or the router here would throw *inside the fallback*, which
 * React treats as unrecoverable and answers with the blank screen we're here to
 * prevent. `retry()` is all there is, and it's honest: it re-mounts the layout,
 * which is a phone's version of reloading the page.
 */
export function RootErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  useReportCrash(error);

  return (
    <View style={styles.screen}>
      <View style={styles.centre}>
        <Text style={styles.title}>TimeLine hit a problem</Text>
        <Text style={styles.body}>
          Something went wrong while loading the app. Your account and
          everything in it are fine.
        </Text>
        <View style={styles.actions}>
          <Button label="Try again" onPress={retry} />
        </View>
        <DevDetails error={error} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.surface },
  centre: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
    gap: spacing.sm,
  },
  title: {
    fontSize: fontSize.lg,
    fontWeight: '700',
    color: colors.ink,
    textAlign: 'center',
  },
  body: {
    fontSize: fontSize.sm,
    color: colors.inkSoft,
    textAlign: 'center',
    lineHeight: 20,
    maxWidth: 320,
  },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  button: {
    borderRadius: radius.pill,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  filled: { backgroundColor: colors.accent },
  ghost: {
    borderWidth: 1,
    borderColor: colors.lineStrong,
    backgroundColor: colors.raised,
  },
  pressed: { opacity: 0.7 },
  buttonLabel: { fontSize: fontSize.sm, fontWeight: '600' },
  filledLabel: { color: '#ffffff' },
  ghostLabel: { color: colors.ink },
  devDetails: {
    marginTop: spacing.lg,
    fontFamily: fonts.mono,
    fontSize: 10,
    lineHeight: 14,
    color: colors.inkFaint,
  },
});
