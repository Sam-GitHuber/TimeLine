import { useState } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithAuth, fakeUser } from "./test-utils.jsx";
import PostCard from "./components/PostCard.jsx";
import CommentThread from "./components/CommentThread.jsx";
import { api } from "./api.js";

// The counts next to "Comments" (issue #63): a total that matches the pruned
// thread, and a "N new" badge that clears once the thread is opened.

vi.mock("./api.js", () => ({
  api: {
    getComments: vi.fn(),
    addComment: vi.fn(),
    reportContent: vi.fn(),
    toggleReaction: vi.fn(),
    getReactors: vi.fn(),
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

  it("hides the 'N new' badge while the thread is open", async () => {
    const user = userEvent.setup();
    renderWithAuth(
      <PostCard post={makePost({ comment_count: 12, new_comment_count: 3 })} />,
    );
    expect(screen.getByText(/3 new/)).toBeInTheDocument();

    // Opening the thread marks the comments seen server-side; the badge hides
    // (you're looking at them now) while the total stays.
    await user.click(screen.getByRole("button", { name: /Comments/ }));
    expect(screen.queryByText(/3 new/)).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Hide comments/ }),
    ).toHaveTextContent("· 12");
  });

  it("re-badges when new comments arrive after you've looked", async () => {
    // The badge follows the (server-shaped) prop, with no permanent per-card
    // "opened" flag — so a later refetch that legitimately raises the count
    // shows the badge again. A small stateful harness stands in for the feed
    // cache handing PostCard a fresh post object.
    function Harness() {
      const [post, setPost] = useState(
        makePost({ comment_count: 12, new_comment_count: 0 }),
      );
      return (
        <>
          <button
            onClick={() =>
              setPost(makePost({ comment_count: 13, new_comment_count: 1 }))
            }
          >
            refetch
          </button>
          <PostCard post={post} />
        </>
      );
    }
    const user = userEvent.setup();
    renderWithAuth(<Harness />);
    expect(screen.queryByText(/new/)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "refetch" }));
    expect(screen.getByText(/1 new/)).toBeInTheDocument();
  });
});

// The other half of keeping that total honest (issue #215). The count lives on
// the *post*, not the comment tree, so a mutation that refetches only the tree
// leaves the button reading "Comments · 3" over a list of four — on this card
// and on every other surface holding the same post.
describe("posting a comment refreshes the count", () => {
  function listData(...posts) {
    return { pages: [{ results: posts, next: null }], pageParams: [undefined] };
  }

  async function postAComment() {
    api.getComments.mockResolvedValue([]);
    const rendered = renderWithAuth(<CommentThread postId={42} />);
    const { queryClient } = rendered;
    // Seed the surfaces a real session would have loaded before opening a
    // thread: the home feed, a profile timeline, a group timeline, the
    // permalink. Each carries its own copy of the post — and its own count.
    queryClient.setQueryData(
      ["feed", { includeGroups: false }],
      listData({ id: 42, comment_count: 3, new_comment_count: 0 }),
    );
    queryClient.setQueryData(
      ["userPosts", 1],
      listData({ id: 42, comment_count: 3, new_comment_count: 0 }),
    );
    queryClient.setQueryData(
      ["groupPosts", 5],
      listData({ id: 42, comment_count: 3, new_comment_count: 0 }),
    );
    queryClient.setQueryData(["post", "42"], {
      id: 42,
      comment_count: 3,
      new_comment_count: 0,
    });

    const user = userEvent.setup();
    const box = await screen.findByPlaceholderText(/Write a comment/);
    await user.type(box, "a fourth comment");
    await user.click(screen.getByRole("button", { name: "Comment" }));
    return { queryClient, user };
  }

  it("invalidates every post list holding the post, not just the thread", async () => {
    api.addComment.mockResolvedValue({ id: 99 });
    const { queryClient } = await postAComment();

    await waitFor(() => expect(api.addComment).toHaveBeenCalled());

    // The thread is mounted, so its invalidation shows up as a refetch rather
    // than a lasting flag — the second GET is the evidence.
    await waitFor(() => expect(api.getComments).toHaveBeenCalledTimes(2));

    // The count-bearing surfaces aren't mounted here, so they stay marked and
    // refetch the moment you go back to them. Before #215 none of these moved.
    for (const queryKey of [
      ["feed"],
      ["userPosts"],
      ["groupPosts"],
      ["post", "42"],
    ]) {
      const matches = queryClient.getQueryCache().findAll({ queryKey });
      expect(matches.length).toBeGreaterThan(0);
      await waitFor(() =>
        expect(matches.every((q) => q.state.isInvalidated)).toBe(true),
      );
    }
  });

  it("leaves the caches alone when the post is refused", async () => {
    // Only a success moves the count. Invalidating on the attempt would refetch
    // the whole feed for nothing every time a comment fails to send.
    api.addComment.mockRejectedValue(new Error("nope"));
    const { queryClient } = await postAComment();

    await waitFor(() => expect(api.addComment).toHaveBeenCalled());

    expect(queryClient.getQueryState(["post", "42"]).isInvalidated).toBe(false);
  });
});
