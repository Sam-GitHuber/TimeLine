import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App.jsx";
import { renderWithAuth, fakeUser } from "./test-utils.jsx";
import { api } from "./api.js";

// Phase 5 messaging. Like App.test.jsx, the pages fetch from the real API, so we
// mock the api module and assert the frontend renders what the backend returns
// and wires the message/block actions to the right endpoints. The scoping/
// unread/block rules themselves are enforced (and tested) on the backend.
vi.mock("./api.js", () => ({
  api: {
    // Feed/profile/nav dependencies the shell touches on any route.
    ensureCsrf: vi.fn().mockResolvedValue({}),
    getFeed: vi.fn(),
    getPage: vi.fn(),
    createPost: vi.fn(),
    getComments: vi.fn(),
    listUsers: vi.fn(),
    getUser: vi.fn(),
    getUserPosts: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    getConnectionRequests: vi.fn(),
    // Messaging.
    getConversations: vi.fn(),
    openConversation: vi.fn(),
    getConversation: vi.fn(),
    getMessages: vi.fn(),
    sendMessage: vi.fn(),
    deleteMessage: vi.fn(),
    markConversationRead: vi.fn(),
    getUnreadMessageCount: vi.fn(),
    blockUser: vi.fn(),
    unblockUser: vi.fn(),
  },
  CONVERSATION_LIST_POLL_MS: 1_000_000, // effectively off in tests
  MESSAGE_POLL_MS: 1_000_000,
}));

function page(results, next = null) {
  return { results, count: results.length, next };
}

function renderAt(path) {
  return renderWithAuth(<App />, { route: path });
}

beforeEach(() => {
  vi.clearAllMocks();
  api.getFeed.mockResolvedValue(page([]));
  api.getConnectionRequests.mockResolvedValue(page([]));
  api.getUnreadMessageCount.mockResolvedValue({ count: 0 });
  api.getConversations.mockResolvedValue(page([]));
  api.markConversationRead.mockResolvedValue({ detail: "Marked read." });
  api.getMessages.mockResolvedValue(page([]));
});

