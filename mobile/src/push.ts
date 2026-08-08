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
 * 3. **The iOS Simulator has no push token**, and `getExpoPushTokenAsync`
 *    throws there — an unhandled throw on login would be a login failure. An
 *    **Android emulator is not the same case**: on a Google Play system image
 *    it has real Play Services and registers a real FCM token, which is what
 *    makes push testable without owning an Android phone. See
 *    `canRegisterForPush`.
 */

import Constants from 'expo-constants';
import * as Device from 'expo-device';
import type { Href } from 'expo-router';
import * as Notifications from 'expo-notifications';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

import { api } from '@/api';

const PUSH_TOKEN_KEY = 'timeline.expoPushToken';

/**
 * The `data` blob the backend puts on every push (`send_pushes.py`'s `_message`).
 *
 * `notificationId` is explicitly nullable: a **message** push has no
 * activity-centre row behind it (issue #118) and sends `null`. That nullness is
 * what tells the two kinds of push apart down here, where the tray gives us
 * nothing else to go on.
 */
type PushData = { url?: string | null; notificationId?: number | null };

/** The `data` off a delivered notification, never undefined. */
function pushData(notification: Notifications.Notification): PushData {
  return (notification.request.content.data ?? {}) as PushData;
}

/**
 * The conversation whose thread is on screen right now, or `null`.
 *
 * Module state rather than context because its one reader is the notification
 * handler, which is registered at module scope (it has to exist before any
 * notification can arrive) and so has no component tree to read from.
 */
let onScreenConversation: number | null = null;

/**
 * Tell the notification handler which thread the user is looking at (#178).
 *
 * Set on *focus*, not mount: the thread screen stays mounted underneath its own
 * info screen, and a screen left behind another must not go on claiming the
 * pushes meant for what's on top. Pass `null` to clear.
 */
export function setOnScreenConversation(conversationId: number | null): void {
  onScreenConversation = conversationId;
}

/**
 * Show notifications that arrive while the app is *foregrounded*.
 *
 * Without this iOS suppresses them — the OS assumes an app on screen will
 * surface its own news. We don't (yet): there's no in-app activity centre on
 * mobile until Milestone E, so a suppressed notification would be lost
 * entirely rather than merely redundant.
 *
 * **The one exception is a message for the thread you're reading** (#178). The
 * banner is left alone — it's transient, and a brief "Ada: …" while you're
 * mid-scroll is at worst redundant — but `shouldShowList: false` keeps it out of
 * the notification centre, where it would otherwise sit for hours claiming you
 * have something to read that you read as it arrived.
 *
 * iOS honours the two independently. Android has no transient-only notification,
 * so a banner there *is* a shade entry; the mark-read dismissal below is what
 * clears it, one message-poll later.
 *
 * **`shouldSetBadge` stays `false`, deliberately** (#179). Every push now carries
 * a server-computed `badge`, and turning this on would apply it while the app is
 * on screen — usually right, and wrong in exactly the case that matters most:
 * a push for the thread you are reading, whose count was computed a tick before
 * you read it. While the app is running, `useBadgeCount` owns the number, from
 * the same counts the in-app badges are showing.
 */
export function configureNotificationHandler(): void {
  Notifications.setNotificationHandler({
    handleNotification: async (notification) => {
      const inThreadOnScreen =
        onScreenConversation !== null &&
        conversationIdFromUrl(pushData(notification).url) === onScreenConversation;
      return {
        shouldShowBanner: true,
        shouldShowList: !inThreadOnScreen,
        shouldPlaySound: true,
        shouldSetBadge: false,
      };
    },
  });
}

