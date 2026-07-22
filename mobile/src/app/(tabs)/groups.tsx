/**
 * The Groups tab (Phase 9 E3a) — your groups, and your pending invites.
 *
 * Two segments share the screen, mirroring the People hub:
 *   • Groups  — the private shared timelines you're an active member of (tap a
 *     row to open its timeline).
 *   • Invites — groups you've been invited to; accept to join, or decline.
 *
 * A group is private and invite-only (groups.md): there's no discovery here, only
 * the groups you're already in and the ones someone pulled you into. The header's
 * compose button creates a new group. The Invites segment + the tab badge share
 * the `['groupInvites']` query key, so accepting/declining anywhere keeps both in
 * step — the same discipline People uses for connection requests.
 */

import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
} from '@tanstack/react-query';
import { router } from 'expo-router';
import { useCallback, useState } from 'react';
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
import { Avatar } from '@/components/Avatar';
import { ComposeIcon } from '@/components/icons';
import { dedupeById, trimToFirstPage } from '@/lists';
import { colors, fontSize, radius, spacing } from '@/theme';
import type { Group, GroupInvite, Paginated } from '@/types';

type Segment = 'groups' | 'invites';

function usePullToRefresh(
  queryKey: readonly unknown[],
  refetch: () => Promise<unknown>
) {
  const queryClient = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      queryClient.setQueryData<InfiniteData<Paginated<unknown>, string>>(
        queryKey,
        trimToFirstPage
      );
      await refetch();
    } finally {
      setRefreshing(false);
    }
  }, [queryClient, queryKey, refetch]);
  return { refreshing, onRefresh };
}

export default function GroupsScreen() {
  const [segment, setSegment] = useState<Segment>('groups');

  const { data: invitesData } = useQuery({
    queryKey: ['groupInvites'],
    queryFn: api.getGroupInvites,
  });
  const inviteCount = invitesData?.count ?? 0;

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.header}>
        <View style={styles.titleRow}>
          <Text style={styles.title}>Groups</Text>
          <Pressable
            onPress={() => router.push('/groups/new')}
            accessibilityRole="button"
            accessibilityLabel="New group"
            hitSlop={12}
            style={({ pressed }) => [styles.compose, pressed && styles.pressed]}
          >
            <ComposeIcon color={colors.accent} size={24} />
          </Pressable>
        </View>
        <View style={styles.segments} accessibilityRole="tablist">
          <SegmentTab
            label="Groups"
            active={segment === 'groups'}
            onPress={() => setSegment('groups')}
          />
          <SegmentTab
            label="Invites"
            active={segment === 'invites'}
            badge={inviteCount}
            onPress={() => setSegment('invites')}
          />
        </View>
      </View>

      {segment === 'invites' ? <InvitesList /> : <GroupsList />}
    </SafeAreaView>
  );
}

function SegmentTab({
  label,
  active,
  badge = 0,
  onPress,
}: {
  label: string;
  active: boolean;
  badge?: number;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="tab"
      accessibilityState={{ selected: active }}
      style={[styles.segment, active && styles.segmentActive]}
    >
      <Text style={[styles.segmentLabel, active && styles.segmentLabelActive]}>
        {label}
      </Text>
      {badge > 0 && (
        <View style={[styles.badge, active && styles.badgeActive]}>
          <Text style={[styles.badgeText, active && styles.badgeTextActive]}>
            {badge > 99 ? '99+' : badge}
          </Text>
        </View>
      )}
    </Pressable>
  );
}

