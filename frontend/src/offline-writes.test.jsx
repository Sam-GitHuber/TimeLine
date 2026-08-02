import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ComposeBox from "./components/ComposeBox.jsx";
import GroupMembersPanel from "./components/GroupMembersPanel.jsx";
import CommentThread from "./components/CommentThread.jsx";
import {
  renderWithAuth,
  fakeUser,
  apiError,
  unauthoredError,
  offlineError,
} from "./test-utils.jsx";
import { serverMessage } from "./errors.js";
import { api } from "./api.js";

// Issue #240. The web had written a sentence for every one of these failures and
// then made it unreachable: a network-level failure rejects out of `fetch` as a
// bare `TypeError`, and `err?.message || "our sentence"` shows the browser's
// words because a `TypeError` has a message. Since being offline is the single
// most likely way a write fails, the fallback was unreachable in practice at
// nearly every site — you'd press Post in a tunnel and read "Failed to fetch".
//
// `api.js` now converts the rejection at the source and every call site asks
// `serverMessage`, so the rule is uniform: **the server's own words when it
// wrote any, ours otherwise, the browser's never.** This suite pins that rule on
// a representative write from each shape it takes — a mutation rendered from
// `isError`, one held in local state, and the panel that had no fallback at all
// until this issue.
vi.mock("./api.js", () => ({
  api: {
    createPost: vi.fn(),
    getGroupMembers: vi.fn(),
    removeGroupMember: vi.fn(),
    setGroupMemberRole: vi.fn(),
    getComments: vi.fn(),
    createComment: vi.fn(),
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("serverMessage", () => {
  it("shows the server's words, and only the server's", () => {
    expect(serverMessage(apiError("That poll is closed.", 400), "ours")).toBe(
      "That poll is closed."
    );
    // The two kinds that carry a message but not one worth reading.
    expect(serverMessage(offlineError(), "ours")).toBe("ours");
    expect(serverMessage(unauthoredError(500), "ours")).toBe("ours");
    // And a raw TypeError, in case one ever gets past api.js again.
    expect(serverMessage(new TypeError("Failed to fetch"), "ours")).toBe(
      "ours"
    );
    expect(serverMessage(undefined, "ours")).toBe("ours");
  });
});

describe("a write that fails with no server reachable", () => {
  it("shows the composer's own sentence, not the browser's", async () => {
    const user = userEvent.setup();
    api.createPost.mockRejectedValue(offlineError());
    renderWithAuth(<ComposeBox />);

    await user.type(screen.getByRole("textbox"), "Hello from a tunnel");
    await user.click(screen.getByRole("button", { name: "Post" }));

    expect(
      await screen.findByText("Couldn't post. Try again.")
    ).toBeInTheDocument();
    expect(screen.queryByText(/failed to fetch/i)).not.toBeInTheDocument();
  });

  it("still shows the server's own words when it managed to speak", async () => {
    const user = userEvent.setup();
    api.createPost.mockRejectedValue(
      apiError("You can attach at most 10 photos.", 400)
    );
    renderWithAuth(<ComposeBox />);

    await user.type(screen.getByRole("textbox"), "Holiday snaps");
    await user.click(screen.getByRole("button", { name: "Post" }));

    expect(
      await screen.findByText("You can attach at most 10 photos.")
    ).toBeInTheDocument();
  });

  it("never shows the stand-in synthesized for a body-less 500", async () => {
    const user = userEvent.setup();
    api.createPost.mockRejectedValue(unauthoredError(500));
    renderWithAuth(<ComposeBox />);

    await user.type(screen.getByRole("textbox"), "Hello");
    await user.click(screen.getByRole("button", { name: "Post" }));

    expect(
      await screen.findByText("Couldn't post. Try again.")
    ).toBeInTheDocument();
    expect(screen.queryByText(/Request failed/)).not.toBeInTheDocument();
  });

  it("says something on a comment that didn't post", async () => {
    const user = userEvent.setup();
    api.getComments.mockResolvedValue([]);
    api.createComment.mockRejectedValue(offlineError());
    renderWithAuth(<CommentThread postId={4} />);

    await user.type(
      await screen.findByPlaceholderText(/write a comment/i),
      "Nice one"
    );
    await user.click(screen.getByRole("button", { name: "Comment" }));

    expect(
      await screen.findByText("Couldn't post. Try again.")
    ).toBeInTheDocument();
    expect(screen.queryByText(/failed to fetch/i)).not.toBeInTheDocument();
  });
});

// This panel is the one site the sweep found with no `|| "our sentence"` at all
// — it rendered `actionError.message` bare, so offline it put "Failed to fetch"
// above the member list. It matters more than most because #239 holds it up as
// the web precedent other row-action screens should copy.
describe("GroupMembersPanel", () => {
  const members = [
    { user: { id: 1, display_name: "You" }, role: "admin" },
    { user: { id: 2, display_name: "Ada" }, role: "member" },
  ];

  it("shows a sentence of ours when a Remove fails with nobody to quote", async () => {
    const user = userEvent.setup();
    api.getGroupMembers.mockResolvedValue(members);
    api.removeGroupMember.mockRejectedValue(offlineError());
    renderWithAuth(<GroupMembersPanel groupId={7} isAdmin />, {
      auth: { user: { ...fakeUser, pk: 1 } },
    });

    await user.click(await screen.findByRole("button", { name: "Remove" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "That didn’t work — check your connection and try again."
    );
    expect(screen.queryByText(/failed to fetch/i)).not.toBeInTheDocument();
  });

  it("still surfaces the rule the server enforced", async () => {
    const user = userEvent.setup();
    api.getGroupMembers.mockResolvedValue(members);
    api.setGroupMemberRole.mockRejectedValue(
      apiError("A group must keep at least one admin.", 400)
    );
    renderWithAuth(<GroupMembersPanel groupId={7} isAdmin />, {
      auth: { user: { ...fakeUser, pk: 1 } },
    });

    await user.click(await screen.findByRole("button", { name: "Make admin" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "A group must keep at least one admin."
    );
  });
});
