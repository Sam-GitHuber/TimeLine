import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App.jsx";
import { renderWithAuth } from "./test-utils.jsx";
import { api } from "./api.js";

// The pages now fetch from the real API, so we mock the api module and assert
// the app renders what the backend returns and calls the right endpoints on
// actions. Feed ordering + follow-scoping themselves are enforced (and tested)
// on the backend; here we check the frontend renders the given order and wires
// compose/follow to the API.
vi.mock("./api.js", () => ({
  api: {
    getFeed: vi.fn(),
    getPage: vi.fn(),
    createPost: vi.fn(),
    listUsers: vi.fn(),
    getUser: vi.fn(),
    getUserPosts: vi.fn(),
    follow: vi.fn(),
    unfollow: vi.fn(),
    getFollowRequests: vi.fn(),
    approveRequest: vi.fn(),
    rejectRequest: vi.fn(),
  },
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
  api.getUser.mockResolvedValue({ id: 2, display_name: "Priya", follow_status: "none" });
  api.getUserPosts.mockResolvedValue(page([]));
  api.getFollowRequests.mockResolvedValue(page([]));
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
      expect(api.createPost).toHaveBeenCalledWith("Hello from the test")
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
  it("shows only the subject's posts (accepted follow), not posts from elsewhere", async () => {
    api.getUser.mockResolvedValue({
      id: 2,
      display_name: "Priya",
      follow_status: "accepted",
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

  it("hides posts behind a private message when you don't follow them", async () => {
    api.getUser.mockResolvedValue({
      id: 2,
      display_name: "Priya",
      follow_status: "none",
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

  it("does not show a follow button on your own profile", async () => {
    api.getUser.mockResolvedValue({ id: 1, display_name: "you", follow_status: "none" });
    // fakeUser.pk is 1, so /u/1 is your own profile.
    renderAt("/u/1");
    await screen.findByRole("heading", { name: "you" });
    expect(
      screen.queryByRole("button", { name: /follow/i })
    ).not.toBeInTheDocument();
  });
});

describe("People page", () => {
  it("lists other members and sends a follow request on click", async () => {
    const user = userEvent.setup();
    api.listUsers.mockResolvedValue(
      page([{ id: 2, display_name: "Priya", follow_status: "none" }])
    );
    api.follow.mockResolvedValue({ follow_status: "pending" });

    renderAt("/people");

    await screen.findByText("Priya");
    await user.click(screen.getByRole("button", { name: "Follow" }));

    await waitFor(() => expect(api.follow).toHaveBeenCalledWith(2));
  });

  it("shows a pending request as 'Requested'", async () => {
    api.listUsers.mockResolvedValue(
      page([{ id: 3, display_name: "Tom", follow_status: "pending" }])
    );

    renderAt("/people");

    expect(
      await screen.findByRole("button", { name: "Requested" })
    ).toBeInTheDocument();
  });

  it("reaches members past the first page via 'Load more'", async () => {
    const user = userEvent.setup();
    api.listUsers.mockResolvedValue(
      page(
        [{ id: 2, display_name: "Priya", follow_status: "none" }],
        "http://localhost:8000/api/users/?page=2"
      )
    );
    api.getPage.mockResolvedValue(
      page([{ id: 3, display_name: "Tom", follow_status: "none" }])
    );

    renderAt("/people");

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
    api.getFollowRequests.mockResolvedValue(
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

  it("reaches requests past the first page via 'Load more'", async () => {
    const user = userEvent.setup();
    api.getFollowRequests.mockResolvedValue(
      page(
        [
          {
            id: 55,
            requester: { id: 2, display_name: "Priya" },
            created_at: "2026-07-04T08:00:00Z",
          },
        ],
        "http://localhost:8000/api/follow-requests/?page=2"
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
    renderAt("/", {
      user: { pk: 9, email: "boss@example.com", display_name: "boss", is_staff: true },
    });
    const adminLink = await screen.findByRole("link", { name: "Admin" });
    expect(adminLink).toHaveAttribute("href", expect.stringContaining("/admin/"));
    expect(adminLink).toHaveAttribute("target", "_blank");
  });

  it("hides the Admin link for non-staff users", async () => {
    renderAt("/", {
      user: { pk: 10, email: "member@example.com", display_name: "member", is_staff: false },
    });
    await screen.findByText(/your feed is empty/i);
    expect(screen.queryByRole("link", { name: "Admin" })).not.toBeInTheDocument();
  });
});

describe("Navigation", () => {
  it("navigates from the feed to a profile via a post author link", async () => {
    const user = userEvent.setup();
    api.getFeed.mockResolvedValue(
      page([post(1, 2, "Priya", "Sunrise over the harbour", "2026-07-04T08:00:00Z")])
    );
    api.getUser.mockResolvedValue({ id: 2, display_name: "Priya", follow_status: "accepted" });
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
