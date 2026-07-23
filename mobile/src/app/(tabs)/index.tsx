/**
 * The feed — the product's core screen.
 *
 * Reverse-chronological, always. The ordering is enforced server-side
 * (`Post.Meta.ordering`), and this screen renders `results` exactly as they
 * arrive: **no sorting, no re-ranking, no filtering on the client**. That's a
 * non-negotiable product principle, not a default (docs/SHARED.md).
 *
 * Paging uses TanStack Query's `useInfiniteQuery` following the paginator's
 * `next` URL — every list endpoint in this API is paginated, so this is the same
 * contract the web app's `useInfiniteList` hook uses.
 */

import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useCallback, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { api } from '@/api';
import { useAuth } from '@/auth';
import { ActivityBell } from '@/components/ActivityBell';
import { Avatar } from '@/components/Avatar';
import { ComposeBox } from '@/components/ComposeBox';
import { TimelineList } from '@/components/TimelineList';
import { toRows, trimToFirstPage, type FeedPages, type FeedRow } from '@/feed';
import { usePreferences } from '@/preferences';
import { colors, fontSize, radius, spacing } from '@/theme';
import type { Post } from '@/types';
import { useDayBoundary } from '@/useDayBoundary';

export default function FeedScreen() {
  const { user } = useAuth();

  // The home feed means "the people I'm connected with"; group posts stay inside
  // their groups by default. Merging them in chronologically (E3a — see
  // groups.md) is an opt-in preference, now set in Settings and persisted
  // per-device (E4b), rather than a header toggle on this screen.
  const { includeGroupsInFeed: includeGroups } = usePreferences();
  const feedKey = ['feed', includeGroups] as const;

  const {
    data,
    error,
    isLoading,
    refetch,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery({
    queryKey: feedKey,
    queryFn: ({ pageParam }) =>
      pageParam ? api.getPage<Post>(pageParam) : api.getFeed(includeGroups),
    initialPageParam: '',
    getNextPageParam: (lastPage) => lastPage.next ?? undefined,
  });

  /**
   * Whether to show the pull-to-refresh spinner.
   *
   * Deliberately **not** `isRefetching`. That is true for *any* refetch,
   * including the one `ComposeBox` triggers by invalidating ['feed'] after a
   * successful post — and setting `refreshing` programmatically makes the
   * RefreshControl slide in and shove the whole list (compose box and "now" tip
   * included) downwards. Posting a post therefore made the app lurch.
   *
   * Tracking the user's own pull separately keeps the spinner for the gesture
   * that asked for it, and lets background refetches update the list in place.
   */
  const [pulled, setPulled] = useState(false);

  const queryClient = useQueryClient();

  /**
   * Pull-to-refresh: drop back to a single page, then fetch it.
   *
   * `refetch()` on its own would refetch every page currently loaded — see
   * `trimToFirstPage`. Discarding pages 2+ is invisible here: you have to be at
   * the top of the list to pull, and they re-fetch as you scroll back down.
   */
  const onPullToRefresh = useCallback(async () => {
    setPulled(true);
    try {
      queryClient.setQueryData<FeedPages>(feedKey, trimToFirstPage);
      await refetch();
    } finally {
      setPulled(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- feedKey is derived from includeGroups
  }, [refetch, queryClient, includeGroups]);

  /**
   * Held so a new post can be scrolled into view.
   *
   * A ref rather than state: it's a handle for imperative calls, never something
   * render reads, so it must not trigger re-renders.
   */
  const listRef = useRef<FlatList<FeedRow>>(null);

  const scrollToTop = useCallback(() => {
    listRef.current?.scrollToOffset({ offset: 0, animated: true });
  }, []);

  // `today` is a dependency, not a value used directly: it changes at midnight
  // and is what re-derives the "Today" / "Yesterday" divider labels.
  const today = useDayBoundary();
  const rows = useMemo(
    () => toRows(data?.pages.flatMap((page) => page.results) ?? []),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see above
    [data, today]
  );

  if (isLoading) {
    return (
      <SafeAreaView style={styles.safe}>
        <View style={styles.centre}>
          <ActivityIndicator color={colors.accent} />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.header}>
        <Text style={styles.title}>TimeLine</Text>
        <View style={styles.headerRight}>
          {/* The activity bell (E4c) — notifications' non-tab home, the Instagram
              pattern. Sits left of the profile bead. */}
          <ActivityBell />
          {/* Your bead opens your own profile — where logout now lives. It used to
              be a shortcut to logout itself; a tap that silently ended the session
              was only ever a stopgap until this screen existed (C4). */}
          <Pressable
            onPress={() => user && router.push(`/u/${user.pk}`)}
            accessibilityRole="button"
            accessibilityLabel="Your profile"
            hitSlop={8}
          >
            <Avatar user={user} size="sm" />
          </Pressable>
        </View>
      </View>

      <TimelineList
        ref={listRef}
        rows={rows}
        // The compose box is the live tip of the timeline, so it belongs *in*
        // the list rather than pinned above it — it scrolls away with the feed
        // exactly as the top entry should.
        ListHeaderComponent={<ComposeBox user={user} onPosted={scrollToTop} />}
        refreshControl={
          <RefreshControl
            refreshing={pulled}
            onRefresh={onPullToRefresh}
            tintColor={colors.accent}
          />
        }
        onEndReached={() => {
          if (hasNextPage && !isFetchingNextPage) fetchNextPage();
        }}
        ListEmptyComponent={
          error ? (
            <View style={styles.centre}>
              <Text style={styles.emptyTitle}>Couldn&rsquo;t load your feed</Text>
              <Text style={styles.emptyBody}>
                {error instanceof Error ? error.message : 'Something went wrong.'}
              </Text>
              <Pressable style={styles.retry} onPress={() => refetch()}>
                <Text style={styles.retryText}>Try again</Text>
              </Pressable>
            </View>
          ) : (
            <View style={styles.centre}>
              <Text style={styles.emptyTitle}>Nothing here yet</Text>
              <Text style={styles.emptyBody}>
                Posts from you and the people you&rsquo;re connected with will
                appear here, newest first.
              </Text>
            </View>
          )
        }
        ListFooterComponent={
          isFetchingNextPage ? (
            <ActivityIndicator style={styles.footer} color={colors.accent} />
          ) : null
        }
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.surface },
  centre: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
    gap: spacing.sm,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.sm,
  },
  title: { fontSize: fontSize.lg, fontWeight: '700', color: colors.ink },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  emptyTitle: { fontSize: fontSize.base, fontWeight: '600', color: colors.ink },
  emptyBody: {
    fontSize: fontSize.sm,
    color: colors.inkSoft,
    textAlign: 'center',
    lineHeight: 20,
  },
  retry: {
    marginTop: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.lineStrong,
  },
  retryText: { color: colors.ink, fontWeight: '600' },
  footer: { marginVertical: spacing.lg },
});
