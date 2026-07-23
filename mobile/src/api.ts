/**
 * The app's one HTTP client. Written fresh for Bearer auth rather than shared
 * with `frontend/src/api.js`, which is cookie + CSRF based — see the repo-layout
 * decision in docs/phases/phase-9-iphone-app.md.
 *
 * What this file owns:
 *   - attaching `Authorization: Bearer <access>` to every request;
 *   - silently refreshing on a 401 and replaying the request once;
 *   - collapsing parallel refreshes into one (the "stampede" guard below);
 *   - telling the app to log out when refresh itself fails.
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
  Paginated,
  PersonSummary,
  Poll,
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
 * A photo chosen from the library, ready to upload. The picker hands us the
 * file's location, its (best-effort) filename, and its MIME type.
 */
export type PhotoUpload = {
  uri: string;
  name: string;
  type: string;
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

  constructor(message: string, status: number, data: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
  }
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

    const response = await fetch(`${BASE_URL}/api/auth/mobile/refresh/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh }),
    });

    if (!response.ok) {
      throw new ApiError('Session expired', response.status, null);
    }

    // Rotation: the response carries a *new* refresh token and the old one is
    // now blacklisted, so both must be stored — keeping the old one would log
    // the user out at the next refresh.
    const pair = (await response.json()) as RefreshResponse;
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
    } catch {
      // Refresh failed: the refresh token is expired, rotated away, or
      // blacklisted. Nothing left to try — drop the session and send the user
      // to login rather than leaving the app in a half-authenticated state.
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
    throw new ApiError(
      firstErrorMessage(data) ?? `Request failed (${response.status})`,
      response.status,
      data
    );
  }
  return data as T;
}

/**
 * The URL for a reaction action on whichever target was named.
 *
 * Both ids are optional at the type level because the components holding them
 * carry them that way, so "neither was passed" is reachable. Left alone it
 * builds `/api/comments/undefined/react/`, which 404s and surfaces to the user
 * as a mystery "Couldn't react" — so it fails loudly here instead.
 */
function reactionPath(
  { postId, commentId }: { postId?: number; commentId?: number },
  action: 'react' | 'reactions'
): string {
  if (postId != null) return `/api/posts/${postId}/${action}/`;
  if (commentId != null) return `/api/comments/${commentId}/${action}/`;
  throw new Error('reactionPath needs either a postId or a commentId');
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
   * Flag a post or comment for the maintainer to review (the content-takedown
   * path). Pass exactly one of `postId` / `commentId`, plus an optional reason.
   * Idempotent server-side: a repeat flag returns your existing report rather
   * than stacking duplicates. You can only report content you can see (a
   * non-visible target 404s, same wall as the feed).
   */
  reportContent: ({
    postId,
    commentId,
    reason = '',
  }: {
    postId?: number;
    commentId?: number;
    reason?: string;
  }) =>
    request<{ id: number }>('/api/reports/', {
      method: 'POST',
      body: {
        ...(postId != null ? { post: postId } : {}),
        ...(commentId != null ? { comment: commentId } : {}),
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
   * A thread's messages, oldest-first and paginated, **clipped to your
   * participation intervals** server-side (a member who left and returned never
   * sees the gap). 403s while you're a pending member — the thread renders the
   * locked panel instead of calling this.
   */
  getMessages: (conversationId: number | string) =>
    request<Paginated<Message>>(
      `/api/conversations/${conversationId}/messages/`
    ),

  /**
   * Send a message. The sender is the authenticated user, never the body — you
   * can't post as someone else. Active participants only (the composer keys off
   * `can_send`, and the backend enforces the same gate).
   */
  sendMessage: (conversationId: number | string, text: string) =>
    request<Message>(`/api/conversations/${conversationId}/messages/`, {
      method: 'POST',
      body: { text },
    }),

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

  // --- Events (Phase 9 E3b: the view + participate subset) -----------------
  // Organiser writes (create/finalise/poll-lifecycle/cancel/edit) land in E3c.

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
   * Delete your own post (Phase 9 E4a). The backend refuses one that isn't yours,
   * so this needs no client-side owner check beyond hiding the affordance. There
   * is deliberately **no** comment-delete counterpart — the API has no such
   * endpoint, and comments are report-only on the web too (see accounts.md).
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
  getComments: (postId: number | string) =>
    request<Comment[]>(`/api/posts/${postId}/comments/`),

  /**
   * Add a comment, or a reply when `parent` is given.
   *
   * The author comes from the token, never the body — same rule as posting.
   */
  addComment: (
    postId: number | string,
    { text, parent = null }: { text: string; parent?: number | null }
  ) =>
    request<Comment>(`/api/posts/${postId}/comments/`, {
      method: 'POST',
      body: { text, parent },
    }),

  /**
   * Toggle your emoji reaction on a post or a comment. Pass exactly one target.
   *
   * **It's a toggle, not an add:** sending an emoji you've already used removes
   * it. Returns the target's updated pruned summary, so the caller can render
   * the result instead of guessing at it or refetching the feed.
   */
  toggleReaction: ({
    postId,
    commentId,
    emoji,
  }: {
    postId?: number;
    commentId?: number;
    emoji: string;
  }) =>
    request<ReactionSummary>(reactionPath({ postId, commentId }, 'react'), {
      method: 'POST',
      body: { emoji },
    }),

  /** Who reacted, grouped by emoji. Pass exactly one target. */
  getReactors: ({ postId, commentId }: { postId?: number; commentId?: number }) =>
    request<ReactorGroup[]>(reactionPath({ postId, commentId }, 'reactions')),

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
