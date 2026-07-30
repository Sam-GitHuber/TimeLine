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

import { KeyboardAvoider } from '@/components/KeyboardAvoider';

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

  const props: Record<string, unknown>[] = [];

  return {
    __props: props,
    KeyboardAvoidingView: (received: Record<string, unknown>) => {
      props.push(received);
      return React.createElement(View, { testID: 'avoider' }, received.children);
    },
  };
});

function lastProps(): Record<string, unknown> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { __props } = require('react-native-keyboard-controller');
  return __props[__props.length - 1];
}

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

