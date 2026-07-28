/**
 * A list row you can swipe for actions (Phase 9b M6) — the shape every
 * mainstream messaging app's conversation list has, and the reason people are
 * surprised when a row doesn't move.
 *
 * The convention it copies is iOS's own, so it needs no teaching: **swipe left**
 * (trailing) for the destructive-leaning actions, **swipe right** (leading) for
 * the read/unread toggle. `SwipeAction`s are data, so a caller decides what a
 * row offers per row — a pending invite has no "mark unread" to give.
 *
 * ## Why this wraps a deprecated component, deliberately
 *
 * `react-native-gesture-handler` ships two: `ReanimatedSwipeable` (current) and
 * `Swipeable` (deprecated, animated with React Native's own `Animated`). We use
 * the latter, for the same reason `MessageActionMenu` animates with `Animated`
 * rather than Reanimated (Phase 9b M1): **Reanimated's worklet runtime cannot be
 * loaded under Jest.** Importing `ReanimatedSwipeable` fails the whole suite at
 * `require` time, and the only way past it is `jest.mock`-ing the swipe away —
 * i.e. mocking out the component under test, which is exactly the trade M1
 * refused to make. Here the actions would be the mocked part, so a test could
 * never prove that "Leave" leaves.
 *
 * The deprecation is real and this is the seam that contains it: when RNGH
 * eventually drops `Swipeable`, one file changes and every caller stays put.
 *
 * ## Why a swipe is safe on *this* screen
 *
 * M3 built and removed a swipe-to-reply on a message bubble because a rightward
 * drag was also the navigator's interactive back gesture and the two raced for
 * the touch. That doesn't apply here: the conversation list is a **tab root**,
 * so there is nothing to go back to and no competing responder. Worth stating,
 * because "we removed a swipe once" is otherwise the sort of note that gets
 * read as "swipes don't work in this app".
 */

import { useRef } from 'react';
import type { ReactNode } from 'react';
import { Animated, Pressable, StyleSheet, Text, View } from 'react-native';
import { Swipeable } from 'react-native-gesture-handler';

import { colors, fontSize, spacing } from '@/theme';

export type SwipeAction = {
  label: string;
  onPress: () => void;
  /** Red rather than neutral — for the ones you can't take back. */
  destructive?: boolean;
  /** Overrides the neutral fill; used for the accented read/unread toggle. */
  tint?: string;
};

/** How wide one action button is. Two fit a phone comfortably; three crowd it. */
const ACTION_WIDTH = 84;

function ActionPanel({
  actions,
  progress,
  side,
  close,
}: {
  actions: SwipeAction[];
  progress: Animated.AnimatedInterpolation<number>;
  side: 'left' | 'right';
  close: () => void;
}) {
  return (
    <View style={[styles.panel, { width: ACTION_WIDTH * actions.length }]}>
      {actions.map((action) => (
        <Animated.View
          key={action.label}
          style={[
            styles.actionWrap,
            {
              // Slide in with the drag rather than sitting there fully formed:
              // the panel is revealed *by* the gesture, so it should look like
              // it's being pulled out from under the row.
              transform: [
                {
                  translateX: progress.interpolate({
                    inputRange: [0, 1],
                    outputRange: [
                      side === 'right' ? ACTION_WIDTH : -ACTION_WIDTH,
                      0,
                    ],
                  }),
                },
              ],
            },
          ]}
        >
          <Pressable
            onPress={() => {
              // Close first: the action may push a screen or open an alert, and
              // a row left hanging open behind it is there when you come back.
              close();
              action.onPress();
            }}
            accessibilityRole="button"
            accessibilityLabel={action.label}
            style={({ pressed }) => [
              styles.action,
              {
                backgroundColor: action.destructive
                  ? colors.danger
                  : action.tint ?? colors.inkFaint,
              },
              pressed && styles.pressed,
            ]}
          >
            <Text style={styles.actionLabel} numberOfLines={2}>
              {action.label}
            </Text>
          </Pressable>
        </Animated.View>
      ))}
    </View>
  );
}

export function SwipeableRow({
  leftActions = [],
  rightActions = [],
  children,
}: {
  /** Revealed by swiping *right*. iOS puts read/unread here. */
  leftActions?: SwipeAction[];
  /** Revealed by swiping *left*. Mute, leave — the ones with consequences. */
  rightActions?: SwipeAction[];
  children: ReactNode;
}) {
  const ref = useRef<Swipeable>(null);
  const close = () => ref.current?.close();

  return (
    <Swipeable
      ref={ref}
      // Both directions are optional, and passing `undefined` (rather than a
      // renderer that returns nothing) is what stops an empty panel from
      // catching the drag on a row with no actions on that side.
      renderLeftActions={
        leftActions.length
          ? (progress) => (
              <ActionPanel
                actions={leftActions}
                progress={progress}
                side="left"
                close={close}
              />
            )
          : undefined
      }
      renderRightActions={
        rightActions.length
          ? (progress) => (
              <ActionPanel
                actions={rightActions}
                progress={progress}
                side="right"
                close={close}
              />
            )
          : undefined
      }
      // Enough drag that a diagonal flick down the list doesn't peel a row open,
      // and enough overshoot resistance that the panel feels attached to it.
      leftThreshold={ACTION_WIDTH / 2}
      rightThreshold={ACTION_WIDTH / 2}
      overshootFriction={8}
    >
      {children}
    </Swipeable>
  );
}

const styles = StyleSheet.create({
  panel: { flexDirection: 'row' },
  actionWrap: { flex: 1 },
  action: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xs,
  },
  actionLabel: {
    fontSize: fontSize.sm - 1,
    fontWeight: '700',
    color: '#ffffff',
    textAlign: 'center',
  },
  pressed: { opacity: 0.8 },
});
