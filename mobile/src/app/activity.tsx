/**
 * The activity centre (Phase 9 E4c) — the unified "something happened to you"
 * list, ported from the web `ActivityCenter`. A root-stack sibling of `(tabs)`,
 * pushed full-screen over the tabs from the feed-header bell (its non-tab home;
 * five tabs is the iOS max — the E4 nav decision).
 *
 * Three states drive each row's look, matching the model (see notifications.md):
 *   - unread    → bold, with an accent dot; what the bell badge counts.
 *   - seen      → normal weight, but still stands out until dealt with. Opening
 *                 this screen marks everything currently-unread *seen*, so the
 *                 badge clears while the items stay in the list.
 *   - addressed → dulled, but kept in the history. Tapping a row addresses it.
 *
 * Delivery is polling (push is the *additional* channel from Milestone D, not a
 * replacement). Tapping a row deep-links via `routeForNotification` — the *same*
 * map push taps use (`usePushTaps`), so in-app and push click-through agree.
 */

import {
  useInfiniteQuery,
  useQueryClient,
  type InfiniteData,
} from '@tanstack/react-query';
import { router } from 'expo-router';
import { useEffect, useRef } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { api, serverMessage, WENT_WRONG } from '@/api';
import { Avatar } from '@/components/Avatar';
import { dedupeById, trimToFirstPage } from '@/lists';
import { dismissActivityNotifications, routeForNotification } from '@/push';
import { colors, fontSize, radius, spacing } from '@/theme';
import type { Notification, Paginated } from '@/types';
import { formatRelativeTime } from '@/utils';

// A render error on this screen stops here instead of blanking the whole app
// (#299). expo-router wraps a route in its `ErrorBoundary` export, and installs
// nothing by default — see `components/ErrorBoundary` for what that means.
export { ErrorBoundary } from '@/components/ErrorBoundary';

