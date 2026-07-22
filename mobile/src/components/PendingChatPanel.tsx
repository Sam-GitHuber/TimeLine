/**
 * The locked view for a group chat you've been added to but aren't an active
 * member of yet (messaging.md's clique-gated invite): you can't read or send
 * until you've connected with everyone in `mustConnectWith`. It replaces the
 * message list + composer entirely — there's nothing to read until you're in —
 * and offers a way out via Decline / Leave. Ported from the web's
 * `PendingChatPanel.jsx`.
 *
 * Each Connect fires the same `api.connect` the ConnectButton does, then
 * invalidates this conversation and the list so a promotion (the backend lets
 * you in the instant you're connected to the whole active clique) repaints the
 * thread without a manual reload.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { api } from '@/api';
import { Avatar } from '@/components/Avatar';
import { colors, fontSize, radius, spacing } from '@/theme';
import type { Author } from '@/types';

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
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ['conversation', conversationId],
      });
      queryClient.invalidateQueries({ queryKey: ['conversations'] });
    },
  });

  const leaveMutation = useMutation({
    mutationFn: () => api.leaveConversation(conversationId),
    onSuccess: onLeave,
  });

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
          {connectMutation.error instanceof Error
            ? connectMutation.error.message
            : "Couldn't send that request."}
        </Text>
      )}

      <Pressable
        onPress={() => leaveMutation.mutate()}
        disabled={leaveMutation.isPending}
        accessibilityRole="button"
        style={({ pressed }) => [styles.leave, pressed && styles.pressed]}
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
