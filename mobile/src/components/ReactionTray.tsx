/**
 * The reaction tray: a small row of emoji that opens **in place**, next to the
 * thing you're reacting to, the way WhatsApp does it.
 *
 * Two tiers, same as the web (reactions.md):
 *
 *   1. Four one-tap positive reactions, deliberately positive — this is a
 *      low-friction way to be warm to someone, not a voting widget.
 *   2. A `+` on the tray opening the **full emoji grid**, so "any emoji from
 *      your keyboard" stays true.
 *
 * **Why a library for tier 2.** The web's `emoji-picker-element` is a DOM web
 * component and cannot run here. The first cut used a text input and asked
 * people to reach for the system emoji keyboard, which was the wrong shape: iOS
 * has no way to *open* the keyboard in emoji mode, so it landed on the ABC
 * keyboard and the user had to know to tap 🙂. `rn-emoji-keyboard` is pure JS
 * (no native module, so Expo Go and Jest are unaffected), MIT, and dependency-
 * free, and gives the grid, categories and search that make this feel native.
 *
 * ## Anchoring
 *
 * React Native has no portal and no `position: fixed`, so an in-place popover is
 * built the same way the web's is: **measure the trigger, then draw the tray at
 * those window coordinates inside a full-screen `Modal`**. A tray rendered
 * in-flow instead would be clipped by the post's own bounds and painted over by
 * later rows — the exact bug the web hit and solved with a body-level portal.
 */

import { useState } from 'react';
import {
  Dimensions,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import EmojiPicker from 'rn-emoji-keyboard';

import { colors, radius, spacing } from '@/theme';

/** Mirrors the web's `QuickReactionPopover`. */
const QUICK = ['👍', '❤️', '😂', '🎉'] as const;

const SLOT = 44;
const TRAY_PADDING = spacing.sm;
const TRAY_WIDTH = SLOT * (QUICK.length + 1) + TRAY_PADDING * 2;
const TRAY_HEIGHT = SLOT + TRAY_PADDING * 2;
/** Clearance from the screen edge, so the tray never touches the bezel. */
const MARGIN = spacing.sm;

/** Where the trigger sits in window coordinates, from `measureInWindow`. */
export type Anchor = { x: number; y: number; width: number; height: number };

/**
 * Place the tray beside its trigger, kept on screen.
 *
 * Above the trigger by preference — that's where the eye already is, and it
 * leaves the thing you're reacting to visible rather than covered. Flips below
 * only when there genuinely isn't room above.
 */
export function trayPosition(
  anchor: Anchor | null,
  screen: { width: number; height: number }
): { left: number; top: number } {
  // No measurement yet: centre it. Not where we'd choose, but a usable tray in
  // a reasonable place beats a button that does nothing.
  if (!anchor) {
    return {
      left: Math.max(MARGIN, (screen.width - TRAY_WIDTH) / 2),
      top: Math.max(MARGIN, screen.height / 2 - TRAY_HEIGHT),
    };
  }

  // Centre on the trigger, then clamp both edges into the screen.
  const wanted = anchor.x + anchor.width / 2 - TRAY_WIDTH / 2;
  const left = Math.max(
    MARGIN,
    Math.min(wanted, screen.width - TRAY_WIDTH - MARGIN)
  );

  const above = anchor.y - TRAY_HEIGHT - spacing.sm;
  const below = anchor.y + anchor.height + spacing.sm;
  const fitsBelow = below + TRAY_HEIGHT <= screen.height - MARGIN;
  const top = above >= MARGIN ? above : fitsBelow ? below : MARGIN;

  return { left, top };
}

export function ReactionTray({
  visible,
  anchor,
  onPick,
  onClose,
  reactedEmojis,
}: {
  visible: boolean;
  /** Where to draw it; null until `measureInWindow` reports back. */
  anchor: Anchor | null;
  onPick: (emoji: string) => void;
  onClose: () => void;
  /** Emoji you've already used, shown active — tapping one removes it. */
  reactedEmojis: Set<string>;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);

  if (!visible) return null;

  const screen = Dimensions.get('window');
  const { left, top } = trayPosition(anchor, screen);

  return (
    <>
      <Modal
        visible={!pickerOpen}
        transparent
        animationType="fade"
        onRequestClose={onClose}
      >
        {/* A transparent full-screen catcher: tapping anywhere off the tray
            dismisses it, which is the only way out on iOS (no back button). */}
        <Pressable
          style={styles.scrim}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Close reactions"
        >
          <View style={[styles.tray, { left, top }]}>
            {QUICK.map((emoji) => {
              const active = reactedEmojis.has(emoji);
              return (
                <Pressable
                  key={emoji}
                  onPress={() => onPick(emoji)}
                  style={({ pressed }) => [
                    styles.slot,
                    active && styles.slotActive,
                    pressed && styles.slotPressed,
                  ]}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                  accessibilityLabel={
                    active ? `Remove ${emoji} reaction` : `React with ${emoji}`
                  }
                >
                  <Text style={styles.emoji}>{emoji}</Text>
                </Pressable>
              );
            })}

            <Pressable
              onPress={() => setPickerOpen(true)}
              style={({ pressed }) => [
                styles.slot,
                styles.more,
                pressed && styles.slotPressed,
              ]}
              accessibilityRole="button"
              accessibilityLabel="More emoji"
            >
              <Text style={styles.moreText}>+</Text>
            </Pressable>
          </View>
        </Pressable>
      </Modal>

      {/* The full grid. Rendered as a sibling rather than inside the tray's
          Modal: two visible Modals stack awkwardly on iOS, so the tray hides
          itself (`visible={!pickerOpen}`) while the picker is up. */}
      <EmojiPicker
        open={pickerOpen}
        onClose={() => {
          setPickerOpen(false);
          onClose();
        }}
        onEmojiSelected={(picked: { emoji: string }) => {
          setPickerOpen(false);
          onPick(picked.emoji);
        }}
        enableSearchBar
        theme={{
          backdrop: 'rgba(28, 26, 22, 0.35)',
          knob: colors.accent,
          container: colors.raised,
          header: colors.inkSoft,
          category: {
            icon: colors.inkFaint,
            iconActive: colors.raised,
            container: colors.surface,
            containerActive: colors.accent,
          },
        }}
      />
    </>
  );
}

const styles = StyleSheet.create({
  scrim: { flex: 1 },
  tray: {
    position: 'absolute',
    flexDirection: 'row',
    alignItems: 'center',
    width: TRAY_WIDTH,
    height: TRAY_HEIGHT,
    padding: TRAY_PADDING,
    borderRadius: radius.pill,
    backgroundColor: colors.raised,
    borderWidth: 1,
    borderColor: colors.line,
    // A real shadow: the tray floats above the content, unlike anything else in
    // this design, because it's transient and must read as "on top".
    shadowColor: colors.ink,
    shadowOpacity: 0.18,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 },
    elevation: 8,
  },
  slot: {
    width: SLOT,
    height: SLOT,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  slotActive: { backgroundColor: colors.accentTint },
  slotPressed: { backgroundColor: colors.line },
  emoji: { fontSize: 28 },
  more: { backgroundColor: colors.surface },
  moreText: { fontSize: 24, color: colors.inkSoft, lineHeight: 28 },
});
