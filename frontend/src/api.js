// Thin wrapper around fetch for talking to the Django API.
//
// Two things every call needs in our cookie-based auth setup:
//   - credentials: "include" — so the browser sends (and stores) our httpOnly
//     auth cookie. Without it, fetch ignores cookies cross-origin.
//   - the CSRF token — mutating requests must echo the `csrftoken` cookie back
//     in the X-CSRFToken header (the backend enforces this whenever the auth
//     cookie is present). GET requests don't need it.
//
// The auth token itself lives in an httpOnly cookie we deliberately can't read
// from JavaScript, so there's nothing here that stores or reads it — the
// browser attaches it automatically.

const BASE_URL = import.meta.env.VITE_API_URL || "http://localhost:8000";

function getCookie(name) {
  const match = document.cookie.match(
    new RegExp("(?:^|; )" + name + "=([^;]*)")
  );
  return match ? decodeURIComponent(match[1]) : null;
}

class ApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.data = data;
  }
}

async function request(path, { method = "GET", body } = {}) {
  // A FormData body means a file upload (post photos, avatar). Let the browser
  // set the multipart Content-Type (with its boundary) — setting it ourselves
  // would omit the boundary and the server couldn't parse the parts. JSON
  // bodies still get an explicit application/json header.
  const isFormData =
    typeof FormData !== "undefined" && body instanceof FormData;
  const headers = {};
  if (body !== undefined && !isFormData) {
    headers["Content-Type"] = "application/json";
  }
  // Only unsafe methods are CSRF-checked; sending it always is harmless.
  if (method !== "GET" && method !== "HEAD") {
    const csrf = getCookie("csrftoken");
    if (csrf) headers["X-CSRFToken"] = csrf;
  }

  const response = await fetch(BASE_URL + path, {
    method,
    headers,
    credentials: "include",
    body:
      body === undefined
        ? undefined
        : isFormData
          ? body
          : JSON.stringify(body),
  });

  // 204 No Content (and empty bodies) have nothing to parse.
  let data = null;
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
      firstErrorMessage(data) || `Request failed (${response.status})`,
      response.status,
      data
    );
  }
  return data;
}

// DRF returns validation errors as { field: ["msg", ...] } or
// { detail: "msg" } / { non_field_errors: [...] }. Pull out something showable.
function firstErrorMessage(data) {
  if (!data || typeof data !== "object") return null;
  if (typeof data.detail === "string") return data.detail;
  const firstKey = Object.keys(data)[0];
  if (!firstKey) return null;
  const value = data[firstKey];
  return Array.isArray(value) ? value[0] : String(value);
}

export const api = {
  ApiError,

  // Prime the csrftoken cookie. Call once on app load, before any mutation.
  ensureCsrf: () => request("/api/auth/csrf/"),

  // "Who am I" — resolves to the user, or throws (401) when logged out.
  getCurrentUser: () => request("/api/auth/user/"),

  login: (email, password) =>
    request("/api/auth/login/", { method: "POST", body: { email, password } }),

  logout: () => request("/api/auth/logout/", { method: "POST" }),

  // Registration creates a *pending* account; it does not log you in. We collect
  // the real name here (there are no usernames), so an approved account has a
  // display name from day one.
  register: (email, password, firstName, lastName) =>
    request("/api/auth/registration/", {
      method: "POST",
      body: {
        email,
        password1: password,
        password2: password,
        first_name: firstName,
        last_name: lastName,
      },
    }),

  // Update your own profile (name, bio, avatar) via dj-rest-auth's user
  // endpoint. Sent as multipart because it can carry an avatar file. Pass
  // `removeAvatar: true` to clear an existing avatar.
  updateProfile: ({ first_name, last_name, bio, avatar, removeAvatar } = {}) => {
    const form = new FormData();
    if (first_name !== undefined) form.append("first_name", first_name);
    if (last_name !== undefined) form.append("last_name", last_name);
    if (bio !== undefined) form.append("bio", bio);
    if (avatar) form.append("avatar", avatar);
    if (removeAvatar) form.append("remove_avatar", "true");
    return request("/api/auth/user/", { method: "PATCH", body: form });
  },

  // --- Timeline (Phase 3) --------------------------------------------------

  // The home feed: your posts + everyone you're connected with, newest-first,
  // paginated.
  getFeed: () => request("/api/feed/"),

  // Follow a paginated response's `next` URL. DRF returns an absolute URL built
  // from the request host, which needn't match BASE_URL (behind a proxy, or a
  // separate API domain in prod). Take just the path + query so request()
  // prepends our own BASE_URL regardless of the origin DRF used.
  getPage: (nextUrl) => {
    const url = new URL(nextUrl, BASE_URL);
    return request(url.pathname + url.search);
  },

  // Create a post. With no photos it's a plain JSON body; with photos it becomes
  // a multipart upload carrying the text plus each image file under `images`.
  createPost: (text, images = []) => {
    if (!images || images.length === 0) {
      return request("/api/posts/", { method: "POST", body: { text } });
    }
    const form = new FormData();
    if (text) form.append("text", text);
    for (const file of images) form.append("images", file);
    return request("/api/posts/", { method: "POST", body: form });
  },

  // The visible comment tree for a post (already pruned server-side to people
  // you're connected with), and adding a comment/reply.
  getComments: (postId) => request(`/api/posts/${postId}/comments/`),

  addComment: (postId, { text, parent = null }) =>
    request(`/api/posts/${postId}/comments/`, {
      method: "POST",
      body: parent ? { text, parent } : { text },
    }),

  // People to connect with — everyone else, each with your connection_status.
  listUsers: () => request("/api/users/"),

  getUser: (id) => request(`/api/users/${id}/`),

  getUserPosts: (id) => request(`/api/users/${id}/posts/`),

  // Connections are private + mutual: this sends a *request* the other person
  // must approve (or, if they already requested you, it accepts theirs).
  connect: (id) => request(`/api/users/${id}/connect/`, { method: "POST" }),

  // Cancels a pending request or ends an accepted connection (same endpoint).
  disconnect: (id) => request(`/api/users/${id}/connect/`, { method: "DELETE" }),

  // Incoming connection requests (people asking to connect) + approve/reject.
  getConnectionRequests: () => request("/api/connection-requests/"),

  approveRequest: (id) =>
    request(`/api/connection-requests/${id}/approve/`, { method: "POST" }),

  rejectRequest: (id) =>
    request(`/api/connection-requests/${id}/reject/`, { method: "POST" }),
};