/**
 * Put a number on the **app icon** (#179), or clear it with `0`.
 *
 * **iOS only, and that is a decision rather than an oversight.** Two reasons,
 * either of which would be enough:
 *
 * 1. `Notifications.setBadgeCountAsync(0)` on Android does not merely clear a
 *    badge — the module's `BadgeHelper` calls `notificationManager.cancelAll()`,
 *    dismissing **every** notification the app has posted. Clearing the icon on
 *    the way to zero would silently wipe the notification shade, in the release
 *    right after #178 taught this app to dismiss notifications precisely and
 *    only when they've genuinely been dealt with.
 * 2. Android badges are launcher-dependent (the module goes through
 *    ShortcutBadger and simply resolves `false` where the launcher has no
 *    concept of one), and Expo's push API has no Android badge field at all. So
 *    the most we could offer is a number we can set but never take back —
 *    strictly worse than none.
 *
 * Android is not left with nothing: launchers derive their dot from the
 * notification shade, and #178 is what keeps that honest.
 *
 * **Still best-effort, but no longer silent about it (#233).** Resolves to
 * whether the write actually landed: `setBadgeCountAsync` returns a *boolean*,
 * and `false` is not an error — it is the module telling us iOS declined.
 * Throwing that away made a refused write indistinguishable from a successful
 * one, which is exactly the bit #234's investigation needed and had to go and
 * read the module's Swift source to guess at.
 *
 * **`false` means one specific thing**, and it's worth naming precisely rather
 * than listing everything that feels like it might suppress a badge:
 * `BadgeModule.swift` returns `false` when `settings.badgeSetting != .enabled`
 * and at no other time — that is the app's badge *authorisation*, the Badges
 * switch under Settings → Notifications → TimeLine. A Focus mode changes how
 * notifications are delivered, not that setting, so a phone in Focus still
 * resolves `true`. Sending the next investigation to check Focus first would
 * cost it the same afternoon #234 cost this one.
 *
 * A **throw** is a third outcome and is kept distinct in the warning, because
 * it's the one carrying real diagnostic text: `setBadgeCount()` can throw on
 * iOS 16+, and an unlinked module raises `UnavailabilityError`. Both resolve
 * `false` to the caller — no badge was set either way — but the developer sees
 * what actually happened rather than a confident guess about a setting.
 *
 * What it deliberately does *not* do is change what the user sees. A refused
 * write stays a no-op: it never throws, never blocks a render, never retries.
 * It is their phone and their setting, and the failure mode — an icon that
 * keeps the last number the server pushed — is the behaviour we had before
 * #179 existed. The return value exists so a caller *could* act, and so the
 * next investigation can answer this on-device in seconds.
 *
 * **`null` on Android**, which is not the same answer as `false`: there the app
 * never attempts a write at all, so "was it refused?" has no answer. A caller
 * that acted on `false` would otherwise treat every Android launch as a refusal.
 */
export async function setAppBadge(count: number): Promise<boolean | null> {
  if (Platform.OS !== 'ios') return null;
  const attempt = ++badgeWrites;
  try {
    // Negative would be a bug upstream, but it's a native call — clamp rather
    // than hand UIKit something it has no defined behaviour for.
    const accepted = await Notifications.setBadgeCountAsync(Math.max(0, count));
    reportBadgeWrite(attempt, accepted, null);
    return accepted;
  } catch (error) {
    reportBadgeWrite(attempt, false, error);
    return false;
  }
}

/**
 * How many badge writes have been *issued*, and the outcome the warning below
 * currently reflects.
 *
 * Callers `void` these, so two can be in flight at once — a `signedOut` clear
 * racing a count that has just landed — and the native side doesn't run them on
 * a serial queue, so they can resolve out of order. Ranking by issue order means
 * the latch ends up holding the fate of the *last write made* rather than the
 * last one to come back, which is the thing a developer reading the warning
 * assumes it means.
 */
let badgeWrites = 0;
let reportedWrite = 0;
/** What we last knew about whether iOS accepts these; `null` before any write. */
let badgeWritesAccepted: boolean | null = null;

/**
 * Warn — in development only — when badge writes *start* being refused.
 *
 * On the transition rather than on every write, because since #232 the badge is
 * re-asserted on every successful count fetch: on a phone with badges switched
 * off that would be a line on every foreground and every mark-read, and a
 * warning that prints constantly is one nobody reads.
 */
