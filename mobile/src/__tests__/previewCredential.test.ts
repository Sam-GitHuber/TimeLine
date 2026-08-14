/**
 * The shared-keychain item the notification service extension reads
 * (Phase 10b, M2).
 *
 * Every assertion here is about **how** the credential is stored rather than
 * that it is. Nothing in the app reads this item — the reader is a separate
 * native process that runs no JavaScript — so the properties below are the only
 * contract between the two halves, and each of them fails silently on a device:
 * the extension gets `errSecItemNotFound` or `errSecInteractionNotAllowed`,
 * falls back to the contentless body exactly as designed, and previews simply
 * never work while nothing anywhere reports a problem.
 *
 * They lean on the upgraded `expo-secure-store` double in `jest.setup.js`,
 * which models the service (suffix included), the access group and the
 * accessibility. Against the old flat-Map double every one of these would have
 * passed no matter what the code did.
 */

import * as SecureStore from 'expo-secure-store';

import {
  clearPreviewCredential,
  getPreviewCredential,
  PREVIEW_CREDENTIAL_KEY,
  PREVIEW_KEYCHAIN_SERVICE,
  previewCredentialSession,
  savePreviewCredential,
} from '@/previewCredential';
import { saveTokens } from '@/tokens';

const CREDENTIAL = 'preview-credential-from-the-server';

/**
 * The exact `kSecAttrService` the item is stored under — pinned service plus
 * the suffix SecureStore appends for `requireAuthentication: false`. M3's Swift
 * hardcodes this literal, so it is spelled out here rather than composed, and a
 * change to either half has to be made in two places on purpose.
 */
const STORED_SERVICE = 'timeline:no-auth';

type Entry = {
  key: string;
  service: string;
  group: string;
  value: string;
  accessible: string;
};

/** Everything the fake keychain holds, however it was stored. */
function entries(): Entry[] {
  return (SecureStore as unknown as { __entries: () => Entry[] }).__entries();
}

/** The stored copies of one key — plural, because duplicates are a failure. */
function copiesOf(key: string): Entry[] {
  return entries().filter((entry) => entry.key === key);
}

/** The one stored credential, or null. */
function stored(): Entry | null {
  return copiesOf(PREVIEW_CREDENTIAL_KEY)[0] ?? null;
}

describe('savePreviewCredential', () => {
  it('stores it where the extension will look', async () => {
    await savePreviewCredential(CREDENTIAL);

    expect(await getPreviewCredential()).toBe(CREDENTIAL);
  });

  it("pins the keychain service rather than taking expo's default", async () => {
    // The extension has to name the service in its own Swift query. Expo's
    // default is `"app"`, an internal detail of a package pinned at `~57.0.1`
    // that a routine SDK bump could change with no build error — so the value
    // has to be one this repo chose, suffix and all.
    await savePreviewCredential(CREDENTIAL);

    expect(stored()?.service).toBe(STORED_SERVICE);
    expect(STORED_SERVICE.startsWith(PREVIEW_KEYCHAIN_SERVICE)).toBe(true);
    // And the corollary, which is what actually breaks if the pin is dropped
    // on one side only: a read at the default service finds nothing.
    expect(await SecureStore.getItemAsync(PREVIEW_CREDENTIAL_KEY)).toBeNull();
  });

  it('stores it readable on a locked phone', async () => {
    // SecureStore defaults to WHEN_UNLOCKED, which is stamped at write time and
    // means the extension can't read the item while the phone is in a pocket —
    // the only case this feature exists for. It would work on every unlocked
    // dev handset and never on a lock screen.
    await savePreviewCredential(CREDENTIAL);

    expect(stored()?.accessible).toBe(
      SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY
    );
  });

  it('re-stamps the accessibility instead of inheriting a stale one', async () => {
    // The trap this exists for: SecureStore's `set` is a `SecItemAdd` that
    // falls back to a `SecItemUpdate` of the *data alone*, so an item first
    // written with the wrong accessibility keeps it through every later save,
    // for the life of the install, with no error. A device that stored a
    // credential the wrong way once could never be repaired by re-saving.
    // `savePreviewCredential` deletes before writing precisely so this can't
    // happen, and this is the test that would catch its removal.
    await SecureStore.setItemAsync(PREVIEW_CREDENTIAL_KEY, 'older', {
      keychainService: PREVIEW_KEYCHAIN_SERVICE,
      keychainAccessible: SecureStore.WHEN_UNLOCKED,
    });

    await savePreviewCredential(CREDENTIAL);

    expect(stored()?.accessible).toBe(
      SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY
    );
    expect(await getPreviewCredential()).toBe(CREDENTIAL);
  });

  it('replaces the previous credential rather than accumulating copies', async () => {
    // The server rotates this on every registration, and the app registers on
    // every launch. A second item under the same key would leave the extension
    // reading whichever the keychain happened to return first — dead half the
    // time, and only on devices that had been opened twice.
    await savePreviewCredential('first');
    await savePreviewCredential(CREDENTIAL);

    expect(copiesOf(PREVIEW_CREDENTIAL_KEY)).toHaveLength(1);
    expect(await getPreviewCredential()).toBe(CREDENTIAL);
  });
});

