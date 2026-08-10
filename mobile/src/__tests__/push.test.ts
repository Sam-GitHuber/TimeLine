/**
 * Push registration and deep-link mapping (Phase 9, Milestone D).
 *
 * `expo-notifications` and `expo-device` are mocked per-test rather than in
 * jest.setup.js: most of what's worth pinning here is *which* branch runs
 * (simulator, permission refused, already granted), and that's chosen by what
 * those modules return.
 */

import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

import { api } from '@/api';
import {
  CHANNEL_IDS,
  conversationIdFromUrl,
  configureNotificationCategories,
  configureNotificationChannels,
  forgetLocalPushToken,
  MESSAGE_CATEGORY,
  registerForPush,
  REPLY_ACTION,
  routeForNotification,
  setAppBadge,
  unregisterPush,
} from '@/push';

// A getter, not a plain value: the module namespace object a test imports is
// read-only under babel's ESM interop, so assigning `Device.isDevice = false`
// silently does nothing and the simulator test passes for the wrong reason.
// (`mock`-prefixed names are the ones jest lets a hoisted factory close over.)
let mockIsDevice = true;
jest.mock('expo-device', () => ({
  get isDevice() {
    return mockIsDevice;
  },
}));

jest.mock('expo-notifications', () => ({
  getPermissionsAsync: jest.fn(),
  requestPermissionsAsync: jest.fn(),
  getExpoPushTokenAsync: jest.fn(),
  setNotificationHandler: jest.fn(),
  setNotificationCategoryAsync: jest.fn(async () => ({})),
  setNotificationChannelAsync: jest.fn(async () => ({})),
  setBadgeCountAsync: jest.fn(async () => true),
  AndroidImportance: { HIGH: 4, DEFAULT: 3, LOW: 2 },
}));

jest.mock('expo-constants', () => ({
  expoConfig: { extra: { eas: { projectId: 'test-project-id' } } },
}));

const mockNotifications = Notifications as jest.Mocked<typeof Notifications>;
const TOKEN = 'ExponentPushToken[test]';
const STORAGE_KEY = 'timeline.expoPushToken';

