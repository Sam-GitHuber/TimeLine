/**
 * The long-press menu on a message bubble (Phase 9b M1).
 *
 * **Why this isn't an action sheet.** The app already has a menu pattern —
 * `PostMenu` opens `ActionSheetIOS` — and reusing it here would have been the
 * cheap call. It's the wrong one for a chat. A sheet slides up from the bottom
 * of the screen, detached from the thing it acts on, so if the long-press landed
 * on the wrong bubble there is nothing on screen to tell you before you tap
 * Delete. So instead: the thread dims, the pressed bubble stays at full
 * brightness, and a small menu floats **directly beneath it**. You can always see
 * what you're about to act on. That's the whole reason for the extra work here.
 *
 * How the anchoring works: the bubble measures itself with `measureInWindow()`
 * on long-press and hands the caller its screen rect. This component renders a
 * transparent `Modal` over the app, re-renders *the same* `BubbleBody` at that
 * exact rect (so the highlight is the real bubble, not an approximation of one),
 * and places the menu below — flipping above when the bubble sits low enough that
 * the menu wouldn't fit.
 *
 * **The item list is data, not JSX**, because M2 (react) and M3 (reply) insert
 * their own entries into this same menu; a caller builds the array so this file
 * never grows a list of features it has to know about.
 *
 * **The quick-reaction row (Phase 9b M2)** sits above the items rather than in
 * them, because it's a different kind of thing: six one-tap emoji laid out
 * horizontally, not a list of verbs. It's the row your thumb is already heading
 * for, so it goes closest to the bubble. Its `＋` hands over to the caller's full
 * emoji grid — see the `visible` prop for the handover rule.
 *
 * The grow-and-fade uses React Native's own `Animated`, not Reanimated. Both are
 * in the app, but Reanimated's worklet runtime can't be loaded by Jest, and
 * mocking it out here would mean mocking away the component under test. A 120ms
 * opacity + scale runs on the native driver either way, so nothing is lost.
 */

