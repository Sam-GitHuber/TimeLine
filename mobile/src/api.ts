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

import {
  clearTokens,
  getAccessToken,
  getCachedAccessToken,
  getRefreshToken,
  saveTokens,
} from './tokens';
import type {
  Comment,
  LoginResponse,
  Paginated,
  Post,
  ProfileUser,
  ReactionSummary,
  ReactorGroup,
  RefreshResponse,
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
 * A photo chosen from the library, ready to upload. React Native's `FormData`
 * wants the file's location, not its bytes.
 */
export type PhotoUpload = {
  uri: string;
  name: string;
  type: string;
};

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
  updateProfile: ({
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
      form.append('avatar', {
        uri: avatar.uri,
        name: avatar.name,
        type: avatar.type,
      } as unknown as Blob);
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
   * The reverse-chronological feed: your posts plus those of everyone you're
   * connected with, newest first.
   *
   * **The ordering is the product's one promise and it is enforced server-side**
   * (`Post.Meta.ordering`). Never sort, re-rank, or filter this list on the
   * client — render it exactly as it arrives. See feed-and-posts.md.
   *
   * Group posts are excluded by default, so the feed keeps its meaning of "the
   * people I'm connected with".
   */
  getFeed: () => request<Paginated<Post>>('/api/feed/'),

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
   * React Native's `FormData` takes a `{uri, name, type}` object for a file
   * rather than a `Blob` — the runtime reads the file off disk itself. Passing a
   * browser-style Blob here silently uploads nothing.
   */
  createPost: (text: string, photos: PhotoUpload[] = []) => {
    const form = new FormData();
    form.append('text', text);
    for (const photo of photos) {
      form.append('images', {
        uri: photo.uri,
        name: photo.name,
        type: photo.type,
      } as unknown as Blob);
    }
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
