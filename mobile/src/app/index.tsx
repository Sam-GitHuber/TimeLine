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

import { useInfiniteQuery } from '@tanstack/react-query';
import { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
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
import { Avatar } from '@/components/Avatar';
import { ComposeBox } from '@/components/ComposeBox';
import { PostCard } from '@/components/PostCard';
import { toRows } from '@/feed';
import { RAIL, SPINE_COLUMN, Spine } from '@/components/timeline';
import { colors, fontSize, radius, spacing } from '@/theme';
import type { Post } from '@/types';

export default function FeedScreen() {
  const { user, signOut } = useAuth();

  function confirmSignOut() {
    Alert.alert('Log out?', 'You’ll need your password to log back in.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Log out', style: 'destructive', onPress: signOut },
    ]);
  }

  const {
    data,
    error,
    isLoading,
    refetch,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery({
    queryKey: ['feed'],
    queryFn: ({ pageParam }) =>
      pageParam ? api.getPage<Post>(pageParam) : api.getFeed(),
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

  const onPullToRefresh = useCallback(async () => {
    setPulled(true);
    try {
      await refetch();
    } finally {
      setPulled(false);
    }
  }, [refetch]);

  const rows = useMemo(
    () => toRows(data?.pages.flatMap((page) => page.results) ?? []),
    [data]
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
        {/* Temporary home for logout until the profile screen lands in C4 —
            without it there's no way back out of the app during testing.
            Confirmed first: this is where the profile button will live, so the
            obvious tap must not silently end a session and force someone to
            retype their password on a phone keyboard. */}
        <Pressable
          onPress={confirmSignOut}
          accessibilityRole="button"
          accessibilityLabel="Log out"
          hitSlop={8}
        >
          <Avatar user={user} size="sm" />
        </Pressable>
      </View>

      <FlatList
        data={rows}
        keyExtractor={(row) => row.key}
        renderItem={({ item }) =>
          item.kind === 'day' ? (
            // The divider carries its own spine segment: without one the line
            // visibly breaks at every change of day.
            <View style={styles.day}>
              <Spine />
              <Text style={styles.dayLabel}>{item.label}</Text>
              {item.sub ? <Text style={styles.daySub}>{item.sub}</Text> : null}
              {/* A hairline finishing the row, kept inside the content column
                  so it separates the days without cutting across the spine. */}
              <View style={styles.dayRule} />
            </View>
          ) : (
            <PostCard post={item.post} />
          )
        }
        contentContainerStyle={styles.list}
        // The compose box is the live tip of the timeline, so it belongs *in*
        // the list rather than pinned above it — it scrolls away with the feed
        // exactly as the top entry should.
        ListHeaderComponent={<ComposeBox user={user} />}
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
        onEndReachedThreshold={0.4}
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
  list: { paddingTop: spacing.sm, flexGrow: 1 },
  day: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: spacing.sm,
    // Indented to sit in the content column rather than cutting across the
    // spine. Derived from the shared geometry so it can't drift out of step.
    paddingLeft: RAIL + SPINE_COLUMN,
    paddingTop: spacing.sm,
    paddingBottom: spacing.sm,
  },
  dayLabel: { fontSize: fontSize.sm, fontWeight: '700', color: colors.inkSoft },
  daySub: { fontSize: 11, color: colors.inkFaint },
  dayRule: {
    flex: 1,
    height: 1,
    marginLeft: spacing.sm,
    marginRight: spacing.md,
    backgroundColor: colors.line,
  },
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
