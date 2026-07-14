import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App.jsx";
import { renderWithAuth } from "./test-utils.jsx";
import { api } from "./api.js";

// The pages now fetch from the real API, so we mock the api module and assert
// the app renders what the backend returns and calls the right endpoints on
// actions. Feed ordering + connection-scoping themselves are enforced (and
// tested) on the backend; here we check the frontend renders the given order
// and wires compose/connect/comment to the API.
vi.mock("./api.js", () => ({
  api: {
    getFeed: vi.fn(),
    getPage: vi.fn(),
    createPost: vi.fn(),
    getComments: vi.fn(),
    addComment: vi.fn(),
    listUsers: vi.fn(),
    listConnections: vi.fn(),
    listDiscover: vi.fn(),
    getUser: vi.fn(),
    getUserPosts: vi.fn(),
    updateProfile: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    getConnectionRequests: vi.fn(),
    approveRequest: vi.fn(),
    rejectRequest: vi.fn(),
    getConversations: vi.fn(),
    openConversation: vi.fn(),
    getConversation: vi.fn(),
    getMessages: vi.fn(),
    sendMessage: vi.fn(),
    deleteMessage: vi.fn(),
    markConversationRead: vi.fn(),
    getUnreadMessageCount: vi.fn(),
    getGroups: vi.fn(),
    getGroupInvites: vi.fn(),
    blockUser: vi.fn(),
    unblockUser: vi.fn(),
    getUnreadNotificationCount: vi.fn(),
    getNotifications: vi.fn(),
    markNotificationsSeen: vi.fn(),
    markNotificationAddressed: vi.fn(),
  },
  CONVERSATION_LIST_POLL_MS: 12000,
  MESSAGE_POLL_MS: 4000,
  NOTIFICATIONS_POLL_MS: 12000,
}));

// A DRF-style paginated payload.
function page(results, next = null) {
  return { count: results.length, next, previous: null, results };
}

function post(id, authorId, name, text, createdAt) {
  return {
    id,
    author: { id: authorId, display_name: name },
    text,
    created_at: createdAt,
  };
}

function renderAt(path = "/", auth) {
  return renderWithAuth(<App />, { route: path, auth });
}

beforeEach(() => {
  vi.clearAllMocks();
  // Sensible empty defaults; individual tests override as needed.
  api.getFeed.mockResolvedValue(page([]));
  api.listUsers.mockResolvedValue(page([]));
  api.listConnections.mockResolvedValue(page([]));
  api.listDiscover.mockResolvedValue(page([]));
  api.getUser.mockResolvedValue({
    id: 2,
    display_name: "Priya",
    connection_status: "none",
  });
  api.getUserPosts.mockResolvedValue(page([]));
  api.updateProfile.mockResolvedValue({ pk: 1 });
  api.getComments.mockResolvedValue([]);
  api.getConnectionRequests.mockResolvedValue(page([]));
  api.getUnreadMessageCount.mockResolvedValue({ count: 0 });
  api.getGroupInvites.mockResolvedValue({ count: 0, results: [] });
  api.getGroups.mockResolvedValue(page([]));
  api.getConversations.mockResolvedValue(page([]));
  api.getUnreadNotificationCount.mockResolvedValue({ count: 0 });
  api.getNotifications.mockResolvedValue(page([]));
  api.markNotificationsSeen.mockResolvedValue({ updated: 0 });
});