function reportBadgeWrite(
  attempt: number,
  accepted: boolean,
  error: unknown
): void {
  // Production keeps no state here: nothing reads it, and a latch nobody
  // consults is just a way to be wrong later.
  if (!__DEV__) return;
  if (attempt < reportedWrite) return;
  reportedWrite = attempt;

  const changed = badgeWritesAccepted !== accepted;
  badgeWritesAccepted = accepted;
  if (accepted || !changed) return;

  if (error) {
    console.warn('[push] the app-icon badge write failed (#233):', error);
  } else {
    console.warn(
      '[push] iOS refused the app-icon badge write: badges are not enabled ' +
        'for this app (Settings → Notifications → TimeLine → Badges). The ' +
        'icon will keep whatever number the last push put there (#233).'
    );
  }
}

/**
 * The category a **message** push carries (Phase 9b M8), and the name the
 * backend puts in its `categoryId`. Change one and you must change the other —
 * an unknown category is silently ignored by iOS, which looks exactly like the
 * feature not existing.
 */
export const MESSAGE_CATEGORY = 'message';
/** The action inside it. Compared against `response.actionIdentifier`. */
export const REPLY_ACTION = 'reply';

/**
 * Register the notification actions iOS draws under a pulled-down push
 * (Phase 9b M8) — for now, one: **Reply, with a text field**.
 *
 * This is what turns a push from a doorbell into something you can answer.
 * `opensAppToForeground: false` is the whole point: the reply is sent from the
 * notification, without the app taking over the screen you were on.
 *
 * Registered at launch rather than at login, because iOS keeps categories per
 * *app*, not per session, and a push can arrive before anyone has signed in on
 * this launch. Failures are swallowed for the same reason `registerForPush`
 * swallows its own: no notification nicety may ever break starting the app —
 * without the category the push simply has no Reply action on it.
 */
export function configureNotificationCategories(): void {
  Notifications.setNotificationCategoryAsync(MESSAGE_CATEGORY, [
    {
      identifier: REPLY_ACTION,
      buttonTitle: 'Reply',
      textInput: {
        submitButtonTitle: 'Send',
        placeholder: 'Message',
      },
      options: { opensAppToForeground: false },
    },
  ]).catch(() => {});
}

/**
 * The Android notification **channels** (Phase 10), and their importance.
 *
 * Android 8+ files every notification into a channel, and the channel — not the
 * app — decides whether it makes a sound or shows a heads-up banner. The user
 * tunes them individually in system settings, which is the point: "let messages
 * interrupt me but keep reactions quiet" becomes something they can decide
 * without us building a screen for it.
 *
 * The grouping mirrors the **per-type preferences** (see the backend's
 * `_KIND_CHANNELS`) so the OS control and the in-app one agree. Deliberately not
 * one channel per notification kind — five separate event channels would be a
 * wall of switches nobody reads.
 *
 * Three things to know before touching this:
 *
 * - **The ids must match the backend's**, which puts one in each push's
 *   `channelId`. A push naming a channel the device doesn't have is **dropped
 *   silently** — it does not fall back to a default — which looks exactly like
 *   push being broken. Pinned by a test on each side.
 * - **A channel is immutable once created on a device.** Changing an importance
 *   here does nothing for anyone who already has the app; only a new id takes
 *   effect. So these are chosen to be lived with.
 * - **Importance is a floor, not a rule.** The user can turn any channel down
 *   (or off) afterwards, and that's deliberate — it's their phone.
 */
