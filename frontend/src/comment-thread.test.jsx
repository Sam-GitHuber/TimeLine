import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import CommentThread from "./components/CommentThread.jsx";
import { renderWithAuth } from "./test-utils.jsx";
import { api } from "./api.js";

/**
 * The branching line a comment thread is drawn as (issue #135).
 *
 * Each comment draws its own pieces of line — an elbow onto its parent's line,
 * that line carried *past* it to the sibling below, and its own stem down to its
 * replies — rather than the thread drawing one line behind everything. That's
 * what lets any node be collapsed, and it's also what makes it easy to get
 * subtly wrong: drop the last-sibling guard and every run trails off past the
 * comment it should end on; hand a node the wrong depth and deep threads keep a
 * step they should have shrunk. Either way the thread still *renders*, and every
 * test that only checks the text is still green — hence these.
 *
 * **What these can't check is the geometry itself**, which lives in `index.css`
 * (jsdom doesn't apply stylesheets, and the offsets are `calc()` over custom
 * properties). So they assert the wiring — which piece of line each comment
 * draws, and the step it takes — and the widths/offsets those classes resolve
 * to have to be checked by eye in a browser.
 */
vi.mock("./api.js", () => ({
  api: {
    getComments: vi.fn(),
    addComment: vi.fn(),
    reportContent: vi.fn(),
    toggleReaction: vi.fn(),
    getReactors: vi.fn(),
  },
}));

function comment(id, { replies = [] } = {}) {
  return {
    id,
    author: { id: 100 + id, display_name: `Author ${id}`, avatar_thumb: null },
    text: `Comment ${id}`,
    created_at: "2026-07-13T08:00:00Z",
    reactions: [],
    replies,
  };
}

/** A single chain `1 → 2 → … → depth`, each comment the only reply to the one above. */
function chainOf(depth) {
  let node = comment(depth);
  for (let id = depth - 1; id >= 1; id -= 1) node = comment(id, { replies: [node] });
  return node;
}

function renderThread(props = {}) {
  return renderWithAuth(<CommentThread postId={7} {...props} />);
}

beforeEach(() => {
  vi.clearAllMocks();
  // jsdom doesn't implement scrollIntoView; the deep-link effect calls it.
  Element.prototype.scrollIntoView = vi.fn();
  api.getComments.mockResolvedValue([]);
});

