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
  it("renders posts in the order the API returns them (newest first)", async () => {
    api.getFeed.mockResolvedValue(
      page([
        post(1, 2, "Priya", "Sunrise over the harbour", "2026-07-04T08:00:00Z"),
        post(2, 3, "Tom", "Coffee first", "2026-06-27T08:00:00Z"),
      ])
    );

    renderAt("/");

    const posts = await screen.findAllByRole("article");
    expect(posts[0]).toHaveTextContent("Sunrise over the harbour");
    expect(posts[posts.length - 1]).toHaveTextContent("Coffee first");
  });

  it("shows an empty-state message when the feed has no posts", async () => {
    renderAt("/");
    expect(await screen.findByText(/your feed is empty/i)).toBeInTheDocument();
  });

  it("creates a real post when the compose box is submitted", async () => {
    const user = userEvent.setup();
    api.createPost.mockResolvedValue(
      post(9, 1, "you", "Hello from the test", "2026-07-04T12:00:00Z")
    );

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
  it("shows the user's posts once you have an accepted follow", async () => {
    api.getUser.mockResolvedValue({
      id: 2,
      display_name: "Priya",
      follow_status: "accepted",
    });
    api.getUserPosts.mockResolvedValue(
      page([post(1, 2, "Priya", "Booked flights", "2026-06-30T21:00:00Z")])
    );

    renderAt("/u/2");

    expect(
      await screen.findByRole("heading", { name: "Priya" })
    ).toBeInTheDocument();
    expect(screen.getByText(/Booked flights/)).toBeInTheDocument();
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

  it("shows a not-found message when the user id doesn't exist", async () => {
    api.getUser.mockRejectedValue(new Error("Not found"));
    renderAt("/u/999");
    expect(await screen.findByText("User not found")).toBeInTheDocument();
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
