/**
 * `useAndroidBack` (Phase 10) — Android's hardware/gesture back, intercepted.
 *
 * This runs under **both** platform projects, which is the point: the same
 * three tests assert that Android consumes the press and that iOS never
 * registers a listener at all. Written against `BackHandler` rather than a
 * screen because the contract worth pinning is "who gets the press", and that's
 * invisible from the rendered output.
 */

import { act, render } from '@testing-library/react-native';
import { BackHandler, Platform, Text } from 'react-native';

import { useAndroidBack } from '@/useAndroidBack';

import { backHandlerCount, captureBackHandler, pressBack } from './helpers';

// Focus is a plain effect under test — the screen is always focused, and the
// cleanup still runs on unmount, so the subscribe/unsubscribe pairing is real.
jest.mock('expo-router', () => ({
  useFocusEffect: (callback: () => void | (() => void)) =>
    // `require`, not an import: jest.mock factories are hoisted above the
    // imports, so a module-scope binding isn't initialised yet when this runs.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('react').useEffect(callback, [callback]),
}));

let back: { removed: () => number };

beforeEach(() => {
  back = captureBackHandler();
});

afterEach(() => {
  jest.restoreAllMocks();
});

function Screen({ active, onBack }: { active: boolean; onBack: () => void }) {
  useAndroidBack(active, onBack);
  return <Text>screen</Text>;
}

const androidOnly = Platform.OS === 'android' ? it : it.skip;
const iosOnly = Platform.OS === 'ios' ? it : it.skip;

androidOnly('runs the handler and swallows the press while active', async () => {
  const onBack = jest.fn();
  await render(<Screen active onBack={onBack} />);

  let handled = false;
  await act(async () => {
    handled = pressBack();
  });

  expect(onBack).toHaveBeenCalledTimes(1);
  // `true` is what stops the navigator also popping the screen — returning
  // false would close the state *and* navigate away, the worse of both.
  expect(handled).toBe(true);
});

androidOnly('registers nothing while inactive, so back navigates normally', async () => {
  const onBack = jest.fn();
  await render(<Screen active={false} onBack={onBack} />);

  expect(backHandlerCount()).toBe(0);
  expect(onBack).not.toHaveBeenCalled();
});

androidOnly('unsubscribes when the state closes', async () => {
  const onBack = jest.fn();
  const view = await render(<Screen active onBack={onBack} />);
  expect(backHandlerCount()).toBe(1);

  // Closing the state must drop the listener, or the screen keeps swallowing
  // back presses for the rest of its life — a screen you can never leave.
  await act(async () => {
    view.rerender(<Screen active={false} onBack={onBack} />);
  });

  expect(back.removed()).toBe(1);
  expect(backHandlerCount()).toBe(0);
});

/**
 * An unmemoised handler neither churns the subscription nor goes stale (#168).
 *
 * Both halves of the same decision. `onBack` is read through a ref, so a caller
 * passing a fresh arrow every render — which is what all eight call sites do,
 * because it reads better next to the state it closes — doesn't tear the
 * listener down and re-add it on every render. The price of a ref is staleness,
 * so the second half checks the press runs the *latest* closure rather than the
 * one from the render that subscribed.
 */
androidOnly('takes a fresh handler each render without resubscribing', async () => {
  const first = jest.fn();
  const second = jest.fn();
  // Not `onBack={first}` — an inline arrow, so the identity differs every render
  // even when the behaviour doesn't. That's the case being pinned.
  const view = await render(<Screen active onBack={() => first()} />);
  expect(backHandlerCount()).toBe(1);

  await act(async () => {
    view.rerender(<Screen active onBack={() => second()} />);
  });

  // One listener throughout: no remove, no re-add.
  expect(backHandlerCount()).toBe(1);
  expect(back.removed()).toBe(0);

  await act(async () => {
    pressBack();
  });

  expect(second).toHaveBeenCalledTimes(1);
  expect(first).not.toHaveBeenCalled();
});

iosOnly('never registers a listener', async () => {
  const onBack = jest.fn();
  await render(<Screen active onBack={onBack} />);

  expect(BackHandler.addEventListener).not.toHaveBeenCalled();
  expect(backHandlerCount()).toBe(0);
});
