/**
 * The app's one HTTP client. Written fresh for Bearer auth rather than shared
 * with `frontend/src/api.js`, which is cookie + CSRF based — see the repo-layout
 * decision in docs/reference/mobile-app.md.
 *
 * What this file owns:
 *   - attaching `Authorization: Bearer <access>` to every request;
 *   - silently refreshing on a 401 and replaying the request once;
 *   - collapsing parallel refreshes into one (the "stampede" guard below);
 *   - logging the app out when the *server refuses* the refresh token — and,
 *     since #245, only then: a refresh that fails for any other reason keeps the
 *     session, because the server has said nothing about it.
 *
 * It deliberately does NOT do CSRF. CSRF is a cookie-session problem: it exists
 * because a browser attaches cookies to a cross-site request automatically. A
 * Bearer header is never attached automatically, so there is nothing to forge.
 * `JWTCookieAuthentication` on the backend skips the CSRF check entirely when an
 * Authorization header is present (see docs/reference/accounts.md).
 */

import { File } from 'expo-file-system';
import { Platform } from 'react-native';

import {
  clearTokens,
  getAccessToken,
  getCachedAccessToken,
  getRefreshToken,
  saveTokens,
} from './tokens';
import type {
  Comment,
  ConnectionRequest,
  Conversation,
  DisconnectImpact,
  Event,
  Group,
  GroupInvite,
  GroupMember,
  LoginResponse,
  Message,
  Notification,
  NotificationPreferences,
  Paginated,
  PersonSummary,
  Poll,
  PollOptionPayload,
  Post,
  ProfileUser,
  ReactionSummary,
  ReactorGroup,
  RefreshResponse,
  RsvpSummary,
  User,
} from './types';

/**
 * Point at the Phase 7 home server by default.
 *
 * The iOS Simulator can't reach the host's `localhost:8000` the way a desktop
 * browser can, and the app should be tested against the real backend anyway. Set
 * `EXPO_PUBLIC_API_URL` in `mobile/.env` to aim at a local Django when debugging
 * API work. The `EXPO_PUBLIC_` prefix is what makes Expo inline it at build time.
 *
 * Note this value ends up embedded in the shipped bundle — which is fine, it's a
 * public URL, but it's the reason no secret may ever go in an `EXPO_PUBLIC_` var.
 */
// `||` rather than `??` deliberately: a commented-out or blank line in `.env`
// yields an empty string, which `??` would happily accept and turn every
// request into a relative URL that goes nowhere.
export const BASE_URL =
  process.env.EXPO_PUBLIC_API_URL || 'https://your-timeline.net';

/**
 * Messaging poll cadences, named once here exactly as the web keeps them in
 * `frontend/src/api.js`. Near-real-time is deliberately polling, not sockets
 * (see messaging.md) — an open thread refetches fast, the conversation list and
 * the unread badge slower, since a new message isn't more urgent in a list than
 * it is in a bell.
 *
 * TanStack Query's `refetchInterval` pauses while the app is backgrounded,
 * because `_layout.tsx` wires `focusManager` to `AppState` — so these don't drain
 * the battery when the phone's in a pocket.
 */
export const MESSAGE_POLL_MS = 4000;
export const CONVERSATION_LIST_POLL_MS = 12000;
/**
 * The open thread's *detail* — the payload carrying the participants, and with
 * them the read receipts (Phase 9b M4). It has to be polled, not just fetched on
 * mount: `last_read_at` taken at mount is by construction older than any message
 * you send afterwards, so without this the second tick could never appear while
 * you were watching for it — only after leaving the thread and coming back.
 *
 * Slower than `MESSAGE_POLL_MS` on purpose. The detail endpoint costs several
 * per-conversation queries (unread count, the last visible message, the two
 * receipt lookups) where the message poll is one cheap page, and a tick landing
 * within ~12s reads as prompt. A message arriving 12s late would not.
 */
export const CONVERSATION_DETAIL_POLL_MS = 12000;

/**
 * The activity-centre bell badge polls the cheap unread-count endpoint on the
 * same slow cadence as the conversation list — a notification isn't more urgent
 * in a bell than a message is in a tab badge, and this mirrors the web's
 * `NOTIFICATIONS_POLL_MS`. Like the others, it pauses when backgrounded.
 */
export const NOTIFICATIONS_POLL_MS = 12000;

/**
 * How long after sending a message you can still correct it (Phase 9b M1).
 *
 * **The server is the authority** — `MESSAGE_EDIT_WINDOW` in `api/views.py` — and
 * it 403s a late PATCH regardless of what the client believes. This copy exists
 * only so the menu can *hide* an Edit item that would fail, which is much better
 * than offering an action that errors. The two can drift by a clock skew's worth
 * without harm: the worst case is an Edit item that 403s and shows its message.
 */
export const MESSAGE_EDIT_WINDOW_MS = 15 * 60 * 1000;

/**
 * A photo chosen from the library, ready to upload. The picker hands us the
 * file's location, its (best-effort) filename, and its MIME type.
 */
export type PhotoUpload = {
  uri: string;
  name: string;
  type: string;
};

/**
 * A chat photo ready to upload — what `prepareChatPhoto` returns (Phase 9b M7).
 *
 * Declared structurally here rather than imported from `@/chatPhotos` so this
 * module stays free of the image pipeline (and its native dependency): `api.ts`
 * is imported by every test in the app, including ones that have no business
 * loading `expo-image-manipulator`.
 */
export type PreparedChatPhoto = {
  photo: PhotoUpload;
  thumbnail: PhotoUpload;
  width: number;
  height: number;
};

/**
 * A multipart file part the winter fetch runtime will actually serialise:
 * raw bytes behind a `.bytes()` method, plus a filename and content-type.
 */
type FilePart = { bytes: () => Uint8Array; name: string; type: string };

/**
 * Turn a picked file into an uploadable multipart part.
 *
 * **Two dead ends this had to route around**, both from Expo SDK 54+ replacing
 * the global `fetch` with its "winter" runtime:
 *
 *   1. The old React Native `{uri, name, type}` part throws `Unsupported
 *      FormDataPart implementation` — the winter FormData serializer doesn't
 *      handle it (asserted in expo's own `convertFormData` test).
 *   2. A real `Blob` is one shape it *does* accept — but React Native's `Blob`
 *      can't be constructed from an `ArrayBuffer` ("Creating blobs from
 *      'ArrayBuffer' … are not supported"), so `new Blob([bytes])` is out too.
 *
 * The serializer's other accepted shape is an object exposing `.bytes()` (its
 * "FileBlob" case). So we read the file's bytes with expo-file-system's `File`
 * (`arrayBuffer()` is a native read, not a Blob build — bundled in Expo Go, no
 * dev build needed) and hand back that shape. `name`/`type` become the multipart
 * filename and content-type.
 *
 * This reads the whole file into memory. Fine for avatars and phone photos;
 * revisit only if we ever allow large attachments.
 */
async function toFilePart(upload: PhotoUpload): Promise<FilePart> {
  const buffer = await new File(upload.uri).arrayBuffer();
  const bytes = new Uint8Array(buffer);
  return { bytes: () => bytes, name: upload.name, type: upload.type };
}

export class ApiError extends Error {
  status: number;
  data: unknown;
  /**
   * The message is one the *server* wrote for a person (DRF's `detail`), rather
   * than one we synthesized because it sent nothing showable. Only the first
   * kind is fit to put in front of a user — see `serverMessage` below. Defaults
   * true because the point of hand-writing one is to give a person a sentence.
   */
  fromServer: boolean;

  /**
   * `options` is passed through to `Error` so a network failure can keep the
   * original `TypeError` as its `cause` — unreadable to a user, but the only
   * thing that says *why* the connection died when debugging.
   */
  constructor(
    message: string,
    status: number,
    data: unknown,
    fromServer = true,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
    this.fromServer = fromServer;
  }
}

/**
 * What we say when the request never reached the server, in our words rather
 * than React Native's `Network request failed` — which names no cause and
 * suggests no action. Paired with `status: 0`, since no response ever arrived
 * and there is no HTTP status to report.
 */
const NETWORK_ERROR_MESSAGE =
  'Couldn’t reach the server — check your connection and try again.';

/**
 * What we say when the server answered but couldn't do the job — a 5xx from the
 * refresh endpoint, which is the box redeploying or Django down behind Caddy.
 * Deliberately not "your session has expired": it hasn't, and until #243 lands
 * ~25 call sites render `.message` whatever `fromServer` says, so a wrong
 * sentence here is a wrong sentence on a real screen.
 */
