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
 * **Starting a new chat is E2b** — for now you begin one from a person's profile
 * (the Message button). The empty state points there rather than offering a
 * compose button that doesn't exist yet.
 */

import { useQuery } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useCallback, useState } from 'react';
import {
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { api, CONVERSATION_LIST_POLL_MS } from '@/api';
import { useAuth } from '@/auth';
import { Avatar } from '@/components/Avatar';
import { AvatarStack } from '@/components/AvatarStack';
import { colors, fontSize, radius, spacing } from '@/theme';
import type { Conversation } from '@/types';
import { formatRelativeTime } from '@/utils';

export default function MessagesScreen() {
  const { user: me } = useAuth();
  const [refreshing, setRefreshing] = useState(false);

  const query = useQuery({
    queryKey: ['conversations'],
    queryFn: api.getConversations,
    refetchInterval: CONVERSATION_LIST_POLL_MS,
  });
  const conversations = query.data?.results ?? [];

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

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.header}>
        <Text style={styles.title}>Messages</Text>
      </View>

      <FlatList
        data={conversations}
        keyExtractor={(convo) => String(convo.id)}
        // Bounce even when short/empty so pull-to-refresh works from the empty
        // and error states too — same guard the People lists use.
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
          <ConversationRow
            convo={item}
            meId={me?.pk}
            onOpen={() => router.push(`/messages/${item.id}`)}
          />
        )}
        ListEmptyComponent={
          query.isLoading ? (
            <ListMessage>Loading…</ListMessage>
          ) : query.isError ? (
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
          ) : (
            <View style={styles.centre}>
              <Text style={styles.emptyTitle}>No conversations yet</Text>
              <Text style={styles.messageText}>
                Start one from someone’s profile — open a connection and tap
                Message.
              </Text>
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
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  title: { fontSize: fontSize.lg, fontWeight: '700', color: colors.ink },
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
