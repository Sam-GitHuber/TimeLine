/**
 * The Messages tab — your conversation list, most-recent-activity first. Ported
 * from the web's `ConversationListView` (inside `MessagesDrawer.jsx`), but as a
 * real tab screen rather than a drawer view (the E2 structure decision: a phone
 * chat is full-screen, not a companion panel beside the feed).
 *
 * Each row previews the last message ("You: …" / "Message deleted" / "No messages
 * yet"), shows a per-thread unread pill, and — for a chat you were added to but
 * haven't joined — reads "Invited — connect to join" instead. Tapping pushes the
 * thread (`/messages/[id]`), which covers the tab bar full-screen.
 *
 * The list polls on the slow cadence (`CONVERSATION_LIST_POLL_MS`); TanStack's
 * `refetchInterval` pauses while the app is backgrounded (see `_layout.tsx`).
 *
 * The header's compose button and the empty-state CTA both open the new-chat
 * picker (`messages/new`, E2b). You can also start a 1:1 from a person's profile
 * (the Message button).
 *
 * **Phase 9b M6** adds the two things a list this size starts to need: a
 * **search field** (by name — see `matchesSearch`, and note what it deliberately
 * doesn't search) and **swipe actions** on a row, so mute / mark-unread / leave
 * don't require opening a thread you were trying to deal with in passing.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import {
  Alert,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { api, CONVERSATION_LIST_POLL_MS } from '@/api';
import { useAuth } from '@/auth';
import { Avatar } from '@/components/Avatar';
import { AvatarStack } from '@/components/AvatarStack';
import { ComposeIcon } from '@/components/icons';
import type { SwipeAction } from '@/components/SwipeableRow';
import { SwipeableRow } from '@/components/SwipeableRow';
import { colors, fontSize, radius, spacing } from '@/theme';
import type { Conversation } from '@/types';
import { formatRelativeTime } from '@/utils';

/**
 * How many conversations before the search field is worth its space.
 *
 * Below this you can see every chat you have, so a search box is chrome that
 * only makes the screen busier. It lives in the list header rather than the
 * screen header for the same reason: it scrolls away with the content instead
 * of permanently narrowing the thing you came here to read.
 */
const SEARCH_FROM = 6;

/**
 * Does this conversation match what you typed?
 *
 * 🔒 **Names only — never the message previews.** Searching message *content* is
 * the obvious next thought and it's deliberately not built: it dies under
 * end-to-end encryption (the server won't have the words, and the client won't
 * have the history), so building toward it now means building something to tear
 * out. See the phase plan's Privacy section. Matching the preview text that
 * happens to be on screen would also be a half-feature that quietly searches
 * only the newest message in each thread, which is worse than not searching.
 *
 * A group matches on its title *and* its members' names, because an untitled
 * group is displayed as its members and you should be able to find a chat by
 * what it's called on the screen in front of you.
 */
function matchesSearch(convo: Conversation, needle: string, meId?: number) {
  const names = [
    convo.title,
    convo.other?.display_name ?? '',
    ...convo.participants
      .filter((p) => p.id !== meId)
      .map((p) => p.display_name),
  ];
  return names.some((name) => name.toLowerCase().includes(needle));
}

