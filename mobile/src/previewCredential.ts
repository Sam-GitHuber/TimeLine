/**
 * The credential the iOS notification service extension reads (Phase 10b, M2).
 *
 * **What it is.** `POST /api/push-tokens/` mints a fresh, opaque, per-device
 * credential on every registration and returns it once, in that response
 * (`accounts.md`). Its only power is `GET /api/conversations/<id>/push-preview/`
 * — the endpoint that answers "what should this thread's notification say?".
 * It is never the account's access token, deliberately: see the *Option B* box
 * in `docs/phases/phase-10b-notification-content.md` for why a second process
 * holding a rotating refresh token would log people out at random.
 *
 * **Why it isn't in `tokens.ts`.** That file holds the *account* session, whose
 * items the extension has no business reading. This one is written with
 * different keychain properties (below) for the extension's sake, has a
 * different lifecycle (it dies with the device registration, not the session),
 * and is the only item another process is ever meant to see. Two ideas, two
 * files. The three rules in `tokens.ts`'s docstring apply here verbatim —
 * never log it, never put it in a URL.
 *
 * ## The keychain properties, and why each one is load-bearing
 *
 * **Accessibility: `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`.** SecureStore
 * defaults to `WHEN_UNLOCKED` (`SecureStoreOptions.swift`), which is stamped on
 * the item at write time and means the extension gets
 * `errSecInteractionNotAllowed` on a locked phone — *the* case this whole
 * feature exists for. It would work on every unlocked dev handset and never on
 * a lock screen. So this is not a preference; without it M3 cannot work at all.
 *
 * It is a real at-rest downgrade and is disclosed as one in the privacy work
 * (M5): the credential becomes readable while the device is locked but
 * booted-and-once-unlocked, instead of only while unlocked. `THIS_DEVICE_ONLY`
 * keeps it out of iCloud Keychain and out of encrypted backups, which is the
 * part worth keeping. **The downgrade stops here** — `tokens.ts` is untouched,
 * so the account's access and refresh tokens keep the stricter property. That
 * is the concrete privacy dividend of using a scoped credential rather than the
 * account token.
 *
 * **Service: pinned to `timeline`.** SecureStore's default service is expo's
 * `"app"`, and its query appends `:no-auth`, so the extension's Swift would
 * have to hardcode `"app:no-auth"` — an internal detail of a package pinned at
 * `~57.0.1`, which a routine SDK bump could change with no build error and no
 * symptom beyond previews silently never working again. Pinning makes the
 * extension depend on a string *this repo* chose. The exact query the Swift
 * must reproduce is written out at the bottom of this file.
 *
 * **Access group: none, on purpose.** The item lands in the app's own keychain
 * access group (`$(AppIdentifierPrefix)net.yourtimeline.app`), exactly where
 * everything this app stores already lands, and M3's extension declares *that*
 * group in its entitlements. The alternative — a separate
 * `…net.yourtimeline.shared` group — would need the literal ten-character Team
 * ID compiled into this file, because `$(AppIdentifierPrefix)` is expanded by
 * Xcode in an entitlements plist and means nothing at runtime. It would also
 * put a `keychain-access-groups` entitlement on the *app* target, and the first
 * entry of that list silently becomes the default group for every add the app
 * makes — including `tokens.ts`'s, which would quietly move house and take
 * everyone's session with them. Not worth it to hide this key from an extension
 * that is forty lines of our own Swift and never queries any other key.
 *
 * **Two of those three are iOS-shaped and inert on Android**, which uses the
 * Keystore rather than the Keychain: `accessGroup` doesn't exist there at all
 * (moot, since we pass none) and `keychainAccessible` is ignored.
 * `keychainService` *is* honoured — it names the keystore alias. Nothing on
 * Android reads this item yet; whether anything ever does is M4's question, and
 * the answer being weighed there is a background task inside the app's *own*
 * process, which would need none of this.
 */

import * as SecureStore from 'expo-secure-store';

/** The item's account/generic attribute. Reproduced verbatim in M3's Swift. */
export const PREVIEW_CREDENTIAL_KEY = 'timeline.previewCredential';

/** The item's `kSecAttrService`, before SecureStore appends `:no-auth`. */
export const PREVIEW_KEYCHAIN_SERVICE = 'timeline';

const OPTIONS = {
  keychainService: PREVIEW_KEYCHAIN_SERVICE,
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};

/**
 * Which registration the stored credential belongs to. Bumped by
 * `clearPreviewCredential`, so it changes exactly when one is torn down.
 *
 * The same device as `tokens.ts`'s `session`, and it exists for the same reason:
 * **a write can outlive the thing that started it**, and the write here is a
 * credential. `savePreviewCredential` can only be called after a round trip to
 * the server, and a sign-out or an expiry landing in that gap would otherwise
 * have us store a working credential onto a phone nobody is signed in on —
 * moments after the teardown whose whole job was to remove it. The extension
 * would go on rendering the previous user's messages on the lock screen.
 *
 * It lives here rather than in `push.ts` because the hazard is a property of
 * this key, not of the caller. `push.ts` has a counter of its own for the Expo
 * token, and a rule enforced only at one call site is a rule the next caller —
 * M3's rotation handling, M4's Android task — has to rediscover.
 *
 * Never persisted: a process death ends every session anyway.
 */
