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

import { clearTokens, getAccessToken, getRefreshToken, saveTokens } from './tokens';
import type { LoginResponse, RefreshResponse, User } from './types';

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
  const access = await getAccessToken();
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

export const api = {
  ApiError,

  /** "Who am I" — resolves to the user, or throws 401 when logged out. */
  getCurrentUser: () => request<User>('/api/auth/user/'),

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