describe('a registration that ends while its credential is being stored', () => {
  it('does not write one tagged with a session that is over', async () => {
    const forSession = previewCredentialSession();
    await clearPreviewCredential();

    expect(await savePreviewCredential(CREDENTIAL, forSession)).toBe(false);
    expect(await getPreviewCredential()).toBeNull();
  });

  it('declines to write when the session ends during the delete', async () => {
    // The guard at the top only covers the moment the function is entered, and
    // the delete is an await like any other. A sign-out landing inside it
    // deletes nothing — we have just deleted — and then watches the credential
    // be written onto a phone that is, by then, on the login screen.
    const forSession = previewCredentialSession();
    (SecureStore.deleteItemAsync as jest.Mock).mockImplementationOnce(
      async () => {
        await clearPreviewCredential();
      }
    );

    expect(await savePreviewCredential(CREDENTIAL, forSession)).toBe(false);
    expect(copiesOf(PREVIEW_CREDENTIAL_KEY)).toHaveLength(0);
  });

  it("leaves a newer registration's credential alone", async () => {
    // Why that middle check declines rather than writing-then-undoing. A
    // teardown can be followed by a *new* registration storing its own
    // credential; a stale write would overwrite it, and the compare-and-delete
    // undo can only remove what it wrote — it cannot put back what it clobbered.
    const forSession = previewCredentialSession();
    (SecureStore.deleteItemAsync as jest.Mock).mockImplementationOnce(
      async () => {
        await clearPreviewCredential();
        await savePreviewCredential('the next session credential');
      }
    );

    await savePreviewCredential(CREDENTIAL, forSession);

    expect(await getPreviewCredential()).toBe('the next session credential');
  });

  it('takes back one whose session ended during the write itself', async () => {
    // The sliver the checks can't cover: the native write is an await too, so a
    // teardown can land after the last look at the counter. There is no
    // compare-and-swap in the Keychain, so this is undone rather than
    // prevented — `tokens.ts` accepts the same residual for the same reason.
    const forSession = previewCredentialSession();
    (SecureStore.setItemAsync as jest.Mock).mockImplementationOnce(
      async (key, value, options) => {
        await clearPreviewCredential();
        await SecureStore.setItemAsync(key, value, options);
      }
    );

    expect(await savePreviewCredential(CREDENTIAL, forSession)).toBe(false);
    expect(await getPreviewCredential()).toBeNull();
    expect(copiesOf(PREVIEW_CREDENTIAL_KEY)).toHaveLength(0);
  });
});

describe('clearPreviewCredential', () => {
  it('removes it', async () => {
    await savePreviewCredential(CREDENTIAL);

    await clearPreviewCredential();

    expect(await getPreviewCredential()).toBeNull();
    expect(stored()).toBeNull();
  });

  it('is safe when there is nothing stored', async () => {
    // It runs on the sign-out path, on every sign-out, including ones where
    // push was never registered (permission refused, or the Simulator). A throw
    // here would surface as a failed logout.
    await expect(clearPreviewCredential()).resolves.toBeUndefined();
  });
});

describe('the account session', () => {
  it('is not stored alongside it', async () => {
    // The whole point of a scoped credential: whatever the extension is
    // entitled to read, the thing it *uses* is this one item, and the account's
    // tokens keep their own keys, their own service and their stricter
    // accessibility. A regression here would be someone "tidying up" by moving
    // token storage onto these options — and the refresh token is the half that
    // matters most, since it is long-lived and buys a whole session, so both
    // are checked rather than whichever one sorts first.
    await saveTokens({ access: 'access-token', refresh: 'refresh-token' });
    await savePreviewCredential(CREDENTIAL);

    for (const key of ['timeline.access', 'timeline.refresh']) {
      const copies = copiesOf(key);
      expect(copies).toHaveLength(1);
      expect(copies[0].service).not.toBe(STORED_SERVICE);
      expect(copies[0].accessible).toBe(SecureStore.WHEN_UNLOCKED);
    }
  });
});