describe("Messages list", () => {
  it("shows conversations with a preview and an unread badge", async () => {
    api.getConversations.mockResolvedValue(
      page([
        {
          id: 7,
          other: { id: 2, display_name: "Priya", avatar_thumb: null },
          last_message: {
            text: "see you then",
            is_deleted: false,
            sender_id: 2,
            created_at: new Date().toISOString(),
          },
          unread_count: 3,
          updated_at: new Date().toISOString(),
        },
      ])
    );

    renderAt("/messages");

    expect(await screen.findByText("Priya")).toBeInTheDocument();
    expect(screen.getByText("see you then")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
  });

  it("shows an empty state when there are no conversations", async () => {
    renderAt("/messages");
    expect(await screen.findByText(/No messages yet/i)).toBeInTheDocument();
  });
});

describe("Nav unread badge", () => {
  it("renders the total unread count in the nav", async () => {
    api.getUnreadMessageCount.mockResolvedValue({ count: 5 });
    renderAt("/messages");
    // The nav "Messages" link carries the badge.
    const nav = await screen.findByRole("navigation");
    expect(await within(nav).findByText("5")).toBeInTheDocument();
  });
});

describe("Conversation thread", () => {
  const convo = {
    id: 7,
    other: { id: 2, display_name: "Priya", avatar_thumb: null },
    last_message: null,
    unread_count: 0,
    can_message: true,
    updated_at: new Date().toISOString(),
  };

  it("renders messages and marks the thread read", async () => {
    api.getConversation.mockResolvedValue(convo);
    api.getMessages.mockResolvedValue(
      page([
        {
          id: 1,
          sender: { id: 2, display_name: "Priya", avatar_thumb: null },
          text: "hey there",
          is_deleted: false,
          created_at: new Date().toISOString(),
        },
        {
          id: 2,
          sender: { id: fakeUser.pk, display_name: "you", avatar_thumb: null },
          text: "hello!",
          is_deleted: false,
          created_at: new Date().toISOString(),
        },
      ])
    );

    renderAt("/messages/7");

    expect(await screen.findByText("hey there")).toBeInTheDocument();
    expect(screen.getByText("hello!")).toBeInTheDocument();
    await waitFor(() =>
      expect(api.markConversationRead).toHaveBeenCalledWith(7)
    );
  });

  it("sends a message via the composer", async () => {
    api.getConversation.mockResolvedValue(convo);
    api.getMessages.mockResolvedValue(page([]));
    api.sendMessage.mockResolvedValue({
      id: 9,
      sender: { id: fakeUser.pk, display_name: "you", avatar_thumb: null },
      text: "yo",
      is_deleted: false,
      created_at: new Date().toISOString(),
    });

    renderAt("/messages/7");

    const box = await screen.findByPlaceholderText(/write a message/i);
    await userEvent.type(box, "yo");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() =>
      expect(api.sendMessage).toHaveBeenCalledWith(7, "yo")
    );
  });

  it("hides the composer when you can no longer message", async () => {
    api.getConversation.mockResolvedValue({ ...convo, can_message: false });
    api.getMessages.mockResolvedValue(page([]));

    renderAt("/messages/7");

    expect(
      await screen.findByText(/no longer connected/i)
    ).toBeInTheDocument();
    expect(
      screen.queryByPlaceholderText(/write a message/i)
    ).not.toBeInTheDocument();
  });

  it("renders a placeholder for a deleted message", async () => {
    api.getConversation.mockResolvedValue(convo);
    api.getMessages.mockResolvedValue(
      page([
        {
          id: 1,
          sender: { id: 2, display_name: "Priya", avatar_thumb: null },
          text: "",
          is_deleted: true,
          created_at: new Date().toISOString(),
        },
      ])
    );

    renderAt("/messages/7");
    expect(await screen.findByText("Message deleted")).toBeInTheDocument();
  });
});

describe("Profile messaging + block controls", () => {
  it("offers Message on a connected profile and opens the thread", async () => {
    api.getUser.mockResolvedValue({
      id: 2,
      display_name: "Priya",
      connection_status: "connected",
      is_blocked: false,
      bio: "",
    });
    api.getUserPosts.mockResolvedValue(page([]));
    api.openConversation.mockResolvedValue({ id: 7 });
    api.getConversation.mockResolvedValue({
      id: 7,
      other: { id: 2, display_name: "Priya", avatar_thumb: null },
      last_message: null,
      unread_count: 0,
      can_message: true,
      updated_at: new Date().toISOString(),
    });

    renderAt("/u/2");

    await userEvent.click(
      await screen.findByRole("button", { name: "Message" })
    );
    await waitFor(() =>
      expect(api.openConversation).toHaveBeenCalledWith(2)
    );
  });

  it("blocks a user after confirmation", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    api.getUser.mockResolvedValue({
      id: 2,
      display_name: "Priya",
      connection_status: "none",
      is_blocked: false,
      bio: "",
    });
    api.getUserPosts.mockResolvedValue(page([]));
    api.blockUser.mockResolvedValue({ detail: "Blocked.", is_blocked: true });

    renderAt("/u/2");

    await userEvent.click(await screen.findByRole("button", { name: "Block" }));
    await waitFor(() => expect(api.blockUser).toHaveBeenCalledWith(2));
    window.confirm.mockRestore();
  });

  it("shows Unblock and the blocked note when you've blocked them", async () => {
    api.getUser.mockResolvedValue({
      id: 2,
      display_name: "Priya",
      connection_status: "none",
      is_blocked: true,
      bio: "",
    });
    api.getUserPosts.mockResolvedValue(page([]));

    renderAt("/u/2");

    expect(
      await screen.findByRole("button", { name: "Unblock" })
    ).toBeInTheDocument();
    expect(screen.getByText(/You’ve blocked Priya/)).toBeInTheDocument();
  });
});
