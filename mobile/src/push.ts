/**
 * Push notifications: registration, and turning a tapped notification into a
 * route (Phase 9, Milestone D).
 *
 * The backend never talks to APNs. The app registers with Expo, gets an **Expo
 * push token**, and hands it to our API; the backend sends to Expo and Expo
 * fans out to Apple. See docs/reference/notifications.md.
 *
 * Three things here are easy to get wrong and are handled deliberately:
 *
 * 1. **Permission is asked for once, and a refusal is final.** Calling
 *    `requestPermissionsAsync` when the user has already said no does not
 *    re-prompt — iOS just returns the existing answer — so we check first and
 *    treat "denied" as a normal outcome, not an error. The app must work fine
 *    without push.
 * 2. **The Expo token is stored locally**, so logout can unregister *this*
 *    device even if the network is flaky at that moment. Re-deriving it at
 *    logout would fail exactly when it matters, leaving the server pushing a
 *    previous user's notifications to a phone they no longer control — the
 *    privacy failure `DevicePushToken`'s upsert-on-token rule exists to avoid.
 * 3. **A simulator has no push token.** `Device.isDevice` guards the whole
 *    path, because `getExpoPushTokenAsync` throws there and an unhandled throw
 *    on login would be a login failure.
 */

import Constants from 'expo-constants';
import * as Device from 'expo-device';
import type { Href } from 'expo-router';
import * as Notifications from 'expo-notifications';
import * as SecureStore from 'expo-secure-store';

import { api } from '@/api';

const PUSH_TOKEN_KEY = 'timeline.expoPushToken';

/**
 * Show notifications that arrive while the app is *foregrounded*.
 *
 * Without this iOS suppresses them — the OS assumes an app on screen will
 * surface its own news. We don't (yet): there's no in-app activity centre on
 * mobile until Milestone E, so a suppressed notification would be lost
 * entirely rather than merely redundant.
 */
export function configureNotificationHandler(): void {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });
}

/** The EAS project id, which `getExpoPushTokenAsync` needs to mint a token. */
function projectId(): string | undefined {
  return (
    Constants.expoConfig?.extra?.eas?.projectId ??
    // Present in builds where the config was resolved at build time.
    (Constants as { easConfig?: { projectId?: string } }).easConfig?.projectId
  );
}

/**
 * Ask for permission, get an Expo push token, and register it with the backend.
 *
 * Returns the token, or `null` when push isn't available (simulator, permission
 * refused, or no project id). **Never throws** — it's called on the login path,
 * and no push-related failure may ever stop someone signing in.
 */
export async function registerForPush(): Promise<string | null> {
  try {
    if (!Device.isDevice) return null;

    const existing = await Notifications.getPermissionsAsync();
    let granted = existing.granted;
    // Only prompt if iOS would actually show one. Asking again after a refusal
    // silently returns the old answer, so this is about intent, not efficiency.
    if (!granted && existing.canAskAgain) {
      const asked = await Notifications.requestPermissionsAsync();
      granted = asked.granted;
    }
    if (!granted) return null;

    const id = projectId();
    if (!id) return null;

    const { data: token } = await Notifications.getExpoPushTokenAsync({
      projectId: id,
    });

    await api.registerPushToken(token);
    await SecureStore.setItemAsync(PUSH_TOKEN_KEY, token);
    return token;
  } catch {
    // Deliberately swallowed: see above. The user is logged in either way.
    return null;
  }
}

/**
 * Unregister this device server-side. Call **before** clearing the auth tokens
 * — the endpoint is authenticated, so afterwards it would just 401 and the row
 * would survive, leaving this phone receiving the previous user's pushes.
 */
export async function unregisterPush(): Promise<void> {
  try {
    const token = await SecureStore.getItemAsync(PUSH_TOKEN_KEY);
    if (!token) return;
    await api.unregisterPushToken(token);
  } catch {
    // Best-effort, mirroring api.logout's blacklist call: a network failure
    // must not trap someone in a logged-in app.
  } finally {
    // Always drop the local copy. If the server row survived a failed DELETE,
    // the next person to log in on this phone re-registers the same token and
    // the backend's upsert-on-token moves the row to them anyway.
    await SecureStore.deleteItemAsync(PUSH_TOKEN_KEY);
  }
}

/**
 * Forget this device's push token locally, without calling the server.
 *
 * For the **session-expired** path, where `unregisterPush` is not an option:
 * the unregister endpoint is authenticated, and by definition we no longer
 * have a working token — the call would 401, trigger a refresh, fail, and
 * re-enter the session-expired handler that called us. So the server row
 * necessarily survives an expiry.
 *
 * That is acceptable, and worth being clear about why. An expired session does
 * not change *whose* phone this is: the notifications still belong to the
 * person holding it, who simply has to log in again. The genuine risk — a
 * handed-on or shared phone reaching a new owner — is covered from the other
 * end, by the backend's upsert-on-token rule moving the row to whoever logs in
 * next. What we must not do is keep a stale token locally, or the next
 * registration would have two ideas of this device.
 */
export async function forgetLocalPushToken(): Promise<void> {
  await SecureStore.deleteItemAsync(PUSH_TOKEN_KEY);
}

/**
 * Map the server's `url` onto a route this app actually has.
 *
 * The backend phrases one deep-link for both clients (see
 * NotificationSerializer), in the *web* app's shape: `/p/42`, `/p/42?comment=7`,
 * `/u/3`, `/requests`, `/group-invites`, `/g/1/events/9`. Mobile's routes differ
 * (`/post/42`), and several targets don't exist yet — connections land in E1,
 * groups and events in E3.
 *
 * Unknown targets fall back to the feed rather than throwing: a notification
 * whose screen we haven't built must still open the app, not crash it. As those
 * milestones land, add cases here.
 */
export function routeForNotification(url: string | null | undefined): Href {
  if (!url) return '/';

  const [path, query] = url.split('?');

  const post = path.match(/^\/p\/(\d+)$/);
  if (post) {
    return (query ? `/post/${post[1]}?${query}` : `/post/${post[1]}`) as Href;
  }

  const profile = path.match(/^\/u\/(\d+)$/);
  if (profile) return `/u/${profile[1]}` as Href;

  // A connection request (backend sends `/requests`) opens the People hub (E1).
  // It lands on the Connections segment rather than Requests — the pending-count
  // badge on the Requests segment surfaces the incoming request from there.
  // Opening directly on Requests would mean threading a segment param through
  // the tab's retained state; deferred until a tester finds the extra tap
  // annoying.
  if (path === '/requests') return '/people';

  // A group invite (backend sends `/group-invites`) opens the Groups tab. Like
  // connection requests → People above, it lands on the tab's default (Groups)
  // segment rather than the Invites one; the pending-count badge on the Invites
  // segment surfaces the invite from there. Landing directly on Invites would
  // mean threading a segment param through the tab's retained state — deferred
  // for the same reason as the requests case (E3a).
  if (path === '/group-invites') return '/groups';

  // An event notification (backend sends `/g/<gid>/events/<eid>` — the web's
  // nested shape) opens the event detail screen. Mobile keeps events flat
  // (`/events/<eid>`), so we take only the event id; the detail screen loads the
  // event (which carries its group) and its Back returns there. This closes all
  // five event push kinds (created / poll_opened / scheduled / updated /
  // cancelled), which all deep-link to the same target (E3b).
  const event = path.match(/^\/g\/\d+\/events\/(\d+)$/);
  if (event) return `/events/${event[1]}` as Href;

  return '/';
}
