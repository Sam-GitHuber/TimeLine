/**
 * Report a post or comment to the maintainer for review.
 *
 * Ported from `frontend/src/components/ReportButton.jsx`'s `ReportModal`. Pass
 * exactly one of `postId` / `commentId`. Opens over the screen, takes an optional
 * reason, and POSTs a report the maintainer reviews in the Django admin (the
 * content-takedown path — see accounts.md). Reporting is required for App Review,
 * so it must be reachable from any post and any comment that isn't your own.
 *
 * Two surfaces open it: the post ⋯ menu (`PostMenu`) and the inline "Report"
 * action on a comment (`CommentThread`) — the owner check lives in *those*, so
 * this component just does the reporting.
 */

import { useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { api } from '@/api';
import { colors, fontSize, radius, spacing } from '@/theme';

export function ReportModal({
  postId,
  commentId,
  onClose,
}: {
  postId?: number;
  commentId?: number;
  onClose: () => void;
}) {
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const target = postId != null ? 'post' : 'comment';

  async function submit() {
    if (submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      await api.reportContent({ postId, commentId, reason: reason.trim() });
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t send the report.');
      setSubmitting(false);
    }
  }

  return (
    <Modal
      transparent
      animationType="fade"
      visible
      onRequestClose={onClose}
      accessibilityViewIsModal
    >
      {/* Backdrop cancels; the card swallows its own presses (a sibling
          Pressable), matching DisconnectWarningModal. */}
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.card} onPress={() => {}}>
          {done ? (
            <>
              <Text style={styles.title}>Thanks for letting us know</Text>
              <Text style={styles.body}>
                We’ll review this {target} and take it down if it breaks the
                rules.
              </Text>
              <View style={styles.actions}>
                <Pressable
                  onPress={onClose}
                  accessibilityRole="button"
                  style={({ pressed }) => [styles.btn, styles.primary, pressed && styles.pressed]}
                >
                  <Text style={styles.primaryLabel}>Done</Text>
                </Pressable>
              </View>
            </>
          ) : (
            <>
              <Text style={styles.title}>Report this {target}</Text>
              <Text style={styles.body}>
                Tell us what’s wrong (optional) — for example it infringes your
                copyright, or shouldn’t be here. It goes to the site owner to
                review.
              </Text>
              <TextInput
                style={styles.input}
                value={reason}
                onChangeText={setReason}
                placeholder="What’s the problem?"
                placeholderTextColor={colors.inkFaint}
                accessibilityLabel={`Reason for reporting this ${target}`}
                multiline
                maxLength={1000}
                editable={!submitting}
              />
              {error ? (
                <Text style={styles.error} accessibilityRole="alert">
                  {error}
                </Text>
              ) : null}
              <View style={styles.actions}>
                <Pressable
                  onPress={onClose}
                  accessibilityRole="button"
                  style={({ pressed }) => [styles.btn, styles.ghost, pressed && styles.pressed]}
                >
                  <Text style={styles.ghostLabel}>Cancel</Text>
                </Pressable>
                <Pressable
                  onPress={submit}
                  disabled={submitting}
                  accessibilityRole="button"
                  style={({ pressed }) => [
                    styles.btn,
                    styles.primary,
                    (pressed || submitting) && styles.pressed,
                  ]}
                >
                  {submitting ? (
                    <ActivityIndicator color="#ffffff" size="small" />
                  ) : (
                    <Text style={styles.primaryLabel}>Send report</Text>
                  )}
                </Pressable>
              </View>
            </>
          )}
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
  title: { fontSize: fontSize.lg, fontWeight: '700', color: colors.ink },
  body: { fontSize: fontSize.sm, color: colors.inkSoft, lineHeight: 20 },
  input: {
    minHeight: 72,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    paddingBottom: spacing.sm,
    fontSize: fontSize.sm,
    color: colors.ink,
    textAlignVertical: 'top',
  },
  error: { fontSize: fontSize.sm, color: colors.danger },
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
  primary: { backgroundColor: colors.accent },
  primaryLabel: { fontSize: fontSize.sm, fontWeight: '600', color: '#ffffff' },
  pressed: { opacity: 0.7 },
});