function GroupsList() {
  const queryKey = ['groups'] as const;
  const query = useInfiniteQuery({
    queryKey,
    queryFn: ({ pageParam }) =>
      pageParam ? api.getPage<Group>(pageParam) : api.getGroups(),
    initialPageParam: '',
    getNextPageParam: (lastPage) => lastPage.next ?? undefined,
  });
  const { refreshing, onRefresh } = usePullToRefresh(queryKey, query.refetch);

  const groups = dedupeById(query.data?.pages.flatMap((p) => p.results) ?? []);

  return (
    <FlatList
      data={groups}
      keyExtractor={(g) => String(g.id)}
      alwaysBounceVertical
      contentContainerStyle={styles.listContent}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={onRefresh}
          tintColor={colors.accent}
        />
      }
      renderItem={({ item }) => (
        <Pressable
          onPress={() => router.push(`/groups/${item.id}`)}
          accessibilityRole="button"
          accessibilityLabel={`Open ${item.name}`}
          style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
        >
          <Avatar user={{ display_name: item.name, avatar_thumb: item.avatar_thumb }} size="md" />
          <View style={styles.rowBody}>
            <Text style={styles.rowName} numberOfLines={1}>
              {item.name}
            </Text>
            <Text style={styles.rowMeta}>
              {item.member_count} {item.member_count === 1 ? 'member' : 'members'}
              {item.your_role === 'admin' ? ' · Admin' : ''}
            </Text>
          </View>
          <Text style={styles.chevron}>›</Text>
        </Pressable>
      )}
      onEndReached={() => {
        if (query.hasNextPage && !query.isFetchingNextPage) query.fetchNextPage();
      }}
      onEndReachedThreshold={0.5}
      ListEmptyComponent={
        query.isLoading ? (
          <ListMessage>Loading…</ListMessage>
        ) : query.isError ? (
          <ListError
            message={
              query.error instanceof Error
                ? query.error.message
                : 'Couldn’t load your groups.'
            }
            onRetry={query.refetch}
          />
        ) : (
          <View style={styles.emptyBlock}>
            <Text style={styles.emptyTitle}>No groups yet</Text>
            <Text style={styles.messageText}>
              Create a private group to share a timeline with family or friends.
            </Text>
            <Pressable
              onPress={() => router.push('/groups/new')}
              accessibilityRole="button"
              style={({ pressed }) => [styles.primaryBtn, pressed && styles.pressed]}
            >
              <Text style={styles.primaryBtnLabel}>New group</Text>
            </Pressable>
          </View>
        )
      }
      ListFooterComponent={
        query.isFetchingNextPage ? (
          <ActivityIndicator style={styles.footer} color={colors.accent} />
        ) : null
      }
    />
  );
}

function InvitesList() {
  const queryClient = useQueryClient();
  const queryKey = ['groupInvites', 'list'] as const;
  const query = useInfiniteQuery({
    queryKey,
    queryFn: ({ pageParam }) =>
      pageParam ? api.getPage<GroupInvite>(pageParam) : api.getGroupInvites(),
    initialPageParam: '',
    getNextPageParam: (lastPage) => lastPage.next ?? undefined,
  });
  const { refreshing, onRefresh } = usePullToRefresh(queryKey, query.refetch);

  const decide = useMutation({
    mutationFn: ({
      act,
      id,
    }: {
      act: (id: number) => Promise<void>;
      id: number;
    }) => act(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['groupInvites'] });
      queryClient.invalidateQueries({ queryKey: ['groups'] });
    },
  });

  const invites = dedupeById(query.data?.pages.flatMap((p) => p.results) ?? []);

  return (
    <FlatList
      data={invites}
      keyExtractor={(inv) => String(inv.id)}
      alwaysBounceVertical
      contentContainerStyle={styles.listContent}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={onRefresh}
          tintColor={colors.accent}
        />
      }
      renderItem={({ item }) => {
        const pending = decide.isPending && decide.variables?.id === item.id;
        return (
          <View style={styles.row}>
            <Avatar
              user={{ display_name: item.group.name, avatar_thumb: item.group.avatar_thumb }}
              size="md"
            />
            <View style={styles.rowBody}>
              <Text style={styles.rowName} numberOfLines={1}>
                {item.group.name}
              </Text>
              <Text style={styles.rowMeta} numberOfLines={1}>
                {item.invited_by.display_name} invited you
              </Text>
            </View>
            <View style={styles.decideRow}>
              <Pressable
                onPress={() => decide.mutate({ act: api.acceptGroupInvite, id: item.id })}
                disabled={pending}
                accessibilityRole="button"
                accessibilityLabel={`Accept ${item.group.name}`}
                style={({ pressed }) => [styles.accept, (pressed || pending) && styles.pressed]}
              >
                <Text style={styles.acceptLabel}>Accept</Text>
              </Pressable>
              <Pressable
                onPress={() => decide.mutate({ act: api.rejectGroupInvite, id: item.id })}
                disabled={pending}
                accessibilityRole="button"
                accessibilityLabel={`Decline ${item.group.name}`}
                style={({ pressed }) => [styles.decline, (pressed || pending) && styles.pressed]}
              >
                <Text style={styles.declineLabel}>Decline</Text>
              </Pressable>
            </View>
          </View>
        );
      }}
      onEndReached={() => {
        if (query.hasNextPage && !query.isFetchingNextPage) query.fetchNextPage();
      }}
      onEndReachedThreshold={0.5}
      ListEmptyComponent={
        query.isLoading ? (
          <ListMessage>Loading…</ListMessage>
        ) : query.isError ? (
          <ListError
            message={
              query.error instanceof Error ? query.error.message : 'Couldn’t load invites.'
            }
            onRetry={query.refetch}
          />
        ) : (
          <ListMessage>No pending invites.</ListMessage>
        )
      }
      ListFooterComponent={
        query.isFetchingNextPage ? (
          <ActivityIndicator style={styles.footer} color={colors.accent} />
        ) : null
      }
    />
  );
}

