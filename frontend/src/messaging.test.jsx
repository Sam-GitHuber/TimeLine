import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App.jsx";
import { renderWithAuth, fakeUser } from "./test-utils.jsx";
import { api } from "./api.js";
import { MessagingProvider } from "./messaging.jsx";
import NewChatPicker from "./components/NewChatPicker.jsx";

// Phase 5 messaging is a companion drawer (not a route): the nav "Messages"
// button opens it over the feed, and it walks list → thread → new message. We
// mock the api module and assert the frontend renders what the backend returns
// and wires the message/block actions to the right endpoints. Scoping/unread/
// block rules themselves are enforced (and tested) on the backend.
vi.mock("./api.js", () => ({
  api: {
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
    getConversations: vi.fn(),
    openConversation: vi.fn(),
    createGroupChat: vi.fn(),
    getConversation: vi.fn(),
    getMessages: vi.fn(),
    sendMessage: vi.fn(),
    deleteMessage: vi.fn(),
    markConversationRead: vi.fn(),
    getUnreadMessageCount: vi.fn(),
    getGroupInvites: vi.fn(),
    blockUser: vi.fn(),
    unblockUser: vi.fn(),
    addParticipants: vi.fn(),
    leaveConversation: vi.fn(),
  },
  CONVERSATION_LIST_POLL_MS: 1_000_000, // effectively off in tests
  MESSAGE_POLL_MS: 1_000_000,
}));

function page(results, next = null) {
  return { results, count: results.length, next };
}

function renderAt(path = "/") {
  return renderWithAuth(<App />, { route: path });
}

function convoRow(overrides = {}) {
  return {
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
    ...overrides,
  };
}

