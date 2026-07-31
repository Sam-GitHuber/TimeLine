/**
 * Edit your own post's text (issue #146).
 *
 * The web flips the card into an inline editor (`PostEditor` in
 * `frontend/src/components/PostCard.jsx`); **the app deliberately uses a modal
 * instead**, and the reason is the list, not taste. `PostCard` renders inside a
 * virtualised `FlatList`: an inline `TextInput` would open under the keyboard
 * with no way to scroll to it, and a row that scrolls out of the window unmounts
 * — taking a half-typed edit with it. A modal is above both problems, and it's
 * the same shape as `ReportModal`, the app's other write-a-bit-of-text sheet.
 *
 * **Text only**, matching the endpoint's v1 scope: photos aren't editable here
 * on either client. The server stamps `edited_at` on a real change (never on a
 * no-op), which is what `PostCard`'s "· edited" marker reads.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { api } from '@/api';
import { KeyboardAvoider } from '@/components/KeyboardAvoider';
import { colors, fontSize, radius, spacing } from '@/theme';

export function PostEditModal({
  postId,
  initialText,
  /** A photo-only post may keep blank text; a text-only one can't be emptied. */
  hasImages = false,
  onClose,
}: {
  postId: number;
  initialText: string;
  hasImages?: boolean;
  onClose: () => void;
}) {
  const [text, setText] = useState(initialText);
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: (value: string) => api.updatePost(postId, value),
    onSuccess: () => {
      // The same four keys the delete path invalidates (`PostMenu`): a post can
      // be on the home feed, a profile, a group timeline, or its own permalink,
      // and the new text — with its "· edited" marker — has to appear on all of
      // them, not just the one you happened to edit from.
      for (const key of [['feed'], ['userPosts'], ['groupPosts'], ['post', String(postId)]]) {
        queryClient.invalidateQueries({ queryKey: key });
      }
      onClose();
    },
  });

  const trimmed = text.trim();
  // Mirrors the server's guard (`PostDetailView.patch`), so the button is
  // disabled rather than the save 400ing. **One flag, read by both the button's
  // `disabled` and `save()`** — #164 was exactly the two disagreeing, and a
  // press that slips past a disabled control would fire a PATCH the server
  // rejects.
  const canSave = !mutation.isPending && (trimmed.length > 0 || hasImages);
  const dirty = trimmed !== initialText.trim();

  function save() {
    if (!canSave) return;
    // Saving the text unchanged just closes. The server already declines to
    // stamp `edited_at` on a no-op, so this changes nothing a user can see —
    // what it avoids is a round-trip and four query invalidations (the feed
    // among them) refetched over a phone connection for no change at all. The
    // message editor makes the same call for the same reason
    // (`[conversationId].tsx`).
    if (!dirty) {
      onClose();
      return;
    }
    mutation.mutate(trimmed);
  }

  /**
   * Backdrop tap and Android back both land here. Losing typing to a stray tap
   * outside the card is a much worse trade in an editor than in the report
   * sheet, so an edit in progress asks first.
   */
  function requestClose() {
    if (mutation.isPending) return;
    if (!dirty) {
      onClose();
      return;
    }
    Alert.alert('Discard changes?', 'Your edit won’t be saved.', [
      { text: 'Keep editing', style: 'cancel' },
      { text: 'Discard', style: 'destructive', onPress: onClose },
    ]);
  }

  return (
    <Modal
      transparent
      animationType="fade"
      visible
      // Android's hardware back routes here — the documented rule for every
      // `<Modal>` in the app (mobile-app.md, "The back button").
      onRequestClose={requestClose}
      accessibilityViewIsModal
    >
      {/* `KeyboardProvider` (#172) strips the `adjustResize` React Native gives
          a modal, so without this the input and its buttons sit behind the
          keyboard — the exact failure `ReportModal` documents. */}
      <KeyboardAvoider style={styles.avoider}>
        <Pressable style={styles.backdrop} onPress={requestClose}>
          {/* The card swallows its own presses, so a tap inside doesn't read as
              a tap on the backdrop behind it. */}
          <Pressable style={styles.card} onPress={() => {}}>
            <Text style={styles.title}>Edit post</Text>
            <TextInput
              style={styles.input}
              value={text}
              onChangeText={setText}
              placeholder={hasImages ? 'Say something (optional)' : 'What’s on your mind?'}
              placeholderTextColor={colors.inkFaint}
              accessibilityLabel="Edit post text"
              multiline
              autoFocus
              editable={!mutation.isPending}
            />
            {/* Everyone who already read the post will see it was changed — say
                so before the edit, not only after it. */}
            <Text style={styles.note}>Edited posts are marked “edited”.</Text>
            {mutation.isError ? (
              <Text style={styles.error} accessibilityRole="alert">
                {mutation.error instanceof Error && mutation.error.message
                  ? mutation.error.message
                  : 'Couldn’t save your changes.'}
              </Text>
            ) : null}
            <View style={styles.actions}>
              <Pressable
                onPress={requestClose}
                // `requestClose` already refuses to close mid-save; saying so
                // with the control's own state means the press is visibly
                // declined rather than silently swallowed.
                disabled={mutation.isPending}
                accessibilityRole="button"
                accessibilityState={{ disabled: mutation.isPending }}
                style={({ pressed }) => [
                  styles.btn,
                  styles.ghost,
                  (pressed || mutation.isPending) && styles.pressed,
                ]}
              >
                <Text style={styles.ghostLabel}>Cancel</Text>
              </Pressable>
              <Pressable
                onPress={save}
                disabled={!canSave}
                accessibilityRole="button"
                accessibilityState={{ disabled: !canSave }}
                style={({ pressed }) => [
                  styles.btn,
                  styles.primary,
                  (pressed || !canSave) && styles.pressed,
                ]}
              >
                {mutation.isPending ? (
                  <ActivityIndicator color="#ffffff" size="small" />
                ) : (
                  <Text style={styles.primaryLabel}>Save</Text>
                )}
              </Pressable>
            </View>
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
  input: {
    minHeight: 96,
    maxHeight: 220,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    paddingBottom: spacing.sm,
    fontSize: fontSize.base,
    lineHeight: 23,
    color: colors.ink,
    textAlignVertical: 'top',
  },
  note: { fontSize: fontSize.sm, color: colors.inkFaint },
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