describe("the lines", () => {
  const linesOf = (container, id) => {
    const li = container.querySelector(`#comment-${id}`);
    return {
      // Its own pieces only — a descendant's must not count as this comment's.
      branch: li.querySelector(":scope > .tl-branch"),
      past: li.querySelector(":scope > .tl-past"),
      stem: li.querySelector(":scope > .tl-comment-row > .tl-stem"),
    };
  };

  it("hooks every comment onto its parent, and stops the run at the last one", async () => {
    api.getComments.mockResolvedValue([comment(1), comment(2), comment(3)]);
    const { container } = renderThread();
    await screen.findByText("Comment 1");

    // Every comment reaches out to the line above it — top-level ones included,
    // whose parent line is the post's spine.
    for (const id of [1, 2, 3]) expect(linesOf(container, id).branch).toBeTruthy();

    // The run carries on past the comments that have a sibling below…
    expect(linesOf(container, 1).past).toBeTruthy();
    expect(linesOf(container, 2).past).toBeTruthy();
    // …and stops at the last, so the line ends on a face rather than trailing
    // off into the composer.
    expect(linesOf(container, 3).past).toBeNull();
  });

  it("grows a stem only while a comment's replies are showing", async () => {
    api.getComments.mockResolvedValue([comment(1, { replies: [comment(2)] })]);
    const { container } = renderThread();
    await screen.findByText("Comment 1");

    // Collapsed: there is nothing below to hold up, so no stem.
    expect(linesOf(container, 1).stem).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: /Show 1 reply/ }));
    await screen.findByText("Comment 2");

    expect(linesOf(container, 1).stem).toBeTruthy();
    // The reply hangs off that stem, and is alone, so the run ends on it.
    expect(linesOf(container, 2).branch).toBeTruthy();
    expect(linesOf(container, 2).past).toBeNull();
  });

  it("shrinks the step only once a thread is genuinely deep", async () => {
    // Deep-linking the leaf opens the whole trail down to it.
    api.getComments.mockResolvedValue([chainOf(6)]);
    const { container } = renderThread({ highlightCommentId: 6 });
    await screen.findByText("Comment 6");

    const isDeep = (id) =>
      container.querySelector(`#comment-${id}`).classList.contains("tl-comment--deep");

    // The first four levels keep the full step — it has to clear the faces the
    // parent's line now runs past.
    for (const id of [1, 2, 3, 4]) expect(isDeep(id)).toBe(false);
    // Past that it shrinks, so a deep thread doesn't march off a narrow screen.
    expect(isDeep(5)).toBe(true);
    expect(isDeep(6)).toBe(true);
  });

  it("never spaces comments with a gap, which would break the line", async () => {
    // The trap this port exists to fix: `space-y-4` on the lists. A gap is empty
    // space no segment covers, so it shows up as a break in the line — spacing
    // belongs *inside* a comment, as bottom padding the run above covers.
    api.getComments.mockResolvedValue([
      comment(1, { replies: [comment(2)] }),
      comment(3),
    ]);
    const { container } = renderThread();
    await screen.findByText("Comment 1");
    await userEvent.click(screen.getByRole("button", { name: /Show 1 reply/ }));
    await screen.findByText("Comment 2");

    const lists = container.querySelectorAll("ul.tl-comment-list");
    expect(lists.length).toBe(2); // top level + the opened replies
    for (const list of lists) {
      expect(list.className).not.toMatch(/space-y-|gap-|\bpt-|\bmt-/);
    }
  });
});

describe("the thread's ground", () => {
  it("sits on the surface rather than in a card of its own", async () => {
    // A raised white box read as a comments widget bolted underneath the post;
    // the thread is meant to be the same line, one level down.
    api.getComments.mockResolvedValue([comment(1)]);
    const { container } = renderThread();
    await screen.findByText("Comment 1");

    const thread = container.querySelector(".tl-thread");
    expect(thread).toBeTruthy();
    expect(thread.className).not.toMatch(/bg-raised|border/);
  });
});

describe("the tree", () => {
  it("keeps replies collapsed until asked for, then reveals them", async () => {
    api.getComments.mockResolvedValue([
      comment(1, { replies: [comment(2), comment(3)] }),
    ]);
    renderThread();
    await screen.findByText("Comment 1");

    expect(screen.queryByText("Comment 2")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Show 2 replies/ }));
    expect(await screen.findByText("Comment 2")).toBeInTheDocument();
    expect(screen.getByText("Comment 3")).toBeInTheDocument();
  });

  it("opening the reply box reveals the sub-thread it will land in", async () => {
    api.getComments.mockResolvedValue([comment(1, { replies: [comment(2)] })]);
    renderThread();
    await screen.findByText("Comment 1");

    await userEvent.click(screen.getByRole("button", { name: "Reply" }));
    // The hidden sibling replies come into view, so the reply you're about to
    // write doesn't land somewhere you can't see.
    expect(await screen.findByText("Comment 2")).toBeInTheDocument();
  });

  it("posts a reply carrying its parent id", async () => {
    api.getComments.mockResolvedValue([comment(1)]);
    api.addComment.mockResolvedValue({});
    renderThread();
    await screen.findByText("Comment 1");

    await userEvent.click(screen.getByRole("button", { name: "Reply" }));
    await userEvent.type(
      screen.getByPlaceholderText(/Reply to Author 1/),
      "mine"
    );
    // Two buttons now read "Reply": the one that opened the box, and the box's
    // own submit below it.
    const [, submit] = screen.getAllByRole("button", { name: "Reply" });
    await userEvent.click(submit);

    await waitFor(() =>
      expect(api.addComment).toHaveBeenCalledWith(7, {
        text: "mine",
        parent: 1,
      })
    );
  });
});
