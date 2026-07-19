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

/**
 * In-memory mirror of the access token, for callers that can't await.
 *
 * `<Image>` is the reason this exists. Uploaded media is auth-gated in
 * production (Caddy `forward_auth`s every `/media/*` request — see
 * feed-and-posts.md), so an image request has to carry the Bearer header, and a
 * render function can't await SecureStore. Reading the Keychain on every image
 * in a scrolling feed would also be needless work.
 *
 * Kept in sync by `saveTokens` / `clearTokens` / `getAccessToken` below, and
 * primed on launch by `AuthProvider`'s cold-start check. Never persisted — it
 * dies with the process, which is the point.
 */
let cachedAccess: string | null = null;

export async function saveTokens({ access, refresh }: TokenPair): Promise<void> {
  cachedAccess = access;
  await Promise.all([
    SecureStore.setItemAsync(ACCESS_KEY, access),
    SecureStore.setItemAsync(REFRESH_KEY, refresh),
  ]);
}

export async function getAccessToken(): Promise<string | null> {
  cachedAccess = await SecureStore.getItemAsync(ACCESS_KEY);
  return cachedAccess;
}

/**
 * The access token if one is already in memory, without touching the Keychain.
 * May be `null` before the first read even when the user is logged in — callers
 * must tolerate that rather than treating it as "logged out", and fall back to
 * `getAccessToken` if they need a definitive answer.
 *
 * This is the normal read path for both `api.ts` (every request) and
 * `AuthedImage` (every photo in a scrolling feed); `getAccessToken` below is
 * reserved for the cold start, where the cache is genuinely empty.
 */
export function getCachedAccessToken(): string | null {
  return cachedAccess;
}

export async function getRefreshToken(): Promise<string | null> {
  return SecureStore.getItemAsync(REFRESH_KEY);
}

export async function clearTokens(): Promise<void> {
  cachedAccess = null;
  await Promise.all([
    SecureStore.deleteItemAsync(ACCESS_KEY),
    SecureStore.deleteItemAsync(REFRESH_KEY),
  ]);
}
