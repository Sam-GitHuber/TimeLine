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
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  // Only unsafe methods are CSRF-checked; sending it always is harmless.
  if (method !== "GET" && method !== "HEAD") {
    const csrf = getCookie("csrftoken");
    if (csrf) headers["X-CSRFToken"] = csrf;
  }

  const response = await fetch(BASE_URL + path, {
    method,
    headers,
    credentials: "include",
    body: body !== undefined ? JSON.stringify(body) : undefined,
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

  // Registration creates a *pending* account; it does not log you in.
  register: (email, password) =>
    request("/api/auth/registration/", {
      method: "POST",
      body: { email, password1: password, password2: password },
    }),
};
