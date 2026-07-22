/**
 * A group's page (Phase 9 E3a) — its shared timeline, and where you post into it.
 *
 * Structurally the feed, scoped to one group: the connection-pruned group
 * timeline (`getGroupPosts`, rendered through the shared `TimelineList`) with a
 * group-scoped `ComposeBox` capping it. Non-members can't reach here — the detail
 * 404s (a private group's existence isn't leaked), handled as "not available".
 *
 * The **⋯ menu** carries the group actions: Invite, Members, Leave, and — for
 * admins — Edit and Delete. Members + Invite are their own pushed screens
 * (E3a); Leave/Delete confirm first. **Events (the upcoming section) land in
 * E3b** — this is groups only.
 *
 * Whose posts you see here is **connection-gated**, not membership-gated (see
 * groups.md): you see a co-member's posts only if you're connected. So each
 * member sees a partial timeline — "my connections' posts under a shared label".
 */

import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import { useMemo } from 'react';
import {
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { api, ApiError } from '@/api';
import { useAuth } from '@/auth';
import { useGroupActions } from '@/components/useGroupActions';
import { Avatar } from '@/components/Avatar';
import { ComposeBox } from '@/components/ComposeBox';
import { TimelineList } from '@/components/TimelineList';
import { toRows } from '@/feed';
import { colors, fontSize, radius, spacing } from '@/theme';
import type { Post } from '@/types';
import { useDayBoundary } from '@/useDayBoundary';

export default function GroupScreen() {
  const { groupId } = useLocalSearchParams<{ groupId: string }>();
  const id = Number(groupId);
  const { user: me } = useAuth();

  const groupQuery = useQuery({
    queryKey: ['group', id],
    queryFn: () => api.getGroup(id),
  });
  const group = groupQuery.data;
  const isAdmin = group?.your_role === 'admin';

  const postsQuery = useInfiniteQuery({
    queryKey: ['groupPosts', id],
    queryFn: ({ pageParam }) =>
      pageParam ? api.getPage<Post>(pageParam) : api.getGroupPosts(id),
    initialPageParam: '',
    getNextPageParam: (lastPage) => lastPage.next ?? undefined,
    enabled: !!group,
  });

  const today = useDayBoundary();
  const rows = useMemo(
    () => toRows(postsQuery.data?.pages.flatMap((p) => p.results) ?? []),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- today is a trigger
    [postsQuery.data, today]
  );

  const goBack = () =>
    router.canGoBack() ? router.back() : router.replace('/groups');

  const { leave, remove } = useGroupActions(id);

  function openMenu() {
    const options = ['Invite people', 'Members'];
    const adminOptions = isAdmin ? ['Edit group', 'Delete group'] : [];
    const labels = [...options, ...adminOptions, 'Leave group', 'Cancel'];
    const cancelIndex = labels.length - 1;
    const leaveIndex = cancelIndex - 1;
    const deleteIndex = isAdmin ? labels.indexOf('Delete group') : -1;

    const run = (i: number) => {
      const label = labels[i];
      if (label === 'Invite people') router.push(`/groups/${id}/invite`);
      else if (label === 'Members') router.push(`/groups/${id}/members`);
      else if (label === 'Edit group') router.push(`/groups/${id}/edit`);
      else if (label === 'Delete group') remove();
      else if (label === 'Leave group') leave();
    };

    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          options: labels,
          destructiveButtonIndex: deleteIndex >= 0 ? deleteIndex : leaveIndex,
          cancelButtonIndex: cancelIndex,
        },
        run
      );
    } else {
      // Android fallback (Phase 10 refines this): a simple alert chooser.
      Alert.alert(group?.name ?? 'Group', undefined, [
        ...labels.slice(0, cancelIndex).map((label, i) => ({
          text: label,
          onPress: () => run(i),
          style: (label === 'Delete group' || label === 'Leave group'
            ? 'destructive'
            : 'default') as 'destructive' | 'default',
        })),
        { text: 'Cancel', style: 'cancel' as const },
      ]);
    }
  }

  const notFound =
    groupQuery.error instanceof ApiError && groupQuery.error.status === 404;

  const header = group ? (
    <View style={styles.info}>
      <Avatar user={{ display_name: group.name, avatar_thumb: group.avatar_thumb }} size="lg" />
      <View style={styles.infoBody}>
        {group.description ? (
          <Text style={styles.description}>{group.description}</Text>
        ) : null}
        <Pressable
          onPress={() => router.push(`/groups/${id}/members`)}
          accessibilityRole="button"
          hitSlop={6}
        >
          <Text style={styles.memberCount}>
            {group.member_count} {group.member_count === 1 ? 'member' : 'members'} ›
          </Text>
        </Pressable>
      </View>
    </View>
  ) : null;

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.topBar}>
        <Pressable onPress={goBack} accessibilityRole="button" accessibilityLabel="Back" hitSlop={8}>
          <Text style={styles.back}>← Back</Text>
        </Pressable>
        <Text style={styles.topName} numberOfLines={1}>
          {group?.name ?? 'Group'}
        </Text>
        {group ? (
          <Pressable onPress={openMenu} accessibilityRole="button" accessibilityLabel="Group actions" hitSlop={8}>
            <Text style={styles.menu}>⋯</Text>
          </Pressable>
        ) : (
          <View style={styles.menuSpacer} />
        )}
      </View>

      {groupQuery.isLoading ? (
        <ActivityIndicator color={colors.accent} style={styles.spinner} />
      ) : notFound ? (
        <View style={styles.centre}>
          <Text style={styles.emptyTitle}>This group isn’t available.</Text>
          <Text style={styles.emptyBody}>
            It may be private, or you may have left it.
          </Text>
        </View>
      ) : groupQuery.isError ? (
        <View style={styles.centre}>
          <Text style={styles.emptyTitle}>Couldn’t load this group</Text>
          <Pressable style={styles.retry} onPress={() => groupQuery.refetch()}>
            <Text style={styles.retryText}>Try again</Text>
          </Pressable>
        </View>
      ) : (
        <TimelineList
          rows={rows}
          keyboardShouldPersistTaps="handled"
          ListHeaderComponent={
            <>
              {header}
              <ComposeBox
                user={me}
                groupId={id}
                invalidateKey={['groupPosts', id]}
              />
            </>
          }
          onEndReached={() => {
            if (postsQuery.hasNextPage && !postsQuery.isFetchingNextPage) {
              postsQuery.fetchNextPage();
            }
          }}
          ListEmptyComponent={
            postsQuery.isLoading ? (
              <ActivityIndicator color={colors.accent} style={styles.spinner} />
            ) : (
              <View style={styles.locked}>
                <Text style={styles.emptyBody}>
                  No posts here yet — say something to the group.
                </Text>
              </View>
            )
          }
          ListFooterComponent={
            postsQuery.isFetchingNextPage ? (
              <ActivityIndicator style={styles.footer} color={colors.accent} />
            ) : null
          }
        />
      )}
    </SafeAreaView>
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
  topName: { flex: 1, textAlign: 'center', fontSize: fontSize.base, fontWeight: '700', color: colors.ink },
  menu: { fontSize: 22, color: colors.ink, fontWeight: '700', width: 44, textAlign: 'right' },
  menuSpacer: { width: 44 },
  info: {
    flexDirection: 'row',
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  infoBody: { flex: 1, gap: spacing.xs },
  description: { fontSize: fontSize.base, color: colors.inkSoft, lineHeight: 22 },
  memberCount: { fontSize: fontSize.sm, color: colors.accent, fontWeight: '600' },
  spinner: { marginTop: spacing.xl },
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl, gap: spacing.sm },
  locked: { padding: spacing.xl, alignItems: 'center', gap: spacing.sm },
  emptyTitle: { fontSize: fontSize.base, fontWeight: '600', color: colors.ink, textAlign: 'center' },
  emptyBody: { fontSize: fontSize.sm, color: colors.inkSoft, textAlign: 'center', lineHeight: 20 },
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
