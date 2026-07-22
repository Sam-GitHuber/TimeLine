/**
 * The People hub — your side of the connection graph. Ported from the web's
 * `PeoplePage.jsx`; three segments share the screen:
 *
 *   • Connections — people you're already connected with (the default: the
 *     everyday job is reaching a friend's profile in one tap, so it must not sit
 *     behind a pile of requests).
 *   • Discover    — everyone else, each with a Connect control.
 *   • Requests    — people asking to connect, to approve or reject.
 *
 * The active segment is local state, not a route param: unlike the web (where
 * `?tab=` makes it linkable and back-navigable), nothing deep-links into a
 * specific segment on mobile, and a tab screen re-mounting from the bottom bar
 * should just open on Connections. Revisit if a notification ever needs to land
 * on Requests directly — the deep-link map (notifications.md) currently sends
 * connection requests to People, and opening on Connections there is fine.
 */

import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { router } from 'expo-router';
import { useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { api } from '@/api';
import { Avatar } from '@/components/Avatar';
import { ConnectButton } from '@/components/ConnectButton';
import { colors, fontSize, radius, spacing } from '@/theme';
import type { ConnectionRequest, Paginated, PersonSummary } from '@/types';

type Segment = 'connections' | 'discover' | 'requests';

export default function PeopleScreen() {
  const [segment, setSegment] = useState<Segment>('connections');

  // Shared with the tab badge (same query key), so the count stays in step
  // wherever a request is approved or rejected.
  const { data: requestsData } = useQuery({
    queryKey: ['connectionRequests'],
    queryFn: api.getConnectionRequests,
  });
  const pendingCount = requestsData?.count ?? 0;

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.header}>
        <Text style={styles.title}>People</Text>
        <View style={styles.segments}>
          <SegmentTab
            label="Connections"
            active={segment === 'connections'}
            onPress={() => setSegment('connections')}
          />
          <SegmentTab
            label="Discover"
            active={segment === 'discover'}
            onPress={() => setSegment('discover')}
          />
          <SegmentTab
            label="Requests"
            active={segment === 'requests'}
            badge={pendingCount}
            onPress={() => setSegment('requests')}
          />
        </View>
      </View>

      {segment === 'requests' ? (
        <RequestsList />
      ) : segment === 'discover' ? (
        <DiscoverList />
      ) : (
        <ConnectionsList onFindPeople={() => setSegment('discover')} />
      )}
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
            {badge}
          </Text>
        </View>
      )}
    </Pressable>
  );
}

/**
 * A person's row: avatar + name (both open the profile), with a `trailing`
 * control on the right — a chevron on Connections, a Connect button on Discover,
 * Approve/Reject on Requests.
 */
function PersonRow({
  person,
  trailing,
}: {
  person: { id: number; display_name: string; avatar_thumb: string | null };
  trailing: React.ReactNode;
}) {
  return (
    <View style={styles.row}>
      <Pressable
        onPress={() => router.push(`/u/${person.id}`)}
        accessibilityRole="button"
        accessibilityLabel={`${person.display_name}'s profile`}
        style={styles.rowMain}
        hitSlop={4}
      >
        <Avatar user={person} size="md" />
        <Text style={styles.rowName} numberOfLines={1}>
          {person.display_name}
        </Text>
      </Pressable>
      {trailing}
    </View>
  );
}

/** A centred message for the loading / error / empty states the lists share. */
function ListMessage({
  children,
  tone = 'faint',
}: {
  children: React.ReactNode;
  tone?: 'faint' | 'error';
}) {
  return (
    <View style={styles.message}>
      <Text style={[styles.messageText, tone === 'error' && styles.messageError]}>
        {children}
      </Text>
    </View>
  );
}

/**
 * Shared shell for the two directory lists (Connections, Discover). Both page a
 * `PersonSummary` list the same way — following the paginator's `next` — so the
 * infinite-query plumbing lives here once and each caller supplies only the row
 * trailing and its empty state.
 */