export default function MessagesScreen() {
  const { user: me } = useAuth();
  const queryClient = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearch] = useState('');

  const query = useQuery({
    queryKey: ['conversations'],
    queryFn: api.getConversations,
    refetchInterval: CONVERSATION_LIST_POLL_MS,
  });
  const all = useMemo(() => query.data?.results ?? [], [query.data]);
  const needle = search.trim().toLowerCase();
  const conversations = useMemo(
    () =>
      needle
        ? all.filter((convo) => matchesSearch(convo, needle, me?.pk))
        : all,
    [all, needle, me?.pk]
  );

  /**
   * The row actions, all three sharing one mutation.
   *
   * Everything a swipe can do is a small write followed by the same
   * invalidations, so one mutation with the call passed in keeps the row's
   * handlers to a line each — the shape `groups/[groupId]/members.tsx` already
   * uses. A failure gets an alert because a swipe closes on its own: without
   * one, a mute that didn't take would look exactly like a mute that did.
   */
  const rowAction = useMutation({
    mutationFn: (call: () => Promise<unknown>) => call(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['conversations'] });
      // Mark-unread and leave both move the tab badge, and it's the number
      // someone is watching when they flag a chat to come back to.
      queryClient.invalidateQueries({ queryKey: ['unreadMessages'] });
      // And the thread's own payload, which holds `muted` and `unread_count`
      // too. Its poll would heal this within a cycle, but opening a chat you
      // just swiped and finding the header disagreeing with the row you
      // swiped is exactly the kind of small lie that reads as a bug.
      queryClient.invalidateQueries({ queryKey: ['conversation'] });
    },
    onError: (error) =>
      Alert.alert(
        'Couldn’t do that',
        error instanceof Error ? error.message : 'Something went wrong.'
      ),
  });

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await query.refetch();
    } finally {
      setRefreshing(false);
    }
  }, [query]);

  const errorMessage =
    query.error instanceof Error
      ? query.error.message
      : "Couldn't load your messages.";

  /**
   * Swipe **right** — the read/unread toggle, where iOS puts it.
   *
   * "Mark unread" is the one people actually came for: it's how you say "I'll
   * reply properly later" without leaving the thread unopened, and it's why the
   * badge is trustworthy as a to-do list.
   *
   * **The gate here is narrower than the server's, on purpose.** The server
   * aims at the newest *visible, incoming, undeleted* message anywhere in the
   * thread, so it happily marks unread a chat you replied to (it lands past
   * your trailing messages — see `MarkConversationUnreadTests`). This list
   * can't tell that case apart: a row carries only `last_message`, so "I
   * replied last" and "I've been talking to myself since I started this chat"
   * look identical from here, and the second is a 400. Offering an action that
   * sometimes comes back an error is worse than offering it slightly less
   * often, and the thread screen is one tap away when you do want it. If a row
   * ever grows a "has incoming history" flag, widen this.
   *
   * A tombstone doesn't count either — a deleted message isn't a target for the
   * marker, so a thread whose only incoming message has been deleted is the
   * same 400. A `pending` invite has no readable history at all.
   */
  function leadingActions(convo: Conversation): SwipeAction[] {
    if (convo.my_status === 'pending') return [];
    if (convo.unread_count > 0) {
      return [
        {
          label: 'Mark read',
          tint: colors.accent,
          onPress: () =>
            rowAction.mutate(() => api.markConversationRead(convo.id)),
        },
      ];
    }
    const incoming =
      !!convo.last_message &&
      !convo.last_message.is_deleted &&
      convo.last_message.sender_id !== me?.pk;
    if (!incoming) return [];
    return [
      {
        label: 'Mark unread',
        tint: colors.accent,
        onPress: () =>
          rowAction.mutate(() => api.markConversationUnread(convo.id)),
      },
    ];
  }

  /**
   * Swipe **left** — the ones with consequences.
   *
   * Mute reads as its current state ("Unmute" once silenced) rather than
   * staying an imperative, the same way the thread's control does. Leave is
   * destructive and confirms first; on an invite you haven't accepted it is
   * *Decline*, which is the same endpoint and a very different sentence.
   */
  function trailingActions(convo: Conversation): SwipeAction[] {
    const leaving = convo.my_status === 'pending';
    return [
      {
        label: convo.muted ? 'Unmute' : 'Mute',
        onPress: () =>
          rowAction.mutate(() =>
            api.setConversationMuted(convo.id, !convo.muted)
          ),
      },
      {
        label: leaving ? 'Decline' : 'Leave',
        destructive: true,
        onPress: () =>
          Alert.alert(
            leaving ? 'Decline invite?' : 'Leave chat?',
            leaving
              ? 'You won’t join this conversation.'
              : 'You’ll stop receiving messages here.',
            [
              { text: 'Cancel', style: 'cancel' },
              {
                text: leaving ? 'Decline' : 'Leave',
                style: 'destructive',
                onPress: () =>
                  rowAction.mutate(() => api.leaveConversation(convo.id)),
              },
            ]
          ),
      },
    ];
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.header}>
        <Text style={styles.title}>Messages</Text>
        <Pressable
          onPress={() => router.push('/messages/new')}
          accessibilityRole="button"
          accessibilityLabel="New message"
          hitSlop={12}
          style={({ pressed }) => [styles.compose, pressed && styles.pressed]}
        >
          <ComposeIcon color={colors.accent} size={24} />
        </Pressable>
      </View>

      <FlatList
        data={conversations}
        keyExtractor={(convo) => String(convo.id)}
        // Bounce even when short/empty so pull-to-refresh works from the empty
        // and error states too — same guard the People lists use.
        alwaysBounceVertical
        contentContainerStyle={styles.listContent}
        // Let a tap on a row through while the search keyboard is up, rather
        // than spending the first tap on dismissing it.
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={colors.accent}
          />
        }
        // Keyed off the *unfiltered* count, so filtering down to one result
        // doesn't pull the field out from under what you just typed.
        ListHeaderComponent={
          all.length >= SEARCH_FROM ? (
            <View style={styles.searchBar}>
              <TextInput
                value={search}
                onChangeText={setSearch}
                placeholder="Search names"
                placeholderTextColor={colors.inkFaint}
                accessibilityLabel="Search conversations"
                autoCorrect={false}
                autoCapitalize="none"
                clearButtonMode="while-editing"
                returnKeyType="search"
                style={styles.searchInput}
              />
            </View>
          ) : null
        }
        renderItem={({ item }) => (
          <SwipeableRow
            leftActions={leadingActions(item)}
            rightActions={trailingActions(item)}
          >
            <ConversationRow
              convo={item}
              meId={me?.pk}
              onOpen={() => router.push(`/messages/${item.id}`)}
            />
          </SwipeableRow>
        )}
        ListEmptyComponent={
          query.isLoading ? (
            <ListMessage>Loading…</ListMessage>
          ) : // The error comes before the search miss: react-query keeps the
          // last good data through a failed refetch, so a search can still be
          // filtering a stale list when the reload breaks. "No conversations
          // match" would then be a confident answer drawn from data we no
          // longer trust.
          query.isError ? (
            <View style={styles.centre}>
              <Text style={[styles.messageText, styles.error]}>
                {errorMessage}
              </Text>
              <Pressable
                onPress={() => query.refetch()}
                accessibilityRole="button"
                style={({ pressed }) => [styles.retry, pressed && styles.pressed]}
              >
                <Text style={styles.retryText}>Try again</Text>
              </Pressable>
            </View>
          ) : needle ? (
            <ListMessage>No conversations match “{search.trim()}”.</ListMessage>
          ) : (
            <View style={styles.centre}>
              <Text style={styles.emptyTitle}>No conversations yet</Text>
              <Text style={styles.messageText}>
                Start one with someone you’re connected with.
              </Text>
              <Pressable
                onPress={() => router.push('/messages/new')}
                accessibilityRole="button"
                style={({ pressed }) => [styles.primaryBtn, pressed && styles.pressed]}
              >
                <Text style={styles.primaryBtnLabel}>New message</Text>
              </Pressable>
            </View>
          )
        }
      />
    </SafeAreaView>
  );
}

