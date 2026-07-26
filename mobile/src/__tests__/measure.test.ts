/**
 * `src/measure.ts` — the native-measurement seam.
 *
 * Every other suite gets the stand-in from `jest.setup.js` (there is no layout
 * engine under Node, so the real `measureInWindow` never calls back). That's
 * what makes the action menu testable, but it also means the module's own logic
 * is never executed anywhere else — so this file reaches past the mock with
 * `requireActual` and exercises the real thing.
 *
 * What's worth pinning is the *degradation*: a node that can't be measured must
 * not throw and must not invent a rect, because a caller that positions an
 * overlay from a made-up measurement is worse than one that never opens.
 */

import type { View } from 'react-native';

const { measureInWindow } = jest.requireActual<
  typeof import('@/measure')
>('@/measure');

/** A stand-in host node whose `measureInWindow` answers like the real one. */
function nodeReturning(x: number, y: number, width: number, height: number) {
  return {
    measureInWindow: (cb: (...args: number[]) => void) =>
      cb(x, y, width, height),
  } as unknown as View;
}

it('hands back the measured rect as a WindowRect', () => {
  const onMeasured = jest.fn();

  measureInWindow(nodeReturning(12, 340, 220, 44), onMeasured);

  expect(onMeasured).toHaveBeenCalledWith({
    x: 12,
    y: 340,
    width: 220,
    height: 44,
  });
});

it('does nothing for a null node', () => {
  // An unmounted bubble — the ref is null and there is nothing to measure.
  const onMeasured = jest.fn();

  expect(() => measureInWindow(null, onMeasured)).not.toThrow();
  expect(onMeasured).not.toHaveBeenCalled();
});

it('does nothing for a node that has no measureInWindow', () => {
  // Defensive: React Native has moved host-instance internals more than once,
  // and a missing method should degrade to "the menu doesn't open", never to a
  // crash mid-gesture.
  const onMeasured = jest.fn();

  expect(() => measureInWindow({} as View, onMeasured)).not.toThrow();
  expect(onMeasured).not.toHaveBeenCalled();
});