function DirectoryList({
  queryKey,
  initialFetch,
  renderTrailing,
  empty,
  loadingText,
  errorText,
}: {
  queryKey: readonly unknown[];
  initialFetch: () => Promise<Paginated<PersonSummary>>;
  renderTrailing: (person: PersonSummary) => React.ReactNode;
  empty: React.ReactNode;
  loadingText: string;
  errorText: string;
}) {
  const query = useInfiniteQuery({
    queryKey,
    queryFn: ({ pageParam }) =>
      pageParam ? api.getPage<PersonSummary>(pageParam) : initialFetch(),
    initialPageParam: '',
    getNextPageParam: (lastPage) => lastPage.next ?? undefined,
  });

  const people = dedupeById(query.data?.pages.flatMap((page) => page.results) ?? []);

  if (query.isLoading) return <ListMessage>{loadingText}</ListMessage>;
  if (query.isError)
    return (
      <ListMessage tone="error">
        {query.error instanceof Error ? query.error.message : errorText}
      </ListMessage>
    );
  if (people.length === 0) return <>{empty}</>;

  return (
    <FlatList
      data={people}
      keyExtractor={(person) => String(person.id)}
      renderItem={({ item }) => (
        <PersonRow person={item} trailing={renderTrailing(item)} />
      )}
      onEndReached={() => {
        if (query.hasNextPage && !query.isFetchingNextPage) query.fetchNextPage();
      }}
      onEndReachedThreshold={0.5}
      ListFooterComponent={
        query.isFetchingNextPage ? (
          <ActivityIndicator style={styles.footer} color={colors.accent} />
        ) : null
      }
    />
  );
}

function ConnectionsList({ onFindPeople }: { onFindPeople: () => void }) {
  return (
    <DirectoryList
      queryKey={['connections']}
      initialFetch={api.listConnections}
      loadingText="Loading connections…"
      errorText="Couldn’t load your connections."
      renderTrailing={(person) => (
        <Pressable
          onPress={() => router.push(`/u/${person.id}`)}
          accessibilityRole="button"
          accessibilityLabel={`View ${person.display_name}'s profile`}
          hitSlop={8}
          style={styles.chevron}
        >
          <Text style={styles.chevronGlyph}>›</Text>
        </Pressable>
      )}
      empty={
        <View style={styles.emptyBlock}>
          <Text style={styles.messageText}>
            You’re not connected with anyone yet.
          </Text>
          <Pressable
            onPress={onFindPeople}
            accessibilityRole="button"
            style={({ pressed }) => [styles.primaryBtn, pressed && styles.pressed]}
          >
            <Text style={styles.primaryBtnLabel}>Find people</Text>
          </Pressable>
        </View>
      }
    />
  );
}

function DiscoverList() {
  return (
    <DirectoryList
      // Keyed under ['users', …] so the ConnectButton's ['users'] invalidation
      // refreshes Discover too, flipping a row's button after you act.
      queryKey={['users', 'discover']}
      initialFetch={api.listDiscover}
      loadingText="Loading people…"
      errorText="Couldn’t load people."
      renderTrailing={(person) => (
        <ConnectButton
          userId={person.id}
          displayName={person.display_name}
          connectionStatus={person.connection_status}
        />
      )}
      empty={
        <ListMessage>You’re connected with everyone here already.</ListMessage>
      }
    />
  );
}

/**
 * Your inbox of incoming requests. Approve makes the connection mutual (you both
 * start seeing each other's posts); Reject discards it. Both invalidate the
 * shared ['connectionRequests'] key (badge + this list), plus the people lists
 * and the feed, which a new connection changes.
 */
