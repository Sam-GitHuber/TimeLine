import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { Routes, Route } from "react-router-dom";
import PostPage from "./pages/PostPage.jsx";
import { renderWithAuth } from "./test-utils.jsx";
import { api } from "./api.js";

// The post permalink page (`/p/:id`) — where notifications deep-link. We assert
// it fetches the single post, opens the thread, and that ?comment=<id> reveals a
// deep reply (auto-expanding its collapsed ancestor) and highlights it.
vi.mock("./api.js", () => ({
  api: {
    getPost: vi.fn(),
    getComments: vi.fn(),
    toggleReaction: vi.fn(),
    getReactors: vi.fn(),
    addComment: vi.fn(),
  },
}));

function renderPost(route) {
  return renderWithAuth(
    <Routes>
      <Route path="p/:id" element={<PostPage />} />
    </Routes>,
    { route }
  );
}

const POST = {
  id: 5,
  author: { id: 2, display_name: "Priya", avatar_thumb: null },
  text: "the post body",
  reactions: [],
  images: [],
};

// A top-level comment with one nested reply — the reply starts collapsed inside
// its parent unless it's deep-linked.
const COMMENTS = [
  {
    id: 100,
    author: { id: 2, display_name: "Ann", avatar_thumb: null },
    text: "top comment",
    created_at: "2026-07-13T08:00:00Z",
    reactions: [],
    replies: [
      {
        id: 200,
        author: { id: 3, display_name: "Bob", avatar_thumb: null },
        text: "the deep reply",
        created_at: "2026-07-13T09:00:00Z",
        reactions: [],
        replies: [],
      },
    ],
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  // jsdom doesn't implement scrollIntoView; the deep-link effect calls it.
  Element.prototype.scrollIntoView = vi.fn();
  api.getPost.mockResolvedValue(POST);
  api.getComments.mockResolvedValue(COMMENTS);
});

describe("PostPage permalink", () => {
  it("renders the post and opens its thread", async () => {
    renderPost("/p/5");
    expect(await screen.findByText("the post body")).toBeInTheDocument();
    // Comments open by default on the permalink (postId is the post's numeric id).
    await waitFor(() => expect(api.getComments).toHaveBeenCalledWith(5));
    expect(await screen.findByText("top comment")).toBeInTheDocument();
  });

  it("keeps a reply collapsed when it isn't deep-linked", async () => {
    renderPost("/p/5");
    expect(await screen.findByText("top comment")).toBeInTheDocument();
    // The nested reply is hidden behind its collapsed parent.
    expect(screen.queryByText("the deep reply")).not.toBeInTheDocument();
  });

  it("reveals and highlights a deep-linked reply via ?comment=", async () => {
    const { container } = renderPost("/p/5?comment=200");
    // The ancestor auto-expands, so the otherwise-collapsed reply is visible.
    expect(await screen.findByText("the deep reply")).toBeInTheDocument();
    // …and it's scrolled to and highlighted.
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
    expect(container.querySelector("#comment-200 .ring-accent")).toBeTruthy();
  });

  it("shows a friendly message for a post you can't see (404)", async () => {
    const err = new Error("Not found");
    err.status = 404;
    api.getPost.mockRejectedValue(err);
    renderPost("/p/999");
    expect(
      await screen.findByText(/doesn.t exist, or you don.t have access/i)
    ).toBeInTheDocument();
  });
});
