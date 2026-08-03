import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  renderWithAuth,
  apiError,
  offlineError,
  unauthoredError,
} from "./test-utils.jsx";
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
    // `messageId: null` since Phase 9b M9c widened the target to three kinds.
    expect(api.getReactors).toHaveBeenCalledWith({
      postId: 7,
      commentId: null,
      messageId: null,
    });
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
    // escaping the feed's stacking context. See docs/reference/reactions.md — the
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

/**
 * What a *rejected* toggle does (issue #242).
 *
 * Until this, the bar had no error path at all: the chips are only ever
 * repainted from `onSuccess`, so a rejection changed nothing on screen, and the
 * popover closes before the request is even sent — so the popover closing was
 * no evidence either. A failed tap was indistinguishable from a successful one,
 * on one of the highest-traffic gestures in the app, and the natural response
 * was to tap again at a server that may have taken the first one — where the
 * second tap is a *removal*.
 *
 * The mobile twin already reported it. These pin the web half, and the two
 * rules #236/#240 settled on: the server's own words where it wrote any and
 * ours otherwise, and a message retired only by the server moving to the answer
 * that tap was reaching for.
 */
describe("ReactionBar — a rejected toggle", () => {
  const THUMB = /👍/;

  it("says so in the server's own words, and leaves the chip where it was", async () => {
    // The per-target distinct-emoji cap is a rule the server owns, and its
    // sentence says far more than any fallback of ours could.
    api.toggleReaction.mockRejectedValue(
      apiError("You've used too many different emoji on this one.", 400),
    );
    renderWithAuth(
      <ReactionBar
        postId={7}
        reactions={[{ emoji: "👍", count: 3, reacted: false }]}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: THUMB }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "You've used too many different emoji on this one.",
    );
    // Nothing moved: still 3, still not yours. That silence was the bug.
    expect(screen.getByRole("button", { name: THUMB })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(screen.getByText("3")).toBeInTheDocument();
  });

  it("uses our own words, named for the direction, when the server wrote none", async () => {
    // Offline — the likeliest way any write fails, and the case a bare
    // `err.message` would answer with the browser's "Failed to fetch".
    api.toggleReaction.mockRejectedValue(offlineError());
    renderWithAuth(
      <ReactionBar
        postId={7}
        reactions={[{ emoji: "👍", count: 3, reacted: false }]}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: THUMB }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Couldn’t add that reaction — try again.",
    );
  });

  it("says 'remove' when the tap was taking your own reaction back", async () => {
    // A body-less 500: it carries a message *and* a status, so anything cruder
    // than the `fromServer` flag would print "Request failed (500)" here.
    api.toggleReaction.mockRejectedValue(unauthoredError(500));
    renderWithAuth(
      <ReactionBar
        postId={7}
        reactions={[{ emoji: "👍", count: 3, reacted: true }]}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: THUMB }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Couldn’t remove that reaction — try again.",
    );
  });

  it("reports a rejection from the quick popover, which closes either way", async () => {
    api.toggleReaction.mockRejectedValue(offlineError());
    renderWithAuth(<ReactionBar commentId={12} reactions={[]} />);

    await userEvent.click(screen.getByRole("button", { name: /add a reaction/i }));
    await userEvent.click(await screen.findByRole("button", { name: /React 👍/ }));

    // The popover shuts on the tap, before the request is sent — so it says
    // nothing about whether the reaction landed. The message has to.
    expect(screen.queryByRole("button", { name: /React 👍/ })).not.toBeInTheDocument();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Couldn’t add that reaction — try again.",
    );
  });

  it("keeps the message when a resync changes anything other than your answer", async () => {
    api.toggleReaction.mockRejectedValue(offlineError());
    const { setProps } = renderWithAuth(
      <ReactionBar
        postId={7}
        reactions={[{ emoji: "👍", count: 3, reacted: false }]}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: THUMB }));
    await screen.findByRole("alert");

    // A feed poll lands: someone else reacted, and a second emoji appeared.
    // Neither is confirmation of *your* tap, so clearing here would be the
    // swallow issue #231 describes.
    setProps(
      <ReactionBar
        postId={7}
        reactions={[
          { emoji: "👍", count: 4, reacted: false },
          { emoji: "🎉", count: 1, reacted: true },
        ]}
      />,
    );

    expect(screen.getByText("4")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Couldn’t add that reaction — try again.",
    );
  });

  it("retires the message once the server shows the toggle landed after all", async () => {
    api.toggleReaction.mockRejectedValue(offlineError());
    const { setProps } = renderWithAuth(
      <ReactionBar
        postId={7}
        reactions={[{ emoji: "👍", count: 3, reacted: false }]}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: THUMB }));
    await screen.findByRole("alert");

    // The POST did land; only its response was lost. Left standing, "couldn't
    // add that reaction" would now sit beside a chip saying you did.
    setProps(
      <ReactionBar
        postId={7}
        reactions={[{ emoji: "👍", count: 4, reacted: true }]}
      />,
    );

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: THUMB })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("clears the previous message when you tap again", async () => {
    api.toggleReaction.mockRejectedValueOnce(offlineError());
    api.toggleReaction.mockResolvedValueOnce({
      reactions: [{ emoji: "👍", count: 4, reacted: true }],
    });
    renderWithAuth(
      <ReactionBar
        postId={7}
        reactions={[{ emoji: "👍", count: 3, reacted: false }]}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: THUMB }));
    await screen.findByRole("alert");
    await userEvent.click(screen.getByRole("button", { name: THUMB }));

    await waitFor(() =>
      expect(screen.queryByRole("alert")).not.toBeInTheDocument(),
    );
    expect(screen.getByText("4")).toBeInTheDocument();
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
