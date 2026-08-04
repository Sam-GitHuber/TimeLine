/**
 * Pull a message rightward to reply to it — the gesture every mainstream
 * messenger has, and the one people try on this app without being told.
 *
 * ## Why it's back
 *
 * M3 shipped a swipe-to-reply and pulled it after a day: a rightward drag
 * starting on a bubble was also the navigator's interactive back gesture, the
 * two raced for the same touch, and the navigator usually won — you'd swipe a
 * bubble and land on the conversation list with no reply started. The note left
 * behind said a swipe could only come back if the screen's own back gesture went
 * first, and called that more machinery than the affordance was worth.
 *
 * That was the wrong way round, and this is the correction. **The thread screen
 * now turns its back gesture off** (`gestureEnabled: false`, set in
 * `app/_layout.tsx` — the reason lives there too), so nothing else is claiming
 * this drag. Back is the header's "← Back", which was always there, plus
 * Android's system back, which is the OS's gesture and unaffected. One drag,
 * one owner: the race is gone rather than tuned.
 *
 * ## How it behaves
 *
 * Drag right and the message follows your thumb, damped, to a hard stop at
 * `MAX_PULL` — it's a nudge, not a drawer you can open. Past `TRIGGER` a reply
 * is **armed**: a light haptic fires once, the arrow behind the bubble is at
 * full strength, and letting go replies. Let go short of it and the message
 * springs home having done nothing. Nothing happens *during* the drag, which is
 * what makes an accidental pull free to abandon.
 *
 * The arrow sits *behind* the message rather than travelling with it, so an
 * incoming bubble uncovers it as it slides — the affordance is revealed by the
 * gesture instead of being announced before it. It's `pointerEvents="none"`: it
 * is a hint, never a target.
 *
 * **Vertical scrolling wins.** `failOffsetY` makes the pan give up the moment a
 * drag looks like a scroll, so flicking through a thread never peels a bubble
 * sideways. `activeOffsetX` keeps a tap or a long-press from registering as a
 * one-pixel drag, which is what leaves the bubble's own two gestures (tap opens
 * a strand, hold opens the menu) intact.
 *
 * ## Why the legacy handler and RN's own `Animated`
 *
 * `PanGestureHandler` is `react-native-gesture-handler`'s deprecated API and the
 * animation is React Native's `Animated`, not Reanimated — the same trade
 * `MessageActionMenu` and `SwipeableRow` document. **Reanimated's worklet
 * runtime cannot be loaded under Jest**, and the modern `Gesture.Pan()` +
 * `GestureDetector` pair leans on it, so the current API would mean mocking the
 * gesture away — i.e. mocking out the thing under test. Here that would leave
 * "does a swipe start a reply" untestable, which is the entire component.
 *
 * `useNativeDriver: false` on the spring for a related reason: the drag itself
 * is a JS callback writing `translateX` with `setValue`, and the hint reads that
 * same value through two interpolations. Handing the value to the native driver
 * for the spring and back for the drag is the mixed-ownership case Animated
 * warns about; the spring is one short transform on one row, so the JS driver is
 * the boring choice and not a visible one.
 */

import type { ReactNode } from 'react';
import { useRef, useState } from 'react';
import * as Haptics from 'expo-haptics';
import { Animated, StyleSheet, View } from 'react-native';
import type {
  PanGestureHandlerGestureEvent,
  PanGestureHandlerStateChangeEvent,
} from 'react-native-gesture-handler';
import { PanGestureHandler, State } from 'react-native-gesture-handler';

import { ReplyIcon } from './icons';
import { colors, spacing } from '@/theme';

/** How far the message must travel before letting go replies. */
const TRIGGER = 56;
/** The hard stop. Past here the drag stops moving anything. */
const MAX_PULL = 76;
/**
 * Rightward drag before the pan takes over, so a tap or a hold is never a
 * swipe. **A positive scalar, not `[-SLOP, SLOP]`** — RNGH reads the array form
 * as two independent thresholds, so the symmetric version also activates on a
 * *leftward* drag, and this component has nothing to do with one. That isn't
 * harmless: an activated pan cancels the touch under it, so a scroll flick that
 * drifted left before it drifted down would be swallowed by a gesture that then
 * moves nothing. A scalar sets only the rightward threshold
 * (`transformPanGestureHandlerProps`), which is what the rest of this file
 * assumes.
 */
const SLOP = 12;
/** Vertical drift that hands the touch back to the list's scroll. */
const SCROLL_SLOP = 10;

/**
 * Has this drag earned a reply? Distance only, deliberately — a flick fast
 * enough to count on velocity is a flick you can't feel yourself making, and
 * this gesture's whole safety story is that you can see and feel where the line
 * is before you commit.
 */
export function repliesOnRelease(translationX: number): boolean {
  return translationX >= TRIGGER;
}

