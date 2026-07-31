import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import CommentThread from "./components/CommentThread.jsx";
import { renderWithAuth, fakeUser } from "./test-utils.jsx";
import { api } from "./api.js";

/**
 * Owner-only edit and delete on your own comment (issue #128).
 *
 * Two things here are easy to break without any test noticing. The first is the
 * **"· edited" marker**: it's the whole transparency floor behind letting people
 * change what others have already read, so an edit path that silently drops it
 * is worse than no edit path. The second is the **tombstone** — a deleted
 * comment that still has replies stays in the tree as a blank placeholder, and
 * every affordance on it has to go *except* the toggle that opens the replies
 * it's there to hold up. Hide that one by accident and the replies are stranded
 * behind a row with no way in.
 */
vi.mock("./api.js", () => ({
  api: {
    getComments: vi.fn(),
    addComment: vi.fn(),
    updateComment: vi.fn(),
    deleteComment: vi.fn(),
    reportContent: vi.fn(),
    toggleReaction: vi.fn(),
    getReactors: vi.fn(),
  },
}));

// A comment by the logged-in test user (fakeUser.pk === 1) unless told
// otherwise, so the owner controls show.
function comment(overrides = {}) {
  return {
    id: 5,
    author: { id: fakeUser.pk, display_name: "You", avatar_thumb: null },
    text: "original comment",
    created_at: "2026-07-13T08:00:00Z",
    edited_at: null,
    deleted_at: null,
    reactions: [],
    replies: [],
    ...overrides,
  };
}

function someoneElse(overrides = {}) {
  return comment({
    id: 6,
    author: { id: 999, display_name: "Them", avatar_thumb: null },
    ...overrides,
  });
}

async function renderThread(comments) {
  api.getComments.mockResolvedValue(comments);
  const result = renderWithAuth(<CommentThread postId={7} />);
  // The top-level composer only paints once the tree has loaded.
  await screen.findByPlaceholderText(/Write a comment/);
  return result;
}

/** Open a comment's ⋯ menu. */
async function openMenu(user) {
  await user.click(screen.getByRole("button", { name: "Comment options" }));
}

/** Open the ⋯ and choose one of its items. */
async function pickMenuItem(user, name) {
  await openMenu(user);
  await user.click(
    within(screen.getByRole("dialog", { name: "Comment options" })).getByRole(
      "button",
      { name },
    ),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  Element.prototype.scrollIntoView = vi.fn();
});

describe("owner controls on a comment", () => {
  it("offers Edit and Delete on your own comment", async () => {
    const user = userEvent.setup();
    await renderThread([comment()]);
    await openMenu(user);
    const menu = within(screen.getByRole("dialog", { name: "Comment options" }));
    expect(menu.getByRole("button", { name: "Edit" })).toBeInTheDocument();
    expect(menu.getByRole("button", { name: "Delete" })).toBeInTheDocument();
    expect(menu.queryByRole("button", { name: "Report" })).not.toBeInTheDocument();
  });

  it("offers Report, not Edit/Delete, on someone else's", async () => {
    // One ⋯ for everybody — what's *in* it is what changes.
    const user = userEvent.setup();
    await renderThread([someoneElse()]);
    await openMenu(user);
    const menu = within(screen.getByRole("dialog", { name: "Comment options" }));
    expect(menu.getByRole("button", { name: "Report" })).toBeInTheDocument();
    expect(menu.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
    expect(menu.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
  });
});

describe("editing your own comment", () => {
  it("edits in place and saves via the API", async () => {
    const user = userEvent.setup();
    api.updateComment.mockResolvedValue(comment({ text: "fixed comment" }));
    await renderThread([comment()]);

    await pickMenuItem(user, "Edit");
    const box = screen.getByRole("textbox", { name: "Edit comment text" });
    expect(box).toHaveValue("original comment");
    await user.clear(box);
    await user.type(box, "fixed comment");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(api.updateComment).toHaveBeenCalledWith(5, "fixed comment"),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("textbox", { name: "Edit comment text" }),
      ).not.toBeInTheDocument(),
    );
  });

  it("cancelling makes no API call and leaves the text alone", async () => {
    const user = userEvent.setup();
    await renderThread([comment()]);

    await pickMenuItem(user, "Edit");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(api.updateComment).not.toHaveBeenCalled();
    expect(screen.getByText("original comment")).toBeInTheDocument();
  });

  it("closes the reply box, so a comment never has two write boxes open", async () => {
    const user = userEvent.setup();
    await renderThread([comment()]);

    await user.click(screen.getByRole("button", { name: "Reply" }));
    expect(screen.getByPlaceholderText(/Reply to You/)).toBeInTheDocument();

    await pickMenuItem(user, "Edit");
    expect(screen.queryByPlaceholderText(/Reply to You/)).not.toBeInTheDocument();
  });

  it("won't save an emptied comment — that's a delete", async () => {
    const user = userEvent.setup();
    await renderThread([comment()]);

    await pickMenuItem(user, "Edit");
    await user.clear(screen.getByRole("textbox", { name: "Edit comment text" }));
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });
});

