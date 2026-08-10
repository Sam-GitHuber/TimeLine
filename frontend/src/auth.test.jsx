import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// Mock the API module so these tests exercise the real AuthProvider + routing
// without any network. Each test decides what the backend "returns". The feed
// endpoints are stubbed to empty so the (logged-in) feed page renders quietly.
vi.mock("./api.js", () => ({
  api: {
    ensureCsrf: vi.fn().mockResolvedValue({}),
    getCurrentUser: vi.fn(),
    login: vi.fn(),
    logout: vi.fn(),
    register: vi.fn(),
    verifyEmail: vi.fn(),
    resendVerification: vi.fn(),
    getFeed: vi.fn().mockResolvedValue({ results: [], next: null }),
    getPage: vi.fn().mockResolvedValue({ results: [], next: null }),
    createPost: vi.fn(),
    getConnectionRequests: vi
      .fn()
      .mockResolvedValue({ results: [], next: null }),
    getUnreadMessageCount: vi.fn().mockResolvedValue({ count: 0 }),
    getGroupInvites: vi.fn().mockResolvedValue({ count: 0, results: [] }),
    getUnreadNotificationCount: vi.fn().mockResolvedValue({ count: 0 }),
    getNotifications: vi.fn().mockResolvedValue({ results: [], next: null }),
    markNotificationsSeen: vi.fn().mockResolvedValue({ updated: 0 }),
  },
  CONVERSATION_LIST_POLL_MS: 12000,
  MESSAGE_POLL_MS: 4000,
  NOTIFICATIONS_POLL_MS: 12000,
}));

import { api } from "./api.js";
import { AuthProvider } from "./auth.jsx";
import { getDraft, setDraft } from "./drafts.js";
import { apiError } from "./test-utils.jsx";
import App from "./App.jsx";

// The real provider, exactly as main.jsx wires it, at a given URL — including
// the QueryClientProvider the app depends on for data fetching. The client is
// returned alongside RTL's result for the tests whose subject is the cache
// itself (what a session leaves behind).
function renderApp(route = "/") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return {
    ...render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[route]}>
          <AuthProvider>
            <App />
          </AuthProvider>
        </MemoryRouter>
      </QueryClientProvider>
    ),
    queryClient,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  api.ensureCsrf.mockResolvedValue({});
  api.getFeed.mockResolvedValue({ results: [], next: null });
});

describe("Auth gating", () => {
  it("redirects to the login page when visiting a protected page logged out", async () => {
    api.getCurrentUser.mockRejectedValue(new Error("401")); // no session

    renderApp("/");

    // We land on the login form, not the feed.
    expect(
      await screen.findByRole("button", { name: "Log in" })
    ).toBeInTheDocument();
    expect(
      screen.queryByPlaceholderText("What's happening?")
    ).not.toBeInTheDocument();
  });

  it("stays logged in across a refresh by re-checking who-am-I on load", async () => {
    // A refreshed page has the httpOnly cookie; who-am-I resolves.
    api.getCurrentUser.mockResolvedValue({ pk: 1, email: "sam@example.com" });

    renderApp("/");

    // The feed (its compose box) renders once the session check resolves.
    expect(
      await screen.findByPlaceholderText("What's happening?")
    ).toBeInTheDocument();
    expect(api.getCurrentUser).toHaveBeenCalled();
  });
});

