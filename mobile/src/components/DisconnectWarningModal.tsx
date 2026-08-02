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
 * It serves both disconnect and **block** (E4a): a block severs any connection
 * *and* the same shared group chats, so it warns exactly the same way. The
 * `action` prop swaps only the verb/label; the impact fetch and shape are
 * identical (`getDisconnectImpact` covers both — see api.ts).
 *
 * `busy` holds the dialog up while the write it confirmed is in flight, instead
 * of dismissing the moment you tap Confirm. Dismissing first is what made a
 * failed block invisible on both clients (issue #236); the caller alerts on the
 * rejection and this stays put behind it, so the confirm button is the retry.
 *
 * The web's copy renders the message inside the dialog instead. The app is
 * genuinely mixed on this — `ReactionBar` alerts a rejected reaction, while
 * `events/PollTally` and `events/RsvpBar` render theirs inline under the control
 * — and the split is about where the control lives. Inline text needs somewhere
 * to sit that the user is already looking at; the block/connect controls are a
 * button in a row with a dialog over it, so an Alert, which sits *over* the
 * modal, is the only surface that survives the dialog staying up.
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
  /** Swaps the verb/label; the warning is otherwise identical. Default disconnect. */
  action?: 'disconnect' | 'block';
  /** The confirmed write is in flight — hold the dialog and take no more taps. */
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

export function DisconnectWarningModal({
  userId,
  userName,
  action = 'disconnect',
  busy = false,
  onConfirm,
  onCancel,
}: Props) {
  const impactQuery = useQuery({
    queryKey: ['disconnect-impact', userId],
    queryFn: () => api.getDisconnectImpact(userId),
  });

  const chats = impactQuery.data?.chats ?? [];
  const hasImpact = chats.length > 0;
  const verb = action === 'block' ? 'Blocking' : 'Disconnecting from';
  const label = action === 'block' ? 'Block' : 'Disconnect';

  return (
    <Modal
      transparent
      animationType="fade"
      visible
      onRequestClose={busy ? undefined : onCancel}
      accessibilityViewIsModal
    >
      {/* Tapping the dimmed backdrop cancels; taps inside the card don't, since
          the card is a sibling Pressable that swallows its own presses. Neither
          the backdrop nor Android's back button dismisses out from under a write
          that has already gone to the server — you'd never see how it turned
          out. */}
      <Pressable style={styles.backdrop} onPress={busy ? undefined : onCancel}>
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
                {verb} <Text style={styles.strong}>{userName}</Text> will remove
                you from these chats until you’re connected to everyone again:
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
              {label} <Text style={styles.strong}>{userName}</Text>?
            </Text>
          )}

          <View style={styles.actions}>
            <Pressable
              onPress={onCancel}
              disabled={busy}
              accessibilityRole="button"
              style={({ pressed }) => [
                styles.btn,
                styles.ghost,
                (pressed || busy) && styles.pressed,
              ]}
            >
              <Text style={styles.ghostLabel}>Cancel</Text>
            </Pressable>
            <Pressable
              onPress={onConfirm}
              disabled={busy || impactQuery.isLoading}
              accessibilityRole="button"
              style={({ pressed }) => [
                styles.btn,
                styles.danger,
                (pressed || busy || impactQuery.isLoading) && styles.pressed,
              ]}
            >
              {busy || impactQuery.isLoading ? (
                <ActivityIndicator color="#ffffff" size="small" />
              ) : (
                <Text style={styles.dangerLabel}>{label}</Text>
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
