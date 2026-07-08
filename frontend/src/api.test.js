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

  it("createPost POSTs the text with a CSRF header", async () => {
    document.cookie = "csrftoken=tok-p";
    const fetchMock = stubFetch({ body: JSON.stringify({ id: 1 }) });

    await api.createPost("hello world");

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toContain("/api/posts/");
    expect(opts.method).toBe("POST");
    expect(opts.headers["X-CSRFToken"]).toBe("tok-p");
    expect(JSON.parse(opts.body)).toEqual({ text: "hello world" });
  });

  it("connect POSTs and disconnect DELETEs the same user URL", async () => {
    document.cookie = "csrftoken=tok-f";
    const fetchMock = stubFetch({ body: "{}" });

    await api.connect(7);
    await api.disconnect(7);

    const [connectUrl, connectOpts] = fetchMock.mock.calls[0];
    const [disconnectUrl, disconnectOpts] = fetchMock.mock.calls[1];
    expect(connectUrl).toContain("/api/users/7/connect/");
    expect(connectOpts.method).toBe("POST");
    expect(disconnectUrl).toContain("/api/users/7/connect/");
    expect(disconnectOpts.method).toBe("DELETE");
  });

  it("addComment POSTs text (and parent for a reply) to the post's comments", async () => {
    document.cookie = "csrftoken=tok-c";
    const fetchMock = stubFetch({ body: "{}" });

    await api.addComment(5, { text: "top-level" });
    await api.addComment(5, { text: "a reply", parent: 42 });

    const [topUrl, topOpts] = fetchMock.mock.calls[0];
    expect(topUrl).toContain("/api/posts/5/comments/");
    expect(topOpts.method).toBe("POST");
    expect(JSON.parse(topOpts.body)).toEqual({ text: "top-level" });

    const [, replyOpts] = fetchMock.mock.calls[1];
    expect(JSON.parse(replyOpts.body)).toEqual({ text: "a reply", parent: 42 });
  });

  it("getPage strips the origin from a DRF `next` URL", async () => {
    const fetchMock = stubFetch({ body: JSON.stringify({ results: [] }) });

    await api.getPage("http://localhost:8000/api/feed/?page=2");

    const [url, opts] = fetchMock.mock.calls[0];
    // Called with the same absolute URL (BASE_URL + path), method GET.
    expect(url).toBe("http://localhost:8000/api/feed/?page=2");
    expect(opts.method ?? "GET").toBe("GET");
  });

  it("getPage rebases a `next` URL whose origin differs from BASE_URL", async () => {
    const fetchMock = stubFetch({ body: JSON.stringify({ results: [] }) });

    // Behind a proxy / on a separate API domain, DRF builds `next` from a host
    // that isn't BASE_URL. getPage must keep only path+query and rebase onto
    // BASE_URL, not fetch the foreign origin (or a malformed concatenation).
    await api.getPage("https://api.example.com/api/feed/?page=3");

    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe("http://localhost:8000/api/feed/?page=3");
  });

  it("createGroupChat POSTs participant_ids/title/group_id", async () => {
    document.cookie = "csrftoken=tok-g";
    const fetchMock = stubFetch({ body: JSON.stringify({ id: 7 }) });

    await api.createGroupChat({
      participantIds: [1, 2],
      title: "Trip",
      groupId: 3,
    });

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toContain("/api/conversations/");
    expect(opts.method).toBe("POST");
    expect(JSON.parse(opts.body)).toEqual({
      participant_ids: [1, 2],
      title: "Trip",
      group_id: 3,
    });
  });

  it("createGroupChat omits group_id when none is given", async () => {
    const fetchMock = stubFetch({ body: JSON.stringify({ id: 8 }) });

    await api.createGroupChat({ participantIds: [1, 2] });

    const [, opts] = fetchMock.mock.calls[0];
    expect(JSON.parse(opts.body)).toEqual({
      participant_ids: [1, 2],
      title: "",
    });
  });

  it("addParticipants POSTs user_ids to the conversation's participants endpoint", async () => {
    const fetchMock = stubFetch({ body: "{}" });

    await api.addParticipants(9, [4, 5]);

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toContain("/api/conversations/9/participants/");
    expect(opts.method).toBe("POST");
    expect(JSON.parse(opts.body)).toEqual({ user_ids: [4, 5] });
  });

  it("leaveConversation POSTs to the conversation's leave endpoint", async () => {
    const fetchMock = stubFetch({ body: "{}" });

    await api.leaveConversation(9);

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toContain("/api/conversations/9/leave/");
    expect(opts.method).toBe("POST");
  });

  it("getDisconnectImpact GETs the user's disconnect-impact endpoint", async () => {
    const fetchMock = stubFetch({ body: JSON.stringify({ conversations: [] }) });

    await api.getDisconnectImpact(6);

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toContain("/api/users/6/disconnect-impact/");
    expect(opts.method ?? "GET").toBe("GET");
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
