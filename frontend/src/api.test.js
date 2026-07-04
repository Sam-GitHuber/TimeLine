import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { api } from "./api.js";

// These tests exercise the REAL api module (not a mock) against a stubbed
// fetch + real document.cookie, so the cookie-parsing and CSRF-header wiring
// that every other test mocks away is actually covered. A regression in
// getCookie or the X-CSRFToken header name would break logout/posting in the
// browser while passing all the mocked suites — this is the safety net.

function stubFetch({ ok = true, status = 200, body = "" } = {}) {
  const fn = vi.fn().mockResolvedValue({ ok, status, text: async () => body });
  vi.stubGlobal("fetch", fn);
  return fn;
}

beforeEach(() => {
  // Clear the csrftoken cookie so each test controls it explicitly.
  document.cookie = "csrftoken=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("api CSRF + fetch wiring", () => {
  it("attaches X-CSRFToken (read from the cookie) on mutating requests", async () => {
    document.cookie = "csrftoken=tok-123";
    const fetchMock = stubFetch({ body: JSON.stringify({ detail: "ok" }) });

    await api.logout();

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toContain("/api/auth/logout/");
    expect(opts.method).toBe("POST");
    expect(opts.credentials).toBe("include");
    expect(opts.headers["X-CSRFToken"]).toBe("tok-123");
  });

  it("omits the CSRF header when there is no csrftoken cookie", async () => {
    const fetchMock = stubFetch({ body: "{}" });

    await api.logout();

    const [, opts] = fetchMock.mock.calls[0];
    expect("X-CSRFToken" in opts.headers).toBe(false);
  });

  it("does not attach the CSRF header on GET requests", async () => {
    document.cookie = "csrftoken=tok-123";
    const fetchMock = stubFetch({ body: JSON.stringify({ pk: 1 }) });

    await api.getCurrentUser();

    const [, opts] = fetchMock.mock.calls[0];
    expect(opts.method).toBe("GET");
    expect("X-CSRFToken" in opts.headers).toBe(false);
  });

  it("sends a JSON body + credentials on login", async () => {
    document.cookie = "csrftoken=tok-9";
    const fetchMock = stubFetch({ body: JSON.stringify({ user: {} }) });

    await api.login("a@b.com", "pw");

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toContain("/api/auth/login/");
    expect(opts.credentials).toBe("include");
    expect(opts.headers["Content-Type"]).toBe("application/json");
    expect(opts.headers["X-CSRFToken"]).toBe("tok-9");
    expect(JSON.parse(opts.body)).toEqual({ email: "a@b.com", password: "pw" });
  });

  it("register sends matching password1/password2 and no auth-token handling", async () => {
    const fetchMock = stubFetch({ body: JSON.stringify({ detail: "pending" }) });

    await api.register("new@b.com", "pw123456");

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toContain("/api/auth/registration/");
    expect(JSON.parse(opts.body)).toEqual({
      email: "new@b.com",
      password1: "pw123456",
      password2: "pw123456",
    });
  });

  it("throws with the backend's error message on a non-OK response", async () => {
    stubFetch({
      ok: false,
      status: 400,
      body: JSON.stringify({
        non_field_errors: ["Unable to log in with provided credentials."],
      }),
    });

    await expect(api.login("a@b.com", "wrong")).rejects.toThrow(
      /unable to log in/i
    );
  });
});
