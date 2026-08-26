import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Routes, Route } from "react-router-dom";
import userEvent from "@testing-library/user-event";
import FollowButton from "./components/FollowButton.jsx";
import ProfilePage from "./pages/ProfilePage.jsx";
import { api } from "./api.js";
import { renderWithAuth, apiError, unauthoredError } from "./test-utils.jsx";

/**
 * Follow / Following on someone else's profile (issue #382).
 *
 * Two things are pinned here, and they're different in kind:
 *
 *   - **Where the control may appear.** Following is only possible with a
 *     connection, and only on someone else's page. A toggle rendered anywhere
 *     else is a button that can only ever fail.
 *   - **What a rejected write says** (#236). A failed follow leaves a control
 *     still reading "Follow" — indistinguishable from a click that never
 *     registered — so it has to say so, in place, and the message has to retire
 *     when (and only when) the server confirms the attempt landed after all.
 */
// The profile's Message button lives beside this one and pulls in the messages
// drawer's context; a real `MessagingProvider` would need the drawer mounted,
// which is nothing to do with what's under test here. Same stub `groups.test`
// uses, for the same reason.
vi.mock("./messaging.jsx", () => ({
  useMessaging: vi.fn(() => ({ openThread: vi.fn(), isWriting: false })),
}));

vi.mock("./api.js", () => ({
  api: {
    followUser: vi.fn(),
    unfollowUser: vi.fn(),
    getUser: vi.fn(),
    getUserPosts: vi.fn(),
    getPage: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    blockUser: vi.fn(),
    unblockUser: vi.fn(),
    openConversation: vi.fn(),
    getDisconnectImpact: vi.fn(),
  },
}));

/** Render a control, and hand back a rerender that keeps the same provider. */
function renderButton(ui) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrap = (node) => (
    <QueryClientProvider client={queryClient}>{node}</QueryClientProvider>
  );
  const utils = render(wrap(ui));
  return {
    ...utils,
    queryClient,
    setProps: (node) => utils.rerender(wrap(node)),
  };
}

const page = (results) => ({ count: results.length, next: null, results });

beforeEach(() => {
  vi.clearAllMocks();
  api.followUser.mockResolvedValue({ detail: "Following.", is_following: true });
  api.unfollowUser.mockResolvedValue({
    detail: "Unfollowed.",
    is_following: false,
  });
  api.getUserPosts.mockResolvedValue(page([]));
  api.getDisconnectImpact.mockResolvedValue({ chats: [] });
});