describe("the edited marker", () => {
  it("is hidden on a comment that was never edited", async () => {
    await renderThread([comment({ edited_at: null })]);
    expect(screen.queryByText("· edited")).not.toBeInTheDocument();
  });

  it("shows with the edit time on a comment that was edited", async () => {
    await renderThread([comment({ edited_at: "2026-07-14T12:30:00Z" })]);
    const marker = screen.getByText("· edited");
    expect(marker).toHaveAttribute("title", expect.stringContaining("Edited"));
    expect(marker.getAttribute("aria-label")).toMatch(/^Edited /);
  });
});

describe("deleting your own comment", () => {
  it("confirms before deleting", async () => {
    const user = userEvent.setup();
    api.deleteComment.mockResolvedValue(null);
    await renderThread([comment()]);

    await pickMenuItem(user, "Delete");
    expect(api.deleteComment).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog", { name: "Delete comment" });

    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(api.deleteComment).toHaveBeenCalledWith(5));
  });

  it("closes the confirm once the delete lands, even on a tombstone", async () => {
    // A comment with replies survives its own delete as a tombstone, so this
    // node stays mounted through the refetch — unlike a post's card, which
    // unmounts and takes its dialog with it. Left open, the dialog is stuck:
    // `pending` never clears again, and that disables Escape and the backdrop.
    const user = userEvent.setup();
    api.deleteComment.mockResolvedValue(null);
    await renderThread([
      comment({ replies: [someoneElse({ id: 6, text: "a reply" })] }),
    ]);

    await pickMenuItem(user, "Delete");
    const dialog = screen.getByRole("dialog", { name: "Delete comment" });
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));

    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Delete comment" }),
      ).not.toBeInTheDocument(),
    );
  });

  it("cancelling the confirm deletes nothing", async () => {
    const user = userEvent.setup();
    await renderThread([comment()]);

    await pickMenuItem(user, "Delete");
    const dialog = screen.getByRole("dialog", { name: "Delete comment" });
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(api.deleteComment).not.toHaveBeenCalled();
  });

  it("warns that replies will survive when there are any", async () => {
    const user = userEvent.setup();
    await renderThread([
      comment({ replies: [someoneElse({ id: 6, text: "a reply" })] }),
    ]);

    await pickMenuItem(user, "Delete");
    const dialog = screen.getByRole("dialog", { name: "Delete comment" });
    expect(within(dialog).getByText(/replies underneath will stay/)).toBeInTheDocument();
  });
});

describe("a deleted comment (the tombstone)", () => {
  const tombstone = (replies) =>
    comment({
      text: "",
      deleted_at: "2026-07-14T09:00:00Z",
      // Deleted by its author, so it stays theirs — the owner controls must
      // still not appear.
      replies,
    });

  it("renders a placeholder instead of the text", async () => {
    await renderThread([tombstone([someoneElse({ id: 6, text: "a reply" })])]);
    expect(screen.getByText("Comment deleted")).toBeInTheDocument();
  });

  it("offers nothing — not even to its own author", async () => {
    await renderThread([tombstone([someoneElse({ id: 6, text: "a reply" })])]);
    for (const name of ["Reply", "Edit", "Delete", /report/i]) {
      expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
    }
  });

  it("keeps the way into the replies it exists to hold up", async () => {
    const user = userEvent.setup();
    await renderThread([tombstone([someoneElse({ id: 6, text: "a reply" })])]);

    const toggle = screen.getByRole("button", { name: /Show 1 reply/ });
    await user.click(toggle);
    expect(screen.getByText("a reply")).toBeInTheDocument();
  });

  it("carries no edited marker even if it was edited before deletion", async () => {
    await renderThread([
      comment({
        text: "",
        edited_at: "2026-07-14T08:00:00Z",
        deleted_at: "2026-07-14T09:00:00Z",
        replies: [someoneElse({ id: 6, text: "a reply" })],
      }),
    ]);
    expect(screen.queryByText("· edited")).not.toBeInTheDocument();
  });
});
