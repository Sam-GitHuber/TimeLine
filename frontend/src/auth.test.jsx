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
import App from "./App.jsx";

// The real provider, exactly as main.jsx wires it, at a given URL — including
// the QueryClientProvider the app depends on for data fetching.
function renderApp(route = "/") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[route]}>
        <AuthProvider>
          <App />
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
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
      new Error("Unable to log in with provided credentials.")
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
});

describe("Sign-up flow", () => {
  it("shows a pending-approval message and does not log you in", async () => {
    const user = userEvent.setup();
    api.getCurrentUser.mockRejectedValue(new Error("401"));
    api.register.mockResolvedValue({
      detail: "Account created and pending approval.",
    });

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

    expect(await screen.findByText(/pending approval/i)).toBeInTheDocument();
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
