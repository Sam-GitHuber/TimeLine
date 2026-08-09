/**
 * The locked view for a group chat you've been added to but aren't an active
 * member of yet (messaging.md's clique-gated invite): you can't read or send
 * until you've connected with everyone in `mustConnectWith`. It replaces the
 * message list + composer entirely — there's nothing to read until you're in —
 * and offers a way out via Decline / Leave. Ported from the web's
 * `PendingChatPanel.jsx`.
 *
 * Each Connect fires the same `api.connect` the ConnectButton does, then
 * refreshes what a connection change refreshes anywhere else
 * (`connectionCache.ts`) — including this conversation and the list, so a
 * promotion (the backend lets you in the instant you're connected to the whole
 * active clique) repaints the thread without a manual reload.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';

import { api, serverMessage, WENT_WRONG } from '@/api';
import { Avatar } from '@/components/Avatar';
import { invalidateConnectionChange } from '@/connectionCache';
import { colors, fontSize, radius, spacing } from '@/theme';
import type { Author } from '@/types';
import { useHoldOpen } from '@/writeHold';

export function PendingChatPanel({
  mustConnectWith,
  conversationId,
  onLeave,
}: {
  mustConnectWith: Author[];
  conversationId: number;
  onLeave: () => void;
}) {
  const queryClient = useQueryClient();

  const connectMutation = useMutation({
    mutationFn: (userId: number) => api.connect(userId),
    // The same `api.connect` the ConnectButton makes, so it refreshes the same
    // set (`connectionCache.ts`) — which includes this thread and the list, the
    // two this panel used to name on its own. Connecting here can promote you
    // into the chat *and* widen what the feed, the calendars and the group
    // timelines may show; only the panel knew about the first half (#278).
    onSuccess: (_data, userId) => invalidateConnectionChange(queryClient, userId),
  });

  const leaveMutation = useMutation({
    mutationFn: () => api.leaveConversation(conversationId),
    onSuccess: () => {
      // Declining drops the pending invite off the list immediately, rather
      // than lingering until the next poll.
      queryClient.invalidateQueries({ queryKey: ['conversations'] });
      queryClient.invalidateQueries({ queryKey: ['unreadMessages'] });
      onLeave();
    },
    // #238: `onLeave()` runs only on success, so a refused decline put the
    // button back from "Leaving…" to "Decline / Leave" and left the invite in
    // your list next time you opened Messages — with nothing to say it hadn't
    // worked. Through `Alert` rather than the inline line the Connect uses,
    // because a native dialog outlives the panel; the hold below is what the
    // Connect needs *instead* of that, and this write doesn't (messaging.md).
    onError: (error) =>
      Alert.alert('Couldn’t leave this chat', serverMessage(error, WENT_WRONG)),
  });

  /**
   * Nothing takes this panel off screen while a Connect is out (#259).
   *
   * The error below is its only renderer, and both routes out unmount it: the
   * screen's "← Back" (and Android's hardware back, which the screen holds by
   * reading this declaration) and the Decline / Leave button right here. Tap
   * Connect, tap Decline while it's slow, and a 400 — you've blocked them, the
   * request is already pending, you're offline — lands nowhere. You believe
   * you're waiting on them to accept; you're not in anyone's inbox, and the
   * chat stays locked with no explanation.
   *
   * Leaving is held here where the web deliberately leaves its Leave controls
   * open, and the difference is what the pending write is *about*: those were
   * conversation-scoped writes whose answer stops mattering once you're out of
   * the conversation. A connection request isn't — it changes a relationship
   * that outlives this chat entirely.
   */
  useHoldOpen(connectMutation.isPending);

  const people = mustConnectWith ?? [];

  return (
    <View style={styles.panel}>
      <Text style={styles.prompt}>
        Connect with <NameList names={people.map((p) => p.display_name)} /> to
        join this chat.
      </Text>

      <View style={styles.list}>
        {people.map((person) => (
          <View key={person.id} style={styles.personRow}>
            <Avatar user={person} size="sm" />
            <Text style={styles.personName} numberOfLines={1}>
              {person.display_name}
            </Text>
            <Pressable
              onPress={() => connectMutation.mutate(person.id)}
              disabled={connectMutation.isPending}
              accessibilityRole="button"
              accessibilityLabel={`Connect with ${person.display_name}`}
              style={({ pressed }) => [
                styles.connect,
                (pressed || connectMutation.isPending) && styles.pressed,
              ]}
            >
              <Text style={styles.connectLabel}>Connect</Text>
            </Pressable>
          </View>
        ))}
      </View>

      {connectMutation.isError && (
        <Text style={styles.error}>
          {serverMessage(connectMutation.error, "Couldn't send that request.")}
        </Text>
      )}

      <Pressable
        onPress={() => leaveMutation.mutate()}
        disabled={leaveMutation.isPending || connectMutation.isPending}
        accessibilityRole="button"
        style={({ pressed }) => [
          styles.leave,
          (pressed || connectMutation.isPending) && styles.pressed,
        ]}
      >
        <Text style={styles.leaveLabel}>
          {leaveMutation.isPending ? 'Leaving…' : 'Decline / Leave'}
        </Text>
      </Pressable>
    </View>
  );
}

/** "X" / "X & Y" / "X, Y & Z", each name emphasised — mirrors the web's list. */
function NameList({ names }: { names: string[] }) {
  if (names.length === 0) return <Text style={styles.name}>everyone</Text>;
  return (
    <>
      {names.map((name, i) => (
        <Text key={`${name}-${i}`}>
          {i > 0 ? (i === names.length - 1 ? ' & ' : ', ') : ''}
          <Text style={styles.name}>{name}</Text>
        </Text>
      ))}
    </>
  );
}

const styles = StyleSheet.create({
  panel: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.lg,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.xxl,
  },
  prompt: {
    maxWidth: 300,
    textAlign: 'center',
    fontSize: fontSize.base,
    lineHeight: 23,
    color: colors.inkSoft,
  },
  name: { fontWeight: '600', color: colors.ink },
  list: { width: '100%', maxWidth: 320, gap: spacing.sm },
  personRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    backgroundColor: colors.raised,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.md - 2,
    paddingVertical: spacing.sm + 2,
  },
  personName: { flex: 1, fontSize: fontSize.base, fontWeight: '600', color: colors.ink },
  connect: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs + 2,
    borderRadius: radius.pill,
    backgroundColor: colors.accent,
  },
  connectLabel: { fontSize: fontSize.sm, fontWeight: '600', color: '#ffffff' },
  error: { fontSize: fontSize.sm, color: colors.danger, textAlign: 'center' },
  leave: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  leaveLabel: { fontSize: fontSize.sm, fontWeight: '600', color: colors.inkSoft },
  pressed: { opacity: 0.7 },
});