const SERVER_ERROR_MESSAGE =
  'Something went wrong on the server — please try again in a moment.';

/**
 * A rejection worth showing a person, or the caller's own sentence.
 *
 * Two common failures carry no readable words. A network-level failure never
 * becomes an `ApiError` at all — React Native rejects with
 * `TypeError: Network request failed`, and offline is the likeliest way any
 * write fails. And a server error with no DRF body (a 500 rendered as an HTML
 * page) leaves `firstErrorMessage` nothing to pull out, so `request` synthesizes
 * "Request failed (500)" — which has a status and a message, and would sail
 * through a bare `instanceof ApiError` check straight onto the screen.
 *
 * Mirrors `frontend/src/errors.js`.
 */
export function serverMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError && err.fromServer ? err.message : fallback;
}

/**
 * DRF returns validation errors as `{ field: ["msg", ...] }` or
 * `{ detail: "msg" }` / `{ non_field_errors: [...] }`. Pull out something
 * showable. Mirrors the web app's helper of the same name.
 */
function firstErrorMessage(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const record = data as Record<string, unknown>;
  if (typeof record.detail === 'string') return record.detail;
  const firstKey = Object.keys(record)[0];
  if (!firstKey) return null;
  const value = record[firstKey];
  return Array.isArray(value) ? String(value[0]) : String(value);
}

/**
 * Called when the session is unrecoverable — refresh failed or there was no
 * refresh token. `AuthProvider` registers a handler that drops the user back to
 * the login screen.
 *
 * A callback rather than an import of the router keeps this module free of React
 * and navigation, which is what makes it testable in plain Jest.
 */
type SessionExpiredHandler = () => void;
let onSessionExpired: SessionExpiredHandler = () => {};

export function setSessionExpiredHandler(handler: SessionExpiredHandler): void {
  onSessionExpired = handler;
}

/**
 * The in-flight refresh, if one is running.
 *
 * **Why this exists (the refresh stampede).** A screen typically fires several
 * requests at once — feed, unread count, profile. When the access token expires
 * they all 401 at roughly the same moment. Without this, each would kick off its
 * own refresh; because the backend has `ROTATE_REFRESH_TOKENS` *and*
 * `BLACKLIST_AFTER_ROTATION` on, the first refresh invalidates the token the
 * other four are still holding, so four of the five fail and the user is logged
 * out at random. Sharing one promise means one rotation, and everyone waits for
 * it.
 */
let refreshInFlight: Promise<string> | null = null;

