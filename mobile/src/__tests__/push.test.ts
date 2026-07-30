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
  MESSAGE_CATEGORY,
  registerForPush,
  REPLY_ACTION,
  routeForNotification,
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
