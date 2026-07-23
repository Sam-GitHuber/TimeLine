/**
 * Test environment setup.
 *
 * `expo-secure-store` is a native module — it calls into the iOS Keychain, which
 * doesn't exist under Node. Every test would fail at import without a stand-in,
 * so we swap in an in-memory map with the same four-method surface. This is the
 * one place tokens are faked; `src/tokens.ts` is otherwise exercised for real.
 */

jest.mock('expo-secure-store', () => {
  const store = new Map();
  return {
    __store: store,
    setItemAsync: jest.fn(async (key, value) => {
      store.set(key, value);
    }),
    getItemAsync: jest.fn(async (key) => store.get(key) ?? null),
    deleteItemAsync: jest.fn(async (key) => {
      store.delete(key);
    }),
  };
});

// `expo-file-system`'s `File` is a native module that reads bytes off the
// device filesystem — no filesystem under Node. `api.ts`'s `toBlob` uses it to
// turn a picked photo into an uploadable Blob, so stand it in with a File whose
// `arrayBuffer()` returns empty bytes. The upload *shape* (a Blob carrying the
// right filename + content-type) is what the api tests assert; the bytes
// themselves are the backend's to validate.
jest.mock('expo-file-system', () => ({
  File: class {
    constructor(uri) {
      this.uri = uri;
    }
    async arrayBuffer() {
      return new ArrayBuffer(0);
    }
  },
}));

// `expo-notifications` is imported transitively by anything that touches auth
// (auth.tsx → push.ts), so nearly every suite pulls it in. Importing the real
// module under Node isn't just noisy — it runs the library's device-token
// auto-registration side effect at import time and warns about Expo Go. Stub
// the surface we use; `push.test.ts` overrides this with its own mock to drive
// the permission branches.
jest.mock('expo-notifications', () => ({
  getPermissionsAsync: jest.fn(async () => ({
    granted: false,
    canAskAgain: false,
  })),
  requestPermissionsAsync: jest.fn(async () => ({ granted: false })),
  getExpoPushTokenAsync: jest.fn(async () => ({ data: null })),
  setNotificationHandler: jest.fn(),
  useLastNotificationResponse: jest.fn(() => null),
}));

// `react-native-safe-area-context` measures the real notch/home-indicator insets
// through a native view. Under Node there's nothing to measure, so its provider
// renders nothing and any component inside it (the photo lightbox) disappears
// from the tree. The library ships this mock for exactly that — it reports a
// fixed iPhone-ish frame so children render.
// (`.default` because the mock is published as a default-exported object, while
// the real module is imported by name.)
jest.mock('react-native-safe-area-context', () =>
  require('react-native-safe-area-context/jest/mock').default
);

// `@react-native-community/datetimepicker` is a native module (the OS date/time
// wheel) with no Node counterpart, and it's imported by the event dimension
// editor (E3c). Stand it in with a pressable that, on press, fires `onChange`
// with a **fixed** date (2026-08-15 10:30) so a test can drive "the organiser
// picked a value" deterministically and then assert the finalise call.
jest.mock('@react-native-community/datetimepicker', () => {
  const React = require('react');
  const { Pressable, Text } = require('react-native');
  return {
    __esModule: true,
    default: ({ onChange, testID }) =>
      React.createElement(
        Pressable,
        {
          testID: testID ?? 'datetimepicker',
          accessibilityLabel: 'Pick a value',
          onPress: () =>
            onChange?.({ type: 'set' }, new Date(2026, 7, 15, 10, 30)),
        },
        React.createElement(Text, null, 'picker')
      ),
  };
});

// Reset between tests so a token stored by one can't leak into the next.
beforeEach(() => {
  const SecureStore = require('expo-secure-store');
  SecureStore.__store.clear();
  jest.clearAllMocks();
});