beforeEach(() => {
  mockIsDevice = true;
  mockNotifications.getPermissionsAsync.mockResolvedValue({
    granted: true,
    canAskAgain: true,
  } as never);
  mockNotifications.getExpoPushTokenAsync.mockResolvedValue({
    data: TOKEN,
  } as never);
  jest.spyOn(api, 'registerPushToken').mockResolvedValue(undefined as never);
  jest.spyOn(api, 'unregisterPushToken').mockResolvedValue(undefined as never);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('registerForPush', () => {
  it('registers the token with the backend and stores it locally', async () => {
    const token = await registerForPush();

    expect(token).toBe(TOKEN);
    expect(api.registerPushToken).toHaveBeenCalledWith(TOKEN);
    // Stored so logout can unregister *this* device without re-deriving it.
    expect(await SecureStore.getItemAsync(STORAGE_KEY)).toBe(TOKEN);
  });

  it('passes the EAS project id, which Expo needs to mint a token', async () => {
    await registerForPush();

    expect(mockNotifications.getExpoPushTokenAsync).toHaveBeenCalledWith({
      projectId: 'test-project-id',
    });
  });

  (Platform.OS === 'ios' ? it : it.skip)(
    'does nothing on the iOS Simulator',
    async () => {
      // getExpoPushTokenAsync throws there, and an unhandled throw on the login
      // path would surface as a failed login.
      mockIsDevice = false;

      expect(await registerForPush()).toBeNull();
      expect(api.registerPushToken).not.toHaveBeenCalled();
    }
  );

  (Platform.OS === 'android' ? it : it.skip)(
    'still registers on an Android emulator (Phase 10)',
    async () => {
      // An Android emulator reports `isDevice: false` exactly like the iOS
      // Simulator, but on a Google Play system image it has real Play Services
      // and mints a real FCM token. Excluding it bought nothing and cost the
      // only way to test Android push without owning a phone — so the guard is
      // scoped to iOS. Without this test the regression is silent: push simply
      // never registers, which is indistinguishable from push being broken.
      mockIsDevice = false;
      mockNotifications.getPermissionsAsync.mockResolvedValue({
        granted: true,
      } as never);
      mockNotifications.getExpoPushTokenAsync.mockResolvedValue({
        data: TOKEN,
      } as never);

      expect(await registerForPush()).toBe(TOKEN);
      expect(api.registerPushToken).toHaveBeenCalledWith(TOKEN);
    }
  );

  it('prompts only when iOS would actually show a prompt', async () => {
    mockNotifications.getPermissionsAsync.mockResolvedValue({
      granted: false,
      canAskAgain: false,
    } as never);

    expect(await registerForPush()).toBeNull();
    // Asking again after a refusal silently returns the old answer, so this is
    // about not pretending to re-ask, not about saving a call.
    expect(mockNotifications.requestPermissionsAsync).not.toHaveBeenCalled();
  });

  it('asks when permission has not been decided yet', async () => {
    mockNotifications.getPermissionsAsync.mockResolvedValue({
      granted: false,
      canAskAgain: true,
    } as never);
    mockNotifications.requestPermissionsAsync.mockResolvedValue({
      granted: true,
    } as never);

    expect(await registerForPush()).toBe(TOKEN);
  });

  it('returns null when the user refuses', async () => {
    mockNotifications.getPermissionsAsync.mockResolvedValue({
      granted: false,
      canAskAgain: true,
    } as never);
    mockNotifications.requestPermissionsAsync.mockResolvedValue({
      granted: false,
    } as never);

    expect(await registerForPush()).toBeNull();
    expect(api.registerPushToken).not.toHaveBeenCalled();
  });

  it('never throws when registration fails', async () => {
    // It runs on the login path — no push failure may stop someone signing in.
    jest
      .spyOn(api, 'registerPushToken')
      .mockRejectedValue(new Error('network down'));

    await expect(registerForPush()).resolves.toBeNull();
  });
});

describe('unregisterPush', () => {
  it('unregisters the stored token and forgets it', async () => {
    await SecureStore.setItemAsync(STORAGE_KEY, TOKEN);

    await unregisterPush();

    expect(api.unregisterPushToken).toHaveBeenCalledWith(TOKEN);
    expect(await SecureStore.getItemAsync(STORAGE_KEY)).toBeNull();
  });

  it('does nothing when this device never registered', async () => {
    await unregisterPush();

    expect(api.unregisterPushToken).not.toHaveBeenCalled();
  });

  it('still drops the local token when the server call fails', async () => {
    // The next user to log in on this phone re-registers the same token, and
    // the backend's upsert-on-token moves the row to them — so a failed DELETE
    // is recoverable, but a retained local copy would be confusing.
    await SecureStore.setItemAsync(STORAGE_KEY, TOKEN);
    jest
      .spyOn(api, 'unregisterPushToken')
      .mockRejectedValue(new Error('offline'));

    await expect(unregisterPush()).resolves.toBeUndefined();
    expect(await SecureStore.getItemAsync(STORAGE_KEY)).toBeNull();
  });
});

describe('a session ending while a registration is in flight (#219)', () => {
  /**
   * One turn of the event loop as a **macrotask**, so every microtask an
   * unawaited registration is sitting on has drained by the time it returns —
   * which is what lets these tests say "it got exactly this far" rather than
   * hoping.
   */
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  /** A promise a test resolves by hand, to hold a call open. */
  function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((settle) => {
      resolve = settle;
    });
    return { promise, resolve };
  }

  beforeEach(async () => {
    await SecureStore.deleteItemAsync(STORAGE_KEY);
  });

  it('waits for a registration that has already reached the server, then undoes it', async () => {
    // Sign in, then sign out before the POST comes back. Without the wait,
    // unregister finds no stored token, no-ops, and the registration lands
    // afterwards — leaving this phone armed for the user who just left.
    const landing = deferred<void>();
    jest
      .spyOn(api, 'registerPushToken')
      .mockReturnValue(landing.promise as never);

    const registration = registerForPush();
    await flush();
    expect(api.registerPushToken).toHaveBeenCalledWith(TOKEN);

    let signedOut = false;
    const teardown = unregisterPush().then(() => {
      signedOut = true;
    });
    await flush();
    expect(signedOut).toBe(false);

    landing.resolve();
    await registration;
    await teardown;

    // Only now is there a row to delete and a token to delete it with.
    expect(api.unregisterPushToken).toHaveBeenCalledWith(TOKEN);
    expect(await SecureStore.getItemAsync(STORAGE_KEY)).toBeNull();
  });

  it('abandons a registration that had not reached the server yet', async () => {
    const minting = deferred<{ data: string }>();
    mockNotifications.getExpoPushTokenAsync.mockReturnValue(
      minting.promise as never
    );

    const registration = registerForPush();
    await flush();

    // Nothing has been written yet, so there is nothing to wait for — and
    // sign-out must *not* wait, or it would hang behind a permission prompt
    // the user can leave sitting on screen indefinitely. If this ever starts
    // waiting, the test times out rather than failing quietly.
    await unregisterPush();

    minting.resolve({ data: TOKEN });

    expect(await registration).toBeNull();
    expect(api.registerPushToken).not.toHaveBeenCalled();
    expect(await SecureStore.getItemAsync(STORAGE_KEY)).toBeNull();
  });

  it('abandons a registration when the session expires instead', async () => {
    // The cold-start path registers on every launch, so an expiry landing on
    // that launch's registration is the same race one door along.
    const minting = deferred<{ data: string }>();
    mockNotifications.getExpoPushTokenAsync.mockReturnValue(
      minting.promise as never
    );

    const registration = registerForPush();
    await flush();

    await forgetLocalPushToken();

    minting.resolve({ data: TOKEN });

    expect(await registration).toBeNull();
    expect(api.registerPushToken).not.toHaveBeenCalled();
    expect(await SecureStore.getItemAsync(STORAGE_KEY)).toBeNull();
  });

  it('can still unregister when the POST landed but its response did not', async () => {
    // The row is created server-side and the response is lost — a timeout, a
    // dropped connection. With the local write after the POST that left no
    // token at all, so sign-out found nothing, returned early, and the row
    // survived: #219's leak wearing a network blip's clothes.
    jest
      .spyOn(api, 'registerPushToken')
      .mockRejectedValue(new Error('response lost'));

    expect(await registerForPush()).toBeNull();
    expect(await SecureStore.getItemAsync(STORAGE_KEY)).toBe(TOKEN);

    await unregisterPush();

    expect(api.unregisterPushToken).toHaveBeenCalledWith(TOKEN);
  });

  it('joins an in-flight registration rather than starting a second', async () => {
    // Only the newest attempt fits in the slot a teardown consults, so a second
    // one starting mid-flight would leave the first untracked — and sign-out,
    // seeing the newer uncommitted attempt, wouldn't wait for the older
    // committed one. It would land afterwards and re-arm the phone.
    const landing = deferred<void>();
    jest
      .spyOn(api, 'registerPushToken')
      .mockReturnValue(landing.promise as never);

    const first = registerForPush();
    await flush();
    const second = registerForPush();

    expect(second).toBe(first);

    landing.resolve();
    await first;

    expect(api.registerPushToken).toHaveBeenCalledTimes(1);
  });

  it('does not hold the expiry path open behind a committed registration', async () => {
    // Deliberately *unlike* sign-out. This path lands on the login screen
    // immediately, so a wait here is a wait during which someone else can sign
    // in — and the delete would then take out the token their registration had
    // just stored, leaving a server row nothing local can unregister. That is
    // the same leak arrived at from the other side.
    const landing = deferred<void>();
    jest
      .spyOn(api, 'registerPushToken')
      .mockReturnValue(landing.promise as never);

    const registration = registerForPush();
    await flush();

    // Resolves without the POST having come back at all.
    await forgetLocalPushToken();
    expect(await SecureStore.getItemAsync(STORAGE_KEY)).toBeNull();

    landing.resolve();
    await registration;
  });
});

describe('routeForNotification', () => {
  it('maps a post permalink onto the mobile post route', () => {
    // The backend phrases one url for both clients, in the web app's shape.
    expect(routeForNotification('/p/42')).toBe('/post/42');
  });

  it('keeps the comment anchor so the thread can open at it', () => {
    expect(routeForNotification('/p/42?comment=7')).toBe('/post/42?comment=7');
  });

  it('maps a profile url', () => {
    expect(routeForNotification('/u/3')).toBe('/u/3');
  });

  it('opens the People hub for a connection request (E1)', () => {
    expect(routeForNotification('/requests')).toBe('/people');
  });

  it('routes a group invite to the Groups tab (E3a)', () => {
    expect(routeForNotification('/group-invites')).toBe('/groups');
  });

  it('routes an event notification to the flat event screen (E3b)', () => {
    // The backend sends the web's nested shape (`/g/<gid>/events/<eid>`); mobile
    // keeps events flat and takes only the event id. All five event push kinds
    // deep-link here.
    expect(routeForNotification('/g/1/events/9')).toBe('/events/9');
    expect(routeForNotification('/g/42/events/7')).toBe('/events/7');
  });

  it('keeps a comment deep-link on an event, as it does on a post', () => {
    // Since events grew a comment thread, `comment_reply` and a comment
    // `reaction` on one deep-link to `…/events/<eid>?comment=<cid>`. Dropping
    // the query here doesn't fail loudly — it lands you at the top of the
    // thread and makes `EventScreen`'s `highlightCommentId` dead code.
    expect(routeForNotification('/g/1/events/9?comment=42')).toBe(
      '/events/9?comment=42'
    );
  });

  it('opens the thread for a new-message push (#118)', () => {
    // The one push with no activity-centre row behind it — messaging keeps its
    // own unread badge — so the route is all the tap has to go on.
    expect(routeForNotification('/messages/12')).toBe('/messages/12');
  });

  it('falls back to the feed for a missing url', () => {
    expect(routeForNotification(undefined)).toBe('/');
    expect(routeForNotification(null)).toBe('/');
  });
});


describe('configureNotificationCategories', () => {
  it('registers a Reply action with a text field, that does not open the app', () => {
    // The three things that make replying from a notification work at all: the
    // category name the backend sends, a text input to type into, and *not*
    // foregrounding the app — which is the whole point of answering from the
    // lock screen.
    configureNotificationCategories();

    const [category, actions] =
      mockNotifications.setNotificationCategoryAsync.mock.calls[0];
    expect(category).toBe(MESSAGE_CATEGORY);
    expect(actions[0].identifier).toBe(REPLY_ACTION);
    expect(actions[0].textInput).toBeTruthy();
    expect(actions[0].options?.opensAppToForeground).toBe(false);
  });
});

describe('configureNotificationChannels (Phase 10)', () => {
  /**
   * The ids the **backend** puts in each push's `channelId`
   * (`api/notifications.py`'s `_KIND_CHANNELS` + `MESSAGE_CHANNEL`).
   *
   * Hard-coded rather than derived, deliberately: this is the copy that has to
   * agree with a different language in a different process, and a test that
   * read them from the same array as the code would agree with itself while
   * both drifted from the server. An Android push naming a channel the device
   * doesn't have is **dropped silently**, so drift here looks exactly like push
   * being broken — with nothing in any log to say so.
   */
  const BACKEND_CHANNEL_IDS = [
    'messages',
    'mentions',
    'replies',
    'reactions',
    'events',
    'social',
  ];

  it('creates exactly the channels the backend sends', () => {
    expect([...CHANNEL_IDS].sort()).toEqual([...BACKEND_CHANNEL_IDS].sort());
  });

  const androidOnly = Platform.OS === 'android' ? it : it.skip;
  const iosOnly = Platform.OS === 'ios' ? it : it.skip;

  androidOnly('registers every channel, messages loud and reactions quiet', () => {
    configureNotificationChannels();

    const created = mockNotifications.setNotificationChannelAsync.mock.calls;
    expect(created.map(([id]) => id).sort()).toEqual(
      [...BACKEND_CHANNEL_IDS].sort()
    );

    // Importance is the whole reason channels are worth having: the split
    // between what may interrupt you and what may not.
    const importanceOf = (id: string) =>
      created.find(([channelId]) => channelId === id)?.[1]?.importance;
    expect(importanceOf('messages')).toBe(Notifications.AndroidImportance.HIGH);
    expect(importanceOf('mentions')).toBe(Notifications.AndroidImportance.HIGH);
    expect(importanceOf('reactions')).toBe(Notifications.AndroidImportance.LOW);

    // Every channel needs a name — it's what the user sees in system settings,
    // and an unnamed one is unmanageable there.
    for (const [, config] of created) {
      expect(config?.name).toBeTruthy();
    }
  });

  iosOnly('creates nothing on iOS, where channels do not exist', () => {
    configureNotificationChannels();
    expect(mockNotifications.setNotificationChannelAsync).not.toHaveBeenCalled();
  });
});

describe('setAppBadge', () => {
  const androidOnly = Platform.OS === 'android' ? it : it.skip;
  const iosOnly = Platform.OS === 'ios' ? it : it.skip;

  beforeEach(() => {
    // The module factory's `jest.fn` isn't a spy, so `restoreAllMocks` doesn't
    // reach it — a `mockResolvedValue(false)` set by one refusal test would
    // otherwise be the state every later test starts from.
    mockNotifications.setBadgeCountAsync.mockResolvedValue(true as never);
    // Every refusal below prints the `__DEV__` warning. Silence it so a
    // deliberate failure case doesn't look like a broken run.
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  iosOnly('puts the count on the icon', async () => {
    await setAppBadge(3);

    expect(mockNotifications.setBadgeCountAsync).toHaveBeenCalledWith(3);
  });

  iosOnly('clears the icon with zero', async () => {
    // The count that matters most: the one that takes the badge away. It has to
    // go through the same call, which is why this isn't guarded against zero.
    await setAppBadge(0);

    expect(mockNotifications.setBadgeCountAsync).toHaveBeenCalledWith(0);
  });

  iosOnly('never hands the native side a negative count', async () => {
    await setAppBadge(-1);

    expect(mockNotifications.setBadgeCountAsync).toHaveBeenCalledWith(0);
  });

  androidOnly('does nothing at all on Android', async () => {
    // **The load-bearing test in this file.** `setBadgeCountAsync(0)` on
    // Android doesn't clear a badge — `BadgeHelper` calls
    // `notificationManager.cancelAll()` and dismisses *every* notification the
    // app has posted. A well-meaning "clear the badge on foreground" would
    // silently wipe the shade, in the release right after #178 taught this app
    // to dismiss notifications only once they've genuinely been dealt with.
    await setAppBadge(0);
    await setAppBadge(5);

    expect(mockNotifications.setBadgeCountAsync).not.toHaveBeenCalled();
  });

  androidOnly('answers null on Android, which is not the same as refused', async () => {
    // `false` means "attempted and declined". Android never attempts, so a
    // caller that acted on `false` — surfacing it, retrying it — would treat
    // every Android launch as a refusal. Only `setAppBadge` knows the platform
    // rule, so only `setAppBadge` can tell the two apart.
    await expect(setAppBadge(2)).resolves.toBeNull();

    // And the early return has to come *before* the warning, or every launch
    // reports a refusal for a write we deliberately never make.
    expect(console.warn).not.toHaveBeenCalled();
  });

  iosOnly('survives a badge the OS refuses to set', async () => {
    // Best-effort like every other push nicety here: the worst a failure may do
    // is leave the number where it was. It must not reject into a screen — the
    // app's callers `void` this, so a rejection would surface as an unhandled
    // one mid-render. A throw is reported as a refusal, not re-thrown.
    mockNotifications.setBadgeCountAsync.mockRejectedValue(
      new Error('no badge permission') as never
    );

    await expect(setAppBadge(2)).resolves.toBe(false);
  });

  iosOnly('says whether the write actually landed', async () => {
    // #233. `setBadgeCountAsync` resolves to a **boolean**, and `false` is not
    // an error — it is the module reporting that iOS declined, because badges
    // are not enabled for the app. Discarding it made a refused write
    // indistinguishable from a successful one, which is precisely the bit
    // #234's stuck-badge investigation needed and had to fall back on reading
    // the module's Swift source to guess at.
    await expect(setAppBadge(3)).resolves.toBe(true);

    mockNotifications.setBadgeCountAsync.mockResolvedValue(false as never);

    await expect(setAppBadge(3)).resolves.toBe(false);
  });

  iosOnly('keeps what a thrown write said, rather than guessing at a setting', async () => {
    // A throw and a `false` are different answers. `setBadgeCount()` can throw
    // on iOS 16+, and an unlinked module raises `UnavailabilityError` — the one
    // branch carrying real diagnostic text. Reporting it as "badges are off in
    // Settings" would send the next investigation to a Settings screen with the
    // actual error already discarded, which is the failure #233 exists to stop.
    const boom = new Error('ExpoNotifications is not available');
    // A landed write first, so the failure below is a transition whatever ran
    // before this — see the latch note in the refusal test.
    await setAppBadge(0);
    mockNotifications.setBadgeCountAsync.mockRejectedValue(boom as never);

    await setAppBadge(1);

    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('failed'),
      boom
    );
  });

  iosOnly('latches on the last write made, not the last one to come back', async () => {
    // Callers `void` these, so two can be in flight at once, and the native
    // side doesn't serialise them. If an older write resolving late got the
    // last word, the latch would hold an outcome that isn't the icon's — and
    // the next genuine transition into refusal would go unreported.
    const warn = console.warn as jest.Mock;
    await setAppBadge(0);

    let settleFirst!: (accepted: boolean) => void;
    mockNotifications.setBadgeCountAsync.mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        settleFirst = resolve;
      }) as never
    );
    const first = setAppBadge(1);
    mockNotifications.setBadgeCountAsync.mockResolvedValue(false as never);

    // The second write is issued later and comes back first, refused.
    await setAppBadge(2);
    expect(warn).toHaveBeenCalledTimes(1);

    // Now the older one lands, accepted. It must not overwrite the newer
    // outcome, or the next refusal reads as a fresh transition and warns again.
    settleFirst(true);
    await first;
    await setAppBadge(3);

    expect(warn).toHaveBeenCalledTimes(1);
  });

  iosOnly('warns once when writes start being refused, not on every write', async () => {
    // The dedupe is load-bearing rather than tidiness: since #232 the badge is
    // re-asserted on every successful count fetch, so a phone with badges
    // switched off would log on every foreground and every mark-read. A warning
    // that prints constantly is one nobody reads.
    const warn = console.warn as jest.Mock;
    // Establish the starting state rather than assume it: the latch is module
    // state and outlives a test, so what ran before this decides whether the
    // first refusal is a transition.
    await setAppBadge(0);
    mockNotifications.setBadgeCountAsync.mockResolvedValue(false as never);

    await setAppBadge(1);
    await setAppBadge(2);

    expect(warn).toHaveBeenCalledTimes(1);

    // ...but it is a latch on the *state*, not a once-per-process gag: badges
    // being switched back on and off again is worth hearing about twice.
    mockNotifications.setBadgeCountAsync.mockResolvedValue(true as never);
    await setAppBadge(3);
    mockNotifications.setBadgeCountAsync.mockResolvedValue(false as never);
    await setAppBadge(4);

    expect(warn).toHaveBeenCalledTimes(2);
  });

});

describe('conversationIdFromUrl', () => {
  it('reads the thread a message push points at', () => {
    // The reply path needs the id, not a route — taken from the same `url` the
    // deep link uses, so there's only one shape on the wire.
    expect(conversationIdFromUrl('/messages/12')).toBe(12);
  });

  it('is null for anything that isn’t a thread', () => {
    expect(conversationIdFromUrl('/p/42')).toBeNull();
    expect(conversationIdFromUrl(undefined)).toBeNull();
  });
});