async function refreshAccessToken(): Promise<string> {
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    const refresh = await getRefreshToken();
    if (!refresh) throw new ApiError('No refresh token', 401, null);

    // Serialized *before* the guard below, the lesson #244 encodes on the web:
    // `JSON.stringify` throws on a body we built wrong, and that's a bug in our
    // code rather than a connectivity problem. Inside the `try` it would be
    // caught and dressed up as a lost connection, sending someone to check their
    // signal over a mistake here.
    const payload = JSON.stringify({ refresh });

    // Guarded, because the caller cannot tell these apart otherwise and the
    // consequence of guessing wrong is a destroyed session (#245). A
    // network-level failure rejects out of `fetch` itself as a bare `TypeError`
    // — and a phone's connection working for one request and failing for the
    // next is the ordinary condition of a mobile network, not an exotic one.
    // Re-raised in the same shape every other rejection has, with `status: 0`
    // so `isTokenRejection` below reads it as "we never asked" rather than "the
    // server said no".
    let response;
    try {
      response = await fetch(`${BASE_URL}/api/auth/mobile/refresh/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
      });
    } catch (err) {
      throw new ApiError(NETWORK_ERROR_MESSAGE, 0, null, false, { cause: err });
    }

    if (!response.ok) {
      // The status travels because it's the whole basis on which the caller
      // decides whether the session is over: a 400/401 is the server refusing
      // this token, while a 502 while the box redeploys is not.
      //
      // Which is also why the two get different sentences. A refusal's message
      // is never seen — `request` replaces it with the one written for a dead
      // session — but a 5xx now *propagates* to whatever screen made the call,
      // and "Session expired" would be a lie told to everyone at once during a
      // deploy. `fromServer` is false on both because neither is the server's
      // own words, so `serverMessage` prefers the call site's.
      throw new ApiError(
        isRefusalStatus(response.status) ? 'Session expired' : SERVER_ERROR_MESSAGE,
        response.status,
        null,
        false
      );
    }

    // Rotation: the response carries a *new* refresh token and the old one is
    // now blacklisted, so both must be stored — keeping the old one would log
    // the user out at the next refresh.
    //
    // A 200 whose body isn't that pair didn't come from our server: a captive
    // portal intercepting the request answers with its own login page, and
    // that's a connection problem wearing a success status. Left alone the
    // `.json()` would throw a `SyntaxError`, which is indistinguishable from a
    // refused token at the catch below — the same sign-out by a different door.
    const pair = (await response.json().catch(() => null)) as RefreshResponse | null;
    if (!pair?.access || !pair?.refresh) {
      throw new ApiError(NETWORK_ERROR_MESSAGE, 0, null, false);
    }
    await saveTokens({ access: pair.access, refresh: pair.refresh });
    return pair.access;
  })();

  try {
    return await refreshInFlight;
  } finally {
    // Clear unconditionally, success or failure, so a failed refresh doesn't
    // wedge every future request behind a permanently rejected promise.
    refreshInFlight = null;
  }
}

/**
 * The two answers the refresh endpoint gives when it has refused the token.
 *
 * simplejwt's `TokenRefreshView` answers a token that is expired, rotated away
 * or blacklisted with a **401**, and a malformed request body with a **400**;
 * either way the token on this device is dead and there is nothing left to keep.
 * Every other status — a 502 while the box redeploys, a 503 — says nothing at
 * all about the token.
 */
function isRefusalStatus(status: number): boolean {
  return status === 401 || status === 400;
}

/**
 * Did the *server* refuse the refresh token, as opposed to us never managing to
 * ask it?
 *
 * Only the first ends a session. `status: 0` is the shape a request that never
 * landed is re-raised in, so it falls on the "we never asked" side along with
 * every server-side wobble, and the tokens stay put.
 */
function isTokenRejection(err: unknown): boolean {
  return err instanceof ApiError && isRefusalStatus(err.status);
}

type RequestOptions = {
  method?: string;
  body?: unknown;
  /** Internal: false on the replay, so a request can only be retried once. */
  retry?: boolean;
};

async function request<T>(
  path: string,
  { method = 'GET', body, retry = true }: RequestOptions = {}
): Promise<T> {
  // A FormData body means a file upload (post photos, avatar). Let the runtime
  // set the multipart Content-Type with its boundary — setting it ourselves
  // would omit the boundary and the server couldn't parse the parts.
  const isFormData = typeof FormData !== 'undefined' && body instanceof FormData;

  const headers: Record<string, string> = {};
  if (body !== undefined && !isFormData) {
    headers['Content-Type'] = 'application/json';
  }
  // Prefer the in-memory copy and only fall back to the Keychain when there
  // isn't one. `saveTokens` / `clearTokens` are the only writers and both update
  // the cache synchronously, so the two can't disagree — but a Keychain read is
  // an async native round-trip, and doing one before *every* request puts it on
  // the critical path of the whole app. The fallback still covers the cold-start
  // window before `AuthProvider` has primed the cache.
  const access = getCachedAccessToken() ?? (await getAccessToken());
  if (access) headers.Authorization = `Bearer ${access}`;

  const response = await fetch(BASE_URL + path, {
    method,
    headers,
    body:
      body === undefined
        ? undefined
        : isFormData
          ? (body as FormData)
          : JSON.stringify(body),
  });

  // A 401 on an authenticated request means the access token has expired. Get a
  // fresh one and replay exactly once — `retry: false` on the replay is what
  // stops a server that 401s unconditionally from looping forever.
  if (response.status === 401 && retry && access) {
    try {
      await refreshAccessToken();
    } catch (err) {
      if (!isTokenRejection(err)) {
        // We never got an answer — the request didn't land, or the server is
        // having a bad minute. It has said nothing about this token, so we
        // destroy nothing: the refresh token is very likely still valid, and
        // wiping it costs the user a password to type back in for what a
        // dropped packet did (#245). Reject as the network failure it is; the
        // next request, once there's signal, refreshes and carries on.
        throw err;
      }
      // The server refused the token — a 401 (expired, rotated away or
      // blacklisted) or a 400 (a body it couldn't read). Nothing left to try:
      // drop the session and send the user to login rather than leaving the app
      // in a half-authenticated state.
      await clearTokens();
      onSessionExpired();
      throw new ApiError('Your session has expired. Please log in again.', 401, null);
    }
    return request<T>(path, { method, body, retry: false });
  }

  // 204 No Content (and empty bodies) have nothing to parse.
  let data: unknown = null;
  const text = await response.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!response.ok) {
    // A body that isn't DRF's error JSON leaves nothing a person can read, so
    // the synthesized stand-in is flagged as *not* the server's own words.
    const authored = firstErrorMessage(data);
    throw new ApiError(
      authored ?? `Request failed (${response.status})`,
      response.status,
      data,
      authored !== null
    );
  }
  return data as T;
}

/** Exactly one of these names the thing being reacted to. */
export type ReactionTarget = {
  postId?: number;
  commentId?: number;
  messageId?: number;
  eventId?: number;
};

/**
 * Which thread a comment belongs to — a post's or an event's.
 *
 * Both ids are optional for the same reason `ReactionTarget`'s are: the screens
 * holding them carry them that way, so "neither was passed" is reachable.
 */
export type CommentTarget = {
  postId?: number | string;
  eventId?: number | string;
  /** Carried along so a write can refresh the group's views of the event. */
  groupId?: number | string;
};

/**
 * The URL for a reaction action on whichever target was named.
 *
 * Every id is optional at the type level because the components holding them
 * carry them that way, so "none was passed" is reachable. Left alone it
 * builds `/api/comments/undefined/react/`, which 404s and surfaces to the user
 * as a mystery "Couldn't react" — so it fails loudly here instead.
 */
function reactionPath(
  { postId, commentId, messageId, eventId }: ReactionTarget,
  action: 'react' | 'reactions'
): string {
  if (postId != null) return `/api/posts/${postId}/${action}/`;
  if (commentId != null) return `/api/comments/${commentId}/${action}/`;
  if (messageId != null) return `/api/messages/${messageId}/${action}/`;
  if (eventId != null) return `/api/events/${eventId}/${action}/`;
  throw new Error(
    'reactionPath needs a postId, commentId, messageId or eventId'
  );
}

/**
 * The comment-thread URL for whichever target was named. Same reasoning as
 * `reactionPath`, and the same loud failure: left alone a target-less call
 * builds `/api/posts/undefined/comments/`, which 404s and reads as a mystery
 * "couldn't load comments". Mirrors `commentsPath` in `frontend/src/api.js`.
 */
function commentsPath({ postId, eventId }: CommentTarget): string {
  if (postId != null) return `/api/posts/${postId}/comments/`;
  if (eventId != null) return `/api/events/${eventId}/comments/`;
  throw new Error('commentsPath needs a postId or an eventId');
}

export const api = {
  ApiError,

  /** "Who am I" — resolves to the user, or throws 401 when logged out. */
  getCurrentUser: () => request<User>('/api/auth/user/'),

  /**
   * Update your own profile — real name, bio, avatar — via dj-rest-auth's user
   * endpoint (the same `PATCH /api/auth/user/` the web app uses).
   *
   * Multipart because it can carry an avatar file, and PATCH not PUT so an
   * unsent field is left untouched rather than blanked — we only append the
   * fields the form actually holds.
   *
   * `avatar` is a picked-and-cropped photo (`{uri,name,type}`, the RN FormData
   * file shape — a browser `Blob` would silently upload nothing, same trap as
   * `createPost`). `removeAvatar: true` clears an existing avatar; the two are
   * mutually exclusive and the caller must never send both.
   *
   * Returns the refreshed `User`, which is also what `refreshUser()` in
   * `auth.tsx` reads back to repaint the nav avatar/name everywhere.
   */
  updateProfile: async ({
    first_name,
    last_name,
    bio,
    avatar,
    removeAvatar,
  }: {
    first_name?: string;
    last_name?: string;
    bio?: string;
    avatar?: PhotoUpload;
    removeAvatar?: boolean;
  }) => {
    const form = new FormData();
    if (first_name !== undefined) form.append('first_name', first_name);
    if (last_name !== undefined) form.append('last_name', last_name);
    if (bio !== undefined) form.append('bio', bio);
    if (avatar) {
      form.append('avatar', (await toFilePart(avatar)) as unknown as Blob);
    }
    if (removeAvatar) form.append('remove_avatar', 'true');
    return request<User>('/api/auth/user/', { method: 'PATCH', body: form });
  },

  /**
   * Turn read receipts on or off (Phase 9b M4).
   *
   * Its own call rather than a field on `updateProfile`, because that one is
   * multipart (it can carry an avatar) and a boolean over multipart is a string
   * the server then has to un-guess. Same endpoint, JSON body — PATCH, so
   * nothing else on the profile is touched.
   *
   * The switch is **symmetric and enforced server-side**: with it off your read
   * marker is withheld from everyone else's payload and theirs from yours. So
   * flipping it changes what the conversation-detail endpoint *sends*, which is
   * why the caller has to invalidate open conversation queries rather than
   * hiding ticks locally.
   */
  setReadReceipts: (enabled: boolean) =>
    request<User>('/api/auth/user/', {
      method: 'PATCH',
      body: { send_read_receipts: enabled },
    }),

  /**
   * A single person's public profile by numeric id — the header for `/u/[id]`.
   *
   * Returns `connection_status` and `is_blocked` relative to you, so the screen
   * can decide whether their posts are visible. Like the feed, a profile you
   * genuinely can't see still returns its header (the wall is on the *posts*,
   * which come back empty) — the id itself isn't a secret, a real person is.
   */
  getUser: (userId: number | string) =>
    request<ProfileUser>(`/api/users/${userId}/`),

  /**
   * One person's own posts, newest-first — the body of their profile.
   *
   * **Private by default:** unless it's you or a connection, the backend returns
   * an empty page, and the screen shows a locked state rather than their posts.
   * Paginated like every list here, so the profile pages with the same
   * `getPage` contract the feed uses.
   */
  getUserPosts: (userId: number | string) =>
    request<Paginated<Post>>(`/api/users/${userId}/posts/`),

  /**
   * The People hub's two directories, one endpoint narrowed by a filter:
   *   - `listConnections` — people you're already accepted-connected with.
   *   - `listDiscover` — everyone you're *not* yet connected with (so existing
   *     connections don't clutter "find new people"). Pending/incoming requests
   *     still appear here, so you can act on them.
   * Both paginate like every list, so the screen follows `next` with `getPage`.
   */
  listConnections: () =>
    request<Paginated<PersonSummary>>('/api/users/?filter=connected'),
  listDiscover: () =>
    request<Paginated<PersonSummary>>('/api/users/?filter=discover'),

  /**
   * Send a connection request **or** accept an incoming one — the backend
   * decides. Accounts are private, so this creates a *pending* request that
   * grants nothing until the other person approves; the one exception is when
   * they've already requested you, in which case this accepts that existing row
   * (a mutual intent, not a competing second request). See connections.md.
   */
  connect: (userId: number | string) =>
    request<void>(`/api/users/${userId}/connect/`, { method: 'POST' }),

  /**
   * Cancel a pending request or end an accepted connection — same endpoint,
   * same DELETE. Disconnecting is symmetric: it severs the single shared row, so
   * neither of you sees the other's posts afterwards.
   */
  disconnect: (userId: number | string) =>
    request<void>(`/api/users/${userId}/connect/`, { method: 'DELETE' }),

  /**
   * The shared group chats a disconnect/block would drop you out of, so the
   * warning modal can name them before you confirm. Read as a plain check, not a
   * mutation — it changes nothing.
   */
  getDisconnectImpact: (userId: number | string) =>
    request<DisconnectImpact>(`/api/users/${userId}/disconnect-impact/`),

  /* ---- Safety: block + report (Phase 9 E4a) ------------------------------ *
   * The App-Review-critical controls. Pure client port — block has existed since
   * Phase 5, report since Phase 7 (see accounts.md); no backend change. */

  /**
   * Block (POST) or unblock (DELETE) a person. Blocking is the strong, explicit
   * cut: it severs any connection, stops messaging both ways, hides your
   * conversation from both of you, and bars re-connecting — so the caller confirms
   * first via `DisconnectWarningModal` (which also names shared group chats you'd
   * be dropped from). Unblocking undoes none of that damage, so it needs no
   * warning. The block is directional but enforced both ways; unblock lifts only
   * your own.
   */
  blockUser: (userId: number | string) =>
    request<void>(`/api/users/${userId}/block/`, { method: 'POST' }),
  unblockUser: (userId: number | string) =>
    request<void>(`/api/users/${userId}/block/`, { method: 'DELETE' }),

  /**
   * Flag a post, comment or message for the maintainer to review (the
   * content-takedown path). Pass exactly one of `postId` / `commentId` /
   * `messageId`, plus an optional reason. Idempotent server-side: a repeat flag
   * returns your existing report rather than stacking duplicates. You can only
   * report content you can see (a non-visible target 404s, same wall as the feed
   * — for a message, the interval-clipped thread gate).
   *
   * **A message report is the only route by which message text reaches the
   * maintainer** (Phase 9b M0 removed the admin's conversation message inline),
   * so the report stores a server-written snapshot of the text — soft-deleting the
   * message afterwards doesn't erase the evidence. A message that's *already*
   * deleted can't be reported (400): there's nothing left to moderate.
   */
  reportContent: ({
    postId,
    commentId,
    messageId,
    reason = '',
  }: {
    postId?: number;
    commentId?: number;
    messageId?: number;
    reason?: string;
  }) =>
    request<{ id: number }>('/api/reports/', {
      method: 'POST',
      body: {
        ...(postId != null ? { post: postId } : {}),
        ...(commentId != null ? { comment: commentId } : {}),
        ...(messageId != null ? { message: messageId } : {}),
        reason,
      },
    }),

  /* ---- Messaging (Phase 9 E2) -------------------------------------------- *
   * Direct + group chats share these endpoints, and a `Conversation` serves both
   * the list row and the thread detail — see messaging.md, which owns the data
   * model, the clique/safety gate, and the interval-clipped history. This is a
   * pure client port: no backend change. E2a (this PR) reads and uses existing
   * conversations; E2b adds create/add-people (`createGroupChat`,
   * `addParticipants`). */

  /**
   * Your conversations, most-recent-activity first, each with a last-message
   * preview and your per-thread `unread_count`. Paginated like every list.
   * Polled on the slow cadence (`CONVERSATION_LIST_POLL_MS`).
   */
  getConversations: () =>
    request<Paginated<Conversation>>('/api/conversations/'),

  /**
   * A single conversation's detail — the other person / participants, your
   * `my_status`, and `can_send`. This exists **separately from the messages
   * endpoint** because the thread header needs the other participant on a cold
   * load, which the message list doesn't carry (see messaging.md).
   */
  getConversation: (conversationId: number | string) =>
    request<Conversation>(`/api/conversations/${conversationId}/`),

  /**
   * A thread's messages, **newest-first** and paginated, **clipped to your
   * participation intervals** server-side (a member who left and returned never
   * sees the gap). 403s while you're a pending member — the thread renders the
   * locked panel instead of calling this.
   *
   * `?order=desc` is what makes the thread openable in one request (Phase 9b
   * M5). The endpoint's default is oldest-first, which puts the newest messages
   * on the *last* page — so the screen used to walk every page on open just to
   * reach the bottom of the chat. Now page one is the screenful you're looking
   * at and `next` pages *backwards* into history as you scroll up, which is also
   * the order an inverted `FlatList` wants its data in.
   *
   * The web drawer still reads the default order; the parameter is opt-in
   * precisely so an old client never meets a reordered payload.
   */
  getMessages: (conversationId: number | string) =>
    request<Paginated<Message>>(
      `/api/conversations/${conversationId}/messages/?order=desc`
    ),

  /**
   * One reply thread — a root message and every reply hanging off it (Phase 9b
   * M3). What the focused thread view loads.
   *
   * It's the *same* endpoint as `getMessages` with a filter, not a route of its
   * own, and that's deliberate on the server side: one queryset means a thread
   * can never show a message the transcript wouldn't. So a viewer who was
   * clipped out of the root gets the replies they can see and no head, and the
   * view renders that honestly rather than pretending the thread is broken.
   *
   * Being that same endpoint, it **paginates like every list** — this is the
   * first page (oldest-first), and the caller follows `next` with `getPage`.
   * Reading only what this returns would cut a strand off at its oldest 20.
   */
  getThread: (conversationId: number | string, rootId: number) =>
    request<Paginated<Message>>(
      `/api/conversations/${conversationId}/messages/?thread_root=${rootId}`
    ),

  /**
   * Send a message. The sender is the authenticated user, never the body — you
   * can't post as someone else. Active participants only (the composer keys off
   * `can_send`, and the backend enforces the same gate).
   *
   * `replyToId` makes it a reply (Phase 9b M3). The server validates it against
   * *your* visible messages, so an id from another thread or from inside a gap
   * in your membership is rejected exactly like one that doesn't exist. Replies
   * are one level deep: replying to a reply joins that thread rather than
   * nesting, which the server derives — the client never has to work out a root.
   */
  sendMessage: async (
    conversationId: number | string,
    text: string,
    replyToId?: number | null,
    /**
     * A photo to send with it (Phase 9b M7), already resized, stripped and
     * re-encoded by `prepareChatPhoto`. Switches the request to multipart.
     *
     * 🔒 Send only what came out of that helper. The server does **not** open
     * the file — it can't, because this same path has to work when it's handed
     * ciphertext — so the EXIF stripping this app does is the *only* stripping
     * that happens. Uploading a raw camera-roll URI here would ship the photo's
     * GPS coordinates to everyone in the chat.
     */
    photo?: PreparedChatPhoto,
    /**
     * Who the message names with `@` (Phase 9b M8), as user ids.
     *
     * Sent as ids rather than left for the server to find in the text: names
     * change, two people can share one, and under E2E there is no text for the
     * server to read. It's what decides whether a *muted* thread still buzzes
     * the person named, so the server checks every id is an active participant
     * — an id from outside the room is refused, not ignored.
     */
    mentionIds?: number[]
  ) => {
    const path = `/api/conversations/${conversationId}/messages/`;
    if (!photo) {
      return request<Message>(path, {
        method: 'POST',
        body: {
          text,
          ...(replyToId ? { reply_to_id: replyToId } : {}),
          ...(mentionIds?.length ? { mention_ids: mentionIds } : {}),
        },
      });
    }
    const form = new FormData();
    // Blank is legal *with* a photo and only then — a photo with no caption is
    // an ordinary thing to send, an empty message is not. The server enforces
    // the same rule; this just doesn't get in its way.
    form.append('text', text);
    if (replyToId) form.append('reply_to_id', String(replyToId));
    // One part per id — how a multipart body carries a list, and what DRF's
    // ListField reads back. A single `mention_ids` part holding "1,2" would
    // arrive as one unparseable value.
    mentionIds?.forEach((userId) => form.append('mention_ids', String(userId)));
    // Parallel lists, one entry each. Plural because the server accepts a list
    // (capped at one for now), so allowing several photos per message later is
    // a server constant rather than a wire change.
    form.append('attachments', (await toFilePart(photo.photo)) as unknown as Blob);
    form.append(
      'attachment_thumbnails',
      (await toFilePart(photo.thumbnail)) as unknown as Blob
    );
    form.append('attachment_widths', String(photo.width));
    form.append('attachment_heights', String(photo.height));
    return request<Message>(path, { method: 'POST', body: form });
  },

  /**
   * Every photo in this chat, newest first (Phase 9b M7) — the media gallery on
   * the thread info screen.
   *
   * Another filter on the messages endpoint rather than a route of its own, for
   * the third time and the same reason as `thread_root` and `ids`: the gallery
   * must not be able to show a photo the transcript wouldn't, and the surest
   * way to guarantee that is for both to be the same interval-clipped queryset.
   * Paginates like every list; the caller follows `next` with `getPage`.
   */
  getConversationMedia: (conversationId: number | string) =>
    request<Paginated<Message>>(
      `/api/conversations/${conversationId}/messages/?media=1&order=desc`
    ),

  /**
   * Correct your *own* message (Phase 9b M1) — the beta's first real complaint
   * was that a typo was permanent.
   *
   * Sender-only, and only within the server's 15-minute window (403 after that:
   * a thread is a shared record, so you can fix "teh", not rewrite what someone
   * read and replied to yesterday). A deleted message can't be edited (400).
   *
   * Deliberately does **not** bump the conversation's activity time — fixing a
   * typo shouldn't jump the thread to the top of everyone's list — so the
   * conversation list doesn't need reordering, only the preview text refreshed.
   */
  editMessage: (
    conversationId: number | string,
    messageId: number | string,
    text: string
  ) =>
    request<Message>(
      `/api/conversations/${conversationId}/messages/${messageId}/`,
      { method: 'PATCH', body: { text } }
    ),

  /**
   * Soft-delete your *own* message — it becomes a "message deleted" tombstone
   * that keeps its place in the thread (so nothing reshuffles and pagination
   * isn't disturbed), rather than vanishing. Deleted messages don't count toward
   * unread.
   */
  deleteMessage: (
    conversationId: number | string,
    messageId: number | string
  ) =>
    request<void>(
      `/api/conversations/${conversationId}/messages/${messageId}/`,
      { method: 'DELETE' }
    ),

  /**
   * Mark the conversation read up to now, clearing its unread count. Called on
   * open and as new messages land — the thread-level equivalent of stamping a
   * post thread "seen".
   */
  markConversationRead: (conversationId: number | string) =>
    request<void>(`/api/conversations/${conversationId}/read/`, {
      method: 'POST',
    }),

  /**
   * Put the badge back on a thread you've read (Phase 9b M6) — for the people
   * who use it as a to-do list.
   *
   * The server moves your read marker to just behind the newest message you
   * didn't send, rather than dropping it: with no marker the *whole history*
   * counts as unread, so a chat you'd read to the end would come back wearing
   * "99+". It comes back as one, which is what "waiting for you" means here.
   *
   * It aims at the newest **visible, incoming, undeleted** message *anywhere*
   * in the thread, not at the last one — so a chat you replied to marks unread
   * fine, landing past your own trailing messages. 400 only when there's
   * genuinely nothing to aim at: an empty thread, or one where every visible
   * message is yours or a tombstone. The list's swipe gate is narrower than
   * that (see `leadingActions`) because a row carries only `last_message` and
   * can't tell the two apart.
   *
   * 🔒 **It also retracts your read receipt** for that message, since ticks and
   * unread counts are the same marker — see messaging.md.
   */
  markConversationUnread: (conversationId: number | string) =>
    request<{ unread_count: number }>(
      `/api/conversations/${conversationId}/read/`,
      { method: 'DELETE' }
    ),

  /**
   * Rename a group chat (Phase 9b M6). Until now a title could only be set when
   * the chat was created, so "Weekend plans" outlived the weekend.
   *
   * Any *active* member may — chats have no admin role, and inventing one for a
   * text field would be the wrong place to start. Group chats only (400 on a
   * 1:1, whose name is the other person). Blank clears it, and both clients
   * then fall back to the members' names, which beats a stale title.
   *
   * It deliberately doesn't bump the thread's activity time, so renaming
   * doesn't jump it to the top of everyone's list — same rule as an edit.
   */
  renameConversation: (conversationId: number | string, title: string) =>
    request<Conversation>(`/api/conversations/${conversationId}/`, {
      method: 'PATCH',
      body: { title },
    }),

  /**
   * Total unread messages across all conversations — one number for the Messages
   * tab badge, so it doesn't have to load and sum the paginated list. Polled on
   * the same slow cadence as the list.
   */
  getUnreadMessageCount: () =>
    request<{ count: number }>('/api/messages/unread-count/'),

  /**
   * Get-or-create the 1:1 conversation with a connected person — idempotent, so
   * the Message button on a profile can call it blind and land on the existing
   * thread if there is one. Returns the `Conversation`; the caller pushes its
   * thread. Backend gates it to people you're connected with.
   */
  openConversation: (userId: number | string) =>
    request<Conversation>('/api/conversations/', {
      method: 'POST',
      body: { user_id: userId },
    }),

  /**
   * Mute or unmute this thread's push notifications for you (issue #118).
   * Per-participant, so it never silences the chat for anyone else, and it
   * stops the buzz only — the thread keeps its unread badge either way.
   * Returns the resulting state, so the caller can render from the response.
   */
  setConversationMuted: (conversationId: number | string, muted: boolean) =>
    request<{ muted: boolean }>(`/api/conversations/${conversationId}/mute/`, {
      method: muted ? 'POST' : 'DELETE',
    }),

  /**
   * Leave a chat, or — while pending — decline the invite. Works from either
   * status (see messaging.md); closes your interval and triggers a promote
   * re-eval for everyone else. The thread routes back to the list on success.
   */
  leaveConversation: (conversationId: number | string) =>
    request<void>(`/api/conversations/${conversationId}/leave/`, {
      method: 'POST',
    }),

  /**
   * Create a multi-person chat (Phase 9 E2b). `participantIds` are your
   * connections — a non-connection is rejected server-side (the clique gate). An
   * optional `title`; `groupId` scopes the chat to a Phase 6 group (every
   * invitee must be a member) — the group-scoped launch is E3, so E2b's picker
   * always passes it null. Returns the new `Conversation`; the caller opens its
   * thread.
   */
  createGroupChat: ({
    participantIds,
    title = '',
    groupId = null,
  }: {
    participantIds: number[];
    title?: string;
    groupId?: number | null;
  }) =>
    request<Conversation>('/api/conversations/', {
      method: 'POST',
      body: {
        participant_ids: participantIds,
        title,
        ...(groupId ? { group_id: groupId } : {}),
      },
    }),

  /**
   * Add more of your connections to an existing chat — any active member may add
   * one of *their own* connections (see messaging.md's add-gate). Each new person
   * lands `pending` and is promoted the instant they're connected to the whole
   * active clique.
   */
  addParticipants: (conversationId: number | string, userIds: number[]) =>
    request<void>(`/api/conversations/${conversationId}/participants/`, {
      method: 'POST',
      body: { user_ids: userIds },
    }),

  /* ---- Groups (Phase 9 E3a) ---------------------------------------------- *
   * Private, invite-only shared timelines. groups.md owns the two gates
   * (membership gates access; connection gates whose posts you see inside),
   * the roles model, and the endpoints. Client port; no backend change. */

  /** Groups you're an active member of (name, avatar, member_count, your_role). */
  getGroups: () => request<Paginated<Group>>('/api/groups/'),

  /** One group's detail — members only, 404 otherwise. */
  getGroup: (groupId: number | string) =>
    request<Group>(`/api/groups/${groupId}/`),

  /**
   * Create a group — multipart so it can carry an optional avatar (name +
   * description ride as fields). You become its first member, an admin.
   */
  createGroup: async ({
    name,
    description = '',
    avatar,
  }: {
    name: string;
    description?: string;
    avatar?: PhotoUpload;
  }) => {
    const form = new FormData();
    form.append('name', name);
    form.append('description', description);
    if (avatar) form.append('avatar', (await toFilePart(avatar)) as unknown as Blob);
    return request<Group>('/api/groups/', { method: 'POST', body: form });
  },

  /**
   * Edit a group (admins only) — multipart, like the profile edit. PATCH, so an
   * unsent field is left untouched. `removeAvatar` clears an existing avatar; it
   * and `avatar` are mutually exclusive.
   */
  updateGroup: async (
    groupId: number | string,
    {
      name,
      description,
      avatar,
      removeAvatar,
    }: {
      name?: string;
      description?: string;
      avatar?: PhotoUpload;
      removeAvatar?: boolean;
    }
  ) => {
    const form = new FormData();
    if (name !== undefined) form.append('name', name);
    if (description !== undefined) form.append('description', description);
    if (avatar) form.append('avatar', (await toFilePart(avatar)) as unknown as Blob);
    if (removeAvatar) form.append('remove_avatar', 'true');
    return request<Group>(`/api/groups/${groupId}/`, {
      method: 'PATCH',
      body: form,
    });
  },

  /** Delete a group (admin) — cascades to memberships, posts, photos, comments. */
  deleteGroup: (groupId: number | string) =>
    request<void>(`/api/groups/${groupId}/`, { method: 'DELETE' }),

  /** A group's timeline — newest-first, paginated, connection-pruned (members only). */
  getGroupPosts: (groupId: number | string) =>
    request<Paginated<Post>>(`/api/groups/${groupId}/posts/`),

  /** A group's active members, each with their role (members only, not paginated). */
  getGroupMembers: (groupId: number | string) =>
    request<GroupMember[]>(`/api/groups/${groupId}/members/`),

  /**
   * Invite one of *your* connections to a group — any active member may invite,
   * but only their own connections (the add-gate; see groups.md). Lands as a
   * pending row the invitee accepts from their inbox.
   */
  inviteToGroup: (groupId: number | string, userId: number) =>
    request<void>(`/api/groups/${groupId}/members/`, {
      method: 'POST',
      body: { user_id: userId },
    }),

  /**
   * Remove a member (admin), or — with your own id — **leave** the group. Blocked
   * by the last-admin guardrail (a 400: the sole admin must promote someone
   * first, so a group is never orphaned).
   */
  removeGroupMember: (groupId: number | string, userId: number) =>
    request<void>(`/api/groups/${groupId}/members/${userId}/`, {
      method: 'DELETE',
    }),

  /** Promote/demote a member between `admin` and `member` (admins only). */
  setGroupMemberRole: (
    groupId: number | string,
    userId: number,
    role: 'admin' | 'member'
  ) =>
    request<void>(`/api/groups/${groupId}/members/${userId}/role/`, {
      method: 'POST',
      body: { role },
    }),

  /**
   * Your pending group invitations — "X invited you to Y", newest-first. `count`
   * is the badge total; the same key feeds the Groups tab badge and the invites
   * segment (mirrors connection requests).
   */
  getGroupInvites: () =>
    request<Paginated<GroupInvite>>('/api/group-invites/'),

  /** Accept an invite (join as a member) — `id` is the `GroupInvite.id`. */
  acceptGroupInvite: (inviteId: number) =>
    request<void>(`/api/group-invites/${inviteId}/accept/`, { method: 'POST' }),

  /** Decline an invite. */
  rejectGroupInvite: (inviteId: number) =>
    request<void>(`/api/group-invites/${inviteId}/reject/`, { method: 'POST' }),

  // --- Events (Phase 9 E3b: view + participate; E3c: organiser writes) ------
  // E3b reads/participates; E3c-a adds create + finalise (set a dimension) +
  // cancel/delete; E3c-b adds the poll lifecycle. Pure client port (events.md).

  /**
   * A group's events you can see, `window` = `upcoming` (default) / `past` /
   * `all`. Returns a **plain array**, not paginated — bounded by the window
   * (unlike the group's posts). Connection-pruned to organisers you're connected
   * with; members only (404 otherwise). See events.md.
   */
  getGroupEvents: (groupId: number | string, window: 'upcoming' | 'past' | 'all' = 'upcoming') =>
    request<Event[]>(`/api/groups/${groupId}/events/?window=${window}`),

  /**
   * One event's full detail — dimensions + states, your RSVP/votes, poll
   * tallies (counts complete, voter/RSVP names connection-gated), and
   * `can_manage`/`can_moderate`. A **404** if you're not connected to the
   * organiser (the event doesn't exist for you).
   */
  getEvent: (eventId: number | string) => request<Event>(`/api/events/${eventId}/`),

  /**
   * Upsert your RSVP (any member who can see the event) — one per person.
   * `guests` is a "+N" headcount, `note` an optional short line.
   */
  rsvpEvent: (
    eventId: number | string,
    { response, guests = 0, note = '' }: {
      response: 'going' | 'maybe' | 'declined';
      guests?: number;
      note?: string;
    }
  ) =>
    request<Event>(`/api/events/${eventId}/rsvp/`, {
      method: 'PUT',
      body: { response, guests, note },
    }),

  /** The event's RSVPs on their own: complete counts + connection-gated lists. */
  getEventRsvps: (eventId: number | string) =>
    request<RsvpSummary>(`/api/events/${eventId}/rsvps/`),

  /**
   * Cast/replace your votes on an open poll — `optionIds` is your **full**
   * selection (it replaces any prior votes; an empty array clears your vote).
   * Single-choice polls take one id; pick-any takes several.
   */
  votePoll: (pollId: number | string, optionIds: number[]) =>
    request<Poll>(`/api/polls/${pollId}/vote/`, {
      method: 'PUT',
      body: { option_ids: optionIds },
    }),

  /**
   * One group's **dated** events in a window, for the month grid. `from`/`to`
   * are `YYYY-MM-DD`; the server defaults to a sensible window when omitted.
   */
  getGroupCalendar: (
    groupId: number | string,
    { from, to }: { from?: string; to?: string } = {}
  ) => {
    const qs = new URLSearchParams();
    if (from) qs.set('from', from);
    if (to) qs.set('to', to);
    const suffix = qs.toString();
    return request<Event[]>(
      `/api/groups/${groupId}/calendar/${suffix ? `?${suffix}` : ''}`
    );
  },

  /**
   * Your personal calendar: a time-merge of the dated events you can see across
   * every group you're an active member of, each labelled with its group — the
   * same discipline as the `include_groups` feed toggle.
   */
  getPersonalCalendar: ({ from, to }: { from?: string; to?: string } = {}) => {
    const qs = new URLSearchParams();
    if (from) qs.set('from', from);
    if (to) qs.set('to', to);
    const suffix = qs.toString();
    return request<Event[]>(`/api/calendar/${suffix ? `?${suffix}` : ''}`);
  },

  /* ---- Events: organiser writes (Phase 9 E3c-a) -------------------------- *
   * Create + finalise (set a built-in dimension) + cancel/delete. The poll
   * lifecycle (open/edit/close/reopen) is E3c-b. */

  /**
   * Plan an event in a group (any active member). Body is the organiser-authored
   * fields — the date/time/location are set later via `finaliseDimension`.
   * Returns the new event (in `planning`, with you as organiser).
   */
  createEvent: (
    groupId: number | string,
    { title, description = '', timezone }: { title: string; description?: string; timezone?: string }
  ) =>
    request<Event>(`/api/groups/${groupId}/events/`, {
      method: 'POST',
      body: { title, description, ...(timezone ? { timezone } : {}) },
    }),

  /**
   * Edit an event's non-scheduling fields (organiser): title, description,
   * location link/note, timezone, end time. **No web UI drives this yet** (it's a
   * dormant endpoint on the web too) — ported for completeness; the scheduling
   * fields go through `finaliseDimension`, never here.
   */
  updateEvent: (eventId: number | string, fields: Record<string, unknown>) =>
    request<Event>(`/api/events/${eventId}/`, { method: 'PATCH', body: fields }),

  /**
   * Soft-cancel an event (organiser or a group admin) — a tombstone that notifies
   * going/maybe RSVPs, not a delete. The event stays visible, marked cancelled.
   */
  cancelEvent: (eventId: number | string) =>
    request<Event>(`/api/events/${eventId}/cancel/`, { method: 'POST' }),

  /** Hard-delete an event (organiser or a group admin). Cascades. Returns 204. */
  deleteEvent: (eventId: number | string) =>
    request<void>(`/api/events/${eventId}/`, { method: 'DELETE' }),

  /**
   * The organiser's **decision** on a dimension — advisory, never auto-decided
   * (events.md decision 3). For a built-in (`date`/`time`/`location`), `value`
   * writes the field (need not be a poll option — "actually, let's do Friday");
   * for a custom poll, `optionId` pins a winning option. `closePoll` (default
   * true) closes any open poll on the dimension. Recomputes status, notifies.
   */
  finaliseDimension: (
    eventId: number | string,
    {
      dimension,
      value,
      optionId,
      closePoll = true,
    }: {
      dimension: 'date' | 'time' | 'location' | 'custom';
      value?: string;
      optionId?: number;
      closePoll?: boolean;
    }
  ) =>
    request<Event>(`/api/events/${eventId}/finalise/`, {
      method: 'POST',
      body: {
        dimension,
        ...(value !== undefined ? { value } : {}),
        ...(optionId !== undefined ? { option_id: optionId } : {}),
        close_poll: closePoll,
      },
    }),

  /* ---- Events: poll lifecycle (Phase 9 E3c-b) ---------------------------- *
   * Open/edit/close/reopen/remove an advisory poll on a dimension. Options are
   * organiser-authored, typed to the dimension (`date_value`/`time_value`/
   * `text_value`). See events.md's poll section. */

  /**
   * Open a poll on a dimension (organiser). `options` is `[{ date_value | ...
   * text_value }]` typed to the dimension; `question` is required for custom.
   * At most one open poll per built-in dimension (server-enforced).
   */
  openPoll: (
    eventId: number | string,
    {
      dimension,
      question,
      allowMultiple,
      closesAt,
      options,
    }: {
      dimension: 'date' | 'time' | 'location' | 'custom';
      question?: string;
      allowMultiple?: boolean;
      closesAt?: string;
      options: PollOptionPayload[];
    }
  ) =>
    request<Poll>(`/api/events/${eventId}/polls/`, {
      method: 'POST',
      body: {
        dimension,
        ...(question !== undefined ? { question } : {}),
        ...(allowMultiple !== undefined ? { allow_multiple: allowMultiple } : {}),
        ...(closesAt ? { closes_at: closesAt } : {}),
        options,
      },
    }),

  /**
   * Fix a poll's mistakes (organiser) — its `question`, `allowMultiple`, and its
   * full `options` set (an entry with an `id` rewrites, an id-less one is new,
   * an omitted existing option is deleted). **Refused (409) once any vote
   * exists** — the client also hides the affordance on `vote_count > 0`.
   */
  editPoll: (
    pollId: number | string,
    {
      question,
      allowMultiple,
      options,
    }: { question?: string; allowMultiple?: boolean; options: PollOptionPayload[] }
  ) =>
    request<Poll>(`/api/polls/${pollId}/`, {
      method: 'PATCH',
      body: {
        ...(question !== undefined ? { question } : {}),
        ...(allowMultiple !== undefined ? { allow_multiple: allowMultiple } : {}),
        options,
      },
    }),

  /** Close a poll without deciding (organiser) — freezes the tally. */
  closePoll: (pollId: number | string) =>
    request<Poll>(`/api/polls/${pollId}/close/`, { method: 'POST' }),

  /** Re-open a closed poll (organiser) — voting resumes; re-checks the one-open rule. */
  reopenPoll: (pollId: number | string) =>
    request<Poll>(`/api/polls/${pollId}/reopen/`, { method: 'POST' }),

  /** Remove a poll (organiser). Returns 204. */
  deletePoll: (pollId: number | string) =>
    request<void>(`/api/polls/${pollId}/`, { method: 'DELETE' }),

  /**
   * Your inbox of incoming connection requests — people asking to connect with
   * you, newest-first. `count` is the badge total (the whole inbox, not this
   * page); the same query key feeds the People tab's badge and its Requests
   * segment, so approving/rejecting keeps both in step.
   */
  getConnectionRequests: () =>
    request<Paginated<ConnectionRequest>>('/api/connection-requests/'),

  /**
   * Approve an incoming request (makes the connection mutual — you both start
   * seeing each other's posts) or reject it (discards the request). `id` is the
   * `ConnectionRequest.id`, not a user id. Guarded server-side so only the
   * requestee can act; someone else's request 404s rather than being revealed.
   */
  approveRequest: (requestId: number) =>
    request<void>(`/api/connection-requests/${requestId}/approve/`, {
      method: 'POST',
    }),
  rejectRequest: (requestId: number) =>
    request<void>(`/api/connection-requests/${requestId}/reject/`, {
      method: 'POST',
    }),

  /**
   * The reverse-chronological feed: your posts plus those of everyone you're
   * connected with, newest first.
   *
   * **The ordering is the product's one promise and it is enforced server-side**
   * (`Post.Meta.ordering`). Never sort, re-rank, or filter this list on the
   * client — render it exactly as it arrives. See feed-and-posts.md.
   *
   * Group posts are excluded by default, so the feed keeps its meaning of "the
   * people I'm connected with". Passing `includeGroups` merges in posts from
   * groups you're a member of, **strictly chronologically** (no ranking) — the
   * home feed's opt-in "include groups" toggle (E3a; see groups.md). Membership
   * still gates which groups' posts merge.
   */
  getFeed: (includeGroups = false) =>
    request<Paginated<Post>>(
      includeGroups ? '/api/feed/?include_groups=1' : '/api/feed/'
    ),

  /**
   * Follow a paginator's `next` URL.
   *
   * The server returns an absolute URL built from the request it saw, which
   * behind Caddy is not necessarily the host the app is talking to. Keeping only
   * the path + query and re-basing on `BASE_URL` makes paging work regardless —
   * the same thing `api.getPage` does on the web.
   *
   * **Parsed by hand rather than with `new URL()` on purpose.** React Native's
   * `URL` is a partial implementation and has historically returned empty or
   * wrong components (it's why `react-native-url-polyfill` exists). A silent
   * failure here would break infinite scroll on device while every test passed
   * under Node, whose `URL` is complete — so string-slicing it is.
   */
  getPage: <T>(url: string) => {
    const afterScheme = url.indexOf('://');
    const pathStart =
      afterScheme === -1 ? 0 : url.indexOf('/', afterScheme + 3);
    // A URL with no path at all ("https://host") — nothing sensible to follow.
    const relative = pathStart === -1 ? '/' : url.slice(pathStart);
    return request<Paginated<T>>(relative);
  },

  /**
   * Create a post: text, photos, or both.
   *
   * Multipart because photos ride along in the same request, as repeated
   * `images` parts — the shape `PostCreateView` expects. The author is **never**
   * sent: the server sets it from the authenticated user and ignores anything in
   * the body, so a client can't post as someone else.
   *
   * Each photo is uploaded via `toFilePart` — the winter fetch runtime rejects
   * the old React Native `{uri, name, type}` part.
   */
  createPost: async (
    text: string,
    photos: PhotoUpload[] = [],
    groupId?: number
  ) => {
    const form = new FormData();
    form.append('text', text);
    for (const photo of photos) {
      form.append('images', (await toFilePart(photo)) as unknown as Blob);
    }
    // A group post reuses this same endpoint with an optional `group` id
    // (membership-checked server-side); omitting it is a personal post. See
    // groups.md — a group post *is* a post, one nullable FK, not a new model.
    if (groupId != null) form.append('group', String(groupId));
    return request<Post>('/api/posts/', { method: 'POST', body: form });
  },

  /**
   * One post by id — the permalink behind `/post/[postId]`.
   *
   * **Fetched by id rather than reused from a feed row on purpose.** Push
   * notifications deep-link here (Milestone D), and the target post may be
   * nowhere near the first page of any feed, so this is the only reliable way to
   * open an old thread. Gated by the same wall as the feed: a post you can't see
   * **404s rather than 403s**, so the app can't be used to probe whether a post
   * exists.
   */
  getPost: (postId: number | string) => request<Post>(`/api/posts/${postId}/`),

  /**
   * Correct your own post (issue #146) — the app could already *show* that a
   * post was edited, but not produce an edit, so a typo made on the phone could
   * only be fixed from the web.
   *
   * **Text only**, matching the web client and the endpoint's v1 scope: photos
   * can't be added or removed by an edit. Owner-only server-side (403 for
   * someone else's post, 404 for one you can't see), so the client's owner check
   * only hides an affordance that would fail. A post can't be emptied to nothing
   * — a blank `text` on a post with no photos is a 400.
   *
   * Unlike `editMessage` there is **no time window**: a post is your own entry on
   * your own timeline, and the quiet "· edited" marker the server stamps is the
   * agreed transparency floor (see feed-and-posts.md).
   */
  updatePost: (postId: number | string, text: string) =>
    request<Post>(`/api/posts/${postId}/`, { method: 'PATCH', body: { text } }),

  /**
   * Delete your own post (Phase 9 E4a). The backend refuses one that isn't yours,
   * so this needs no client-side owner check beyond hiding the affordance.
   */
  deletePost: (postId: number | string) =>
    request<void>(`/api/posts/${postId}/`, { method: 'DELETE' }),

  /**
   * A post's comment tree, already pruned to what you may see.
   *
   * **This GET has a side effect, deliberately:** it stamps your "last seen"
   * marker for the thread, which is what clears the post's "N new" badge. Seen
   * is thread-level, exactly like opening a conversation clears its unread
   * count (see feed-and-posts.md). So don't call it to prefetch — only call it
   * when someone has actually opened the thread.
   *
   * Not paginated: `PostCommentsView` is a plain `APIView` returning the whole
   * nested tree, so there's no `next` to follow here.
   */
  getComments: (target: CommentTarget) =>
    request<Comment[]>(commentsPath(target)),

  /**
   * Add a comment, or a reply when `parent` is given.
   *
   * The author comes from the token, never the body — same rule as posting.
   */
  addComment: (
    target: CommentTarget,
    { text, parent = null }: { text: string; parent?: number | null }
  ) =>
    request<Comment>(commentsPath(target), {
      method: 'POST',
      body: { text, parent },
    }),

  /**
   * Edit your own comment (issue #128). Owner-only server-side, so hiding the
   * affordance is presentation, not the control.
   *
   * Like `updatePost` and unlike `editMessage` there is **no time window** — a
   * comment sits on a page anyone can re-read at leisure, so the honest
   * disclosure is the "· edited" marker the server stamps, not a deadline. The
   * response is the whole comment node, its visible replies included.
   */
  updateComment: (commentId: number | string, text: string) =>
    request<Comment>(`/api/comments/${commentId}/`, {
      method: 'PATCH',
      body: { text },
    }),

  /**
   * Delete your own comment (issue #128).
   *
   * 204 either way, because *which* delete happened isn't yours to choose: the
   * server drops the row when nothing hangs off it, and blanks it into a
   * tombstone when replies do, so deleting your comment can never take someone
   * else's reply with it. Refetch the thread rather than guessing which.
   */
  deleteComment: (commentId: number | string) =>
    request<void>(`/api/comments/${commentId}/`, { method: 'DELETE' }),

  /**
   * Toggle your emoji reaction on a post, comment or message (Phase 9b M2). Pass
   * exactly one target.
   *
   * **It's a toggle, not an add:** sending an emoji you've already used removes
   * it. Returns the target's updated summary, so the caller can render the
   * result instead of guessing at it or refetching.
   *
   * A message target has two extra ways to fail, both server-enforced: reacting
   * needs the same permission as *sending* (403 once you're disconnected — a
   * reaction is content everyone in the thread sees), and a deleted message
   * can't be reacted to (400).
   */
  toggleReaction: ({ emoji, ...target }: ReactionTarget & { emoji: string }) =>
    request<ReactionSummary>(reactionPath(target, 'react'), {
      method: 'POST',
      body: { emoji },
    }),

  /**
   * Who reacted, grouped by emoji. Pass exactly one target.
   *
   * Post and comment reactors are pruned to people you may see; a *message*'s
   * aren't, because a chat's active members are already a clique — so everyone
   * in a thread sees the same list (reactions.md).
   */
  getReactors: (target: ReactionTarget) =>
    request<ReactorGroup[]>(reactionPath(target, 'reactions')),

  /**
   * Register this device for push (Phase 9, Milestone D).
   *
   * Upserts server-side on the Expo token, so calling it on every launch is
   * both safe and wanted — Expo can rotate a device's token.
   */
  registerPushToken: (expoToken: string) =>
    request<void>('/api/push-tokens/', {
      method: 'POST',
      // Platform.OS rather than a literal 'ios': the backend already accepts
      // both values, so Phase 10 (Android) needs no change here.
      body: { expo_token: expoToken, platform: Platform.OS },
    }),

  /** Unregister this device. Must run while still authenticated. */
  unregisterPushToken: (expoToken: string) =>
    request<void>('/api/push-tokens/', {
      method: 'DELETE',
      body: { expo_token: expoToken },
    }),

  /**
   * Mark a notification addressed (which implies seen).
   *
   * Fired when a push is tapped, so the in-app activity centre and the web
   * dropdown agree that it's been dealt with — the same click-through
   * semantics the web app already has.
   */
  markNotificationAddressed: (notificationId: number) =>
    request<void>(`/api/notifications/${notificationId}/addressed/`, {
      method: 'POST',
    }),

  /* ---- Activity centre (Phase 9 E4c) ------------------------------------ *
   * The in-app notification list + bell badge. Pure client port of the web
   * ActivityCenter — the delivery channel (push) landed in Milestone D, this is
   * the on-device history it deep-links into. No backend change (all endpoints
   * are Phase 8). `markNotificationAddressed` above is shared with push taps.  */

  /**
   * Your notifications, newest-first, paginated (`NotificationSerializer`). Only
   * fetched while the activity screen is open — the bell badge uses the cheap
   * count endpoint below, so we never pull the full list just to render a pip.
   */
  getNotifications: () =>
    request<Paginated<Notification>>('/api/notifications/'),

  /** Your unread (not-yet-seen) count — drives the bell badge. Cheap; polled. */
  getUnreadNotificationCount: () =>
    request<{ count: number }>('/api/notifications/unread-count/'),

  /**
   * Mark unread notifications **seen** — clears the badge while keeping every
   * item in the list. Called once when the activity screen opens. Omitting `ids`
   * marks all currently-unread seen (what we want); the param mirrors the web's
   * signature for parity. Idempotent server-side.
   */
  markNotificationsSeen: (ids?: number[]) =>
    request<{ updated: number }>('/api/notifications/seen/', {
      method: 'POST',
      body: ids ? { ids } : {},
    }),

  /* ---- Settings (Phase 9 E4b) ------------------------------------------- *
   * Account hygiene + per-type notification preferences. Pure client port of
   * the web SettingsPage's three sections — no backend change (password change
   * is Phase 7, account deletion Phase 7, prefs Phase 8).                     */

  /**
   * Change your password. The current password is required (the backend
   * enforces it via `OLD_PASSWORD_FIELD_ENABLED`) so a hijacked session can't
   * silently rotate it; `confirm` is re-checked server-side too. On success the
   * session stays valid — no re-login, and the tokens are unaffected.
   */
  changePassword: (
    currentPassword: string,
    newPassword: string,
    confirmPassword: string
  ) =>
    request<void>('/api/auth/password/change/', {
      method: 'POST',
      body: {
        old_password: currentPassword,
        new_password1: newPassword,
        new_password2: confirmPassword,
      },
    }),

  /**
   * Permanently delete your own account and all your data (UK GDPR erasure).
   * Password-reconfirmed because it's irreversible; the backend rejects a wrong
   * password. On success the server returns 204 and the session is dead — the
   * caller signs out to wipe the device and land on login.
   */
  deleteAccount: (password: string) =>
    request<void>('/api/account/delete/', {
      method: 'POST',
      body: { password },
    }),

  /**
   * Per-kind notification preferences as a `{ kind: bool }` map over just the
   * *mutable* kinds (replies/reactions/events). The connection & invite kinds
   * are always-on and never appear here. GET reads the merged map.
   */
  getNotificationPreferences: () =>
    request<NotificationPreferences>('/api/notification-preferences/'),

  /** PATCH a partial `{ kind: bool }` map; returns the full merged map back. */
  updateNotificationPreferences: (patch: NotificationPreferences) =>
    request<NotificationPreferences>('/api/notification-preferences/', {
      method: 'PATCH',
      body: patch,
    }),

  /**
   * Log in and persist both tokens.
   *
   * Hits the mobile-specific endpoint, not `/api/auth/login/`: the web endpoint
   * blanks the refresh token out of the response body because `JWT_AUTH_HTTPONLY`
   * is on. See `accounts.views.MobileLoginView`.
   */
  login: async (email: string, password: string): Promise<User> => {
    const data = await request<LoginResponse>('/api/auth/mobile/login/', {
      method: 'POST',
      body: { email, password },
    });
    await saveTokens({ access: data.access, refresh: data.refresh });
    return data.user;
  },

  /**
   * Log out: blacklist the refresh token server-side, then wipe the device.
   *
   * The server call matters. Deleting the tokens locally only would leave a
   * still-valid refresh token in any device backup taken before now — the
   * blacklist is what actually kills the session. But a network failure must
   * never trap someone in a logged-in app, so a failed blacklist is swallowed
   * and the local wipe happens regardless.
   */
  logout: async (): Promise<void> => {
    const refresh = await getRefreshToken();
    if (refresh) {
      try {
        // `retry: false` matters here, and is not just an optimisation. The
        // blacklist endpoint takes the refresh token in the *body*, so if the
        // access token happened to be expired, the normal retry path would
        // refresh first — rotating this very token and blacklisting it — and
        // then replay the request with the now-stale token in the body. The
        // server would reject the replay, we'd swallow the error, and the
        // freshly-issued refresh token would be left **live on the server**
        // while we wiped it from the device: precisely the "copy lifted from a
        // backup still works" case the server-side blacklist exists to close.
        await request('/api/auth/mobile/logout/', {
          method: 'POST',
          body: { refresh },
          retry: false,
        });
      } catch {
        // Best-effort; see above.
      }
    }
    await clearTokens();
  },
};