function ConversationRow({
  convo,
  meId,
  onOpen,
}: {
  convo: Conversation;
  meId: number | undefined;
  onOpen: () => void;
}) {
  const isGroup = convo.kind === 'group';
  const isPending = convo.my_status === 'pending';
  const last = convo.last_message;
  const mine = !!last && last.sender_id === meId;
  const unread = convo.unread_count > 0;

  // An untitled group falls back to a comma-joined list of the *other*
  // participants' names — `participants` includes you, so excluding yourself
  // stops an untitled group reading as "You, Priya, Sanjay".
  const groupName =
    convo.title ||
    convo.participants
      .filter((p) => p.id !== meId)
      .map((p) => p.display_name)
      .join(', ') ||
    'Group chat';
  const name = isGroup ? groupName : convo.other?.display_name ?? 'Conversation';

  const preview = last
    ? last.is_deleted
      ? 'Message deleted'
      : last.text
    : 'No messages yet';

  return (
    <Pressable
      onPress={onOpen}
      accessibilityRole="button"
      accessibilityLabel={`Open conversation with ${name}`}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
    >
      {isGroup ? (
        <AvatarStack participants={convo.participants} max={3} />
      ) : (
        <Avatar user={convo.other} size="md" />
      )}

      <View style={styles.rowBody}>
        <View style={styles.rowTop}>
          <Text style={styles.rowName} numberOfLines={1}>
            {name}
          </Text>
          <Text style={styles.rowTime}>{formatRelativeTime(convo.updated_at)}</Text>
        </View>

        {isPending ? (
          <Text style={styles.rowInvited} numberOfLines={1}>
            Invited — connect to join
          </Text>
        ) : (
          <Text
            style={[styles.rowPreview, unread && styles.rowPreviewUnread]}
            numberOfLines={1}
          >
            {mine && !last?.is_deleted ? (
              <Text style={styles.youPrefix}>You: </Text>
            ) : null}
            {preview}
          </Text>
        )}
      </View>

      {!isPending && unread && (
        <View style={styles.unreadPill}>
          <Text style={styles.unreadText}>
            {convo.unread_count > 99 ? '99+' : convo.unread_count}
          </Text>
        </View>
      )}
    </Pressable>
  );
}

