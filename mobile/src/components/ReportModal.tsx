/**
 * Report a post, comment or message to the maintainer for review.
 *
 * Ported from `frontend/src/components/ReportButton.jsx`'s `ReportModal`. Pass
 * exactly one of `postId` / `commentId` / `messageId`. Opens over the screen, takes
 * an optional reason, and POSTs a report the maintainer reviews in the Django admin
 * (the content-takedown path — see accounts.md). Reporting is required for App
 * Review, so it must be reachable from any post and any comment that isn't your own.
 *
 * Surfaces that open it: the post ⋯ menu (`PostMenu`), the inline "Report" action
 * on a comment (`CommentThread`), and a message's long-press menu — the owner
 * check lives in *those*, so this component just does the reporting.
 *
 * Reporting a **message** carries extra weight (Phase 9b M0): the admin can no
 * longer read a conversation, so a report is the only way the maintainer ever sees
 * message text, and the server snapshots the reported text into the report. The
 * copy says so — someone flagging a private message deserves to know exactly what
 * they're handing over.
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

import { api, serverMessage } from '@/api';
import { KeyboardAvoider } from '@/components/KeyboardAvoider';
import { colors, fontSize, radius, spacing } from '@/theme';

export function ReportModal({
  postId,
  commentId,
  messageId,
  onClose,
}: {
  postId?: number;
  commentId?: number;
  messageId?: number;
  onClose: () => void;
}) {
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const target =
    postId != null ? 'post' : commentId != null ? 'comment' : 'message';

  async function submit() {
    if (submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      await api.reportContent({
        postId,
        commentId,
        messageId,
        reason: reason.trim(),
      });
      // Clear `submitting` alongside `done`: the dismissal gates below read it,
      // and the success screen must stay dismissable by back and the backdrop.
      setSubmitting(false);
      setDone(true);
    } catch (err) {
      setError(serverMessage(err, 'Couldn’t send the report.'));
      setSubmitting(false);
    }
  }

  return (
    <Modal
      transparent
      animationType="fade"
      visible
      onRequestClose={() => {
        if (!submitting) onClose();
      }}
      accessibilityViewIsModal
    >
      {/* Required since #172 mounted `KeyboardProvider`: that strips the
          `adjustResize` React Native gives every modal dialog, so the reason box
          and the Cancel/Send buttons would otherwise sit behind the keyboard,
          with no scroll to reach them. See `components/KeyboardAvoider.tsx`. */}
      <KeyboardAvoider style={styles.avoider}>
        {/* Backdrop cancels; the card swallows its own presses (a sibling
            Pressable), matching DisconnectWarningModal.

            Every way out — backdrop, Cancel, and the Android hardware back
            above — is held shut while the report is in flight (issue #254).
            The rejection renders inside this modal, so dismissing it mid-request
            tears down the only thing that could have said the report never
            sent, and silence here is indistinguishable from never having
            pressed Send. This is the safety path; it doesn't get to be
            ambiguous. Matches the web's `ConfirmDeleteDialog`. */}
        <Pressable
          testID="report-backdrop"
          style={styles.backdrop}
          onPress={submitting ? undefined : onClose}
        >
          <Pressable style={styles.card} onPress={() => {}}>
            {done ? (
              <>
                <Text style={styles.title}>Thanks for letting us know</Text>
                <Text style={styles.body}>
                  {target === 'message'
                    ? 'We’ll review this message and act on it if it breaks the rules.'
                    : `We’ll review this ${target} and take it down if it breaks the rules.`}
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
                {/* Say plainly what reporting a private message hands over. The
                    site owner can't read conversations any other way, so this is
                    the one moment message text leaves the chat. */}
                {target === 'message' ? (
                  <Text style={styles.body}>
                    A copy of this message is sent with your report. It’s the only
                    way the site owner can see it — they can’t read your
                    conversations otherwise.
                  </Text>
                ) : null}
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
                    disabled={submitting}
                    accessibilityRole="button"
                    style={({ pressed }) => [
                      styles.btn,
                      styles.ghost,
                      (pressed || submitting) && styles.pressed,
                    ]}
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
      </KeyboardAvoider>
    </Modal>
  );
}

const styles = StyleSheet.create({
  avoider: { flex: 1 },
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