describe("FollowButton", () => {
  it("reads Follow when you don't follow them, and calls the follow endpoint", async () => {
    renderButton(
      <FollowButton userId={2} displayName="Priya" isFollowing={false} />
    );
    const button = screen.getByRole("button", { name: "Follow" });
    await userEvent.click(button);
    expect(api.followUser).toHaveBeenCalledWith(2);
    expect(api.unfollowUser).not.toHaveBeenCalled();
  });

  it("reads Following when you do, and calls the unfollow endpoint", async () => {
    renderButton(
      <FollowButton userId={2} displayName="Priya" isFollowing />
    );
    await userEvent.click(screen.getByRole("button", { name: "Following" }));
    expect(api.unfollowUser).toHaveBeenCalledWith(2);
    expect(api.followUser).not.toHaveBeenCalled();
  });

  it("refreshes the profile it sits on, and nothing else", async () => {
    // Following moves no visibility boundary, so unlike the Connect and Block
    // buttons beside it this must *not* reach for `invalidateConnectionChange`.
    // `is_following` lives on the profile payload and nowhere else.
    const { queryClient } = renderButton(
      <FollowButton userId={2} displayName="Priya" isFollowing={false} />
    );
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    await userEvent.click(screen.getByRole("button", { name: "Follow" }));
    await waitFor(() => expect(invalidate).toHaveBeenCalled());
    expect(invalidate.mock.calls.map(([arg]) => arg.queryKey)).toEqual([
      ["user", 2],
    ]);
  });

  it("says so when the follow is refused, rather than looking like a missed click", async () => {
    api.followUser.mockRejectedValue(unauthoredError(500));
    renderButton(
      <FollowButton userId={2} displayName="Priya" isFollowing={false} />
    );
    await userEvent.click(screen.getByRole("button", { name: "Follow" }));
    const alert = await screen.findByRole("alert");
    // Names which of the two actions failed, and what is consequently still
    // true — not "something went wrong".
    expect(alert).toHaveTextContent(/Couldn’t follow Priya/);
    expect(alert).toHaveTextContent(/won’t be notified/);
  });

  it("says the opposite thing when the unfollow is refused", async () => {
    api.unfollowUser.mockRejectedValue(unauthoredError(500));
    renderButton(<FollowButton userId={2} displayName="Priya" isFollowing />);
    await userEvent.click(screen.getByRole("button", { name: "Following" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/Couldn’t unfollow Priya/);
    expect(alert).toHaveTextContent(/still being notified/);
  });

  it("prefers the server's own words where it has any", async () => {
    // They disconnected while this page was open: the server's sentence says
    // why, where a generic fallback would leave the reader guessing.
    api.followUser.mockRejectedValue(
      apiError("You can only follow people you're connected with.", 400)
    );
    renderButton(
      <FollowButton userId={2} displayName="Priya" isFollowing={false} />
    );
    await userEvent.click(screen.getByRole("button", { name: "Follow" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "You can only follow people you're connected with."
    );
  });

  it("retires the message once the server confirms the attempt landed", async () => {
    // The request went through and only its response was lost, so "couldn't
    // follow" would now be sitting under a button reading "Following".
    api.followUser.mockRejectedValue(unauthoredError(500));
    const { setProps } = renderButton(
      <FollowButton userId={2} displayName="Priya" isFollowing={false} />
    );
    await userEvent.click(screen.getByRole("button", { name: "Follow" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();

    setProps(<FollowButton userId={2} displayName="Priya" isFollowing />);
    await waitFor(() =>
      expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    );
  });

  it("does not carry the message to another person's profile", async () => {
    // `/u/:id` is one route, so moving between profiles changes the props
    // without remounting — "Couldn’t follow Priya" must not end up under
    // Dana's button.
    api.followUser.mockRejectedValue(unauthoredError(500));
    const { setProps } = renderButton(
      <FollowButton userId={2} displayName="Priya" isFollowing={false} />
    );
    await userEvent.click(screen.getByRole("button", { name: "Follow" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Priya/);

    // Same follow state, different person — the state the retirement check
    // alone would have missed.
    setProps(
      <FollowButton userId={3} displayName="Dana" isFollowing={false} />
    );
    await waitFor(() =>
      expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    );
  });

  it("keeps the message while the answer stays what it was", async () => {
    // A refetch that agrees with the pre-attempt state is not confirmation of
    // anything; clearing on any resync is the swallow #231 describes.
    api.followUser.mockRejectedValue(unauthoredError(500));
    const { setProps } = renderButton(
      <FollowButton userId={2} displayName="Priya" isFollowing={false} />
    );
    await userEvent.click(screen.getByRole("button", { name: "Follow" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();

    setProps(
      <FollowButton userId={2} displayName="Priya" isFollowing={false} />
    );
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });
});

describe("the Follow toggle on a profile", () => {
  const profile = (extra) => ({
    id: 2,
    display_name: "Priya",
    connection_status: "connected",
    bio: "",
    avatar_thumb: null,
    is_blocked: false,
    is_following: false,
    ...extra,
  });

  // Mounted under its real route: `ProfilePage` reads `:id` from the params
  // and adjusts state during render on it, so a bare render (id `undefined`,
  // hence `NaN`) never settles.
  const showProfile = (route = "/u/2") =>
    renderWithAuth(
      <Routes>
        <Route path="/u/:id" element={<ProfilePage />} />
      </Routes>,
      { route }
    );

  it("appears on a connection's profile, in the state the server reported", async () => {
    api.getUser.mockResolvedValue(profile({ is_following: true }));
    showProfile();
    expect(
      await screen.findByRole("button", { name: "Following" })
    ).toBeInTheDocument();
  });

  it("is absent unless you're connected", async () => {
    // Every non-connected state: the server would refuse, so offering the
    // control would be offering a button that can only fail.
    for (const connection_status of ["none", "requested", "incoming"]) {
      api.getUser.mockResolvedValue(profile({ connection_status }));
      const { unmount } = showProfile();
      await screen.findByRole("heading", { name: "Priya" });
      expect(
        screen.queryByRole("button", { name: /^Follow(ing)?$/ })
      ).not.toBeInTheDocument();
      unmount();
    }
  });

  it("is absent on someone you've blocked", async () => {
    api.getUser.mockResolvedValue(
      profile({ is_blocked: true, connection_status: "none" })
    );
    showProfile();
    await screen.findByRole("heading", { name: "Priya" });
    expect(
      screen.queryByRole("button", { name: /^Follow(ing)?$/ })
    ).not.toBeInTheDocument();
  });

  it("is absent on your own profile", async () => {
    // You can't follow yourself, and there is nothing on your own page for it
    // to mean. `fakeUser` is pk 1.
    api.getUser.mockResolvedValue(
      profile({ id: 1, display_name: "you", connection_status: "none" })
    );
    showProfile("/u/1");
    await screen.findByRole("button", { name: "Edit profile" });
    expect(
      screen.queryByRole("button", { name: /^Follow(ing)?$/ })
    ).not.toBeInTheDocument();
  });
});