describe("Feed page", () => {
  it("renders posts strictly newest-first, in the exact API order", async () => {
    api.getFeed.mockResolvedValue(
      page([
        post(1, 2, "Priya", "Sunrise over the harbour", "2026-07-04T08:00:00Z"),
        post(2, 3, "Tom", "Midweek walk", "2026-07-01T08:00:00Z"),
        post(3, 4, "Sam", "Coffee first", "2026-06-27T08:00:00Z"),
      ])
    );

    renderAt("/");

    // Assert the *whole* sequence, not just first vs last — a stray client-side
    // sort or a bad flatMap that reorders the middle must fail this test. The
    // reverse-chronological render is the project's #1 non-negotiable.
    const posts = await screen.findAllByRole("article");
    expect(posts.map((el) => el.textContent)).toEqual([
      expect.stringContaining("Sunrise over the harbour"),
      expect.stringContaining("Midweek walk"),
      expect.stringContaining("Coffee first"),
    ]);
    // And the rendered <time> stamps are non-increasing down the list.
    const times = Array.from(document.querySelectorAll("time")).map(
      (el) => el.dateTime
    );
    expect(times).toEqual([...times].sort().reverse());
  });

  it("shows an empty-state message when the feed has no posts", async () => {
    renderAt("/");
    expect(await screen.findByText(/your feed is empty/i)).toBeInTheDocument();
  });

  it("creates a post and shows it in the feed after submit", async () => {
    const user = userEvent.setup();
    // Empty on first load; the post appears once compose invalidates the feed
    // and it refetches. This guards the invalidation key — a typo'd/broken key
    // would leave the empty-state up and the new post invisible.
    const newPost = post(9, 1, "you", "Hello from the test", "2026-07-04T12:00:00Z");
    api.getFeed
      .mockResolvedValueOnce(page([]))
      .mockResolvedValue(page([newPost]));
    api.createPost.mockResolvedValue(newPost);

    renderAt("/");
    await screen.findByText(/your feed is empty/i);

    await user.type(
      screen.getByPlaceholderText("What's happening?"),
      "Hello from the test"
    );
    await user.click(screen.getByRole("button", { name: "Post" }));

    await waitFor(() =>
      expect(api.createPost).toHaveBeenCalledWith(
        "Hello from the test",
        [],
        null
      )
    );
    expect(
      await screen.findByText("Hello from the test")
    ).toBeInTheDocument();
  });

  it("disables the Post button for whitespace-only input", async () => {
    const user = userEvent.setup();
    renderAt("/");
    await screen.findByText(/your feed is empty/i);

    await user.type(screen.getByPlaceholderText("What's happening?"), "   ");
    expect(screen.getByRole("button", { name: "Post" })).toBeDisabled();
    expect(api.createPost).not.toHaveBeenCalled();
  });
});

describe("Profile page", () => {
  it("shows only the subject's posts (connected), not posts from elsewhere", async () => {
    api.getUser.mockResolvedValue({
      id: 2,
      display_name: "Priya",
      connection_status: "connected",
    });
    api.getUserPosts.mockResolvedValue(
      page([post(1, 2, "Priya", "Booked flights", "2026-06-30T21:00:00Z")])
    );
    // If the profile ever rendered from the wrong query (e.g. reused the feed
    // cache), this stranger's post would leak onto Priya's page.
    api.getFeed.mockResolvedValue(
      page([post(7, 3, "Tom", "Third loaf this week", "2026-07-02T09:00:00Z")])
    );

    renderAt("/u/2");

    expect(
      await screen.findByRole("heading", { name: "Priya" })
    ).toBeInTheDocument();
    expect(screen.getByText(/Booked flights/)).toBeInTheDocument();
    expect(screen.queryByText(/Third loaf this week/)).not.toBeInTheDocument();
    expect(api.getUserPosts).toHaveBeenCalledWith(2);
  });

  it("hides posts behind a private message when you aren't connected", async () => {
    api.getUser.mockResolvedValue({
      id: 2,
      display_name: "Priya",
      connection_status: "none",
    });

    renderAt("/u/2");

    await screen.findByRole("heading", { name: "Priya" });
    expect(screen.getByText(/posts are private/i)).toBeInTheDocument();
  });

  it("shows a not-found message for a real 404", async () => {
    api.getUser.mockRejectedValue(
      Object.assign(new Error("Not found"), { status: 404 })
    );
    renderAt("/u/999");
    expect(await screen.findByText("User not found")).toBeInTheDocument();
  });

  it("shows a retryable error (not 'not found') for a transient failure", async () => {
    // A 5xx/network blip must not masquerade as "this user doesn't exist".
    api.getUser.mockRejectedValue(
      Object.assign(new Error("Server error"), { status: 500 })
    );
    renderAt("/u/2");
    expect(
      await screen.findByRole("button", { name: /try again/i })
    ).toBeInTheDocument();
    expect(screen.queryByText("User not found")).not.toBeInTheDocument();
  });

  it("does not show a connect button on your own profile", async () => {
    api.getUser.mockResolvedValue({
      id: 1,
      display_name: "you",
      connection_status: "none",
    });
    // fakeUser.pk is 1, so /u/1 is your own profile.
    renderAt("/u/1");
    await screen.findByRole("heading", { name: "you" });
    expect(
      screen.queryByRole("button", { name: /connect/i })
    ).not.toBeInTheDocument();
  });

  it("edits your own profile in place — no separate page (issue #53)", async () => {
    const user = userEvent.setup();
    api.getUser.mockResolvedValue({
      id: 1,
      display_name: "you",
      connection_status: "none",
    });

    renderAt("/u/1");
    // Editing happens right here: the button flips the header into a form, it
    // doesn't navigate off to /settings.
    await user.click(await screen.findByRole("button", { name: "Edit profile" }));

    await user.type(screen.getByLabelText("First name"), "Ada");
    await user.type(screen.getByLabelText("Last name"), "Lovelace");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(api.updateProfile).toHaveBeenCalledTimes(1));
    const args = api.updateProfile.mock.calls[0][0];
    expect(args.first_name).toBe("Ada");
    expect(args.last_name).toBe("Lovelace");
    // Saving drops back to the read-only header, on the same page.
    expect(
      await screen.findByRole("button", { name: "Edit profile" })
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("First name")).not.toBeInTheDocument();
  });
});