function ListMessage({ children }: { children: React.ReactNode }) {
  return (
    <View style={styles.message}>
      <Text style={styles.messageText}>{children}</Text>
    </View>
  );
}

function ListError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <View style={styles.message}>
      <Text style={[styles.messageText, styles.messageError]}>{message}</Text>
      <Pressable
        onPress={onRetry}
        accessibilityRole="button"
        style={({ pressed }) => [styles.retry, pressed && styles.pressed]}
      >
        <Text style={styles.retryText}>Try again</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.surface },
  header: {
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  title: { fontSize: fontSize.lg, fontWeight: '700', color: colors.ink },
  compose: { padding: spacing.xs },
  segments: {
    flexDirection: 'row',
    alignSelf: 'flex-start',
    marginTop: spacing.sm,
    padding: 3,
    borderRadius: radius.md,
    backgroundColor: 'rgba(28,26,22,0.05)',
    gap: 2,
  },
  segment: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs + 2,
    borderRadius: radius.sm,
  },
  segmentActive: {
    backgroundColor: colors.raised,
    shadowColor: '#000',
    shadowOpacity: 0.06,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
    elevation: 1,
  },
  segmentLabel: { fontSize: fontSize.sm, fontWeight: '500', color: colors.inkSoft },
  segmentLabelActive: { color: colors.ink },
  badge: {
    minWidth: 18,
    paddingHorizontal: 5,
    borderRadius: radius.pill,
    backgroundColor: colors.accentTint,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeActive: { backgroundColor: colors.accent },
  badgeText: { fontSize: 11, fontWeight: '700', color: colors.accentDeep },
  badgeTextActive: { color: '#ffffff' },
  listContent: { flexGrow: 1 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md - 2,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  rowPressed: { backgroundColor: colors.accentTint },
  rowBody: { flex: 1, minWidth: 0, gap: 2 },
  rowName: { fontSize: fontSize.base, fontWeight: '600', color: colors.ink },
  rowMeta: { fontSize: fontSize.sm, color: colors.inkFaint },
  chevron: { fontSize: 24, color: colors.inkFaint, lineHeight: 24 },
  decideRow: { flexDirection: 'row', gap: spacing.sm },
  accept: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs + 2,
    borderRadius: radius.pill,
    backgroundColor: colors.accent,
  },
  acceptLabel: { fontSize: fontSize.sm, fontWeight: '600', color: '#ffffff' },
  decline: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs + 2,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    backgroundColor: colors.raised,
  },
  declineLabel: { fontSize: fontSize.sm, fontWeight: '600', color: colors.ink },
  pressed: { opacity: 0.7 },
  message: { flex: 1, padding: spacing.xl, alignItems: 'center', justifyContent: 'center' },
  messageText: {
    fontSize: fontSize.sm,
    color: colors.inkFaint,
    textAlign: 'center',
    lineHeight: 20,
  },
  messageError: { color: colors.danger },
  retry: {
    marginTop: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.lineStrong,
  },
  retryText: { color: colors.ink, fontWeight: '600' },
  emptyBlock: {
    flex: 1,
    padding: spacing.xl,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
  },
  emptyTitle: { fontSize: fontSize.base, fontWeight: '600', color: colors.ink },
  primaryBtn: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    backgroundColor: colors.accent,
  },
  primaryBtnLabel: { fontSize: fontSize.sm, fontWeight: '600', color: '#ffffff' },
  footer: { marginVertical: spacing.lg },
});
