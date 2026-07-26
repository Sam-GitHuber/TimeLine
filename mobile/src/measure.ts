/**
 * Ask a mounted view where it is on screen.
 *
 * One line of real work, wrapped in a module for one reason: **measuring a view
 * is a native capability**, and this is the seam the test environment stands in
 * for. Under Node there is no layout engine and no screen, so React Native's
 * `measureInWindow` exists but its callback is never invoked — anything waiting
 * on it waits forever. The RN Jest preset installs that no-op as a per-instance
 * `jest.fn()` reached through `requireActual`, so it can't be mocked from the
 * outside; a seam we own can (see `jest.setup.js`).
 *
 * Callers therefore get to keep the correct shape — measure, *then* position —
 * with no timers, no fallbacks, and no test-shaped branches in the UI.
 */

import type { View } from 'react-native';

export type WindowRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

/**
 * Call `onMeasured` with `node`'s rect in window coordinates. A null or
 * unmountable node simply never calls back, exactly as the native method
 * behaves — callers should not have already committed to an on-screen position
 * before this resolves.
 */
export function measureInWindow(
  node: View | null,
  onMeasured: (rect: WindowRect) => void
) {
  node?.measureInWindow?.((x, y, width, height) =>
    onMeasured({ x, y, width, height })
  );
}