export default function ActivityScreen() {
  const queryClient = useQueryClient();
  const goBack = () => (router.canGoBack() ? router.back() : router.replace('/'));

  // Paginated (#134), following the paginator's `next` like every other list in
  // the app — see notifications.md for what rendering `results` alone cost.
  const {
    data,
    isLoading,
    isError,
    error,
    refetch,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery({
    queryKey: ['notifications'],
    queryFn: ({ pageParam }) =>
      pageParam ? api.getPage<Notification>(pageParam) : api.getNotifications(),
    initialPageParam: '',
    getNextPageParam: (lastPage) => lastPage.next ?? undefined,
  });
  // `dedupeById` for the reason the feed uses it: a page-number window shifts
  // when a notification lands mid-scroll.
  const notifications = dedupeById(data?.pages.flatMap((page) => page.results) ?? []);

  /**
   * **Is the list itself on screen?** (#312) This screen had no error branch at
   * all: a failed load leaves `data` undefined, `notifications` falls back to
   * `[]`, and "You're all caught up" — a flat statement of fact — rendered on
   * the strength of a request that never arrived.
   *
   * `!!data` rather than a bare `isError`, the same way round as every other
   * screen (*Branch on the data, not the query flags*, `mobile-app.md`): a
   * failed *refetch* keeps the pages already loaded, and those stay up rather
   * than being replaced by an apology.
   *
   * Declared here, next to the data, because the seen-write below has to ask the
   * same question — asking it a second way is how the two halves of a file
   * drift apart (#315).
   */
  const listLoaded = data !== undefined;
  const loadFailed = isError && !listLoaded;

  // Leaving drops back to a single page — the app's half of the web dropdown's
  // trim-on-close (notifications.md). The ['notifications'] cache outlives this
  // screen, so otherwise the next visit, and the seen-on-open invalidation
  // below it, refetch every page the last visit scrolled through.
  //
  // `mounted` rides along here rather than in the seen-write's own cleanup so
  // that it means what it says: the write fires when the list lands, which can
  // be several renders after mount, and a cleanup that re-ran on any dependency
  // change would cancel a POST that is still perfectly live.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      queryClient.setQueryData<InfiniteData<Paginated<Notification>, string>>(
        ['notifications'],
        trimToFirstPage
      );
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Opening the screen marks everything currently-unread *seen* — the badge
   * clears, but every item stays in the list (that's the whole point). Fire it
   * once per visit, then refresh the badge + list so both reflect it. Any unread
   * that arrive *after* this stay unread until the next open, which is fine —
   * the web behaves the same (it marks seen on the open transition).
   *
   * **It waits for the list now (#312), where it used to fire on mount.** The
   * two came apart in the case that matters: open the bell with no signal, the
   * fetch fails, and this cleared every unread server-side while the screen
   * said "You're all caught up" — so the badge that would have brought you back
   * was gone, and the screen had just told you there was nothing to come back
   * for. That is the #307/#308 rule reaching a second surface: a write that
   * mirrors what the reader has *seen* has to ride the read that showed it to
   * them, not a render that happened anyway.
   *
   * `listLoaded`, not `isSuccess`: a warm cache whose refetch failed is still a
   * screen full of notifications the reader is looking at, and those have been
   * seen. It's the same value the empty/error branches below read.
   *
   * The ref makes it once-per-visit rather than once-per-mount — the effect now
   * has to re-run to notice the list arriving, and only the first pass through
   * should write.
   */
  const seenWritten = useRef(false);
  useEffect(() => {
    if (!listLoaded || seenWritten.current) return;
    seenWritten.current = true;
    // …and takes back the OS notifications behind them (#178). The same
    // reasoning one line up: the row is *kept*, its badge signal is cleared,
    // and a notification sitting in the shade is a badge signal. Fired
    // alongside the POST rather than after it — the user has read these
    // whatever the server makes of it — and it can't touch a message push,
    // which carries no `notificationId`.
    void dismissActivityNotifications();
    api
      .markNotificationsSeen()
      .then(() => {
        if (!mounted.current) return;
        queryClient.invalidateQueries({ queryKey: ['notificationsUnread'] });
        queryClient.invalidateQueries({ queryKey: ['notifications'] });
      })
      // Swallowed on purpose. This can now fire on a warm list whose refetch
      // failed — patchy signal, which is exactly when it will reject — and
      // there is nothing to tell the reader: they have read the rows either
      // way, and the next open marks them again. An uncaught rejection is a
      // redbox in development for a failure that genuinely doesn't matter.
      // Same call the thread's mark-read makes (#309).
      .catch(() => {});
  }, [listLoaded, queryClient]);

  async function handlePress(notification: Notification) {
    // Click-through addresses it (the dulled, dealt-with state) and deep-links to
    // its target. We navigate immediately and let the refetch settle behind us —
    // a failed address shouldn't block navigation; the poll will reconcile.
    if (!notification.addressed) {
      api.markNotificationAddressed(notification.id).catch(() => {});
      queryClient.invalidateQueries({ queryKey: ['notificationsUnread'] });
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
    }
    // `navigate`, matching the push-tap path exactly (#177) — the header's claim
    // that in-app and push click-through agree has to hold for *how* they
    // navigate, not just where. It also makes a double-tapped row land once
    // rather than stacking the target twice.
    router.navigate(routeForNotification(notification.url));
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.topBar}>
        <Pressable
          onPress={goBack}
          accessibilityRole="button"
          accessibilityLabel="Back"
          hitSlop={8}
        >
          <Text style={styles.back}>← Back</Text>
        </Pressable>
        <Text style={styles.title}>Activity</Text>
        <View style={styles.spacer} />
      </View>

      {isLoading ? (
        <View style={styles.centre}>
          <ActivityIndicator color={colors.accent} />
        </View>
      ) : (
        <FlatList
          testID="activity-list"
          data={notifications}
          keyExtractor={(n) => String(n.id)}
          renderItem={({ item }) => (
            <NotificationRow notification={item} onPress={handlePress} />
          )}
          ListEmptyComponent={
            // The error branch lives in here on purpose: `ListEmptyComponent`
            // only renders when the list is empty, so it *is* the data check,
            // structurally — it can't throw away pages that did load. The same
            // shape as the feed and the messages list.
            loadFailed ? (
              <View style={styles.centre}>
                <Text style={styles.emptyTitle}>
                  Couldn&rsquo;t load your activity
                </Text>
                <Text style={styles.emptyBody}>
                  {serverMessage(error, WENT_WRONG)}
                </Text>
                <Pressable
                  onPress={() => refetch()}
                  accessibilityRole="button"
                  style={({ pressed }) => [styles.retry, pressed && styles.pressed]}
                >
                  <Text style={styles.retryText}>Try again</Text>
                </Pressable>
              </View>
            ) : (
              <View style={styles.centre}>
                <Text style={styles.emptyTitle}>You&rsquo;re all caught up</Text>
                <Text style={styles.emptyBody}>
                  Replies, reactions, connection requests, invites and event
                  updates will show up here.
                </Text>
              </View>
            )
          }
          contentContainerStyle={
            notifications.length === 0 ? styles.emptyContainer : undefined
          }
          onEndReached={() => {
            if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
          }}
          onEndReachedThreshold={0.5}
          ListFooterComponent={
            isFetchingNextPage ? (
              <ActivityIndicator style={styles.footer} color={colors.accent} />
            ) : null
          }
        />
      )}
    </SafeAreaView>
  );
}

// One row. Visual weight encodes the state: unread is bold with an accent dot;
// seen is normal weight; addressed is dulled (but still present).
function NotificationRow({
  notification,
  onPress,
}: {
  notification: Notification;
  onPress: (n: Notification) => void;
}) {
  const { actor, text, created_at, seen, addressed } = notification;
  return (
    <Pressable
      onPress={() => onPress(notification)}
      accessibilityRole="button"
      style={[styles.row, addressed && styles.rowDulled]}
    >
      <Avatar user={actor} size="sm" />
      <View style={styles.rowBody}>
        <Text style={[styles.rowText, !seen && styles.rowTextUnread]}>{text}</Text>
        <Text style={styles.rowTime}>{formatRelativeTime(created_at)}</Text>
      </View>
      {!seen && <View style={styles.dot} accessibilityElementsHidden />}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.surface },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  back: { fontSize: fontSize.sm, color: colors.inkFaint, fontWeight: '600' },
  title: {
    flex: 1,
    textAlign: 'center',
    fontSize: fontSize.base,
    fontWeight: '700',
    color: colors.ink,
  },
  spacer: { width: 48 },
  centre: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
    gap: spacing.sm,
  },
  emptyContainer: { flexGrow: 1 },
  footer: { paddingVertical: spacing.md },
  emptyTitle: { fontSize: fontSize.base, fontWeight: '600', color: colors.ink },
  emptyBody: {
    fontSize: fontSize.sm,
    color: colors.inkSoft,
    textAlign: 'center',
    lineHeight: 20,
  },
  // The same outlined button as the feed, messages and calendar screens' retry.
  retry: {
    marginTop: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.lineStrong,
  },
  retryText: { color: colors.ink, fontWeight: '600' },
  pressed: { opacity: 0.7 },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  rowDulled: { opacity: 0.6 },
  rowBody: { flex: 1 },
  rowText: { fontSize: fontSize.sm, color: colors.ink, lineHeight: 19 },
  rowTextUnread: { fontWeight: '700' },
  rowTime: { marginTop: 2, fontSize: fontSize.sm, color: colors.inkFaint },
  dot: {
    marginTop: 6,
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.accent,
  },
});
