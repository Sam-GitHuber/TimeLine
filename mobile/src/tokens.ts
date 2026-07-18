/**
 * Token storage, isolated behind four functions.
 *
 * **Why `expo-secure-store` and not `AsyncStorage`.** SecureStore is backed by
 * the iOS Keychain / Android Keystore, so the tokens are encrypted at rest and
 * don't ride along in an unencrypted device backup. AsyncStorage is a plain file
 * in the app's sandbox — fine for a UI preference, wrong for a credential.
 *
 * **These tokens are readable by our own JavaScript**, unlike the web app's
 * httpOnly cookie. That's the unavoidable cost of native auth (see
 * docs/reference/accounts.md). It puts three rules on every caller:
 *
 *   1. Never log a token — not to the console, not to an error reporter.
 *   2. Never put one in a URL. URLs land in server access logs and crash reports.
 *   3. Read them here and attach them in `api.ts`. Nowhere else should touch
 *      SecureStore directly, so the surface stays this one file.
 */

import * as SecureStore from 'expo-secure-store';

const ACCESS_KEY = 'timeline.access';
const REFRESH_KEY = 'timeline.refresh';

export type TokenPair = {
  access: string;
  refresh: string;
};

export async function saveTokens({ access, refresh }: TokenPair): Promise<void> {
  await Promise.all([
    SecureStore.setItemAsync(ACCESS_KEY, access),
    SecureStore.setItemAsync(REFRESH_KEY, refresh),
  ]);
}

export async function getAccessToken(): Promise<string | null> {
  return SecureStore.getItemAsync(ACCESS_KEY);
}

export async function getRefreshToken(): Promise<string | null> {
  return SecureStore.getItemAsync(REFRESH_KEY);
}

export async function clearTokens(): Promise<void> {
  await Promise.all([
    SecureStore.deleteItemAsync(ACCESS_KEY),
    SecureStore.deleteItemAsync(REFRESH_KEY),
  ]);
}