describe("People page — Connections tab (default)", () => {
  it("lands on your connections and links each through to their profile", async () => {
    api.listConnections.mockResolvedValue(
      page([{ id: 2, display_name: "Priya", connection_status: "connected" }])
    );

    renderAt("/people");

    // Connections is the default tab, so it's what a returning user sees first.
    expect(
      screen.getByRole("tab", { name: "Connections" })
    ).toHaveAttribute("aria-selected", "true");
    const nameLink = await screen.findByRole("link", { name: "Priya" });
    expect(nameLink).toHaveAttribute("href", "/u/2");
    // No Connect/disconnect button clutters the directory.
    expect(screen.queryByRole("button", { name: "Connected" })).not.toBeInTheDocument();
  });

  it("offers a way to find people when you have no connections", async () => {
    const user = userEvent.setup();
    api.listConnections.mockResolvedValue(page([]));
    api.listDiscover.mockResolvedValue(
      page([{ id: 9, display_name: "Sam", connection_status: "none" }])
    );

    renderAt("/people");

    // The empty state sends you to Discover.
    await user.click(await screen.findByRole("button", { name: "Find people" }));
    expect(await screen.findByText("Sam")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Discover" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
  });
});

describe("People page — Discover tab", () => {
  it("lists other members and sends a connection request on click", async () => {
    const user = userEvent.setup();
    api.listDiscover.mockResolvedValue(
      page([{ id: 2, display_name: "Priya", connection_status: "none" }])
    );
    api.connect.mockResolvedValue({ connection_status: "requested" });

    renderAt("/people?tab=discover");

    await screen.findByText("Priya");
    await user.click(screen.getByRole("button", { name: "Connect" }));

    await waitFor(() => expect(api.connect).toHaveBeenCalledWith(2));
  });

  it("shows a pending request as 'Requested'", async () => {
    api.listDiscover.mockResolvedValue(
      page([{ id: 3, display_name: "Tom", connection_status: "requested" }])
    );

    renderAt("/people?tab=discover");

    expect(
      await screen.findByRole("button", { name: "Requested" })
    ).toBeInTheDocument();
  });

  it("shows an incoming request as 'Approve'", async () => {
    api.listDiscover.mockResolvedValue(
      page([{ id: 4, display_name: "Ada", connection_status: "incoming" }])
    );

    renderAt("/people?tab=discover");

    expect(
      await screen.findByRole("button", { name: "Approve" })
    ).toBeInTheDocument();
  });

  it("reaches members past the first page via 'Load more'", async () => {
    const user = userEvent.setup();
    api.listDiscover.mockResolvedValue(
      page(
        [{ id: 2, display_name: "Priya", connection_status: "none" }],
        "http://localhost:8000/api/users/?filter=discover&page=2"
      )
    );
    api.getPage.mockResolvedValue(
      page([{ id: 3, display_name: "Tom", connection_status: "none" }])
    );

    renderAt("/people?tab=discover");

    await screen.findByText("Priya");
    // Tom is on page 2 — unreachable before (the bug this fixes) and hidden now.
    expect(screen.queryByText("Tom")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByText("Tom")).toBeInTheDocument();
  });
});

describe("Requests page", () => {
  it("lists incoming requests and approves one on click", async () => {
    const user = userEvent.setup();
    api.getConnectionRequests.mockResolvedValue(
      page([
        {
          id: 55,
          requester: { id: 2, display_name: "Priya" },
          created_at: "2026-07-04T08:00:00Z",
        },
      ])
    );
    api.approveRequest.mockResolvedValue({ detail: "Approved." });

    renderAt("/requests");

    await screen.findByText("Priya");
    await user.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() => expect(api.approveRequest).toHaveBeenCalledWith(55));
  });

  it("is reachable as a tab within the People hub", async () => {
    const user = userEvent.setup();
    api.listConnections.mockResolvedValue(
      page([{ id: 2, display_name: "Priya", connection_status: "connected" }])
    );
    api.getConnectionRequests.mockResolvedValue(
      page([
        {
          id: 55,
          requester: { id: 3, display_name: "Ada" },
          created_at: "2026-07-04T08:00:00Z",
        },
      ])
    );

    renderAt("/people");

    // Connections is the default tab: your people show, requests don't.
    await screen.findByText("Priya");
    expect(screen.queryByText("Ada")).not.toBeInTheDocument();

    // The Requests tab carries the pending count and reveals the request.
    await user.click(screen.getByRole("tab", { name: /Requests/ }));
    expect(await screen.findByText("Ada")).toBeInTheDocument();
    expect(
      await screen.findByRole("button", { name: "Approve" })
    ).toBeInTheDocument();
  });

  it("redirects the legacy /requests URL to the Requests tab", async () => {
    api.getConnectionRequests.mockResolvedValue(
      page([
        {
          id: 55,
          requester: { id: 3, display_name: "Ada" },
          created_at: "2026-07-04T08:00:00Z",
        },
      ])
    );

    renderAt("/requests");

    // The redirect lands on People with the Requests tab active.
    expect(await screen.findByText("Ada")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Requests/ })).toHaveAttribute(
      "aria-selected",
      "true"
    );
  });

  it("reaches requests past the first page via 'Load more'", async () => {
    const user = userEvent.setup();
    api.getConnectionRequests.mockResolvedValue(
      page(
        [
          {
            id: 55,
            requester: { id: 2, display_name: "Priya" },
            created_at: "2026-07-04T08:00:00Z",
          },
        ],
        "http://localhost:8000/api/connection-requests/?page=2"
      )
    );
    api.getPage.mockResolvedValue(
      page([
        {
          id: 56,
          requester: { id: 3, display_name: "Tom" },
          created_at: "2026-07-03T08:00:00Z",
        },
      ])
    );

    renderAt("/requests");

    await screen.findByText("Priya");
    // The 2nd-page request must be approvable, not stranded off-list.
    expect(screen.queryByText("Tom")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByText("Tom")).toBeInTheDocument();
  });
});