function RequestsList() {
  const queryClient = useQueryClient();

  const query = useInfiniteQuery({
    queryKey: ['connectionRequests', 'list'],
    queryFn: ({ pageParam }) =>
      pageParam
        ? api.getPage<ConnectionRequest>(pageParam)
        : api.getConnectionRequests(),
    initialPageParam: '',
    getNextPageParam: (lastPage) => lastPage.next ?? undefined,
  });

  const decide = useMutation({
    mutationFn: ({ act, id }: { act: (id: number) => Promise<void>; id: number }) =>
      act(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['connectionRequests'] });
      queryClient.invalidateQueries({ queryKey: ['users'] });
      queryClient.invalidateQueries({ queryKey: ['connections'] });
      queryClient.invalidateQueries({ queryKey: ['feed'] });
    },
  });

  const requests = dedupeById(
    query.data?.pages.flatMap((page) => page.results) ?? []
  );

  if (query.isLoading) return <ListMessage>Loading…</ListMessage>;
  if (query.isError)
    return (
      <ListMessage tone="error">
        {query.error instanceof Error
          ? query.error.message
          : 'Couldn’t load requests.'}
      </ListMessage>
    );
  if (requests.length === 0)
    return <ListMessage>No pending requests.</ListMessage>;

  return (
    <FlatList
      data={requests}
      keyExtractor={(req) => String(req.id)}
      renderItem={({ item }) => (
        <PersonRow
          person={item.requester}
          trailing={
            <View style={styles.decideRow}>
              <Pressable
                onPress={() => decide.mutate({ act: api.approveRequest, id: item.id })}
                disabled={decide.isPending}
                accessibilityRole="button"
                accessibilityLabel={`Approve ${item.requester.display_name}`}
                style={({ pressed }) => [
                  styles.approve,
                  (pressed || decide.isPending) && styles.pressed,
                ]}
              >
                <Text style={styles.approveLabel}>Approve</Text>
              </Pressable>
              <Pressable
                onPress={() => decide.mutate({ act: api.rejectRequest, id: item.id })}
                disabled={decide.isPending}
                accessibilityRole="button"
                accessibilityLabel={`Reject ${item.requester.display_name}`}
                style={({ pressed }) => [
                  styles.reject,
                  (pressed || decide.isPending) && styles.pressed,
                ]}
              >
                <Text style={styles.rejectLabel}>Reject</Text>
              </Pressable>
            </View>
          }
        />
      )}
      onEndReached={() => {
        if (query.hasNextPage && !query.isFetchingNextPage) query.fetchNextPage();
      }}
      onEndReachedThreshold={0.5}
      ListFooterComponent={
        query.isFetchingNextPage ? (
          <ActivityIndicator style={styles.footer} color={colors.accent} />
        ) : null
      }
    />
  );
}

/**
 * Drop repeated ids while preserving order — page-number pagination can re-send
 * a row across a page boundary when the underlying set shifts (someone connects
 * mid-scroll), and duplicate keys warn and mis-render in a FlatList. Same guard
 * the feed's `toRows` applies.
 */
function dedupeById<T extends { id: number }>(items: T[]): T[] {
  const seen = new Set<number>();
  const out: T[] = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.surface },
  header: {
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  title: { fontSize: fontSize.lg, fontWeight: '700', color: colors.ink },
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
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md - 2,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  rowMain: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minWidth: 0,
  },
  rowName: { flex: 1, fontSize: fontSize.base, fontWeight: '600', color: colors.ink },
  chevron: { paddingHorizontal: spacing.xs },
  chevronGlyph: { fontSize: 24, color: colors.inkFaint, lineHeight: 24 },
  decideRow: { flexDirection: 'row', gap: spacing.sm },
  approve: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs + 2,
    borderRadius: radius.pill,
    backgroundColor: colors.accent,
  },
  approveLabel: { fontSize: fontSize.sm, fontWeight: '600', color: '#ffffff' },
  reject: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs + 2,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    backgroundColor: colors.raised,
  },
  rejectLabel: { fontSize: fontSize.sm, fontWeight: '600', color: colors.ink },
  pressed: { opacity: 0.7 },
  message: { padding: spacing.xl, alignItems: 'center' },
  messageText: {
    fontSize: fontSize.sm,
    color: colors.inkFaint,
    textAlign: 'center',
    lineHeight: 20,
  },
  messageError: { color: colors.danger },
  emptyBlock: { padding: spacing.xl, alignItems: 'center', gap: spacing.md },
  primaryBtn: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    backgroundColor: colors.accent,
  },
  primaryBtnLabel: { fontSize: fontSize.sm, fontWeight: '600', color: '#ffffff' },
  footer: { marginVertical: spacing.lg },
});
