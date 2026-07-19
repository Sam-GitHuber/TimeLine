/**
 * Choosing an emoji to react with.
 *
 * **Why this is not a port of the web's picker.** The web uses
 * `emoji-picker-element`, a DOM web component — there is no React Native
 * equivalent of it, and bundling a third-party RN emoji grid would mean a new
 * dependency to vet and maintain for something the phone already does better.
 *
 * So this keeps the web's *two-tier shape* — four one-tap positive reactions,
 * with a way through to the full set — but the second tier is the **system
 * emoji keyboard**: an input the OS fills. That preserves the product promise of
 * "any emoji from your keyboard" (reactions.md) with no dependency at all, and
 * it's the picker people already have muscle memory for on a phone.
 *
 * The quick four are deliberately all positive (product philosophy): this is a
 * low-friction way to be warm to someone, not a voting widget.
 */

import { useState } from 'react';
import {
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { colors, fontSize, radius, spacing } from '@/theme';

/** Mirrors the web's `QuickReactionPopover`. Order matters only to muscle memory. */
const QUICK = ['👍', '❤️', '😂', '🎉'] as const;

export function EmojiSheet({
  visible,
  onPick,
  onClose,
  reactedEmojis,
  error,
}: {
  visible: boolean;
  onPick: (emoji: string) => void;
  onClose: () => void;
  /** Emoji you've already used, shown as active — tapping one removes it. */
  reactedEmojis: Set<string>;
  /** A rejection from the server, e.g. when the typed text isn't an emoji. */
  error?: string | null;
}) {
  const [typed, setTyped] = useState('');

  function submitTyped() {
    const value = typed.trim();
    if (!value) return;
    setTyped('');
    onPick(value);
  }

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      {/* Tapping the scrim closes — the expected way out of a sheet, and the
          only one available on iOS, which has no back button. */}
      <Pressable
        style={styles.scrim}
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel="Close"
      >
        {/* Swallow taps on the sheet itself so they don't reach the scrim. */}
        <Pressable style={styles.sheet} onPress={() => {}}>
          <Text style={styles.title}>React</Text>

          <View style={styles.quickRow}>
            {QUICK.map((emoji) => {
              const active = reactedEmojis.has(emoji);
              return (
                <Pressable
                  key={emoji}
                  onPress={() => onPick(emoji)}
                  style={({ pressed }) => [
                    styles.quick,
                    active && styles.quickActive,
                    pressed && styles.quickPressed,
                  ]}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                  accessibilityLabel={
                    active ? `Remove ${emoji} reaction` : `React with ${emoji}`
                  }
                >
                  <Text style={styles.quickEmoji}>{emoji}</Text>
                </Pressable>
              );
            })}
          </View>

          <Text style={styles.hint}>
            Or use any emoji — tap 🙂 on your keyboard to browse them all.
          </Text>

          <View style={styles.typeRow}>
            <TextInput
              style={styles.input}
              value={typed}
              onChangeText={setTyped}
              // No `keyboardType` for emoji exists on iOS, so we can't open the
              // emoji keyboard directly — hence the hint above. Autocorrect and
              // autocapitalise off: neither helps, and both can mangle input.
              autoCorrect={false}
              autoCapitalize="none"
              placeholder="😀"
              placeholderTextColor={colors.inkFaint}
              accessibilityLabel="Any emoji"
              returnKeyType="done"
              onSubmitEditing={submitTyped}
            />
            <Pressable
              onPress={submitTyped}
              disabled={!typed.trim()}
              style={({ pressed }) => [
                styles.add,
                pressed && styles.addPressed,
                !typed.trim() && styles.addDisabled,
              ]}
              accessibilityRole="button"
              accessibilityLabel="Add reaction"
            >
              <Text style={styles.addText}>Add</Text>
            </Pressable>
          </View>

          {/* The server is the authority on what counts as an emoji (it rejects
              pasted text and caps ZWJ chains — see api/emoji.py), so its message
              is surfaced rather than duplicating that rule here. */}
          {error ? <Text style={styles.error}>{error}</Text> : null}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: {
    flex: 1,
    backgroundColor: 'rgba(28, 26, 22, 0.35)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: colors.raised,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    padding: spacing.lg,
    paddingBottom: spacing.xl,
    gap: spacing.md,
  },
  title: { fontSize: fontSize.base, fontWeight: '700', color: colors.ink },
  quickRow: { flexDirection: 'row', gap: spacing.sm },
  quick: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
  },
  quickActive: { borderColor: colors.accent, backgroundColor: colors.accentTint },
  quickPressed: { backgroundColor: colors.accentTint },
  quickEmoji: { fontSize: 26 },
  hint: { fontSize: fontSize.sm, color: colors.inkFaint, lineHeight: 18 },
  typeRow: { flexDirection: 'row', gap: spacing.sm, alignItems: 'center' },
  input: {
    flex: 1,
    height: 44,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    fontSize: fontSize.lg,
    color: colors.ink,
    backgroundColor: colors.surface,
  },
  add: {
    backgroundColor: colors.accent,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm + 2,
  },
  addPressed: { backgroundColor: colors.accentDeep },
  addDisabled: { opacity: 0.4 },
  addText: { color: colors.raised, fontWeight: '600', fontSize: fontSize.sm },
  error: { fontSize: fontSize.sm, color: colors.danger },
});
