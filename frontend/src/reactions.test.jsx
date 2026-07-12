import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithAuth } from "./test-utils.jsx";
import ReactionBar from "./components/ReactionBar.jsx";
import PostCard from "./components/PostCard.jsx";
import { api } from "./api.js";

vi.mock("./api.js", () => ({
  api: {
    toggleReaction: vi.fn(),
    getReactors: vi.fn(),
    getComments: vi.fn(),
  },
}));

// Stub the emoji picker: the real one loads the `emoji-picker-element` web
// component (browser-only APIs jsdom lacks). The stub proves the picker opens
// and that choosing an emoji flows through to a toggle — the picker's own
// internals aren't ours to test.
vi.mock("./components/EmojiPickerPopover.jsx", () => ({
  default: ({ onPick }) => (
    <div data-testid="emoji-picker">
      <button type="button" onClick={() => onPick("🎉")}>
        pick party
      </button>
    </div>
  ),
}));

beforeEach(() => {
  vi.clearAllMocks();
  api.getReactors.mockResolvedValue([]);
});

describe("ReactionBar", () => {
  it("renders each emoji with its count, flagging your own", () => {
    renderWithAuth(
      <ReactionBar
        postId={7}
        reactions={[
          { emoji: "👍", count: 3, reacted: false },
          { emoji: "❤️", count: 1, reacted: true },
        ]}
      />,
    );
    expect(screen.getByText("👍")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
    // The one you reacted to is pressed.
    const mine = screen.getByRole("button", { pressed: true });
    expect(mine).toHaveTextContent("❤️");
  });

  it("toggles a reaction on a chip click and updates the count from the response", async () => {
    api.toggleReaction.mockResolvedValue({
      reactions: [{ emoji: "👍", count: 4, reacted: true }],
    });
    renderWithAuth(
      <ReactionBar
        postId={7}
        reactions={[{ emoji: "👍", count: 3, reacted: false }]}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: /👍/ }));

    expect(api.toggleReaction).toHaveBeenCalledWith({ postId: 7, emoji: "👍" });
    expect(await screen.findByText("4")).toBeInTheDocument();
  });

  it("opens the quick reactions and reacts with a one-tap emoji", async () => {
    api.toggleReaction.mockResolvedValue({
      reactions: [{ emoji: "👍", count: 1, reacted: true }],
    });
    renderWithAuth(<ReactionBar commentId={12} reactions={[]} />);

    // The add button opens the compact quick popover (not the full picker).
    await userEvent.click(screen.getByRole("button", { name: /add a reaction/i }));
    await userEvent.click(await screen.findByRole("button", { name: /React 👍/ }));

    expect(api.toggleReaction).toHaveBeenCalledWith({ commentId: 12, emoji: "👍" });
  });

  it("expands from quick reactions to the full picker via 'more'", async () => {
    api.toggleReaction.mockResolvedValue({
      reactions: [{ emoji: "🎉", count: 1, reacted: true }],
    });
    renderWithAuth(<ReactionBar commentId={12} reactions={[]} />);

    await userEvent.click(screen.getByRole("button", { name: /add a reaction/i }));
    // No full picker until you ask for "more".
    expect(screen.queryByTestId("emoji-picker")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /more emoji/i }));
    await userEvent.click(await screen.findByText("pick party"));

    expect(api.toggleReaction).toHaveBeenCalledWith({ commentId: 12, emoji: "🎉" });
  });

  it("shows who reacted, pruned by the server, on demand", async () => {
    api.getReactors.mockResolvedValue([
      { emoji: "👍", count: 1, users: [{ id: 2, display_name: "Alice" }] },
    ]);
    renderWithAuth(
      <ReactionBar
        postId={7}
        reactions={[{ emoji: "👍", count: 1, reacted: false }]}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: /who reacted/i }));

    expect(await screen.findByText("Alice")).toBeInTheDocument();
    expect(api.getReactors).toHaveBeenCalledWith({ postId: 7, commentId: null });
  });

  it("offers no 'who reacted' control when there are no reactions", () => {
    renderWithAuth(<ReactionBar postId={7} reactions={[]} />);
    expect(
      screen.queryByRole("button", { name: /who reacted/i }),
    ).not.toBeInTheDocument();
  });

  it("renders the popover in a body-level portal, not trapped inside the feed", async () => {
    // The popover overflows its post and must paint above later feed content, so
    // it is portalled to <body> with absolute (page-anchored) positioning,
    // escaping the feed's stacking context. See docs/phases/phase-7b — the
    // "translucent picker" bug was later feed posts painting over an in-flow
    // popover.
    const { container } = renderWithAuth(
      <ReactionBar commentId={12} reactions={[]} />,
    );
    await userEvent.click(screen.getByRole("button", { name: /add a reaction/i }));
    await userEvent.click(screen.getByRole("button", { name: /more emoji/i }));

    const picker = await screen.findByTestId("emoji-picker");
    // The stub lives in a portal on document.body, not within the bar's subtree.
    expect(container).not.toContainElement(picker);
    const portalRoot = picker.closest("[data-reaction-popover]");
    expect(portalRoot).not.toBeNull();
    // Page-anchored (absolute), so it scrolls with the feed rather than floating.
    expect(portalRoot.style.position).toBe("absolute");
    expect(document.body).toContainElement(portalRoot);
  });

  it("shows the who-reacted popover in a body-level portal too", async () => {
    api.getReactors.mockResolvedValue([
      { emoji: "👍", count: 1, users: [{ id: 2, display_name: "Alice" }] },
    ]);
    const { container } = renderWithAuth(
      <ReactionBar
        postId={7}
        reactions={[{ emoji: "👍", count: 1, reacted: false }]}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /who reacted/i }));

    const name = await screen.findByText("Alice");
    expect(container).not.toContainElement(name);
    expect(name.closest("[data-reaction-popover]")).not.toBeNull();
  });

  it("shows the four quick reactions in a portal, flagging ones you've used", async () => {
    const { container } = renderWithAuth(
      <ReactionBar
        postId={7}
        reactions={[{ emoji: "❤️", count: 2, reacted: true }]}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /add a reaction/i }));

    for (const emoji of ["👍", "❤️", "😂", "🎉"]) {
      expect(
        await screen.findByRole("button", { name: new RegExp(`React ${emoji}`) }),
      ).toBeInTheDocument();
    }
    // The one already reacted with is marked pressed (and re-tapping removes it).
    const heart = screen.getByRole("button", { name: /React ❤️/ });
    expect(heart).toHaveAttribute("aria-pressed", "true");
    // Quick popover is portalled to <body>, like the full picker.
    expect(container).not.toContainElement(heart);
    expect(heart.closest("[data-reaction-popover]")).not.toBeNull();
  });
});

describe("PostCard", () => {
  it("renders the reaction bar from the post's embedded reactions", () => {
    renderWithAuth(
      <PostCard
        post={{
          id: 7,
          author: { id: 2, display_name: "Alice" },
          text: "hello",
          created_at: "2026-07-12T10:00:00Z",
          reactions: [{ emoji: "🎉", count: 2, reacted: false }],
        }}
      />,
    );
    expect(screen.getByText("🎉")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
  });
});