let session = 0;

/** The session a write should be tagged with. Capture it *before* the await. */
export function previewCredentialSession(): number {
  return session;
}

/**
 * Store the credential the server just minted, replacing any previous one.
 *
 * Pass the `forSession` you captured **before** the round trip that produced
 * it. Returns whether it was actually stored; the default is "right now", which
 * only a caller with no round trip behind it should use.
 *
 * **Deletes before writing, and that is not belt-and-braces.** SecureStore's
 * `set` is a `SecItemAdd` that falls back to `SecItemUpdate` on a duplicate
 * (`SecureStoreModule.swift`), and the update sets `kSecValueData` *only* — so
 * an item written once with the wrong accessibility keeps it forever, through
 * every subsequent save, with no error anywhere. On a device that has already
 * stored a credential the wrong way that is unfixable by re-saving and
 * undiagnosable from the app; a delete first makes the properties above the
 * ones the item actually has, every time.
 *
 * Nothing is at risk in the gap between the two calls. The server rotates this
 * credential on every registration, so by the time we are called the previously
 * stored value is already dead — there is no older-but-working copy to lose,
 * only a stale one to replace. A push arriving mid-write falls back to the
 * contentless body the server put in the payload, which is the discipline every
 * failure path in this phase follows.
 */
export async function savePreviewCredential(
  credential: string,
  forSession: number = session
): Promise<boolean> {
  if (forSession !== session) return false;
  await SecureStore.deleteItemAsync(PREVIEW_CREDENTIAL_KEY, OPTIONS);
  // **Checked again here, and this is the check that does the most work.** The
  // guard above closes the window only up to the point this function is
  // entered, and the delete is an await like any other: a sign-out landing
  // inside it deletes nothing (we have just deleted) and then watches us write.
  // Declining to write at all is better than writing and undoing, because a
  // teardown can be followed by a *new* registration storing its own
  // credential — which our write would silently overwrite, and which the undo
  // below could then only delete rather than put back.
  if (forSession !== session) return false;
  await SecureStore.setItemAsync(PREVIEW_CREDENTIAL_KEY, credential, OPTIONS);
  // And once more after the write, for the sliver that remains: the native call
  // above is itself an await. Undoing beats leaving a live credential on a
  // device nobody is signed in on. `tokens.ts` accepts the same residual for
  // the same reason — there is no compare-and-swap in the Keychain, so the
  // window can be made narrow but not closed.
  if (forSession === session) return true;
  await undoWrite(credential);
  return false;
}

/**
 * Take back a credential written after its registration ended — **only** if it
 * is still the one that's stored.
 *
 * Deliberately not `clearPreviewCredential()`, for the reason `tokens.ts`'
 * `undoWrite` gives: that deletes whatever is there *now* and bumps the counter
 * again, so an undo could wipe a newer registration's credential and, by moving
 * the counter, push that registration's own in-flight save down this same path.
 * A compare-and-delete can only ever remove what it wrote.
 */
async function undoWrite(credential: string): Promise<void> {
  const stored = await SecureStore.getItemAsync(PREVIEW_CREDENTIAL_KEY, OPTIONS);
  if (stored !== credential) return;
  await SecureStore.deleteItemAsync(PREVIEW_CREDENTIAL_KEY, OPTIONS);
}

/**
 * Forget the credential. Called wherever this device's push registration is
 * dropped — sign-out, session expiry, and a cold start whose token the server
 * rejects, all via `push.ts`'s two teardown functions.
 *
 * A copy left behind would keep answering for the person who has just left, on
 * a phone that may now be someone else's. It is the same hazard
 * `unregisterPush` and `forgetLocalPushToken` exist to close, one credential
 * further down, and it is closed in the same places rather than a new one.
 *
 * Bumps the session counter **synchronously, before its first await**, so a
 * save belonging to the registration being torn down can never slip past the
 * checks above.
 */
export async function clearPreviewCredential(): Promise<void> {
  session += 1;
  await SecureStore.deleteItemAsync(PREVIEW_CREDENTIAL_KEY, OPTIONS);
}

/**
 * Read the credential back.
 *
 * **Nothing in the app needs this** — the extension is the reader, and it is a
 * separate native process that never runs this JavaScript. It exists so the
 * read has an executable description here rather than only in Swift: the query
 * below is the one M3 must reproduce, and a test that reads through this
 * function is a test that the write and the read agree.
 *
 * The Swift, for reference — `SecureStoreModule.swift`'s `query()` with
 * `requireAuthentication: false`:
 *
 * ```
 * kSecClass          = kSecClassGenericPassword
 * kSecAttrService    = "timeline:no-auth"          // note the suffix
 * kSecAttrGeneric    = Data("timeline.previewCredential".utf8)
 * kSecAttrAccount    = Data("timeline.previewCredential".utf8)   // Data, not String
 * ```
 *
 * Both `kSecAttrGeneric` and `kSecAttrAccount` are the UTF-8 **bytes** of the
 * key, not a `String`. The obvious Swift passes a `String` and gets
 * `errSecItemNotFound` on every push on every device — indistinguishable, from
 * inside the extension, from a missing entitlement.
 */
export async function getPreviewCredential(): Promise<string | null> {
  return SecureStore.getItemAsync(PREVIEW_CREDENTIAL_KEY, OPTIONS);
}