const CHANNELS: {
  id: string;
  name: string;
  importance: Notifications.AndroidImportance;
}[] = [
  {
    // The one thing people generally do want interrupting them, and the only
    // push that arrives while a conversation is live.
    id: 'messages',
    name: 'Messages',
    importance: Notifications.AndroidImportance.HIGH,
  },
  {
    // Being named should still reach you in a chat you've otherwise quietened —
    // the whole reason mentions have their own preference.
    id: 'mentions',
    name: 'Mentions',
    importance: Notifications.AndroidImportance.HIGH,
  },
  {
    id: 'replies',
    name: 'Replies',
    importance: Notifications.AndroidImportance.DEFAULT,
  },
  {
    // Quiet by default: a reaction is nice to know about, never urgent, and a
    // popular post shouldn't buzz a pocket twenty times.
    id: 'reactions',
    name: 'Reactions',
    importance: Notifications.AndroidImportance.LOW,
  },
  {
    id: 'events',
    name: 'Group events',
    importance: Notifications.AndroidImportance.DEFAULT,
  },
  {
    // Connection requests and group invites — things waiting on an answer.
    id: 'social',
    name: 'Requests and invites',
    importance: Notifications.AndroidImportance.DEFAULT,
  },
];

/** The channel ids, for the test that pins them against the backend's. */
export const CHANNEL_IDS = CHANNELS.map((channel) => channel.id);

/**
 * Create the notification channels. Android-only, and a no-op elsewhere.
 *
 * Runs at launch rather than at login, for the same reason the categories do:
 * a push can arrive before anyone signs in on this launch, and the channel has
 * to exist *before* the notification does or it's dropped. Creating one that
 * already exists is a cheap no-op, so this is safe to run every time.
 *
 * Failures are swallowed — as with the categories, no notification nicety may
 * break starting the app.
 */
export function configureNotificationChannels(): void {
  if (Platform.OS !== 'android') return;
  for (const channel of CHANNELS) {
    Notifications.setNotificationChannelAsync(channel.id, {
      name: channel.name,
      importance: channel.importance,
    }).catch(() => {});
  }
}

/**
 * Whether this device can mint a push token at all.
 *
 * **Not simply `Device.isDevice`**, and the difference matters (Phase 10). That
 * check is really asking "is this the iOS Simulator", where
 * `getExpoPushTokenAsync` throws and there is no push to be had. An **Android
 * emulator** running a *Google Play* system image has genuine Play Services and
 * registers a genuine FCM token — so excluding it bought nothing and cost the
 * only way to test Android push without owning an Android phone.
 *
 * Being wrong in the permissive direction is cheap: `registerForPush` wraps
 * everything in a try/catch that returns `null`, so an emulator that somehow
 * can't register degrades to "no push" rather than breaking a login. Being
 * wrong in the restrictive direction is what we had — silent, and indis-
 * tinguishable from push being broken.
 */