import { useEffect, useState } from 'react';
import {
  Animated,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';

import { BubbleBody } from './MessageBubble';
import { colors, fontSize, radius, spacing } from '@/theme';
import type { Message } from '@/types';

/** A bubble's position on screen, from `measureInWindow`. */
export type BubbleAnchor = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type MessageAction = {
  /** Shown in the row, and used as the accessibility label. */
  label: string;
  onPress: () => void;
  /** Renders the row in the danger colour (Delete). */
  destructive?: boolean;
};

/**
 * The one-tap emoji, and the row's whole design brief: cover the replies people
 * actually send so the `＋` is the exception rather than the route.
 *
 * **Deliberately not the same six as the feed's four.** `ReactionTray` keeps its
 * quick set strictly positive (👍 ❤️ 😂 🎉) because reacting to someone's *post*
 * with 😢 reads as a verdict on it. In a conversation the opposite is true: "😮"
 * and "😢" to someone's news are the warm, human answers, and a set that can
 * only be cheerful makes you type a whole message to say "oh no". Different
 * context, different set — not an oversight.
 */
const QUICK = ['👍', '❤️', '😂', '😮', '😢', '🙏'] as const;

const MENU_WIDTH = 268;
/** Row height + the menu's own vertical padding — used to decide about-facing. */
const ITEM_HEIGHT = 46;
/** The quick-reaction row's height, including its divider. */
const QUICK_HEIGHT = 52;
const MENU_PADDING = spacing.xs;
/** Gap between the highlighted bubble and the menu. */
const GAP = spacing.sm;
/** Keep the whole floating group clear of the screen edges. */
const EDGE = spacing.md;

export function MessageActionMenu({
  message,
  mine,
  anchor,
  actions,
  mentionNames,
  onReact,
  onMoreEmoji,
  visible = true,
  onClose,
}: {
  message: Message;
  mine: boolean;
  anchor: BubbleAnchor;
  actions: MessageAction[];
  /**
   * Names for this message's mention ids (Phase 9b M8). The preview re-renders
   * the *real* bubble, so a highlighted `@Ada` that lost its highlight under the
   * menu would give the game away that it's a copy.
   *
   * A reply used to need `quoted` here for the same reason. The strand edge
   * (M9g) needs nothing passed: the bar is drawn from `message.reply_to`, which
   * the preview already has, so the copy matches by construction.
   */
  mentionNames?: Map<number, string>;
  /**
   * Toggle an emoji on this message. Omitted when reacting isn't available —
   * a thread you can no longer send to — and the row is then left out entirely
   * rather than shown offering an action that would 403.
   */
  onReact?: (emoji: string) => void;
  /**
   * Open the full emoji grid — the caller's job, because `rn-emoji-keyboard` is
   * itself a `Modal`. It must **keep this component mounted** and hide it with
   * `visible={false}` while the grid is up; see that prop.
   */
  onMoreEmoji?: () => void;
  /**
   * Hides the menu without unmounting it, for handing over to another modal.
   *
   * `ReactionTray` learned this the hard way and it's the same trap here: on iOS
   * you must not tear down a presented modal in the same commit that presents
   * the next one, or the new one can fail to appear and leave the screen
   * unresponsive behind a dismissed one. Toggling `visible` lets RN sequence the
   * transition itself. The caller unmounts this only once nothing else is up.
   */
  visible?: boolean;
  onClose: () => void;
}) {
  const { width: screenW, height: screenH } = useWindowDimensions();
  // The bubble is re-rendered inside the modal, so it can be *taller* here than
  // it measured (a different font scale, a stale measure after a re-render).
  // Measuring the copy keeps the menu attached to what's actually drawn.
  const [previewHeight, setPreviewHeight] = useState(anchor.height);

  // Grow-and-fade from the bubble's edge, so the menu reads as coming *out of*
  // the message rather than appearing over it.
  // `useState` with an initialiser, not `useRef().current`: the value is read
  // during render (it drives the style), and a ref read in render is exactly
  // what React tells you not to do.
  const [reveal] = useState(() => new Animated.Value(0));
  useEffect(() => {
    Animated.timing(reveal, {
      toValue: 1,
      duration: 120,
      useNativeDriver: true,
    }).start();
  }, [reveal]);

  // Emoji you've already put on this message, shown active — tapping one takes
  // it off, which is the same toggle the pill under the bubble does.
  const reacted = new Set(
    (message.reactions ?? []).filter((r) => r.reacted).map((r) => r.emoji)
  );
  const showQuick = !!onReact;

  const menuHeight =
    actions.length * ITEM_HEIGHT +
    (showQuick ? QUICK_HEIGHT : 0) +
    MENU_PADDING * 2;
  const below = anchor.y + previewHeight + GAP;
  // Flip above when the menu would run off the bottom. Nothing clever about the
  // threshold: if it doesn't fit under the bubble, it goes over it.
  const flip = below + menuHeight > screenH - EDGE;
  const top = flip ? Math.max(EDGE, anchor.y - GAP - menuHeight) : below;

  // Hang the menu off the bubble's near edge — right-aligned under your own
  // messages, left-aligned under everyone else's — so it reads as belonging to
  // that bubble rather than floating loose.
  const rawLeft = mine ? anchor.x + anchor.width - MENU_WIDTH : anchor.x;
  const left = Math.min(Math.max(EDGE, rawLeft), screenW - MENU_WIDTH - EDGE);

  return (
    <Modal
      transparent
      visible={visible}
      animationType="fade"
      onRequestClose={onClose}
      accessibilityViewIsModal
    >
      {/* Anywhere off the menu dismisses — including on the highlighted bubble,
          which is a preview, not a control. */}
      <Pressable
        style={styles.backdrop}
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel="Close message actions"
      />

      <View
        pointerEvents="box-none"
        style={[styles.preview, { top: anchor.y, left: anchor.x, width: anchor.width }]}
        onLayout={(e) => setPreviewHeight(e.nativeEvent.layout.height)}
      >
        <BubbleBody message={message} mine={mine} mentionNames={mentionNames} />
      </View>

      <Animated.View
        style={[
          styles.menu,
          {
            top,
            left,
            width: MENU_WIDTH,
            opacity: reveal,
            transform: [
              {
                scale: reveal.interpolate({
                  inputRange: [0, 1],
                  outputRange: [0.94, 1],
                }),
              },
            ],
          },
        ]}
      >
        {/* Rounding + clipping live on an inner view, never on the shadowed one:
            `overflow: hidden` is `clipsToBounds` on iOS, which clips the shadow
            away as well as the corners. Two views is the standard fix. */}
        <View style={styles.menuClip}>
          {showQuick ? (
            <View style={styles.quickRow}>
              {QUICK.map((emoji) => {
                const active = reacted.has(emoji);
                return (
                  <Pressable
                    key={emoji}
                    onPress={() => {
                      onClose();
                      onReact?.(emoji);
                    }}
                    accessibilityRole="button"
                    accessibilityState={{ selected: active }}
                    accessibilityLabel={
                      active ? `Remove ${emoji} reaction` : `React with ${emoji}`
                    }
                    style={({ pressed }) => [
                      styles.quickSlot,
                      active && styles.quickSlotActive,
                      pressed && styles.quickSlotPressed,
                    ]}
                  >
                    <Text style={styles.quickEmoji}>{emoji}</Text>
                  </Pressable>
                );
              })}
              {onMoreEmoji ? (
                <Pressable
                  // Deliberately does *not* call onClose: the caller hides this
                  // menu via `visible` and closes it once the grid is done. See
                  // that prop for why unmounting here would be a bug.
                  onPress={onMoreEmoji}
                  accessibilityRole="button"
                  accessibilityLabel="More emoji"
                  style={({ pressed }) => [
                    styles.quickSlot,
                    styles.more,
                    pressed && styles.quickSlotPressed,
                  ]}
                >
                  <Text style={styles.moreText}>＋</Text>
                </Pressable>
              ) : null}
            </View>
          ) : null}

          {/* A long list (M3 adds Reply) scrolls rather than overflowing the
              screen; at three or four items it never does. */}
          <ScrollView bounces={false} style={{ maxHeight: screenH * 0.5 }}>
            {actions.map((action, i) => (
              <Pressable
                key={action.label}
                onPress={() => {
                  // Close first: every action either navigates, opens a modal,
                  // or puts the composer into edit mode, and all three want the
                  // overlay gone before they run.
                  onClose();
                  action.onPress();
                }}
                accessibilityRole="button"
                accessibilityLabel={action.label}
                style={({ pressed }) => [
                  styles.item,
                  i > 0 && styles.itemDivided,
                  pressed && styles.itemPressed,
                ]}
              >
                <Text
                  style={[styles.itemLabel, action.destructive && styles.destructive]}
                >
                  {action.label}
                </Text>
              </Pressable>
            ))}
          </ScrollView>
        </View>
      </Animated.View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  // Dimming the thread is what makes the pressed bubble read as "selected"
  // without drawing a border on it.
  backdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(28,26,22,0.35)',
  },
  preview: { position: 'absolute' },
  // The shadow layer. Carries no `overflow: hidden` — see `menuClip`.
  menu: {
    position: 'absolute',
    borderRadius: radius.md,
    // A real shadow, because the menu floats over a dimmed thread and needs to
    // sit visibly above it.
    shadowColor: '#1c1a16',
    shadowOpacity: 0.18,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 },
    elevation: 8,
  },
  // The surface layer: background, border, rounded corners, and the clipping
  // that keeps a pressed row's tint inside them.
  menuClip: {
    paddingVertical: MENU_PADDING,
    borderRadius: radius.md,
    backgroundColor: colors.raised,
    borderWidth: 1,
    borderColor: colors.line,
    overflow: 'hidden',
  },
  // The emoji row. `space-between` rather than a gap so the seven slots always
  // span the menu's width exactly, whatever MENU_WIDTH becomes.
  quickRow: {
    height: QUICK_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  quickSlot: {
    width: 34,
    height: 34,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  quickSlotActive: { backgroundColor: colors.accentTint },
  quickSlotPressed: { backgroundColor: colors.line },
  quickEmoji: { fontSize: 24 },
  more: { backgroundColor: colors.surface },
  moreText: { fontSize: 16, color: colors.inkSoft },
  item: {
    height: ITEM_HEIGHT,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
  },
  itemDivided: { borderTopWidth: 1, borderTopColor: colors.line },
  itemPressed: { backgroundColor: colors.accentTint },
  itemLabel: { fontSize: fontSize.base - 1, color: colors.ink, fontWeight: '500' },
  destructive: { color: colors.danger },
});
