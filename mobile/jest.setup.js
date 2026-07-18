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

// Reset between tests so a token stored by one can't leak into the next.
beforeEach(() => {
  const SecureStore = require('expo-secure-store');
  SecureStore.__store.clear();
  jest.clearAllMocks();
});