describe("Login flow", () => {
  it("logs in via the form and lands on the feed", async () => {
    const user = userEvent.setup();
    api.getCurrentUser.mockRejectedValueOnce(new Error("401")); // start anonymous

    renderApp("/");
    const emailField = await screen.findByLabelText("Email");

    // Once logged in, the backend recognises the session.
    api.login.mockResolvedValue({});
    api.getCurrentUser.mockResolvedValue({ pk: 1, email: "sam@example.com" });

    await user.type(emailField, "sam@example.com");
    await user.type(screen.getByLabelText("Password"), "correcthorse");
    await user.click(screen.getByRole("button", { name: "Log in" }));

    expect(
      await screen.findByPlaceholderText("What's happening?")
    ).toBeInTheDocument();
    expect(api.login).toHaveBeenCalledWith("sam@example.com", "correcthorse");
  });

  it("shows an error and stays on the login page on bad credentials", async () => {
    const user = userEvent.setup();
    api.getCurrentUser.mockRejectedValue(new Error("401"));

    renderApp("/");
    const emailField = await screen.findByLabelText("Email");

    api.login.mockRejectedValue(
      apiError("Unable to log in with provided credentials.", 400)
    );

    await user.type(emailField, "sam@example.com");
    await user.type(screen.getByLabelText("Password"), "wrong");
    await user.click(screen.getByRole("button", { name: "Log in" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /unable to log in/i
    );
    // Still on the login page, not the feed.
    expect(
      screen.queryByPlaceholderText("What's happening?")
    ).not.toBeInTheDocument();
  });

  it("logs out and returns to the login page", async () => {
    const user = userEvent.setup();
    api.getCurrentUser.mockResolvedValue({ pk: 1, email: "sam@example.com" });
    api.logout.mockResolvedValue({});

    renderApp("/");
    await screen.findByPlaceholderText("What's happening?");

    // Log out now lives behind the avatar menu, so open that first.
    await user.click(screen.getByRole("button", { name: "Account menu" }));
    await user.click(screen.getByRole("menuitem", { name: "Log out" }));

    expect(api.logout).toHaveBeenCalled();
    expect(
      await screen.findByRole("button", { name: "Log in" })
    ).toBeInTheDocument();
  });

  it("🔒 drops any half-written message drafts on the way out", async () => {
    const user = userEvent.setup();
    api.getCurrentUser.mockResolvedValue({ pk: 1, email: "sam@example.com" });
    api.logout.mockResolvedValue({});

    // A draft lives outside React (`drafts.js`) so it can survive the thread
    // view unmounting — which means nothing tears it down on its own. On a
    // shared computer the next person to open the drawer isn't the person who
    // typed it, so sign-out has to.
    setDraft(7, "something I never sent");

    renderApp("/");
    await screen.findByPlaceholderText("What's happening?");
    await user.click(screen.getByRole("button", { name: "Account menu" }));
    await user.click(screen.getByRole("menuitem", { name: "Log out" }));

    await screen.findByRole("button", { name: "Log in" });
    expect(getDraft(7)).toBe("");
  });

  it("🔒 empties the query cache on the way out", async () => {
    const user = userEvent.setup();
    api.getCurrentUser.mockResolvedValue({ pk: 1, email: "sam@example.com" });
    api.logout.mockResolvedValue({});

    const { queryClient } = renderApp("/");
    await screen.findByPlaceholderText("What's happening?");

    // Stand in for what a real session leaves in there: the conversation list
    // carries other people's message text, and TanStack paints cached data
    // before any refetch — so on a shared computer the next person to log in
    // reads it (#194).
    queryClient.setQueryData(["conversations"], {
      results: [{ id: 3, last_message: { body: "see you at 6" } }],
    });
    queryClient.setQueryData(["user", 9], { display_name: "Ada Lovelace" });

    await user.click(screen.getByRole("button", { name: "Account menu" }));
    await user.click(screen.getByRole("menuitem", { name: "Log out" }));

    await screen.findByRole("button", { name: "Log in" });
    // Two unrelated keys, because the claim is "the cache", not "the one key
    // this test seeded" — but named keys rather than a count of everything in
    // there, which would fail the day a public page fetches something.
    expect(queryClient.getQueryData(["conversations"])).toBeUndefined();
    expect(queryClient.getQueryData(["user", 9])).toBeUndefined();
  });

  it("🔒 lets go of the session even when the logout request fails", async () => {
    const user = userEvent.setup();
    api.getCurrentUser.mockResolvedValue({ pk: 1, email: "sam@example.com" });
    // The POST never lands — a blink of network, or a session the server had
    // already dropped. The menu sends you to the login page either way, so
    // everything this browser holds has to go with it or the next person to log
    // in here inherits it.
    api.logout.mockRejectedValue(apiError("Request failed", 500));

    const { queryClient } = renderApp("/");
    await screen.findByPlaceholderText("What's happening?");
    setDraft(7, "something I never sent");
    queryClient.setQueryData(["conversations"], { results: [{ id: 3 }] });

    await user.click(screen.getByRole("button", { name: "Account menu" }));
    await user.click(screen.getByRole("menuitem", { name: "Log out" }));

    expect(await screen.findByRole("button", { name: "Log in" })).toBeInTheDocument();
    expect(getDraft(7)).toBe("");
    expect(queryClient.getQueryData(["conversations"])).toBeUndefined();
  });

  it("🔒 drops the last person's session when someone else logs in without one", async () => {
    const user = userEvent.setup();
    // A tab still holding Ada's session, navigated to the public login page —
    // she logged out in her *other* tab, or followed the link from sign-up.
    // Nothing here ever goes null, so `useSessionReset` never fires and the
    // guard has to be on the sign-in side.
    api.getCurrentUser.mockResolvedValue({ pk: 1, email: "ada@example.com" });

    const { queryClient } = renderApp("/login");
    await screen.findByLabelText("Email");
    setDraft(7, "something Ada never sent");
    queryClient.setQueryData(["conversations"], { results: [{ id: 3 }] });

    api.login.mockResolvedValue({});
    api.getCurrentUser.mockResolvedValue({ pk: 2, email: "grace@example.com" });

    await user.type(screen.getByLabelText("Email"), "grace@example.com");
    await user.type(screen.getByLabelText("Password"), "correcthorse");
    await user.click(screen.getByRole("button", { name: "Log in" }));

    await screen.findByPlaceholderText("What's happening?");
    expect(queryClient.getQueryData(["conversations"])).toBeUndefined();
    expect(getDraft(7)).toBe("");
  });

  it("keeps your own drafts when you log back in as yourself", async () => {
    const user = userEvent.setup();
    api.getCurrentUser.mockResolvedValue({ pk: 1, email: "ada@example.com" });

    renderApp("/login");
    await screen.findByLabelText("Email");
    // Same person, same browser — an outbox that survives is the point of
    // having one, so the guard is "somebody else", not "a sign-in happened".
    setDraft(7, "something I'll finish in a minute");

    api.login.mockResolvedValue({});

    await user.type(screen.getByLabelText("Email"), "ada@example.com");
    await user.type(screen.getByLabelText("Password"), "correcthorse");
    await user.click(screen.getByRole("button", { name: "Log in" }));

    await screen.findByPlaceholderText("What's happening?");
    expect(getDraft(7)).toBe("something I'll finish in a minute");
  });
});

describe("Sign-up flow", () => {
  it("sends you to verify your email and does not log you in", async () => {
    const user = userEvent.setup();
    api.getCurrentUser.mockRejectedValue(new Error("401"));
    api.register.mockResolvedValue({ detail: "Almost there…" });

    renderApp("/signup");

    await user.type(await screen.findByLabelText("First name"), "New");
    await user.type(screen.getByLabelText("Last name"), "Member");
    await user.type(screen.getByLabelText("Email"), "new@example.com");
    await user.type(screen.getByLabelText("Password"), "correcthorsebattery");
    await user.type(
      screen.getByLabelText("Confirm password"),
      "correcthorsebattery"
    );
    // Must agree to the Terms + Privacy Policy before the button enables.
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "Sign up" }));

    // We land on the verify-email step, pre-addressed with the signup email.
    expect(
      await screen.findByRole("heading", { name: "Verify your email" })
    ).toBeInTheDocument();
    expect(screen.getByText("new@example.com")).toBeInTheDocument();
    expect(api.register).toHaveBeenCalledWith(
      "new@example.com",
      "correcthorsebattery",
      "New",
      "Member",
      true
    );
    // A pending account is not logged in — no feed.
    expect(
      screen.queryByPlaceholderText("What's happening?")
    ).not.toBeInTheDocument();
  });

  it("verifies with the 6-digit code, then points you back to log in", async () => {
    const user = userEvent.setup();
    api.getCurrentUser.mockRejectedValue(new Error("401"));
    api.verifyEmail.mockResolvedValue({ detail: "Your email address is verified." });

    // Arrive on the verify step as sign-up leaves us: address in router state.
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <MemoryRouter
          initialEntries={[{ pathname: "/verify-email", state: { email: "new@example.com" } }]}
        >
          <AuthProvider>
            <App />
          </AuthProvider>
        </MemoryRouter>
      </QueryClientProvider>
    );

    await user.type(
      await screen.findByLabelText("Verification code"),
      "048213"
    );
    await user.click(screen.getByRole("button", { name: "Verify" }));

    expect(api.verifyEmail).toHaveBeenCalledWith("new@example.com", "048213");
    expect(
      await screen.findByRole("heading", { name: "Email verified" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Back to log in" })
    ).toBeInTheDocument();
  });

  it("won't submit until the terms are accepted", async () => {
    const user = userEvent.setup();
    api.getCurrentUser.mockRejectedValue(new Error("401"));

    renderApp("/signup");

    await user.type(await screen.findByLabelText("First name"), "New");
    await user.type(screen.getByLabelText("Last name"), "Member");
    await user.type(screen.getByLabelText("Email"), "new@example.com");
    await user.type(screen.getByLabelText("Password"), "correcthorsebattery");
    await user.type(
      screen.getByLabelText("Confirm password"),
      "correcthorsebattery"
    );

    // Consent unticked → the button is disabled and nothing is sent.
    expect(screen.getByRole("button", { name: "Sign up" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Sign up" }));
    expect(api.register).not.toHaveBeenCalled();

    // Tick it → the button enables.
    await user.click(screen.getByRole("checkbox"));
    expect(screen.getByRole("button", { name: "Sign up" })).toBeEnabled();
  });

  it("blocks submission when the passwords don't match", async () => {
    const user = userEvent.setup();
    api.getCurrentUser.mockRejectedValue(new Error("401"));

    renderApp("/signup");

    await user.type(await screen.findByLabelText("First name"), "New");
    await user.type(screen.getByLabelText("Last name"), "Member");
    await user.type(screen.getByLabelText("Email"), "new@example.com");
    await user.type(screen.getByLabelText("Password"), "one-password");
    await user.type(screen.getByLabelText("Confirm password"), "different");
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "Sign up" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/don't match/i);
    expect(api.register).not.toHaveBeenCalled();
  });

  it("reaches the Terms and Privacy pages (public, before login)", async () => {
    api.getCurrentUser.mockRejectedValue(new Error("401"));

    renderApp("/terms");
    expect(
      await screen.findByRole("heading", { name: "Terms of Service" })
    ).toBeInTheDocument();

    renderApp("/privacy");
    expect(
      await screen.findByRole("heading", { name: "Privacy Policy" })
    ).toBeInTheDocument();
  });
});
