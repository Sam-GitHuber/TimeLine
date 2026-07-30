/**
 * `KeyboardAvoider` — the shared fix for the Android keyboard covering the
 * composer.
 *
 * **Jest cannot see this bug.** Nothing here proves the composer ends up above
 * the keyboard; that needs a docked keyboard on a device or emulator, and the
 * project docs are explicit that layout is the one thing the suite can't check.
 *
 * So these tests pin the *decisions* that broke instead, which are checkable:
 * that the avoider is driven by the library that reads IME insets rather than
 * React Native's inert stand-in, and that it asks for a real `behavior` on
 * **both** platforms. Running under both platform projects is the point — the
 * original bug was a `Platform.OS === 'ios'` ternary that CI never executed on
 * Android at all.
 *
 * The other half of the guard is a lint rule (`eslint.config.js`), which is
 * where "never write this pattern again" belongs: it reports at the call site
 * and can say what to use instead.
 */

import { render, screen } from '@testing-library/react-native';
import { Platform, Text } from 'react-native';

import {
  KeyboardAvoider,
  useKeyboardVisible,
} from '@/components/KeyboardAvoider';

/**
 * Replaces the shared mock from `jest.setup.js` with one that records the props
 * it was handed, so a test can assert what `KeyboardAvoider` asked the library
 * for. Still renders a `View`, so children stay queryable.
 */
jest.mock('react-native-keyboard-controller', () => {
  // `require` inside the factory: jest.mock is hoisted above the imports, so
  // module-scope bindings aren't initialised yet when this runs.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { View } = require('react-native');

  // A `jest.fn()` rather than a plain array, so the `jest.clearAllMocks()` in
  // jest.setup.js resets it between tests. A module-scope array would persist,
  // and every assertion would read the last render *anywhere in the file* —
  // so adding a test later could silently certify another test's props.
  const record = jest.fn();

  return {
    __record: record,
    KeyboardAvoidingView: (received: Record<string, unknown>) => {
      record(received);
      return React.createElement(View, { testID: 'avoider' }, received.children);
    },
    // A stand-in for the real keyboard state, so `useKeyboardVisible` can be
    // driven from a test. The selector shape matters: the hook passes one in.
    useKeyboardState: (selector: (s: { isVisible: boolean }) => unknown) =>
      selector({ isVisible: true }),
  };
});

/**
 * The props the wrapper handed the library on the most recent render.
 *
 * Asserts it rendered at all first: if `KeyboardAvoider` is ever repointed at
 * react-native's `KeyboardAvoidingView` — the regression this file exists to
 * catch — the mock is never reached, and without this the tests would die with
 * `Cannot read properties of undefined` instead of saying what went wrong.
 */
function lastProps(): Record<string, unknown> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { __record } = require('react-native-keyboard-controller');
  expect(__record).toHaveBeenCalled();
  return __record.mock.lastCall[0];
}

it('has its provider mounted above the navigator in the root layout', () => {
  // Every avoider in the app is inert without `KeyboardProvider`, and mounting
  // it is also what re-configures Android's modals (see KeyboardAvoider.tsx), so
  // a refactor that drops or re-nests it below the navigator breaks eleven
  // screens *and* changes every modal — silently, with lint, tsc and the whole
  // suite still green. Asserted against the source rather than by rendering
  // `RootLayout`, which would need the auth gate, the query client, the router
  // and the push stack stood up to prove one wrapper's position.
  // Resolved through the `@/` mapper rather than `__dirname` or a cwd-relative
  // path, so the test works whichever directory Jest is invoked from. The casts
  // are because this project deliberately has no `@types/node` — adding it to a
  // React Native app invites global type clashes (Node's timer and Buffer types
  // against RN's), which is a bad trade for two calls in one test.
  const resolve = (require as unknown as { resolve(id: string): string }).resolve;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('fs') as { readFileSync(p: string, enc: string): string };
  const layout = fs.readFileSync(resolve('@/app/_layout'), 'utf8');

  expect(layout).toContain('<KeyboardProvider>');
  // Above the navigator, not merely present.
  expect(layout.indexOf('<KeyboardProvider>')).toBeLessThan(
    layout.indexOf('<AuthGate />')
  );
});

it('is backed by the keyboard-controller library, not React Native', async () => {
  await render(
    <KeyboardAvoider>
      <Text>composer</Text>
    </KeyboardAvoider>
  );

  // If this ever fails because the mocked module isn't reached, the component
  // has been pointed back at `react-native`'s KeyboardAvoidingView — which
  // cannot work under edge-to-edge, because it positions itself from
  // `screenY` and edge-to-edge stopped resizing the window.
  expect(screen.getByTestId('avoider')).toBeTruthy();
  // The children of an app-wide wrapper disappearing is the expensive failure:
  // every screen would render blank rather than merely misplaced.
  expect(screen.getByText('composer')).toBeTruthy();
});

it(`asks for a real behavior on ${Platform.OS}`, async () => {
  await render(
    <KeyboardAvoider>
      <Text>composer</Text>
    </KeyboardAvoider>
  );

  // The bug, stated as an assertion. `undefined` here — which is exactly what
  // the old ternary passed on Android — means the view is inert and the
  // keyboard draws straight over the composer.
  expect(lastProps().behavior).toBe('padding');
});

it('lets a screen override the behavior deliberately', async () => {
  await render(
    <KeyboardAvoider behavior="height">
      <Text>composer</Text>
    </KeyboardAvoider>
  );

  // 'padding' is a default, not a lock: the spread in the component has to come
  // after it, or a screen with a layout that needs 'height' is silently ignored.
  expect(lastProps().behavior).toBe('height');
});

it('keeps the default when behavior is explicitly undefined', async () => {
  await render(
    // What `Platform.select({ ios: 'padding' })` evaluates to on Android, and
    // what any hoisted platform ternary would produce.
    <KeyboardAvoider behavior={undefined}>
      <Text>composer</Text>
    </KeyboardAvoider>
  );

  // Object spread copies keys whose value is `undefined`, so with
  // `behavior="padding"` written *before* `{...props}` this returned undefined
  // and the avoider was inert on both platforms — worse than the original bug,
  // which at least worked on iOS. A parameter default is the fix; this pins it.
  expect(lastProps().behavior).toBe('padding');
});

it('reports keyboard visibility through the selector', async () => {
  function Probe() {
    return <Text>{useKeyboardVisible() ? 'up' : 'down'}</Text>;
  }
  await render(<Probe />);

  // The hook exists so the composers can drop their safe-area bottom inset while
  // the keyboard covers it. Reading the wrong field (or forgetting the selector,
  // which would return the whole state object — truthy either way) would leave a
  // dead band above the keyboard on Android that no other test would notice.
  expect(screen.getByText('up')).toBeTruthy();
});

it('passes style and offsets through to the library', async () => {
  await render(
    <KeyboardAvoider style={{ flex: 1 }} keyboardVerticalOffset={12}>
      <Text>composer</Text>
    </KeyboardAvoider>
  );

  // A wrapper that swallowed `style` would collapse every screen it wraps —
  // each of the eleven call sites relies on `flex: 1` reaching the real view.
  expect(lastProps().style).toEqual({ flex: 1 });
  expect(lastProps().keyboardVerticalOffset).toBe(12);
});