export function SwipeToReply({
  onReply,
  testID,
  children,
}: {
   /**
   * Start a reply to this message. **Absent turns the gesture off** —
   * `enabled={false}`, so the pan never activates and the drag stays with
   * whatever is underneath. The callbacks return early on it too, which isn't
   * redundant: an event arriving at a disabled row would otherwise still slide
   * it sideways, since moving the row and calling this are separate things.
   * The caller decides who opts out — a read-only thread, a tombstone, a
   * message still in the outbox, or anything at all while a selection is on.
   */
  onReply?: () => void;
  /**
   * Lands on the host view underneath the handler, which is how a test fires
   * the gesture for *one particular* message — see `thread.test.tsx`. A drag
   * has no accessible name to query by, so without this a suite could only
   * reach the swipe by position in the tree.
   */
  testID?: string;
  children: ReactNode;
}) {
  // Lazy `useState`, not the familiar `useRef(new Animated.Value(0)).current`:
  // an `Animated.Value` is read during render — it *is* the style — and the
  // React Compiler (on in `app.json`) fails that under `react-hooks/refs`. The
  // house pattern, see `MessageActionMenu` and `docs/reference/mobile-app.md`.
  const [translateX] = useState(() => new Animated.Value(0));
  /**
   * Whether this drag is currently past the line. A ref, not state: it exists
   * to fire the haptic exactly once per crossing, and re-rendering the row on
   * every gesture frame is precisely what an `Animated.Value` is here to avoid.
   */
  const armed = useRef(false);
  /**
   * Where the drag had already got to when the pan took over.
   *
   * `translationX` is measured from touch-down, so the first event after
   * activation already reads `SLOP` — setting the row to that would pop it
   * sideways by 12 points in a single frame, which is the opposite of following
   * your thumb. Subtracting this makes travel mean *travel since the gesture
   * became a swipe*, and it's read off the event rather than assumed to be
   * `SLOP` because a fast flick can overshoot the threshold before the handler
   * sees it.
   */
  const origin = useRef(0);

  function settle() {
    armed.current = false;
    origin.current = 0;
    Animated.spring(translateX, {
      toValue: 0,
      bounciness: 0,
      useNativeDriver: false,
    }).start();
  }

  function handleGesture({ nativeEvent }: PanGestureHandlerGestureEvent) {
    if (!onReply) return;
    // Rightward only, and damped past the trigger so the last 20 points feel
    // like resistance rather than travel — the physical form of "that's far
    // enough".
    const pulled = Math.max(0, nativeEvent.translationX - origin.current);
    const damped =
      pulled <= TRIGGER
        ? pulled
        : Math.min(MAX_PULL, TRIGGER + (pulled - TRIGGER) / 3);
    translateX.setValue(damped);

    const past = repliesOnRelease(pulled);
    if (past && !armed.current) {
      armed.current = true;
      // The whole feedback story on a gesture with no button: you feel the
      // moment it becomes a reply, so letting go is a decision. Fire and
      // forget — a phone without a taptic engine just resolves it.
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    } else if (!past) {
      armed.current = false;
    }
  }

  function handleStateChange({ nativeEvent }: PanGestureHandlerStateChangeEvent) {
    if (!onReply) return;
    if (nativeEvent.state === State.ACTIVE) {
      origin.current = nativeEvent.translationX;
      return;
    }
    if (
      nativeEvent.state !== State.END &&
      nativeEvent.state !== State.CANCELLED &&
      nativeEvent.state !== State.FAILED
    ) {
      return;
    }
    const replying =
      nativeEvent.state === State.END &&
      repliesOnRelease(nativeEvent.translationX - origin.current);
    // Home first, act second. The reply opens the strand over this screen, and
    // a bubble left sitting 56 points to the right is what you'd find waiting
    // underneath when you closed it.
    settle();
    if (replying) onReply();
  }

  return (
    <View>
      <Animated.View
        pointerEvents="none"
        style={[
          styles.hint,
          {
            opacity: translateX.interpolate({
              inputRange: [0, TRIGGER],
              outputRange: [0, 1],
              extrapolate: 'clamp',
            }),
            transform: [
              {
                scale: translateX.interpolate({
                  inputRange: [0, TRIGGER],
                  outputRange: [0.6, 1],
                  extrapolate: 'clamp',
                }),
              },
            ],
          },
        ]}
      >
        <ReplyIcon color={colors.accent} />
      </Animated.View>
      <PanGestureHandler
        testID={testID}
        // Off, rather than absent. An earlier cut returned `children` bare when
        // a message declined the gesture, which put them at a different depth
        // in the tree — so every bubble on screen unmounted and remounted the
        // moment select mode turned the swipe off, taking its photos, its
        // measured rect and its reaction pills with it. One tree, one switch.
        enabled={!!onReply}
        onGestureEvent={handleGesture}
        onHandlerStateChange={handleStateChange}
        activeOffsetX={SLOP}
        failOffsetY={[-SCROLL_SLOP, SCROLL_SLOP]}
      >
        <Animated.View style={{ transform: [{ translateX }] }}>
          {children}
        </Animated.View>
      </PanGestureHandler>
    </View>
  );
}

const styles = StyleSheet.create({
  // Pinned to the leading edge and vertically centred on the whole message, so
  // it reads as belonging to the row rather than to any one line of it.
  hint: {
    position: 'absolute',
    left: spacing.xs,
    top: 0,
    bottom: 0,
    justifyContent: 'center',
  },
});