function ListMessage({ children }: { children: React.ReactNode }) {
  return (
    <View style={styles.centre}>
      <Text style={styles.messageText}>{children}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.surface },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  title: { fontSize: fontSize.lg, fontWeight: '700', color: colors.ink },
  // Plain icon button in the header — no pill, the iOS nav-action pattern.
  compose: { padding: spacing.xs },
  searchBar: {
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    paddingBottom: spacing.xs,
  },
  searchInput: {
    height: 36,
    borderRadius: radius.md,
    backgroundColor: colors.raised,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    paddingHorizontal: spacing.sm + 2,
    fontSize: fontSize.sm,
    color: colors.ink,
  },
  primaryBtn: {
    marginTop: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    backgroundColor: colors.accent,
  },
  primaryBtnLabel: { fontSize: fontSize.sm, fontWeight: '600', color: '#ffffff' },
  listContent: { flexGrow: 1 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    // Opaque on purpose: the swipe actions sit *behind* the row, so a
    // transparent row would let them show through before it moves.
    backgroundColor: colors.surface,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md - 2,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  rowPressed: { backgroundColor: colors.accentTint },
  rowBody: { flex: 1, minWidth: 0, gap: 2 },
  rowTop: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  rowName: { flex: 1, fontSize: fontSize.base, fontWeight: '600', color: colors.ink },
  rowTime: { fontSize: fontSize.sm - 1, color: colors.inkFaint },
  rowInvited: { fontSize: fontSize.sm, color: colors.inkFaint },
  rowPreview: { fontSize: fontSize.sm, color: colors.inkSoft },
  rowPreviewUnread: { fontWeight: '600', color: colors.ink },
  youPrefix: { color: colors.inkFaint },
  unreadPill: {
    minWidth: 20,
    paddingHorizontal: 6,
    height: 20,
    borderRadius: radius.pill,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  unreadText: { fontSize: 11, fontWeight: '700', color: '#ffffff' },
  centre: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
    gap: spacing.sm,
  },
  emptyTitle: { fontSize: fontSize.base, fontWeight: '600', color: colors.ink },
  messageText: {
    fontSize: fontSize.sm,
    color: colors.inkFaint,
    textAlign: 'center',
    lineHeight: 20,
  },
  error: { color: colors.danger },
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
});
