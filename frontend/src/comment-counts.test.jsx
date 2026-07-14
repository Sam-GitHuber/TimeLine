import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithAuth, fakeUser } from "./test-utils.jsx";
import PostCard from "./components/PostCard.jsx";
import { api } from "./api.js";

// The counts next to "Comments" (issue #63): a total that matches the pruned
// thread, and a "N new" badge that clears once the thread is opened.

vi.mock("./api.js", () => ({
  api: {
    getComments: vi.fn(),
    reportContent: vi.fn(),
  },
}));

function makePost(overrides = {}) {
  return {
    id: 42,
    author: { id: fakeUser.pk, display_name: "You", avatar_thumb: null },
    text: "a post",
    images: [],
    group: null,
    reactions: [],
    comment_count: 0,
    new_comment_count: 0,
    created_at: "2026-07-01T10:00:00Z",
    edited_at: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  api.getComments.mockResolvedValue([]);
});

describe("PostCard comment counts", () => {
  it("shows the total next to Comments when there are comments", () => {
    renderWithAuth(
      <PostCard post={makePost({ comment_count: 12, new_comment_count: 0 })} />,
    );
    const button = screen.getByRole("button", { name: /Comments/ });
    expect(button).toHaveTextContent("· 12");
  });

  it("shows no count for an empty thread", () => {
    renderWithAuth(<PostCard post={makePost()} />);
    const button = screen.getByRole("button", { name: /Comments/ });
    expect(button).toHaveTextContent("Comments");
    expect(button).not.toHaveTextContent("·");
  });

  it("shows the 'N new' badge when there are unseen comments", () => {
    renderWithAuth(
      <PostCard post={makePost({ comment_count: 12, new_comment_count: 3 })} />,
    );
    expect(screen.getByText(/3 new/)).toBeInTheDocument();
  });

  it("clears the 'N new' badge once the thread is opened", async () => {
    const user = userEvent.setup();
    renderWithAuth(
      <PostCard post={makePost({ comment_count: 12, new_comment_count: 3 })} />,
    );
    expect(screen.getByText(/3 new/)).toBeInTheDocument();

    // Opening the thread marks the comments seen server-side, so the stale
    // "new" badge should disappear immediately.
    await user.click(screen.getByRole("button", { name: /Comments/ }));
    expect(screen.queryByText(/3 new/)).not.toBeInTheDocument();
    // The total stays.
    expect(
      screen.getByRole("button", { name: /Hide comments/ }),
    ).toHaveTextContent("· 12");
  });
});
