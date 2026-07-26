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

const MENU_WIDTH = 220;
/** Row height + the menu's own vertical padding — used to decide about-facing. */
const ITEM_HEIGHT = 46;
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
  onClose,
}: {
  message: Message;
  mine: boolean;
  anchor: BubbleAnchor;
  actions: MessageAction[];
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

  const menuHeight = actions.length * ITEM_HEIGHT + MENU_PADDING * 2;
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
      visible
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
        <BubbleBody message={message} mine={mine} />
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
        {/* A long list (M2/M3 add rows) scrolls rather than overflowing the
            screen; at M1's three items it never does. */}
        <ScrollView bounces={false} style={{ maxHeight: screenH * 0.5 }}>
          {actions.map((action, i) => (
            <Pressable
              key={action.label}
              onPress={() => {
                // Close first: every action either navigates, opens a modal, or
                // puts the composer into edit mode, and all three want the
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
  menu: {
    position: 'absolute',
    paddingVertical: MENU_PADDING,
    borderRadius: radius.md,
    backgroundColor: colors.raised,
    borderWidth: 1,
    borderColor: colors.line,
    // A real shadow, because the menu floats over a dimmed thread and needs to
    // sit visibly above it.
    shadowColor: '#1c1a16',
    shadowOpacity: 0.18,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 },
    elevation: 8,
    overflow: 'hidden',
  },
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