describe("Admin link", () => {
  it("shows an Admin link only for staff users", async () => {
    const user = userEvent.setup();
    renderAt("/", {
      user: { pk: 9, email: "boss@example.com", display_name: "boss", is_staff: true },
    });
    // Admin now lives inside the avatar menu.
    await user.click(await screen.findByRole("button", { name: "Account menu" }));
    const adminLink = await screen.findByRole("menuitem", { name: "Admin" });
    expect(adminLink).toHaveAttribute("href", expect.stringContaining("/admin/"));
    expect(adminLink).toHaveAttribute("target", "_blank");
  });

  it("hides the Admin link for non-staff users", async () => {
    const user = userEvent.setup();
    renderAt("/", {
      user: { pk: 10, email: "member@example.com", display_name: "member", is_staff: false },
    });
    await screen.findByText(/your feed is empty/i);
    await user.click(screen.getByRole("button", { name: "Account menu" }));
    expect(screen.queryByRole("menuitem", { name: "Admin" })).not.toBeInTheDocument();
  });
});

describe("Comments", () => {
  const feedPost = post(
    1,
    2,
    "Priya",
    "Sunrise over the harbour",
    "2026-07-04T08:00:00Z"
  );

  function comment(id, name, text, replies = []) {
    return {
      id,
      author: { id: 2, display_name: name },
      parent: null,
      text,
      created_at: "2026-07-04T09:00:00Z",
      replies,
    };
  }

  it("lazily loads and shows the comment tree when expanded", async () => {
    const user = userEvent.setup();
    api.getFeed.mockResolvedValue(page([feedPost]));
    api.getComments.mockResolvedValue([comment(10, "Priya", "Lovely shot")]);

    renderAt("/");
    await screen.findByText("Sunrise over the harbour");

    // Not fetched until you open the thread — the feed shouldn't fire a request
    // per post on load.
    expect(api.getComments).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Comments" }));

    expect(await screen.findByText("Lovely shot")).toBeInTheDocument();
    expect(api.getComments).toHaveBeenCalledWith(1);
  });

  it("collapses replies by default and reveals them on demand", async () => {
    const user = userEvent.setup();
    api.getFeed.mockResolvedValue(page([feedPost]));
    // A top-level comment with one reply under it.
    api.getComments.mockResolvedValue([
      comment(10, "Priya", "Lovely shot", [
        {
          id: 11,
          author: { id: 3, display_name: "Tom" },
          parent: 10,
          text: "Where was this taken?",
          created_at: "2026-07-04T10:00:00Z",
          replies: [],
        },
      ]),
    ]);

    renderAt("/");
    await screen.findByText("Sunrise over the harbour");
    await user.click(screen.getByRole("button", { name: "Comments" }));

    // The top-level comment shows, but its reply stays tucked behind a toggle —
    // so a long thread reads as a clean list, not a wall of nested replies.
    expect(await screen.findByText("Lovely shot")).toBeInTheDocument();
    expect(screen.queryByText("Where was this taken?")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /show 1 reply/i }));
    expect(await screen.findByText("Where was this taken?")).toBeInTheDocument();
  });

  it("posts a new top-level comment", async () => {
    const user = userEvent.setup();
    api.getFeed.mockResolvedValue(page([feedPost]));
    api.getComments.mockResolvedValue([]);
    api.addComment.mockResolvedValue({ id: 11 });

    renderAt("/");
    await screen.findByText("Sunrise over the harbour");
    await user.click(screen.getByRole("button", { name: "Comments" }));

    await user.type(
      await screen.findByPlaceholderText("Write a comment…"),
      "Where is this?"
    );
    await user.click(screen.getByRole("button", { name: "Comment" }));

    await waitFor(() =>
      expect(api.addComment).toHaveBeenCalledWith(1, {
        text: "Where is this?",
        parent: null,
      })
    );
  });
});