function groupConvoRow(overrides = {}) {
  return {
    id: 11,
    kind: "group",
    title: "Book Club",
    other: null,
    participants: [
      { id: 2, display_name: "Priya", avatar_thumb: null, status: "active" },
      { id: 3, display_name: "Sanjay", avatar_thumb: null, status: "active" },
    ],
    my_status: "active",
    last_message: {
      text: "see you then",
      is_deleted: false,
      sender_id: 2,
      created_at: new Date().toISOString(),
    },
    unread_count: 0,
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function convoDetail(overrides = {}) {
  return {
    id: 7,
    kind: "direct",
    title: "",
    other: { id: 2, display_name: "Priya", avatar_thumb: null },
    participants: [],
    my_status: "active",
    must_connect_with: [],
    last_message: null,
    unread_count: 0,
    can_send: true,
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function groupConvoDetail(overrides = {}) {
  return convoDetail({
    id: 11,
    kind: "group",
    title: "Book Club",
    other: null,
    participants: [
      { id: fakeUser.pk, display_name: "you", avatar_thumb: null, status: "active" },
      { id: 2, display_name: "Priya", avatar_thumb: null, status: "active" },
      { id: 3, display_name: "Sanjay", avatar_thumb: null, status: "active" },
    ],
    ...overrides,
  });
}

async function openDrawer(user) {
  await user.click(await screen.findByRole("button", { name: /Messages/ }));
}

beforeEach(() => {
  vi.clearAllMocks();
  api.getFeed.mockResolvedValue(page([]));
  api.getConnectionRequests.mockResolvedValue(page([]));
  api.getUnreadMessageCount.mockResolvedValue({ count: 0 });
  api.getGroupInvites.mockResolvedValue({ count: 0, results: [] });
  api.getConversations.mockResolvedValue(page([]));
  api.listUsers.mockResolvedValue(page([]));
  api.getMessages.mockResolvedValue(page([]));
  api.getConversation.mockResolvedValue(convoDetail());
  api.markConversationRead.mockResolvedValue({ detail: "Marked read." });
});

describe("Messages drawer — list", () => {
  it("opens from the nav and lists conversations with a preview + unread badge", async () => {
    const user = userEvent.setup();
    api.getConversations.mockResolvedValue(page([convoRow()]));

    renderAt("/");
    await openDrawer(user);

    const drawer = await screen.findByRole("dialog", { name: "Messages" });
    expect(within(drawer).getByText("Priya")).toBeInTheDocument();
    expect(within(drawer).getByText("see you then")).toBeInTheDocument();
    expect(within(drawer).getByText("3")).toBeInTheDocument();
  });

  it("shows an empty state with a New message action", async () => {
    const user = userEvent.setup();
    renderAt("/");
    await openDrawer(user);

    expect(await screen.findByText(/No conversations yet/i)).toBeInTheDocument();
    // A compose control is offered (header icon + the empty-state CTA).
    expect(
      screen.getAllByRole("button", { name: "New message" }).length
    ).toBeGreaterThan(0);
  });

  it("shows a group row's title + stacked avatars, and a pending row's invited hint with no preview", async () => {
    const user = userEvent.setup();
    api.getConversations.mockResolvedValue(
      page([
        convoRow(),
        groupConvoRow({
          id: 12,
          title: "",
          my_status: "pending",
          participants: [
            { id: 2, display_name: "Priya", avatar_thumb: null, status: "active" },
            { id: 3, display_name: "Sanjay", avatar_thumb: null, status: "pending" },
          ],
          last_message: {
            text: "secret plans",
            is_deleted: false,
            sender_id: 2,
            created_at: new Date().toISOString(),
          },
        }),
      ])
    );

    renderAt("/");
    await openDrawer(user);

    const drawer = await screen.findByRole("dialog", { name: "Messages" });
    // Untitled group falls back to a comma-joined list of participant names.
    expect(within(drawer).getByText("Priya, Sanjay")).toBeInTheDocument();
    expect(
      within(drawer).getByText(/Invited — connect to join/i)
    ).toBeInTheDocument();
    expect(within(drawer).queryByText("secret plans")).not.toBeInTheDocument();
  });

  it("leaves the feed mounted underneath (companion, not a route)", async () => {
    const user = userEvent.setup();
    api.getFeed.mockResolvedValue(page([]));
    renderAt("/");
    await openDrawer(user);

    // The compose box (feed) is still present while the drawer is open.
    expect(
      screen.getByPlaceholderText("What's happening?")
    ).toBeInTheDocument();
  });
});

describe("Legacy messaging URLs", () => {
  it("opens the drawer when landing on /messages", async () => {
    api.getConversations.mockResolvedValue(page([convoRow()]));
    renderAt("/messages");
    // The drawer opens over the feed without a blank screen.
    expect(
      await screen.findByRole("dialog", { name: "Messages" })
    ).toBeInTheDocument();
    expect(await screen.findByText("Priya")).toBeInTheDocument();
  });

  it("opens a specific thread when landing on /messages/:id", async () => {
    renderAt("/messages/7");
    expect(
      await screen.findByRole("dialog", { name: "Messages" })
    ).toBeInTheDocument();
    await waitFor(() => expect(api.getConversation).toHaveBeenCalledWith(7));
  });

  it("sends an unknown path to the feed, never a blank screen", async () => {
    renderAt("/does-not-exist");
    expect(
      await screen.findByPlaceholderText("What's happening?")
    ).toBeInTheDocument();
  });
});

describe("Nav unread badge", () => {
  it("renders the total unread count in the nav", async () => {
    api.getUnreadMessageCount.mockResolvedValue({ count: 5 });
    renderAt("/");
    const nav = await screen.findByRole("navigation");
    expect(await within(nav).findByText("5")).toBeInTheDocument();
  });
});

describe("Messages drawer — new chat", () => {
  beforeEach(() => {
    api.listUsers.mockResolvedValue(
      page([
        { id: 2, display_name: "Priya", connection_status: "connected" },
        { id: 3, display_name: "Sanjay", connection_status: "connected" },
        { id: 4, display_name: "Stranger", connection_status: "none" },
      ])
    );
  });

  it("checks one connection with no title and opens a 1:1 thread", async () => {
    const user = userEvent.setup();
    api.getConversations.mockResolvedValue(page([]));
    api.openConversation.mockResolvedValue({ id: 7 });

    renderAt("/");
    await openDrawer(user);
    // The header compose icon (first "New message" control) opens the picker.
    const composeButtons = await screen.findAllByRole("button", {
      name: "New message",
    });
    await user.click(composeButtons[0]);

    // Only connections are offered.
    expect(await screen.findByText("Priya")).toBeInTheDocument();
    expect(screen.queryByText("Stranger")).not.toBeInTheDocument();

    await user.click(screen.getByRole("checkbox", { name: "Priya" }));
    await user.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(api.openConversation).toHaveBeenCalledWith(2));
  });

  it("checks two connections and creates a group chat", async () => {
    const user = userEvent.setup();
    api.getConversations.mockResolvedValue(page([]));
    api.createGroupChat.mockResolvedValue({ id: 9 });

    renderAt("/");
    await openDrawer(user);
    const composeButtons = await screen.findAllByRole("button", {
      name: "New message",
    });
    await user.click(composeButtons[0]);

    await user.click(await screen.findByRole("checkbox", { name: "Priya" }));
    await user.click(screen.getByRole("checkbox", { name: "Sanjay" }));
    await user.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() =>
      expect(api.createGroupChat).toHaveBeenCalledWith({
        participantIds: [2, 3],
        title: "",
        groupId: null,
      })
    );
  });

  it("scopes the picker to prefill.memberIds when opened from a group", async () => {
    // Both Priya and Sanjay are connections, but only Priya is a member of
    // the group this chat is being started from — Sanjay must not appear.
    renderWithAuth(
      <MessagingProvider>
        <NewChatPicker
          prefill={{ groupId: 5, groupName: "Book Club", memberIds: [2] }}
        />
      </MessagingProvider>
    );

    expect(await screen.findByText("Priya")).toBeInTheDocument();
    expect(screen.queryByText("Sanjay")).not.toBeInTheDocument();
    expect(screen.queryByText("Stranger")).not.toBeInTheDocument();
  });
});

describe("Messages drawer — thread", () => {
  it("opens a conversation, renders messages, and marks it read", async () => {
    const user = userEvent.setup();
    api.getConversations.mockResolvedValue(page([convoRow()]));
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

    renderAt("/");
    await openDrawer(user);
    await user.click(await screen.findByRole("button", { name: /Priya/ }));

    expect(await screen.findByText("hey there")).toBeInTheDocument();
    expect(screen.getByText("hello!")).toBeInTheDocument();
    await waitFor(() =>
      expect(api.markConversationRead).toHaveBeenCalledWith(7)
    );
  });

  it("sends a message from the composer", async () => {
    const user = userEvent.setup();
    api.getConversations.mockResolvedValue(page([convoRow()]));
    api.getMessages.mockResolvedValue(page([]));
    api.sendMessage.mockResolvedValue({
      id: 9,
      sender: { id: fakeUser.pk, display_name: "you", avatar_thumb: null },
      text: "yo",
      is_deleted: false,
      created_at: new Date().toISOString(),
    });

    renderAt("/");
    await openDrawer(user);
    await user.click(await screen.findByRole("button", { name: /Priya/ }));

    const box = await screen.findByPlaceholderText(/write a message/i);
    await user.type(box, "yo");
    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(api.sendMessage).toHaveBeenCalledWith(7, "yo"));
  });

  it("hides the composer when you can no longer message", async () => {
    const user = userEvent.setup();
    api.getConversations.mockResolvedValue(page([convoRow()]));
    api.getConversation.mockResolvedValue(convoDetail({ can_send: false }));

    renderAt("/");
    await openDrawer(user);
    await user.click(await screen.findByRole("button", { name: /Priya/ }));

    expect(await screen.findByText(/no longer connected/i)).toBeInTheDocument();
    expect(
      screen.queryByPlaceholderText(/write a message/i)
    ).not.toBeInTheDocument();
  });

  it("renders a placeholder for a deleted message", async () => {
    const user = userEvent.setup();
    api.getConversations.mockResolvedValue(page([convoRow()]));
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

    renderAt("/");
    await openDrawer(user);
    await user.click(await screen.findByRole("button", { name: /Priya/ }));

    expect(await screen.findByText("Message deleted")).toBeInTheDocument();
  });
});

describe("Messages drawer — group thread", () => {
  it("locks a pending group chat behind a PendingChatPanel with a Connect button", async () => {
    const user = userEvent.setup();
    api.getConversation.mockResolvedValue(
      groupConvoDetail({
        my_status: "pending",
        must_connect_with: [{ id: 5, display_name: "Amara", avatar_thumb: null }],
        can_send: false,
      })
    );
    api.connect.mockResolvedValue({});

    renderAt("/messages/11");

    expect(await screen.findByText(/connect with/i)).toBeInTheDocument();
    expect(screen.getAllByText("Amara").length).toBeGreaterThan(0);
    expect(
      screen.queryByPlaceholderText(/write a message/i)
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(api.connect).toHaveBeenCalledWith(5));

    expect(
      screen.getByRole("button", { name: /decline|leave/i })
    ).toBeInTheDocument();
  });

  it("shows the title, participant avatars, and composer for an active group chat", async () => {
    api.getConversation.mockResolvedValue(groupConvoDetail());
    api.getMessages.mockResolvedValue(page([]));

    renderAt("/messages/11");

    expect(await screen.findByText("Book Club")).toBeInTheDocument();
    expect(
      await screen.findByPlaceholderText(/write a message/i)
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /add people/i })
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /leave/i })).toBeInTheDocument();
  });

  it("leaves a group chat and returns to the list", async () => {
    const user = userEvent.setup();
    api.getConversation.mockResolvedValue(groupConvoDetail());
    api.getMessages.mockResolvedValue(page([]));
    api.getConversations.mockResolvedValue(page([]));
    api.leaveConversation.mockResolvedValue({});

    renderAt("/messages/11");
    await screen.findByText("Book Club");

    await user.click(screen.getByRole("button", { name: /leave/i }));

    await waitFor(() => expect(api.leaveConversation).toHaveBeenCalledWith(11));
    expect(await screen.findByText(/No conversations yet/i)).toBeInTheDocument();
  });

  it("adds people to the current chat via the Add people picker", async () => {
    const user = userEvent.setup();
    api.getConversation.mockResolvedValue(groupConvoDetail());
    api.getMessages.mockResolvedValue(page([]));
    api.listUsers.mockResolvedValue(
      page([{ id: 4, display_name: "Nadia", connection_status: "connected" }])
    );
    api.addParticipants.mockResolvedValue({});

    renderAt("/messages/11");
    await screen.findByText("Book Club");

    await user.click(screen.getByRole("button", { name: /add people/i }));

    await user.click(await screen.findByRole("checkbox", { name: "Nadia" }));
    await user.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() =>
      expect(api.addParticipants).toHaveBeenCalledWith(11, [4])
    );
    expect(api.createGroupChat).not.toHaveBeenCalled();
    expect(api.openConversation).not.toHaveBeenCalled();
    // Back in the thread it was added to.
    expect(await screen.findByText("Book Club")).toBeInTheDocument();
  });
});

describe("Profile messaging + block controls", () => {
  it("offers Message on a connected profile and opens the thread drawer", async () => {
    const user = userEvent.setup();
    api.getUser.mockResolvedValue({
      id: 2,
      display_name: "Priya",
      connection_status: "connected",
      is_blocked: false,
      bio: "",
    });
    api.getUserPosts.mockResolvedValue(page([]));
    api.openConversation.mockResolvedValue({ id: 7 });

    renderAt("/u/2");
    await user.click(await screen.findByRole("button", { name: "Message" }));

    await waitFor(() => expect(api.openConversation).toHaveBeenCalledWith(2));
    // The thread drawer opens in place (profile stays underneath).
    expect(
      await screen.findByRole("dialog", { name: "Messages" })
    ).toBeInTheDocument();
  });

  it("blocks a user after confirmation", async () => {
    const user = userEvent.setup();
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
    await user.click(await screen.findByRole("button", { name: "Block" }));

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
