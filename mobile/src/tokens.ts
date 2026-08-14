/**
 * The **account session's** tokens, isolated in one module.
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
 *   3. Read them here and attach them in `api.ts`. Nothing else may touch
 *      *these two keys*, so the account session's surface stays this one file.
 *
 * **Rule 3 is about the keys, not about SecureStore.** Three other places store
 * things there — `push.ts` (this device's Expo token), `preferences.tsx` (a UI
 * preference, for want of a synchronous store) and `previewCredential.ts` (the
 * notification extension's scoped read credential, Phase 10b). None of them is
 * a session token, and none of them shares a key with this file.
 *
 * `previewCredential.ts` is the one worth knowing about from here, because it
 * is the reason the account tokens **didn't** have to change. A notification
 * service extension is a separate process that must read a credential off a
 * locked phone, which means an item stored with a weaker `kSecAttrAccessible`
 * than these have. Giving it its own credential is what confines that downgrade
 * to a read-only preview scope and leaves the pair below exactly as strict as
 * they were.
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

/**
 * Which session the tokens on this device belong to. Bumped by `clearTokens`,
 * so it changes exactly when a session ends.
 *
 * It exists because **a write can outlive the session that started it**, and
 * the write here is the credential itself. `refreshAccessToken` rotates on the
 * wire and stores the new pair when the response lands; logging out in that gap
 * used to wipe the Keychain and then have the refresh write a *live* refresh
 * token straight back into it — one the logout blacklist had missed, because
 * the rotation superseded the token it blacklisted. The next launch found a
 * good token and signed the previous user back in with no password, which on a
 * handed-on phone hands over the account. Same shape as the push-registration
 * race in `push.ts` (#219), one layer down and with more at stake.
 *
 * Never persisted: a process death ends every session anyway.
 */
let session = 0;

/** The session a write should be tagged with. Capture it *before* the await. */
export function tokenSession(): number {
  return session;
}

/**
 * Store a token pair, unless the session it belongs to has since ended.
 *
 * Returns whether the tokens were actually stored. Pass the `forSession` you
 * captured before whatever round trip produced them; the default is "right
 * now", which is what a fresh login wants.
 */
export async function saveTokens(
  { access, refresh }: TokenPair,
  forSession: number = session
): Promise<boolean> {
  if (forSession !== session) return false;
  cachedAccess = access;
  await Promise.all([
    SecureStore.setItemAsync(ACCESS_KEY, access),
    SecureStore.setItemAsync(REFRESH_KEY, refresh),
  ]);
  // Re-checked, because the two writes above are awaits like any other: a
  // teardown starting midway through them would have deleted the keys *before*
  // we wrote them, and left the pair behind. Undoing beats leaving a live
  // credential on a device nobody is signed in on.
  if (forSession === session) return true;
  await undoWrite(access, refresh);
  return false;
}

/**
 * Take back a pair that was written after its session ended — **only** if it's
 * still the pair that's stored.
 *
 * Deliberately not `clearTokens()`. That deletes whatever is there *now* and
 * bumps the counter again, so an undo could wipe a newer session's credentials
 * and, by moving the counter, push that session's own in-flight `saveTokens`
 * down this same path. A compare-and-delete can only ever remove what it wrote.
 */
async function undoWrite(access: string, refresh: string): Promise<void> {
  const [storedAccess, storedRefresh] = await Promise.all([
    SecureStore.getItemAsync(ACCESS_KEY),
    SecureStore.getItemAsync(REFRESH_KEY),
  ]);
  if (cachedAccess === access) cachedAccess = null;
  await Promise.all([
    storedAccess === access
      ? SecureStore.deleteItemAsync(ACCESS_KEY)
      : Promise.resolve(),
    storedRefresh === refresh
      ? SecureStore.deleteItemAsync(REFRESH_KEY)
      : Promise.resolve(),
  ]);
}

/**
 * Read the access token from the Keychain, priming the in-memory cache.
 *
 * The cache write is guarded for the same reason `saveTokens` is: the read is
 * an await, and a sign-out landing during it would otherwise have its
 * `cachedAccess = null` undone by a value read *before* the delete — leaving a
 * signed-out app quietly holding a live token that every `getCachedAccessToken`
 * hands out.
 */
export async function getAccessToken(): Promise<string | null> {
  const forSession = session;
  const stored = await SecureStore.getItemAsync(ACCESS_KEY);
  if (forSession !== session) return null;
  cachedAccess = stored;
  return stored;
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
  // Bumped synchronously, before the first await, so that a `saveTokens` from
  // the session being torn down can never slip past the check above.
  session += 1;
  cachedAccess = null;
  await Promise.all([
    SecureStore.deleteItemAsync(ACCESS_KEY),
    SecureStore.deleteItemAsync(REFRESH_KEY),
  ]);
}
