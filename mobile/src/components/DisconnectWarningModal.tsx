/**
 * Confirms a disconnect, naming the group chats it would drop you out of.
 * Ported from `frontend/src/components/DisconnectWarningModal.jsx`.
 *
 * Disconnecting severs any group chat you *only* share through this person —
 * you're dropped to pending there until you reconnect with everyone. Before the
 * disconnect fires, this fetches that impact (`getDisconnectImpact`) and, if
 * it's non-empty, makes you read the list and confirm. When nothing is shared it
 * still confirms, but as a plain "Disconnect X?" — a disconnect is worth a
 * deliberate second tap either way.
 *
 * The web version handles block too (`action` prop); mobile block lands in E4,
 * so this is disconnect-only for now and grows an `action` prop when block does.
 */

import { useQuery } from '@tanstack/react-query';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { api } from '@/api';
import { colors, fontSize, radius, spacing } from '@/theme';

type Props = {
  userId: number;
  userName: string;
  onConfirm: () => void;
  onCancel: () => void;
};

export function DisconnectWarningModal({
  userId,
  userName,
  onConfirm,
  onCancel,
}: Props) {
  const impactQuery = useQuery({
    queryKey: ['disconnect-impact', userId],
    queryFn: () => api.getDisconnectImpact(userId),
  });

  const chats = impactQuery.data?.chats ?? [];
  const hasImpact = chats.length > 0;

  return (
    <Modal
      transparent
      animationType="fade"
      visible
      onRequestClose={onCancel}
      accessibilityViewIsModal
    >
      {/* Tapping the dimmed backdrop cancels; taps inside the card don't, since
          the card is a sibling Pressable that swallows its own presses. */}
      <Pressable style={styles.backdrop} onPress={onCancel}>
        <Pressable style={styles.card} onPress={() => {}}>
          {impactQuery.isLoading ? (
            <Text style={styles.body}>Checking shared chats…</Text>
          ) : impactQuery.isError ? (
            <Text style={styles.body}>
              Couldn’t check for shared chats. You can still continue.
            </Text>
          ) : hasImpact ? (
            <>
              <Text style={styles.body}>
                Disconnecting from{' '}
                <Text style={styles.strong}>{userName}</Text> will remove you
                from these chats until you’re connected to everyone again:
              </Text>
              <ScrollView style={styles.chatList} contentContainerStyle={styles.chatListInner}>
                {chats.map((chat) => (
                  <Text key={chat.id} style={styles.chat} numberOfLines={1}>
                    {chat.title}
                  </Text>
                ))}
              </ScrollView>
            </>
          ) : (
            <Text style={styles.body}>
              Disconnect from <Text style={styles.strong}>{userName}</Text>?
            </Text>
          )}

          <View style={styles.actions}>
            <Pressable
              onPress={onCancel}
              accessibilityRole="button"
              style={({ pressed }) => [styles.btn, styles.ghost, pressed && styles.pressed]}
            >
              <Text style={styles.ghostLabel}>Cancel</Text>
            </Pressable>
            <Pressable
              onPress={onConfirm}
              disabled={impactQuery.isLoading}
              accessibilityRole="button"
              style={({ pressed }) => [
                styles.btn,
                styles.danger,
                (pressed || impactQuery.isLoading) && styles.pressed,
              ]}
            >
              {impactQuery.isLoading ? (
                <ActivityIndicator color="#ffffff" size="small" />
              ) : (
                <Text style={styles.dangerLabel}>Disconnect</Text>
              )}
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(28,26,22,0.4)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
  },
  card: {
    width: '100%',
    maxWidth: 380,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.raised,
    padding: spacing.lg,
    gap: spacing.md,
  },
  body: { fontSize: fontSize.sm, color: colors.ink, lineHeight: 20 },
  strong: { fontWeight: '700' },
  chatList: {
    maxHeight: 160,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
  },
  chatListInner: { padding: spacing.md, gap: spacing.xs },
  chat: { fontSize: fontSize.sm, color: colors.inkSoft },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.sm },
  btn: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    minWidth: 96,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ghost: { borderWidth: 1, borderColor: colors.lineStrong, backgroundColor: colors.raised },
  ghostLabel: { fontSize: fontSize.sm, fontWeight: '600', color: colors.ink },
  danger: { backgroundColor: colors.danger },
  dangerLabel: { fontSize: fontSize.sm, fontWeight: '600', color: '#ffffff' },
  pressed: { opacity: 0.7 },
});