describe("Navigation", () => {
  it("navigates from the feed to a profile via a post author link", async () => {
    const user = userEvent.setup();
    api.getFeed.mockResolvedValue(
      page([post(1, 2, "Priya", "Sunrise over the harbour", "2026-07-04T08:00:00Z")])
    );
    api.getUser.mockResolvedValue({
      id: 2,
      display_name: "Priya",
      connection_status: "connected",
    });
    api.getUserPosts.mockResolvedValue(
      page([post(1, 2, "Priya", "Sunrise over the harbour", "2026-07-04T08:00:00Z")])
    );

    renderAt("/");

    const links = await screen.findAllByRole("link", { name: "Priya" });
    await user.click(links[0]);

    expect(
      await screen.findByRole("heading", { name: "Priya" })
    ).toBeInTheDocument();
  });
});

// The Groups (left) and Messages (right) companion drawers are 400px each. Below
// 800px there isn't room for both, so opening one closes the other; on a wide
// viewport both stay open. `useMediaQuery` reads `window.matchMedia`, stubbed to
// "no match" (wide) in test/setup.js — the narrow test overrides it per-test.
describe("Companion drawer coordination", () => {
  let originalMatchMedia;

  beforeEach(() => {
    originalMatchMedia = window.matchMedia;
  });
  afterEach(() => {
    window.matchMedia = originalMatchMedia;
  });

  function setViewportTooNarrowForBoth(narrow) {
    window.matchMedia = (query) => ({
      matches: narrow,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    });
  }

  it("closes the groups drawer when opening messages on a narrow viewport", async () => {
    setViewportTooNarrowForBoth(true);
    const user = userEvent.setup();
    renderAt("/");

    await user.click(screen.getByRole("button", { name: /Groups/ }));
    expect(
      await screen.findByRole("dialog", { name: "Groups" })
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Messages/ }));
    expect(
      await screen.findByRole("dialog", { name: "Messages" })
    ).toBeInTheDocument();
    // The groups drawer must have been dismissed — no room for both.
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Groups" })).toBeNull()
    );
  });

  it("keeps both drawers open on a wide viewport", async () => {
    setViewportTooNarrowForBoth(false);
    const user = userEvent.setup();
    renderAt("/");

    await user.click(screen.getByRole("button", { name: /Groups/ }));
    expect(
      await screen.findByRole("dialog", { name: "Groups" })
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Messages/ }));
    expect(
      await screen.findByRole("dialog", { name: "Messages" })
    ).toBeInTheDocument();
    // Both fit side by side, so the groups drawer stays open.
    expect(screen.getByRole("dialog", { name: "Groups" })).toBeInTheDocument();
  });
});
