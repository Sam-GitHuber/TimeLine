/**
 * Something that changed in place, drawn resolving into its new state (#395) —
 * the tick that replaced a clock, an edit's new words, a bubble's tombstone.
 *
 * **It animates as it mounts, and only then**, so the caller gives it a `key`
 * that changes when the content does. That is the whole design, and it's there
 * to avoid the obvious alternative: one long-lived animated view whose value is
 * reset when a prop changes. A reset has to happen in an effect, an effect runs
 * after the new content has been committed, and the result is the new content
 * drawn at full strength for a frame before it dips and fades back up — a
 * flicker, on exactly the changes this exists to soften. (Resetting in a
 * *layout* effect instead fails differently: the native driver can't attach to
 * a view that is still mounting in the same commit.) A view that is *created*
 * at its starting value has no such frame.
 *
 * `animate` is read once. False — or Reduce Motion — draws the end state and
 * never moves.
 */
import { type ReactNode, useState } from 'react';
import { Animated, type StyleProp, View, type ViewStyle } from 'react-native';

import { settle, useEntrance } from '@/motion';

export function SettleIn({
  animate,
  opacity = [0, 1],
  scale = [1, 1],
  style,
  children,
}: {
  animate: boolean;
  /** Start and end. `[1, 0]` is how the thing being replaced leaves. */
  opacity?: [number, number];
  scale?: [number, number];
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  const progress = useEntrance(animate, settle);
  // Built once, beside the value: this re-renders with its bubble on every
  // poll, and an interpolation is a node, not a number.
  const [moving] = useState(() =>
    progress
      ? {
          opacity: progress.interpolate({ inputRange: [0, 1], outputRange: opacity }),
          transform: [
            {
              scale: progress.interpolate({ inputRange: [0, 1], outputRange: scale }),
            },
          ],
        }
      : null
  );

  // The end state, plainly. Nearly every bubble's text and tick is this.
  if (!moving) {
    return <View style={[style, opacity[1] !== 1 && { opacity: opacity[1] }]}>{children}</View>;
  }
  return <Animated.View style={[style, moving]}>{children}</Animated.View>;
}
