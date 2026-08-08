import { useState } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { onlineManager, useQuery } from "@tanstack/react-query";
import { renderWithAuth, fakeUser, offlineError } from "./test-utils.jsx";
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

// **When** the badge clears (issue #230). The server stamps `last_seen_at` as a
// side effect of the comments GET, so the cache write that mirrors it has to
// wait for that request — not fire on the click that will eventually make it.
// The card used to zero the count in `onClick`, with nothing to roll back, so a
// failed GET left it claiming you'd read comments the server still had unseen.
//
// These go through a mounted feed query rather than a static prop, because the
// prop is exactly what the bug can't be seen in: `markPostCommentsSeen` writes
// to the *cache*, and it's the feed handing the card a fresh post that turns
// that into a badge going out.
describe("the 'N new' badge follows the request, not the click", () => {
  function FeedHarness({ children = null }) {
    const { data } = useQuery({
      queryKey: ["feed", { includeGroups: false }],
      queryFn: async () => ({
        pages: [
          {
            results: [makePost({ comment_count: 12, new_comment_count: 3 })],
            next: null,
          },
        ],
        pageParams: [undefined],
      }),
      // The card's re-render must come from the seen-write, not from a refetch
      // that would repaint the badge either way.
      staleTime: Infinity,
    });
    const post = data?.pages[0]?.results[0];
    return (
      <>
        {post && <PostCard post={post} />}
        {children}
      </>
    );
  }

  function cachedNewCount(queryClient) {
    return queryClient.getQueryData(["feed", { includeGroups: false }])
      ?.pages[0].results[0].new_comment_count;
  }

  it("keeps the badge when the comments request fails", async () => {
    api.getComments.mockRejectedValue(offlineError());
    const user = userEvent.setup();
    const { queryClient } = renderWithAuth(<FeedHarness />);
    expect(await screen.findByText(/3 new/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Comments/ }));
    expect(
      await screen.findByText(/Couldn't load comments/),
    ).toBeInTheDocument();

    // Collapsing is the ordinary thing to do next, and it's where the lie used
    // to show: three comments still unread server-side, and nothing saying so.
    await user.click(screen.getByRole("button", { name: /Hide comments/ }));
    expect(screen.getByText(/3 new/)).toBeInTheDocument();
    expect(cachedNewCount(queryClient)).toBe(3);
  });

  it("clears the badge once the thread has actually loaded", async () => {
    api.getComments.mockResolvedValue([]);
    const user = userEvent.setup();
    const { queryClient } = renderWithAuth(<FeedHarness />);
    expect(await screen.findByText(/3 new/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Comments/ }));
    await waitFor(() => expect(cachedNewCount(queryClient)).toBe(0));

    await user.click(screen.getByRole("button", { name: /Hide comments/ }));
    expect(screen.queryByText(/3 new/)).not.toBeInTheDocument();
  });

  it("marks seen on a permalink, which opens without a click", async () => {
    // /p/:id mounts the thread already expanded, so there's no open-comments
    // action to hang the write on — the request is the only signal there is.
    // The permalink is opened *after* the feed has loaded, which is both the
    // real ordering (you clicked through from it) and the only one this can
    // assert: the write mirrors into whatever is cached when the GET lands, so
    // a post list still in flight at that moment isn't reached. That's a
    // pre-existing gap, unchanged here, and it self-heals — every list refetches
    // on its next mount at staleTime 0.
    api.getComments.mockResolvedValue([]);
    const { queryClient, setProps } = renderWithAuth(<FeedHarness />);
    expect(await screen.findByText(/3 new/)).toBeInTheDocument();

    setProps(
      <FeedHarness>
        <PostCard
          post={makePost({ comment_count: 12, new_comment_count: 3 })}
          defaultCommentsOpen
        />
      </FeedHarness>,
    );

    await waitFor(() => expect(cachedNewCount(queryClient)).toBe(0));
  });

  it("keeps the badge on a reopen whose refetch fails", async () => {
    // The reopen path, and the reason the write is bolted to the `queryFn`
    // rather than to an effect on `data`. The tree is still cached from the
    // first visit, so `useQuery` hands it back *synchronously* — an effect
    // gated on `data` fires on that stale tree before the refetch has been
    // anywhere near the server, which is #230 again with extra steps.
    api.getComments.mockResolvedValue([]);
    const user = userEvent.setup();
    const { queryClient } = renderWithAuth(<FeedHarness />);
    expect(await screen.findByText(/3 new/)).toBeInTheDocument();

    // First visit: opens, loads, clears.
    await user.click(screen.getByRole("button", { name: /Comments/ }));
    await waitFor(() => expect(cachedNewCount(queryClient)).toBe(0));
    await user.click(screen.getByRole("button", { name: /Hide comments/ }));

    // A new comment lands and a feed refetch legitimately re-badges the card.
    queryClient.setQueryData(["feed", { includeGroups: false }], (data) => ({
      ...data,
      pages: [
        {
          results: [makePost({ comment_count: 13, new_comment_count: 1 })],
          next: null,
        },
      ],
    }));
    expect(await screen.findByText(/1 new/)).toBeInTheDocument();

    // Reopen with no signal. The cached tree paints immediately — but it is a
    // *tree*, not a stamp, and the server still has that comment unseen.
    api.getComments.mockRejectedValue(offlineError());
    await user.click(screen.getByRole("button", { name: /Comments/ }));
    await waitFor(() => expect(api.getComments).toHaveBeenCalledTimes(2));

    await user.click(screen.getByRole("button", { name: /Hide comments/ }));
    expect(screen.getByText(/1 new/)).toBeInTheDocument();
    expect(cachedNewCount(queryClient)).toBe(1);
  });

  it("says so, rather than crashing, when the browser is offline", async () => {
    // Not a rejection — a query the *browser* paused. With the default
    // `networkMode: 'online'` this sits at `status: 'pending'`,
    // `fetchStatus: 'paused'`, so `isLoading` (isPending && isFetching) is
    // **false** with no data behind it. Rendering on `!isLoading && !isError`
    // meant `comments.length` on undefined, and with no ErrorBoundary in the
    // tree (#299) that unmounts the entire app to a blank page. Being offline
    // is the likeliest way this request ever fails, so it must be a sentence.
    api.getComments.mockResolvedValue([]);
    const user = userEvent.setup();
    const { queryClient } = renderWithAuth(<FeedHarness />);
    expect(await screen.findByText(/3 new/)).toBeInTheDocument();

    // The signal goes after the feed is on screen — which is how this happens:
    // you're reading, you go into a tunnel, you tap Comments.
    onlineManager.setOnline(false);
    try {
      await user.click(screen.getByRole("button", { name: /Comments/ }));
      expect(
        await screen.findByText(/Waiting for a connection/),
      ).toBeInTheDocument();
      // Nothing was stamped, so nothing is mirrored.
      expect(cachedNewCount(queryClient)).toBe(3);
    } finally {
      onlineManager.setOnline(true);
    }
  });

  it("keeps an open thread when a background refetch fails", async () => {
    // A failed *refresh* of something already on screen is not a reason to take
    // it off screen: the comments being read, and any half-typed reply in the
    // composer, would go with it.
    //
    // This pins behaviour rather than fixing it — it holds on `main` too, since
    // TanStack keeps handing back the data it has. It's here because rewriting
    // the render gates (for the paused-query crash above) is exactly the kind of
    // change that could quietly start letting `isError` win over a loaded tree.
    api.getComments.mockResolvedValue([
      {
        id: 7,
        author: { id: 2, display_name: "Ada", avatar_thumb: null },
        text: "already loaded",
        created_at: "2026-07-01T11:00:00Z",
        edited_at: null,
        deleted_at: null,
        replies: [],
        reactions: [],
      },
    ]);
    const user = userEvent.setup();
    const { queryClient } = renderWithAuth(<FeedHarness />);
    expect(await screen.findByText(/3 new/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Comments/ }));
    expect(await screen.findByText("already loaded")).toBeInTheDocument();

    api.getComments.mockRejectedValue(offlineError());
    // Inside `act`, so the rejection is *rendered* before anything is asserted.
    // Awaiting `refetchQueries` alone only settles the query — React hasn't
    // re-rendered yet, and the assertions below then read a DOM from before the
    // failure and pass against any implementation at all.
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ["comments", "post", 42] });
    });
    expect(queryClient.getQueryState(["comments", "post", 42]).status).toBe(
      "error",
    );

    expect(screen.getByText("already loaded")).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Write a comment/)).toBeInTheDocument();
    expect(
      screen.queryByText(/Couldn't load comments/),
    ).not.toBeInTheDocument();
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
    const rendered = renderWithAuth(<CommentThread target={{ postId: 42 }} />);
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
