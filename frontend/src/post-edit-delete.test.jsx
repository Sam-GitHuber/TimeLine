import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithAuth, fakeUser } from "./test-utils.jsx";
import PostCard from "./components/PostCard.jsx";
import { api } from "./api.js";

vi.mock("./api.js", () => ({
  api: {
    updatePost: vi.fn(),
    deletePost: vi.fn(),
    reportContent: vi.fn(),
    getComments: vi.fn(),
  },
}));

// A post owned by the logged-in test user (fakeUser.pk === 1), so the ⋯ menu
// offers Edit/Delete. Override `author.id` to make it someone else's.
function makePost(overrides = {}) {
  return {
    id: 42,
    author: { id: fakeUser.pk, display_name: "You", avatar_thumb: null },
    text: "original text",
    images: [],
    group: null,
    reactions: [],
    created_at: "2026-07-01T10:00:00Z",
    edited_at: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  api.getComments.mockResolvedValue([]);
});

async function openMenu(user) {
  await user.click(screen.getByRole("button", { name: "Post options" }));
}

describe("PostCard ⋯ menu — owner", () => {
  it("offers Edit and Delete, not Report", async () => {
    const user = userEvent.setup();
    renderWithAuth(<PostCard post={makePost()} />);
    await openMenu(user);
    expect(screen.getByRole("menuitem", { name: "Edit" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Delete" })).toBeInTheDocument();
    expect(
      screen.queryByRole("menuitem", { name: "Report" }),
    ).not.toBeInTheDocument();
  });

  it("edits the text in place and saves via the API", async () => {
    const user = userEvent.setup();
    api.updatePost.mockResolvedValue(makePost({ text: "fixed text" }));
    renderWithAuth(<PostCard post={makePost()} />);

    await openMenu(user);
    await user.click(screen.getByRole("menuitem", { name: "Edit" }));

    const box = screen.getByRole("textbox", { name: "Edit post text" });
    expect(box).toHaveValue("original text");
    await user.clear(box);
    await user.type(box, "fixed text");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(api.updatePost).toHaveBeenCalledWith(42, "fixed text"),
    );
    // Editor closes on success.
    await waitFor(() =>
      expect(
        screen.queryByRole("textbox", { name: "Edit post text" }),
      ).not.toBeInTheDocument(),
    );
  });

  it("cancelling the editor makes no API call", async () => {
    const user = userEvent.setup();
    renderWithAuth(<PostCard post={makePost()} />);
    await openMenu(user);
    await user.click(screen.getByRole("menuitem", { name: "Edit" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(api.updatePost).not.toHaveBeenCalled();
    expect(screen.getByText("original text")).toBeInTheDocument();
  });

  it("won't save an emptied text-only post", async () => {
    const user = userEvent.setup();
    renderWithAuth(<PostCard post={makePost()} />);
    await openMenu(user);
    await user.click(screen.getByRole("menuitem", { name: "Edit" }));
    await user.clear(screen.getByRole("textbox", { name: "Edit post text" }));
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("deletes only after confirming", async () => {
    const user = userEvent.setup();
    api.deletePost.mockResolvedValue(null);
    renderWithAuth(<PostCard post={makePost()} />);

    await openMenu(user);
    await user.click(screen.getByRole("menuitem", { name: "Delete" }));
    // A confirm step appears; nothing deleted yet.
    expect(api.deletePost).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog", { name: "Delete post" });
    expect(dialog).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(api.deletePost).toHaveBeenCalledWith(42));
  });
});

describe("PostCard ⋯ menu — non-owner", () => {
  it("offers Report, not Edit/Delete", async () => {
    const user = userEvent.setup();
    renderWithAuth(
      <PostCard post={makePost({ author: { id: 999, display_name: "Them" } })} />,
    );
    await openMenu(user);
    expect(screen.getByRole("menuitem", { name: "Report" })).toBeInTheDocument();
    expect(
      screen.queryByRole("menuitem", { name: "Edit" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("menuitem", { name: "Delete" }),
    ).not.toBeInTheDocument();
  });
});

describe("PostCard edited marker", () => {
  it("is hidden on a post that was never edited", () => {
    renderWithAuth(<PostCard post={makePost({ edited_at: null })} />);
    expect(screen.queryByText("· edited")).not.toBeInTheDocument();
  });

  it("shows with the edit time on a post that was edited", () => {
    renderWithAuth(
      <PostCard post={makePost({ edited_at: "2026-07-02T12:30:00Z" })} />,
    );
    const marker = screen.getByText("· edited");
    expect(marker).toBeInTheDocument();
    // The exact edit time is discoverable via title / aria-label.
    expect(marker).toHaveAttribute("title", expect.stringContaining("Edited"));
    expect(marker.getAttribute("aria-label")).toMatch(/^Edited /);
  });
});