function canRegisterForPush(): boolean {
  return Device.isDevice || Platform.OS === 'android';
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
    if (!canRegisterForPush()) return null;

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
 * The conversation a `/messages/<id>` deep link points at (Phase 9b M8).
 *
 * The reply-from-a-notification path needs the id itself, not a route: it sends
 * a message rather than opening a screen. Reading it from the same `url` the
 * deep link uses keeps one shape on the wire — the push carries no separate
 * conversation field to fall out of step with it.
 *
 * **Total by construction**, and it has to stay that way: the foreground
 * notification handler calls this on every arriving push, and a handler that
 * *rejects* means the notification isn't presented at all. `data` is untyped
 * JSON off the wire, so a `url` that isn't a string is a possibility rather
 * than a contradiction — hence the type test rather than a bare `?.match`,
 * which would throw a TypeError on a number and silently swallow the push.
 */
export function conversationIdFromUrl(url: unknown): number | null {
  if (typeof url !== 'string') return null;
  const match = url.match(/^\/messages\/(\d+)$/);
  return match ? Number(match[1]) : null;
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
  //
  // **The query has to come with it**, exactly as the post branch above carries
  // it: since events grew a comment thread, `comment_reply` and a comment
  // `reaction` on an event deep-link to `…/events/<eid>?comment=<cid>`, and
  // `EventScreen` reads that param to open the thread at the comment somebody
  // actually wrote. Dropping it here doesn't fail loudly — it lands you at the
  // top of the thread and makes the screen's `highlightCommentId` dead code.
  const event = path.match(/^\/g\/\d+\/events\/(\d+)$/);
  if (event) {
    return (
      query ? `/events/${event[1]}?${query}` : `/events/${event[1]}`
    ) as Href;
  }

  // A new message (backend sends `/messages/<conversationId>`) opens the thread.
  // Unlike every other case here there's no activity-centre row behind it —
  // messaging keeps its own unread badge and is deliberately outside the bell
  // (issue #118) — so the push's `kind` is "message" and its `notificationId` is
  // null. Nothing downstream needs that distinction: the thread screen marks
  // itself read on open, which is what clears the badge.
  const conversation = path.match(/^\/messages\/(\d+)$/);
  if (conversation) return `/messages/${conversation[1]}` as Href;

  return '/';
}

/**
 * Taking back notifications the user has since dealt with **inside the app**
 * (#178).
 *
 * The server already does the *pre*-delivery half of this well: a queued message
 * push whose read marker has moved past it is binned before it ever buzzes
 * (`send_pushes.py`'s `_should_drop`). The gap was everything after delivery —
 * read the thread in the app, go back to the home screen, and "New message from
 * Ada" was still sitting on the lock screen. Nothing ever took one back.
 *
 * Everything here is **best-effort and swallows failures**, like the other push
 * niceties in this file. The worst outcome of a failed dismissal is the
 * behaviour we had all along: a notification that stays put. So it may never be
 * allowed to fail *loudly* — into a screen, a retry, or a rejected promise
 * nobody awaits — at a moment when the user is reading a thread or opening the
 * activity centre.
 *
 * What none of it covers is reading somewhere *else* — the web, a second phone.
 * There is no APNs/FCM "unsend"; reaching a phone that isn't running the app
 * means sending it something, and both platforms' silent-delivery paths are
 * best-effort by construction. That's issue #178's case D, deliberately left to
 * ride on Phase 10b's spike rather than guessed at here. The foreground
 * reconcile in `usePushDismissals.ts` — built on `presentedConversations` below
 * — is the cheap 80% of it.
 */
async function dismissDelivered(
  matches: (data: PushData) => boolean
): Promise<void> {
  try {
    const presented = await Notifications.getPresentedNotificationsAsync();
    await Promise.all(
      presented
        .filter((notification) => matches(pushData(notification)))
        .map((notification) =>
          Notifications.dismissNotificationAsync(notification.request.identifier)
        )
    );
  } catch {
    // See above: an undismissed notification is exactly today's behaviour.
  }
}

/**
 * Drop every delivered notification for these conversations.
 *
 * Matched on the push's own `url` (`/messages/<id>`) rather than a dedicated
 * field, which keeps `conversationIdFromUrl`'s invariant intact: one shape on
 * the wire, with no second conversation field to fall out of step with it.
 */
export function dismissConversationNotifications(
  conversationIds: Iterable<number>
): Promise<void> {
  const wanted = new Set(conversationIds);
  if (!wanted.size) return Promise.resolve();
  return dismissDelivered((data) => {
    const id = conversationIdFromUrl(data.url);
    return id !== null && wanted.has(id);
  });
}

/**
 * Drop every delivered notification that has an **activity-centre row** behind
 * it — i.e. everything the bell counts.
 *
 * For opening the activity centre, which marks all unread *seen*. That screen's
 * whole design is that a notification is kept in-app while its badge signal is
 * cleared, and an OS notification is a badge signal.
 *
 * Message pushes are untouched by construction: they carry `notificationId:
 * null` because messaging sits outside the bell, so reading the activity centre
 * can't clear a message you haven't read.
 */
export function dismissActivityNotifications(): Promise<void> {
  return dismissDelivered((data) => data.notificationId != null);
}

/**
 * Drop every delivered notification aimed at one post, for the post screen —
 * whose GET just marked those notifications seen server-side (viewing is
 * seeing, see notifications.md). An OS notification is a badge signal, so it
 * goes the same way the badge count does.
 *
 * Matched on the push's `url`, like the conversation dismissal above: a post
 * push is `/p/<id>`, with a comment deep-link riding as `?comment=<id>` —
 * still the same post, so the query string is ignored.
 */
export function dismissPostNotifications(postId: number): Promise<void> {
  return dismissDelivered((data) => {
    if (typeof data.url !== 'string') return false;
    const match = data.url.split('?')[0].match(/^\/p\/(\d+)$/);
    return match !== null && Number(match[1]) === postId;
  });
}

/**
 * The event screen's version of `dismissPostNotifications`. The wire shape is
 * the web's nested one (`/g/<gid>/events/<eid>`); only the event id matters —
 * an event's push kinds all point at the same target.
 *
 * **The query is stripped first**, for the reason the post version already
 * gives: since events grew a comment thread, a `comment_reply` or comment
 * `reaction` on one arrives as `…/events/<eid>?comment=<cid>`. That's still the
 * same event, but the anchored regex can't match it — so opening the event
 * would mark the notification seen server-side while the OS notification sat in
 * the tray, which is precisely the split this function exists to prevent.
 */
export function dismissEventNotifications(eventId: number): Promise<void> {
  return dismissDelivered((data) => {
    if (typeof data.url !== 'string') return false;
    const match = data.url.split('?')[0].match(/^\/g\/\d+\/events\/(\d+)$/);
    return match !== null && Number(match[1]) === eventId;
  });
}

/**
 * What's in the tray right now, grouped by conversation: id → the delivered
 * notifications for it.
 *
 * Two things want this rather than a dismissal helper. The foreground reconcile
 * has to ask *"is there anything to clean up?"* before spending a network
 * request finding out what's been read — which, for an empty tray, is every
 * foreground of every session. And it then has to dismiss **exactly what it
 * looked at**: re-reading the tray after the round trip would let a message that
 * arrived *during* it be dismissed on the strength of an `unread_count` fetched
 * before it existed, which is the one way this feature could hide a genuinely
 * unread message.
 */
export async function presentedConversations(): Promise<Map<number, string[]>> {
  const byConversation = new Map<number, string[]>();
  try {
    const presented = await Notifications.getPresentedNotificationsAsync();
    for (const notification of presented) {
      const id = conversationIdFromUrl(pushData(notification).url);
      if (id === null) continue;
      const identifiers = byConversation.get(id) ?? [];
      identifiers.push(notification.request.identifier);
      byConversation.set(id, identifiers);
    }
  } catch {
    // An unreadable tray is treated as an empty one: the caller does nothing,
    // which is what it would have done before this existed.
  }
  return byConversation;
}

/** Dismiss exactly these delivered notifications, by identifier. */
export async function dismissNotifications(
  identifiers: Iterable<string>
): Promise<void> {
  try {
    await Promise.all(
      [...identifiers].map((identifier) =>
        Notifications.dismissNotificationAsync(identifier)
      )
    );
  } catch {
    // Best-effort, as above.
  }
}

/**
 * Dismiss a message push **as it arrives** for the thread already on screen.
 *
 * The handler's `shouldShowList: false` covers this on iOS, where banner and
 * notification-centre entry are independent options. **Android has no such
 * split** — `NotificationBehaviorRecord.shouldPresentAlert` is
 * `shouldShowBanner || shouldShowList`, so anything that banners is also posted
 * to the shade — and the mark-read effect can't be relied on to mop it up:
 * that effect re-runs on the message *count*, and the thread's four-second poll
 * usually adds the message before the push lands. Count unchanged, effect
 * doesn't re-run, and the entry sits in the shade for a message being read as it
 * arrived.
 *
 * So the arrival itself is the trigger. One listener for the app's lifetime,
 * registered at launch beside the handler for the same reason: a push can arrive
 * before anyone signs in. A no-op on iOS, where there's nothing in the tray to
 * dismiss.
 */
export function configureOnScreenDismissal(): void {
  Notifications.addNotificationReceivedListener((notification) => {
    const id = conversationIdFromUrl(pushData(notification).url);
    if (id === null || id !== onScreenConversation) return;
    void dismissNotifications([notification.request.identifier]);
  });
}
