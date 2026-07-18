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
import { useMemo } from 'react';
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
import { PostCard } from '@/components/PostCard';
import { toRows } from '@/feed';
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
    isRefetching,
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
            <View style={styles.day}>
              <Text style={styles.dayLabel}>{item.label}</Text>
              {item.sub ? <Text style={styles.daySub}>{item.sub}</Text> : null}
            </View>
          ) : (
            <PostCard post={item.post} />
          )
        }
        contentContainerStyle={styles.list}
        refreshControl={
          <RefreshControl
            refreshing={isRefetching && !isFetchingNextPage}
            onRefresh={refetch}
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
    // Indented to line up with the left edge of the cards (rail 48 + spine
    // column 40), so the label sits in the content column instead of cutting
    // across the spine.
    paddingLeft: 88,
    paddingBottom: spacing.sm,
  },
  dayLabel: { fontSize: fontSize.sm, fontWeight: '700', color: colors.inkSoft },
  daySub: { fontSize: 11, color: colors.inkFaint },
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
