/**
 * Ease something in when it's wanted and out when it isn't (#395) — the thread's
 * jump-to-latest control and the "Editing message" bar, both of which used to
 * be a bare `condition ? <View/> : null` and so appeared and vanished in a
 * frame.
 *
 * Entering is easy; **leaving is why this is a component**. A thing that is
 * conditionally rendered is gone the moment the condition flips, so there is
 * nothing left to animate out. This keeps it mounted until the exit has run,
 * and keeps drawing the *last* children it was given — the edit bar quotes the
 * message being edited, and by the time it's leaving that message is `null`.
 *
 * While it's on its way out it takes no touches and is hidden from assistive
 * tech: it is already gone as far as the screen's state is concerned, and a
 * Cancel that could still be pressed for a fifth of a second after it was
 * pressed would fire on an edit that has ended.
 *
 * Under Reduce Motion it is exactly the conditional render it replaced.
 */
import { type ReactNode, useEffect, useState } from 'react';
import { Animated, type StyleProp, type ViewStyle } from 'react-native';

import { ease, useReducedMotion } from '@/motion';

export function Presence({
  visible,
  children,
  style,
  /** How far below its resting place it starts, in points. */
  offset = 8,
}: {
  visible: boolean;
  children: ReactNode;
  /** Positioning for the wrapper — it is the thing in the layout, not the child. */
  style?: StyleProp<ViewStyle>;
  offset?: number;
}) {
  const reduced = useReducedMotion();
  const [progress] = useState(() => new Animated.Value(0));

  // Mounted is "wanted, or still leaving". Raised during render so the first
  // frame it's wanted already has it; lowered only by the exit finishing.
  const [mounted, setMounted] = useState(visible);
  if (visible && !mounted) setMounted(true);
  // Reduce Motion has no exit to wait for.
  if (!visible && reduced && mounted) setMounted(false);

  // What to draw on the way out. Followed only while visible, so the exit
  // shows what was there rather than whatever the caller renders for "nothing".
  const [kept, setKept] = useState(children);
  if (visible && kept !== children) setKept(children);

  // A passive effect, not a layout one: the value is created at 0, so the view
  // mounts hidden and has nothing to correct before it paints — and the native
  // driver can't attach to a view still mounting in the same commit.
  useEffect(() => {
    if (reduced) return;
    // Starting a new animation on the value stops the one in flight, which
    // reports itself unfinished — so an exit interrupted by `visible` coming
    // back never reaches its unmount.
    ease(progress, visible ? 1 : 0, visible ? undefined : () => setMounted(false));
  }, [visible, reduced, progress]);

  if (!mounted) return null;
  return (
    <Animated.View
      pointerEvents={visible ? 'box-none' : 'none'}
      accessibilityElementsHidden={!visible}
      importantForAccessibility={visible ? 'auto' : 'no-hide-descendants'}
      style={[
        style,
        // Under Reduce Motion it's mounted exactly while it's visible, so there
        // is nothing for the value to say.
        reduced
          ? null
          : {
              opacity: progress,
              transform: [
                {
                  translateY: progress.interpolate({
                    inputRange: [0, 1],
                    outputRange: [offset, 0],
                  }),
                },
              ],
            },
      ]}
    >
      {visible ? children : kept}
    </Animated.View>
  );
}
