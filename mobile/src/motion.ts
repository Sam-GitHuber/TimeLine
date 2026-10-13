/**
 * The small movements in a message thread (#395).
 *
 * Before this, the only thing on the thread screen that moved was the
 * long-press menu. A bubble, a reaction, a tick and a tombstone each appeared
 * in a single frame, and that — more than any latency — was most of the
 * difference in feel from the messenger already in someone's pocket. Motion is
 * what tells the eye *what changed*: a pill that pops is "a reaction arrived",
 * where a pill that is simply there next frame is a screen that redrew.
 *
 * **Short and quiet** (`docs/design-system.md`): nothing here runs longer than
 * `DURATION.base`, nothing loops, and the one overshoot is a reaction pill's.
 * Motion that asks to be noticed would be decoration on a screen whose content
 * is other people's words.
 *
 * **Built-in `Animated`, not Reanimated** — the app's rule for anything that
 * isn't gesture-driven (`docs/reference/mobile-app.md`): Reanimated's worklet
 * runtime doesn't exist under Jest and its own mock still imports it. Every
 * animation here drives `opacity` or `transform` only, so all of them run on
 * the native driver and none costs a layout pass — which is also why a row's
 * *height* never animates. Neighbours of a new bubble or a new tombstone move
 * in one frame, exactly as they do on the web; animating that inside an
 * inverted, virtualised list means a JS-driven relayout per frame, for the
 * least visible part of the change.
 *
 * **Every one of them is skipped under the OS's Reduce Motion setting**, by the
 * caller asking `useReducedMotion()` first. Skipped, not shortened: the setting
 * exists for people whom movement makes unwell, and the state each animation
 * ends in is the state the screen drew before any of this existed.
 *
 * The animations are functions of an `Animated.Value` rather than components,
 * so the bubble decides *when* (which is the hard part — see `arrivals.ts`) and
 * this file only decides *how*. That split is also the test seam: nothing in
 * Node can see a frame, but a test can see that `rise` ran once for a new
 * message and not at all for a page of history.
 */
import { useSyncExternalStore } from 'react';
import { AccessibilityInfo, Animated, Easing } from 'react-native';

export const DURATION = {
  /** A glyph or a pill changing in place. */
  quick: 140,
  /** Something arriving or leaving. */
  base: 200,
} as const;

/** How far a new bubble travels. Yours comes from further: it left the composer. */
export const RISE_FROM = { mine: 16, theirs: 8 } as const;

/** Decelerating — fast off the mark, easing into place. Things arrive; they don't launch. */
const SETTLE = Easing.out(Easing.cubic);

function timing(value: Animated.Value, toValue: number, duration: number, easing = SETTLE) {
  return Animated.timing(value, {
    toValue,
    duration,
    easing,
    useNativeDriver: true,
    // Decorative, so not an "interaction": by default `Animated` holds an
    // InteractionManager handle for the length of the animation and defers
    // anything scheduled with `runAfterInteractions` behind it.
    isInteraction: false,
  });
}

/**
 * A bubble arriving: 0 → 1, which the row maps to opacity and to the last few
 * points of its rise. The value must have been *created* at 0 — setting it here
 * would be a frame after the row first painted at full strength.
 */
export function rise(progress: Animated.Value) {
  timing(progress, 1, DURATION.base).start();
}

/**
 * A reaction pill appearing: 0 → 1 with a slight overshoot, the one place in the
 * thread that earns one. A reaction is a small, glad thing, and a pill that
 * merely fades in reads as the row re-laying itself out.
 */
export function pop(progress: Animated.Value) {
  timing(progress, 1, DURATION.base, Easing.out(Easing.back(1.6))).start();
}

/** A pill's count changing: a nudge up and back, on a scale value resting at 1. */
export function bump(scale: Animated.Value) {
  Animated.sequence([
    timing(scale, 1.14, DURATION.quick / 2),
    timing(scale, 1, DURATION.quick),
  ]).start();
}

/**
 * Something that changed in place resolving into its new state — the tick, an
 * edit's new words, a tombstone. 0 → 1 on a value created at 0; see `SettleIn`
 * for why it is created there rather than reset to it.
 */
export function settle(progress: Animated.Value) {
  timing(progress, 1, DURATION.base).start();
}

/**
 * Ease a floating control in (1) or out (0). `done` fires only if it ran to the
 * end — an exit interrupted by the control being wanted again must not unmount
 * it.
 */
export function ease(progress: Animated.Value, toValue: 0 | 1, done?: () => void) {
  timing(progress, toValue, toValue === 1 ? DURATION.base : DURATION.quick).start(
    ({ finished }) => {
      if (finished) done?.();
    }
  );
}

/**
 * The OS's Reduce Motion setting, live.
 *
 * One subscription for the whole app rather than one per bubble: asking is an
 * async native call, and a transcript mounts twenty rows at once. It starts
 * `false` and corrects itself when the answer lands — a few milliseconds in
 * which nothing on a freshly opened thread animates anyway (see `arrivals.ts`:
 * the first load never does).
 */
let reduced = false;
let watching = false;
const listeners = new Set<() => void>();

function setReduced(next: boolean) {
  if (next === reduced) return;
  reduced = next;
  listeners.forEach((notify) => notify());
}

function subscribe(notify: () => void) {
  listeners.add(notify);
  if (!watching) {
    watching = true;
    // Never torn down: it is one listener for the life of the app, and the
    // answer is still wanted by the next thread that opens.
    AccessibilityInfo.addEventListener('reduceMotionChanged', setReduced);
    AccessibilityInfo.isReduceMotionEnabled()
      .then(setReduced)
      // Unknown is treated as "not asked for": the alternative is an app that
      // silently never moves on a platform where the question failed.
      .catch(() => {});
  }
  return () => {
    listeners.delete(notify);
  };
}

export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, () => reduced);
}
