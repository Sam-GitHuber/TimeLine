/**
 * The pulsing "now" tip that caps the top of the timeline.
 *
 * This is TimeLine's live-tip "logo" (`.tl-node` on the web — see
 * `frontend/src/index.css` and docs/design-system.md): an accent dot with a ring
 * that expands and fades on a slow loop, saying *the line is live and it ends
 * here, at this moment*. Without it the feed looks as though it's been cut off
 * at the top rather than being open-ended at the present.
 *
 * The web does this with a CSS `@keyframes tl-ping`. React Native has no CSS
 * animations, so the motion is rebuilt here — matching the web's timing (2.6s),
 * scale (1 → 2.5) and fade (0.7 → 0) so the two clients pulse alike.
 *
 * **Uses React Native's built-in `Animated`, not Reanimated**, even though
 * Reanimated ships with the template. Reanimated runs animations through a
 * native worklets module that doesn't exist under Jest, and its own published
 * mock still imports that module — so every test touching this component died on
 * a cryptic `loadUnpackers` error. Built-in `Animated` needs no native module,
 * drives this entirely on the native thread anyway, and is plenty for a two-
 * property loop. Reach for Reanimated when there's a gesture-driven animation
 * that actually needs it.
 */

import { useEffect, useState } from 'react';
import { Animated, Easing, StyleSheet, View } from 'react-native';

import { colors } from '@/theme';

/** Matches the web's `--tl-node`. */
const NODE = 12;
const PING_MS = 2600;

/**
 * How far the ring expands.
 *
 * The web uses 2.5×, but it has a whole page of margin around the node. Here the
 * node sits near the top of a scrolling list with the screen header just above,
 * and at 2.5× the ring visibly clipped against it. 2× keeps the pulse readable
 * while staying inside the clearance `ComposeBox` reserves above the node
 * (`NODE_TOP`) — if you raise this, raise that too.
 */
const PING_SCALE = 2;

export function NowNode() {
  // One 0→1 driver; scale and opacity are both derived from it, so they can't
  // drift out of step the way two independent animations would.
  //
  // `useState` with a lazy initialiser rather than the more familiar
  // `useRef(new Animated.Value(0)).current`: this project has the React Compiler
  // enabled, and reading `.current` during render is exactly what it forbids
  // (the lint rule `react-hooks/refs` fails the build). A lazily-initialised
  // state value is constructed once and is safe to read while rendering.
  const [progress] = useState(() => new Animated.Value(0));

  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(progress, {
        toValue: 1,
        duration: PING_MS,
        easing: Easing.out(Easing.ease),
        useNativeDriver: true,
        // Decorative motion must not register as an "interaction". By default
        // Animated holds an InteractionManager handle for the duration, and an
        // *infinite* loop therefore holds one forever — which defers anything
        // scheduled with runAfterInteractions indefinitely, and keeps Jest's
        // event loop alive so the test process never exits.
        isInteraction: false,
      })
    );
    loop.start();
    // Stop on unmount: a loop left running holds a retain cycle on the view and
    // keeps waking the UI thread for an animation nobody can see.
    return () => loop.stop();
  }, [progress]);

  // The web holds the final state from 70% to 100%, so the ring has fully faded
  // before it restarts — without that hold the loop visibly snaps back.
  const scale = progress.interpolate({
    inputRange: [0, 0.7, 1],
    outputRange: [1, PING_SCALE, PING_SCALE],
  });
  const opacity = progress.interpolate({
    inputRange: [0, 0.7, 1],
    outputRange: [0.7, 0, 0],
  });

  return (
    <View style={styles.wrap}>
      <Animated.View
        style={[styles.ping, { opacity, transform: [{ scale }] }]}
        // Decorative motion — nothing for a screen reader to announce.
        accessibilityElementsHidden
        importantForAccessibility="no"
      />
      <View style={styles.node} />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    width: NODE,
    height: NODE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  node: {
    width: NODE,
    height: NODE,
    borderRadius: NODE / 2,
    backgroundColor: colors.accent,
    borderWidth: 2,
    borderColor: colors.accent,
  },
  ping: {
    position: 'absolute',
    width: NODE + 4,
    height: NODE + 4,
    borderRadius: (NODE + 4) / 2,
    borderWidth: 2,
    borderColor: colors.accent,
  },
});
