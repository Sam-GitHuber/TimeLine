/**
 * Push registration and deep-link mapping (Phase 9, Milestone D).
 *
 * `expo-notifications` and `expo-device` are mocked per-test rather than in
 * jest.setup.js: most of what's worth pinning here is *which* branch runs
 * (simulator, permission refused, already granted), and that's chosen by what
 * those modules return.
 */

import * as Notifications from 'expo-notifications';
import * as SecureStore from 'expo-secure-store';

import { api } from '@/api';
import { registerForPush, routeForNotification, unregisterPush } from '@/push';

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

  it('does nothing on a simulator', async () => {
    // getExpoPushTokenAsync throws there, and an unhandled throw on the login
    // path would surface as a failed login.
    mockIsDevice = false;

    expect(await registerForPush()).toBeNull();
    expect(api.registerPushToken).not.toHaveBeenCalled();
  });

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

  it('falls back to the feed for a missing url', () => {
    expect(routeForNotification(undefined)).toBe('/');
    expect(routeForNotification(null)).toBe('/');
  });
});
