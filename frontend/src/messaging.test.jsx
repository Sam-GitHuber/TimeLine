import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App.jsx";
import { renderWithAuth, fakeUser } from "./test-utils.jsx";
import { api } from "./api.js";
import { MessagingProvider } from "./messaging.jsx";
import { clearDrafts } from "./drafts.js";
import { clearOutbox } from "./outbox.js";
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
    editMessage: vi.fn(),
    deleteMessage: vi.fn(),
    reportContent: vi.fn(),
    markConversationRead: vi.fn(),
    getUnreadMessageCount: vi.fn(),
    getGroupInvites: vi.fn(),
    blockUser: vi.fn(),
    unblockUser: vi.fn(),
    addParticipants: vi.fn(),
    leaveConversation: vi.fn(),
    getDisconnectImpact: vi.fn(),
    getUnreadNotificationCount: vi.fn(),
    getNotifications: vi.fn(),
    markNotificationsSeen: vi.fn(),
    markNotificationAddressed: vi.fn(),
    toggleReaction: vi.fn(),
    getReactors: vi.fn(),
  },
  CONVERSATION_LIST_POLL_MS: 1_000_000, // effectively off in tests
  MESSAGE_POLL_MS: 1_000_000,
  CONVERSATION_DETAIL_POLL_MS: 1_000_000,
  NOTIFICATIONS_POLL_MS: 1_000_000,
  MESSAGE_EDIT_WINDOW_MS: 15 * 60 * 1000,
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
  // Drafts live outside React so they can survive a view unmounting (Phase 9b
  // M9b), which means they also survive a *test* — so they're reset here for the
  // same reason sign-out clears them.
  clearDrafts();
  // Unsent messages outlive the view too (Phase 9b M9c), for the same reason,
  // so a failed send in one test would otherwise turn up in the next.
  clearOutbox();
  api.getFeed.mockResolvedValue(page([]));
  api.getConnectionRequests.mockResolvedValue(page([]));
  api.getUnreadMessageCount.mockResolvedValue({ count: 0 });
  api.getGroupInvites.mockResolvedValue({ count: 0, results: [] });
  api.getUnreadNotificationCount.mockResolvedValue({ count: 0 });
  api.getNotifications.mockResolvedValue(page([]));
  api.markNotificationsSeen.mockResolvedValue({ updated: 0 });
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

  it("shows a row's preview as plain text, without the bubble's markup", async () => {
    const user = userEvent.setup();
    api.getConversations.mockResolvedValue(
      page([
        convoRow({
          last_message: {
            text: "*really* important",
            is_deleted: false,
            sender_id: 2,
            created_at: new Date().toISOString(),
          },
        }),
      ])
    );

    renderAt("/");
    await openDrawer(user);

    // A preview is one line of plain text and can't carry emphasis. Since M9b
    // the bubble renders `*really*` as bold, so leaving the asterisks here would
    // be the half-finished seam `plainMessageText` exists to close.
    expect(await screen.findByText("really important")).toBeInTheDocument();
    expect(screen.queryByText("*really* important")).toBeNull();
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
          // The backend's participants list includes the viewer themselves
          // (matching the real payload) — the fallback name must exclude them.
          participants: [
            { id: fakeUser.pk, display_name: "you", avatar_thumb: null, status: "active" },
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
    // Untitled group falls back to a comma-joined list of participant names,
    // excluding the viewer themselves (who is also in `participants`).
    const groupName = within(drawer).getByText("Priya, Sanjay");
    expect(groupName).toBeInTheDocument();
    expect(groupName.textContent).not.toContain("you");
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

  it("leaves a 1:1 thread unattributed — there's only one person it could be", async () => {
    api.getConversation.mockResolvedValue(convoDetail());
    api.getMessages.mockResolvedValue(
      page([
        {
          id: 1,
          sender: { id: 2, display_name: "Priya", avatar_thumb: null },
          text: "hey there",
          is_deleted: false,
          created_at: new Date().toISOString(),
        },
      ])
    );

    renderAt("/messages/7");

    expect(await screen.findByText("hey there")).toBeInTheDocument();
    const drawer = screen.getByRole("dialog", { name: "Messages" });
    // The only "Priya" is the header's profile link — no per-message label.
    expect(within(drawer).getAllByText("Priya")).toHaveLength(1);
    expect(
      within(drawer).getByRole("link", { name: /Priya/ })
    ).toBeInTheDocument();
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

  it("attributes each incoming sender, collapsing runs and leaving your own bubbles unlabelled", async () => {
    api.getConversation.mockResolvedValue(groupConvoDetail());
    // Newest-first, like the real payload since M9b (`?order=desc`) — so this
    // reads bottom-up: you, then Sanjay, then Priya's two in a row.
    api.getMessages.mockResolvedValue(
      page([
        {
          id: 4,
          sender: { id: fakeUser.pk, display_name: "you", avatar_thumb: null },
          text: "loved the ending",
          is_deleted: false,
          created_at: new Date().toISOString(),
        },
        {
          id: 3,
          sender: { id: 3, display_name: "Sanjay", avatar_thumb: null },
          text: "just finished it",
          is_deleted: false,
          created_at: new Date().toISOString(),
        },
        {
          id: 2,
          sender: { id: 2, display_name: "Priya", avatar_thumb: null },
          text: "did you read chapter 3?",
          is_deleted: false,
          created_at: new Date().toISOString(),
        },
        {
          id: 1,
          sender: { id: 2, display_name: "Priya", avatar_thumb: null },
          text: "hey there",
          is_deleted: false,
          created_at: new Date().toISOString(),
        },
      ])
    );

    renderAt("/messages/11");

    expect(await screen.findByText("hey there")).toBeInTheDocument();
    const drawer = screen.getByRole("dialog", { name: "Messages" });

    // Priya sent two in a row: both render, but the label appears once —
    // the run collapses rather than repeating her name on every bubble.
    expect(within(drawer).getByText("did you read chapter 3?")).toBeInTheDocument();
    expect(within(drawer).getAllByText("Priya")).toHaveLength(1);
    // Sanjay breaking the run starts a new one, so he gets his own label.
    expect(within(drawer).getAllByText("Sanjay")).toHaveLength(1);
    // Your own messages are already right-aligned — labelling them is noise.
    expect(within(drawer).getByText("loved the ending")).toBeInTheDocument();
    expect(within(drawer).queryByText("you")).not.toBeInTheDocument();
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

// Phase 9b M9b — the transcript the app has had since M5, and the ⋯ menu it has
// had since M1, brought to the web. The fixtures below are **newest-first**,
// because that's what `?order=desc` returns and what `toThreadRows` is fed.
describe("Messages drawer — transcript mechanics (Phase 9b M9b)", () => {
  function msg(overrides = {}) {
    return {
      id: 1,
      sender: { id: 2, display_name: "Priya", avatar_thumb: null },
      text: "hey there",
      is_deleted: false,
      is_edited: false,
      created_at: new Date().toISOString(),
      ...overrides,
    };
  }
  // A local wall-clock time today, so the rendered clock is the same string
  // whatever timezone the suite runs in.
  function at(hour, minute) {
    const d = new Date();
    d.setHours(hour, minute, 0, 0);
    return d.toISOString();
  }
  function daysAgo(days, hour = 9) {
    const d = new Date();
    d.setDate(d.getDate() - days);
    d.setHours(hour, 0, 0, 0);
    return d.toISOString();
  }
  const mine = { id: fakeUser.pk, display_name: "you", avatar_thumb: null };

  it("loads one page and only fetches older messages when you scroll back", async () => {
    api.getMessages.mockResolvedValue(
      page([msg({ id: 2, text: "second" }), msg({ id: 1, text: "first" })],
        "http://localhost:8000/api/conversations/7/messages/?order=desc&page=2")
    );
    api.getPage.mockResolvedValue(page([msg({ id: 0, text: "ancient" })]));

    renderAt("/messages/7");
    expect(await screen.findByText("second")).toBeInTheDocument();

    // The defect this milestone exists to fix: the drawer used to walk every
    // page in an effect, so opening a chat pulled its whole history.
    expect(api.getPage).not.toHaveBeenCalled();

    // jsdom has no layout, so every scroll reads as "at the top of what's
    // loaded" — which is exactly the condition that pages older messages in.
    fireEvent.scroll(screen.getByRole("log"));
    await waitFor(() => expect(api.getPage).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("ancient")).toBeInTheDocument();
  });

  it("offers Load more as well, since a short thread never fires a scroll", async () => {
    const user = userEvent.setup();
    api.getMessages.mockResolvedValue(
      page(
        [msg({ id: 1, text: "first" })],
        "http://localhost:8000/api/conversations/7/messages/?order=desc&page=2"
      )
    );
    api.getPage.mockResolvedValue(page([msg({ id: 0, text: "ancient" })]));

    renderAt("/messages/7");
    await screen.findByText("first");

    // Scrolling up is the main way older messages load, but `onScroll` never
    // fires on a transcript that doesn't overflow — so a first page that fits
    // the panel would otherwise leave the rest of the chat unreachable.
    await user.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() => expect(api.getPage).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("ancient")).toBeInTheDocument();
    // Nothing left to fetch: the control takes itself away.
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it("closes the ⋯ menu when the transcript scrolls out from under it", async () => {
    const user = userEvent.setup();
    api.getMessages.mockResolvedValue(page([msg({ id: 1, text: "hello" })]));

    renderAt("/messages/7");
    await screen.findByText("hello");
    await user.click(screen.getByRole("button", { name: "Message options" }));
    expect(
      screen.getByRole("dialog", { name: "Message options" })
    ).toBeInTheDocument();

    // The panel is measured once and then sits still, so a scroll would leave
    // it hovering over a different message — acting on the right one while
    // pointing at the wrong one is the failure an anchored menu exists to
    // prevent.
    fireEvent.scroll(screen.getByRole("log"));
    expect(screen.queryByRole("dialog", { name: "Message options" })).toBeNull();
  });

  it("groups the transcript by day and stamps bubbles with a clock time", async () => {
    api.getMessages.mockResolvedValue(
      page([
        msg({ id: 2, text: "this morning", created_at: at(9, 5) }),
        msg({ id: 1, text: "last week", created_at: daysAgo(8) }),
      ])
    );

    renderAt("/messages/7");

    expect(await screen.findByText("this morning")).toBeInTheDocument();
    expect(screen.getByText("Today")).toBeInTheDocument();
    // Clock times, not "5m ago": the separator above answers *which* day, so
    // what a bubble has to answer is when in it.
    expect(screen.getByText(/9:05am/)).toBeInTheDocument();
  });

  it("renders links as real links and draws an emoji-only message large", async () => {
    api.getMessages.mockResolvedValue(
      page([
        msg({ id: 2, text: "🎉" }),
        msg({ id: 1, text: "look at https://example.com/x, it's good" }),
      ])
    );

    renderAt("/messages/7");

    const link = await screen.findByRole("link", {
      name: "https://example.com/x",
    });
    // The trailing comma is the writer's punctuation, not part of the URL.
    expect(link).toHaveAttribute("href", "https://example.com/x");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noreferrer");
    expect(screen.getByText("🎉").className).toContain("text-[2.75rem]");
  });

  it("puts the unread divider where you stopped reading and leaves it there", async () => {
    const user = userEvent.setup();
    api.getConversation.mockResolvedValue(convoDetail({ unread_count: 2 }));
    api.getMessages.mockResolvedValue(
      page([
        msg({ id: 3, text: "and another" }),
        msg({ id: 2, text: "one you missed" }),
        msg({ id: 1, text: "yours", sender: mine }),
      ])
    );

    renderAt("/messages/7");

    const divider = await screen.findByText("2 unread messages");
    // Rows are newest-first in the DOM (the scroller is column-reverse), so the
    // divider's *previous* sibling is the oldest message it marks.
    expect(divider.closest("li").previousElementSibling).toHaveTextContent(
      "one you missed"
    );

    // A message arriving while you read must not slide the marker: the anchor
    // and the label are latched on open, not re-derived from a count that now
    // counts back from a different newest message.
    //
    // The arriving message has to be **theirs**. `firstUnreadId` skips your own,
    // so a message you sent yourself would leave the anchor where it is even
    // with the latch removed — the assertion would pass against the bug it's
    // here to catch.
    api.sendMessage.mockResolvedValue(msg({ id: 4, text: "ok", sender: mine }));
    api.getMessages.mockResolvedValue(
      page([
        msg({ id: 5, text: "and one more from them" }),
        msg({ id: 4, text: "ok", sender: mine }),
        msg({ id: 3, text: "and another" }),
        msg({ id: 2, text: "one you missed" }),
        msg({ id: 1, text: "yours", sender: mine }),
      ])
    );
    await user.type(
      screen.getByPlaceholderText(/write a message/i),
      "ok{Enter}"
    );

    expect(await screen.findByText("and one more from them")).toBeInTheDocument();
    const stillThere = screen.getByText("2 unread messages");
    expect(stillThere.closest("li").previousElementSibling).toHaveTextContent(
      "one you missed"
    );
  });

  it("keeps a per-conversation draft when you leave the thread and come back", async () => {
    const user = userEvent.setup();
    api.getConversations.mockResolvedValue(page([convoRow()]));

    renderAt("/");
    await openDrawer(user);
    await user.click(await screen.findByRole("button", { name: /Priya/ }));

    await user.type(
      await screen.findByPlaceholderText(/write a message/i),
      "half a thought"
    );
    await user.click(screen.getByRole("button", { name: /back/i }));
    await user.click(await screen.findByRole("button", { name: /Priya/ }));

    expect(await screen.findByPlaceholderText(/write a message/i)).toHaveValue(
      "half a thought"
    );
  });

  it("offers Edit on your own recent message and never on someone else's", async () => {
    const user = userEvent.setup();
    api.getMessages.mockResolvedValue(
      page([
        msg({ id: 2, text: "mine", sender: mine }),
        msg({ id: 1, text: "theirs" }),
      ])
    );

    renderAt("/messages/7");
    await screen.findByText("mine");

    const menus = screen.getAllByRole("button", { name: "Message options" });
    // Newest-first in the DOM: yours is the first trigger.
    await user.click(menus[0]);
    let panel = screen.getByRole("dialog", { name: "Message options" });
    expect(within(panel).getByRole("button", { name: "Edit" })).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "Delete" })).toBeInTheDocument();
    expect(within(panel).queryByRole("button", { name: "Report" })).toBeNull();

    await user.keyboard("{Escape}");
    await user.click(menus[1]);
    panel = screen.getByRole("dialog", { name: "Message options" });
    expect(within(panel).queryByRole("button", { name: "Edit" })).toBeNull();
    expect(within(panel).getByRole("button", { name: "Report" })).toBeInTheDocument();
    // Escape closed the menu, not the whole drawer.
    expect(screen.getByRole("dialog", { name: "Messages" })).toBeInTheDocument();
  });

  it("hides Edit once the fifteen-minute window has passed", async () => {
    const user = userEvent.setup();
    api.getMessages.mockResolvedValue(
      page([
        msg({
          id: 2,
          text: "long ago",
          sender: mine,
          created_at: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
        }),
      ])
    );

    renderAt("/messages/7");
    await screen.findByText("long ago");
    await user.click(screen.getByRole("button", { name: "Message options" }));

    const panel = screen.getByRole("dialog", { name: "Message options" });
    expect(within(panel).queryByRole("button", { name: "Edit" })).toBeNull();
    expect(within(panel).getByRole("button", { name: "Delete" })).toBeInTheDocument();
  });

  it("edits a message from the composer and shows the Edited marker", async () => {
    const user = userEvent.setup();
    const original = msg({ id: 5, text: "helo", sender: mine });
    api.getMessages.mockResolvedValue(page([original]));
    api.editMessage.mockResolvedValue({ ...original, text: "hello", is_edited: true });

    renderAt("/messages/7");
    await screen.findByText("helo");
    await user.click(screen.getByRole("button", { name: "Message options" }));
    await user.click(screen.getByRole("button", { name: "Edit" }));

    // Prefilled with the message, and clearly labelled as an edit rather than a
    // new message — Send has become Save.
    const box = screen.getByPlaceholderText(/edit your message/i);
    expect(box).toHaveValue("helo");
    expect(screen.getByText("Editing message")).toBeInTheDocument();

    api.getMessages.mockResolvedValue(
      page([{ ...original, text: "hello", is_edited: true }])
    );
    await user.clear(box);
    await user.type(box, "hello");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(api.editMessage).toHaveBeenCalledWith(7, 5, "hello")
    );
    expect(await screen.findByText("hello")).toBeInTheDocument();
    // The marker is the disclosure that makes editing safe at all, so it has to
    // be on the bubble rather than implied.
    expect(await screen.findByText(/Edited/)).toBeInTheDocument();
    // And the composer is back to writing a new message.
    expect(screen.queryByText("Editing message")).toBeNull();
  });

  it("restores whatever you were half-typing when you cancel an edit", async () => {
    const user = userEvent.setup();
    api.getMessages.mockResolvedValue(
      page([msg({ id: 5, text: "helo", sender: mine })])
    );

    renderAt("/messages/7");
    await screen.findByText("helo");
    await user.type(
      screen.getByPlaceholderText(/write a message/i),
      "unrelated draft"
    );

    await user.click(screen.getByRole("button", { name: "Message options" }));
    await user.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.getByPlaceholderText(/edit your message/i)).toHaveValue("helo");

    await user.click(screen.getByRole("button", { name: /cancel editing/i }));
    expect(screen.getByPlaceholderText(/write a message/i)).toHaveValue(
      "unrelated draft"
    );
    expect(api.editMessage).not.toHaveBeenCalled();
  });

  it("cancels an edit with Escape without closing the drawer", async () => {
    const user = userEvent.setup();
    api.getMessages.mockResolvedValue(
      page([msg({ id: 5, text: "helo", sender: mine })])
    );

    renderAt("/messages/7");
    await screen.findByText("helo");
    await user.type(
      screen.getByPlaceholderText(/write a message/i),
      "unrelated draft"
    );
    await user.click(screen.getByRole("button", { name: "Message options" }));
    await user.click(screen.getByRole("button", { name: "Edit" }));

    // The composer takes focus on the way into edit mode, so Escape lands here
    // rather than on the drawer behind it.
    const box = screen.getByPlaceholderText(/edit your message/i);
    expect(box).toHaveFocus();

    await user.keyboard("{Escape}");

    // The nearer thing wins: the edit is cancelled and the draft comes back,
    // but the panel — and the thread you were in — is still open. Losing the
    // whole drawer mid-correction would be a surprise.
    expect(screen.queryByText("Editing message")).toBeNull();
    expect(screen.getByPlaceholderText(/write a message/i)).toHaveValue(
      "unrelated draft"
    );
    expect(
      screen.getByRole("dialog", { name: "Messages" })
    ).toBeInTheDocument();
    expect(api.editMessage).not.toHaveBeenCalled();
  });

  it("reports the message itself, and says what a report hands over", async () => {
    const user = userEvent.setup();
    api.reportContent.mockResolvedValue({ id: 1 });
    api.getMessages.mockResolvedValue(page([msg({ id: 3, text: "nasty" })]));

    renderAt("/messages/7");
    await screen.findByText("nasty");
    await user.click(screen.getByRole("button", { name: "Message options" }));
    await user.click(screen.getByRole("button", { name: "Report" }));

    // The failure mode this asserts against is a dialog that looks right and
    // reports nothing: before M9b the modal took a post or a comment only, so
    // it would have been headed "Report this comment" and POSTed no target.
    expect(
      screen.getByRole("dialog", { name: "Report message" })
    ).toBeInTheDocument();
    expect(screen.getByText("Report this message")).toBeInTheDocument();
    // 🔒 M0's disclosure: a report is the only route by which a message ever
    // reaches the maintainer, so the reporter is told a copy goes with it.
    expect(
      screen.getByText(/A copy of this message is sent with your report/i)
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /send report/i }));
    await waitFor(() =>
      expect(api.reportContent).toHaveBeenCalledWith(
        expect.objectContaining({ messageId: 3 })
      )
    );
  });
});

describe("Messages drawer — reactions, send state and ticks (Phase 9b M9c)", () => {
  function msg(overrides = {}) {
    return {
      id: 1,
      sender: { id: 2, display_name: "Priya", avatar_thumb: null },
      text: "hey there",
      is_deleted: false,
      is_edited: false,
      created_at: new Date().toISOString(),
      reactions: [],
      ...overrides,
    };
  }
  const mineSender = { id: fakeUser.pk, display_name: "you", avatar_thumb: null };
  /** A participant row as the conversation detail serves it — `last_read_at`
   * present means they report; the key being *absent* means they don't. */
  function participant(id, name, overrides = {}) {
    return {
      id,
      display_name: name,
      avatar_thumb: null,
      status: "active",
      ...overrides,
    };
  }

  it("keeps the ⋯ inside the bubble, so the pills line up under it", async () => {
    api.getMessages.mockResolvedValue(
      page([
        msg({
          id: 3,
          text: "big news",
          reactions: [{ emoji: "👍", count: 1, reacted: false }],
        }),
      ])
    );

    renderAt("/messages/7");
    await screen.findByText("big news");

    // Beside the bubble the trigger was a flex sibling taking real width, so
    // every actionable bubble sat pushed in off the panel edge — and the pills,
    // which hang off the bubble's own edge, stopped lining up under it.
    const bubble = screen.getByText("big news").closest(".msg-menu-host");
    expect(bubble).not.toBeNull();
    expect(
      within(bubble).getByRole("button", { name: "Message options" })
    ).toBeInTheDocument();
  });

  it("reacts from the ⋯ menu and shows the pill the server sends back", async () => {
    const user = userEvent.setup();
    api.getMessages.mockResolvedValue(page([msg({ id: 3, text: "big news" })]));
    api.toggleReaction.mockResolvedValue({
      reactions: [{ emoji: "😮", count: 1, reacted: true }],
    });

    renderAt("/messages/7");
    await screen.findByText("big news");
    await user.click(screen.getByRole("button", { name: "Message options" }));

    // The chat's six, not the feed's four: 😮 and 😢 are the warm replies to
    // someone's news, and a set that can only be cheerful makes you type a
    // whole message to say "oh no".
    await user.click(screen.getByRole("button", { name: "React with 😮" }));
    await waitFor(() =>
      expect(api.toggleReaction).toHaveBeenCalledWith({
        messageId: 3,
        emoji: "😮",
      })
    );

    // No optimistic write (M2's fifth decision) — the pill is what the server
    // answered with, written straight into the cached page.
    expect(
      await screen.findByRole("button", { name: /😮, 1, including you/ })
    ).toBeInTheDocument();
  });

  it("says so when a reaction is rejected, rather than swallowing the click", async () => {
    const user = userEvent.setup();
    api.getMessages.mockResolvedValue(page([msg({ id: 3, text: "big news" })]));
    // The server owns the rules that can reject one — the per-target cap, emoji
    // validation, a thread you've been severed from — so its message is shown.
    api.toggleReaction.mockRejectedValue(
      new Error("You can only use 4 different emoji here.")
    );

    renderAt("/messages/7");
    await screen.findByText("big news");
    await user.click(screen.getByRole("button", { name: "Message options" }));
    await user.click(screen.getByRole("button", { name: "React with 👍" }));

    // There's no optimistic pill to take away, so silence would leave the click
    // looking as though it had worked.
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /only use 4 different emoji/i
    );
  });

  it("opens who-reacted from a pill, and takes your own reaction off there", async () => {
    const user = userEvent.setup();
    api.getMessages.mockResolvedValue(
      page([
        msg({
          id: 3,
          text: "big news",
          reactions: [{ emoji: "👍", count: 2, reacted: true }],
        }),
      ])
    );
    api.getReactors.mockResolvedValue([
      {
        emoji: "👍",
        count: 2,
        users: [
          { id: fakeUser.pk, display_name: "you" },
          { id: 2, display_name: "Priya" },
        ],
      },
    ]);
    api.toggleReaction.mockResolvedValue({ reactions: [] });

    renderAt("/messages/7");
    await screen.findByText("big news");

    // 🔒 One gesture: a pill *opens* the list, it never toggles. A tiny target
    // that both toggles and does something else is where a mis-click does the
    // wrong thing — and unlike a post's chip, a message has a ⋯ menu to carry
    // the alternative.
    await user.click(screen.getByRole("button", { name: /👍, 2, including you/ }));
    expect(
      await screen.findByRole("dialog", { name: "Who reacted" })
    ).toBeInTheDocument();
    expect(api.toggleReaction).not.toHaveBeenCalled();
    const list = screen.getByRole("dialog", { name: "Who reacted" });
    expect(within(list).getByText("Priya")).toBeInTheDocument();

    await user.click(within(list).getByRole("button", { name: /tap to remove/i }));
    await waitFor(() =>
      expect(api.toggleReaction).toHaveBeenCalledWith({
        messageId: 3,
        emoji: "👍",
      })
    );
  });

  it("shows a sent message instantly, before the server has answered", async () => {
    const user = userEvent.setup();
    api.getMessages.mockResolvedValue(page([]));
    // Never settles: the point is that the bubble doesn't wait for it.
    api.sendMessage.mockReturnValue(new Promise(() => {}));

    renderAt("/messages/7");
    const box = await screen.findByPlaceholderText(/write a message/i);
    await user.type(box, "on my way");
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByText("on my way")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Sending" })).toBeInTheDocument();
    // The composer clears on dispatch and never blocks — sending two quick
    // messages in a row is ordinary.
    expect(box).toHaveValue("");
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    // An unsent message has no ⋯ menu: every action it offers needs a server id
    // it hasn't got.
    expect(screen.queryByRole("button", { name: "Message options" })).toBeNull();
  });

  it("keeps a failed send in place with Retry, and never drops the text", async () => {
    const user = userEvent.setup();
    api.getMessages.mockResolvedValue(page([]));
    api.sendMessage.mockRejectedValue(new Error("offline"));

    renderAt("/messages/7");
    const box = await screen.findByPlaceholderText(/write a message/i);
    await user.type(box, "still here");
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByText("Not sent")).toBeInTheDocument();
    // The words stay exactly where they were put — this is the whole reason the
    // outbox sits outside the query cache, which a poll would have emptied.
    expect(screen.getByText("still here")).toBeInTheDocument();

    api.sendMessage.mockResolvedValue({
      ...msg({ id: 9, sender: mineSender, text: "still here" }),
    });
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(api.sendMessage).toHaveBeenCalledTimes(2)
    );
    await waitFor(() => expect(screen.queryByText("Not sent")).toBeNull());
  });

  // The read marker rides on the conversation *detail*, which is polled on
  // `CONVERSATION_DETAIL_POLL_MS` (off in tests) — so each state is staged as
  // its own render rather than by waiting for a poll to move one to the next.
  const sentAt = new Date(Date.now() - 60_000).toISOString();
  const joinedLongAgo = new Date(Date.now() - 600_000).toISOString();
  function detailWithMarkers(theirLastRead) {
    return convoDetail({
      participants: [
        participant(fakeUser.pk, "you", {
          last_read_at: null,
          active_since: joinedLongAgo,
        }),
        participant(2, "Priya", {
          last_read_at: theirLastRead,
          active_since: joinedLongAgo,
        }),
      ],
    });
  }

  it("doesn't replay the arrival animation when a send settles", async () => {
    const user = userEvent.setup();
    api.getMessages.mockResolvedValue(page([]));
    let accept;
    api.sendMessage.mockReturnValue(
      new Promise((resolve) => {
        accept = resolve;
      })
    );

    renderAt("/messages/7");
    const box = await screen.findByPlaceholderText(/write a message/i);
    await user.type(box, "hello");
    await user.click(screen.getByRole("button", { name: "Send" }));

    // The optimistic bubble is the one that arrives, so it animates.
    expect(screen.getByText("hello").closest("li")).toHaveClass("msg-bubble");

    const accepted = msg({ id: 9, sender: mineSender, text: "hello" });
    api.getMessages.mockResolvedValue(page([accepted]));
    accept(accepted);
    await waitFor(() =>
      expect(screen.queryByRole("img", { name: "Sending" })).toBeNull()
    );

    // ⚠️ Its replacement must not. A row is keyed `m-${id}`, so swapping the
    // temp id for the server's remounts the bubble and `tl-rise` would fade the
    // message up from nothing a moment after it appeared — the "appears to
    // change when it lands" flash the outbox exists to prevent.
    expect(screen.getByText("hello").closest("li")).not.toHaveClass(
      "msg-bubble"
    );
  });

  it("keeps a failed send when you go back to the list and return", async () => {
    const user = userEvent.setup();
    api.getConversations.mockResolvedValue(page([convoRow()]));
    api.getMessages.mockResolvedValue(page([]));
    api.sendMessage.mockRejectedValue(new Error("offline"));

    renderAt("/messages/7");
    const box = await screen.findByPlaceholderText(/write a message/i);
    await user.type(box, "don’t lose me");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByText("Not sent");

    // 🔒 This is the whole reason the outbox is a module-level store rather than
    // component state. The drawer switches list ↔ thread without a route
    // change, so held in the view a failed send — the one message this exists
    // to keep — would be thrown away by the most ordinary click there is.
    await user.click(screen.getByRole("button", { name: /back/i }));
    await screen.findByRole("button", { name: /Priya/ });
    await user.click(screen.getByRole("button", { name: /Priya/ }));

    expect(await screen.findByText("don’t lose me")).toBeInTheDocument();
    expect(screen.getByText("Not sent")).toBeInTheDocument();
  });

  it("ticks your own message sent, and never someone else's", async () => {
    // Their marker sits *before* the message: they haven't got to it yet.
    api.getConversation.mockResolvedValue(
      detailWithMarkers(new Date(Date.now() - 120_000).toISOString())
    );
    api.getMessages.mockResolvedValue(
      page([
        msg({ id: 3, sender: mineSender, text: "mine", created_at: sentAt }),
        msg({ id: 2, text: "theirs", created_at: sentAt }),
      ])
    );

    renderAt("/messages/7");
    await screen.findByText("mine");
    expect(screen.getByRole("img", { name: "Sent" })).toBeInTheDocument();
    // Exactly one: a tick on an incoming message would be telling you that you
    // read it.
    expect(screen.getAllByRole("img", { name: /Sent|Read/ })).toHaveLength(1);
  });

  it("ticks read once everyone it was for has read it", async () => {
    // Three states, not four — there is no "delivered", because nothing in our
    // stack reports that a device received anything.
    api.getConversation.mockResolvedValue(
      detailWithMarkers(new Date().toISOString())
    );
    api.getMessages.mockResolvedValue(
      page([msg({ id: 3, sender: mineSender, text: "mine", created_at: sentAt })])
    );

    renderAt("/messages/7");
    await screen.findByText("mine");
    expect(screen.getByRole("img", { name: "Read" })).toBeInTheDocument();
  });

  it("doesn't wait on someone who joined after the message was sent", async () => {
    // `active_since` after the message: it was never theirs to read, so the
    // tick mustn't stall on them. The client-side shadow of the server's
    // interval clipping — it grants nothing, it just stops a late arrival
    // holding a tick open forever.
    api.getConversation.mockResolvedValue(
      convoDetail({
        participants: [
          participant(fakeUser.pk, "you", {
            last_read_at: null,
            active_since: joinedLongAgo,
          }),
          participant(2, "Priya", {
            last_read_at: new Date().toISOString(),
            active_since: joinedLongAgo,
          }),
          participant(3, "Sanjay", {
            last_read_at: null,
            active_since: new Date().toISOString(),
          }),
        ],
      })
    );
    api.getMessages.mockResolvedValue(
      page([msg({ id: 3, sender: mineSender, text: "mine", created_at: sentAt })])
    );

    renderAt("/messages/7");
    await screen.findByText("mine");
    expect(screen.getByRole("img", { name: "Read" })).toBeInTheDocument();
  });

  it("shows no ticks at all when read receipts are off", async () => {
    // 🔒 The setting is symmetric and enforced server-side: with it off the
    // markers simply aren't on the payload, in either direction. Nothing is
    // hidden client-side, because hiding data already on the device would be
    // theatre — so "off" here is the absence of the key.
    api.getConversation.mockResolvedValue(
      convoDetail({
        participants: [
          participant(fakeUser.pk, "you"),
          participant(2, "Priya"),
        ],
      })
    );
    api.getMessages.mockResolvedValue(
      page([msg({ id: 3, sender: mineSender, text: "mine" })])
    );

    renderAt("/messages/7");
    await screen.findByText("mine");
    // The whole column goes, rather than freezing on one tick — a permanent
    // single tick would read as "nobody is ever opening these".
    expect(screen.queryByRole("img", { name: /Sent|Read|Sending/ })).toBeNull();
  });

  it("offers no way to react in a thread you can no longer send to", async () => {
    const user = userEvent.setup();
    api.getConversation.mockResolvedValue(convoDetail({ can_send: false }));
    api.getMessages.mockResolvedValue(page([msg({ id: 3, text: "old chat" })]));

    renderAt("/messages/7");
    await screen.findByText("old chat");
    await user.click(screen.getByRole("button", { name: "Message options" }));

    // Reacting is content everyone in the thread sees, so it needs `can_send`
    // exactly like editing does — the server 403s it either way. The menu just
    // doesn't offer what would fail.
    expect(screen.queryByRole("button", { name: /React with/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Report" })).toBeInTheDocument();
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

  it("blocks a user after confirming the warning modal (no shared chats)", async () => {
    const user = userEvent.setup();
    api.getUser.mockResolvedValue({
      id: 2,
      display_name: "Priya",
      connection_status: "none",
      is_blocked: false,
      bio: "",
    });
    api.getUserPosts.mockResolvedValue(page([]));
    api.getDisconnectImpact.mockResolvedValue({ chats: [] });
    api.blockUser.mockResolvedValue({ detail: "Blocked.", is_blocked: true });

    renderAt("/u/2");
    await user.click(await screen.findByRole("button", { name: "Block" }));

    const dialog = await screen.findByRole("dialog", {
      name: /block confirmation/i,
    });
    expect(api.blockUser).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole("button", { name: "Confirm" }));

    await waitFor(() => expect(api.blockUser).toHaveBeenCalledWith(2));
  });

  it("warns about shared group chats before blocking, and only blocks on Confirm", async () => {
    const user = userEvent.setup();
    api.getUser.mockResolvedValue({
      id: 2,
      display_name: "Priya",
      connection_status: "none",
      is_blocked: false,
      bio: "",
    });
    api.getUserPosts.mockResolvedValue(page([]));
    api.getDisconnectImpact.mockResolvedValue({
      chats: [
        { id: 11, title: "Book Club", kind: "group" },
        { id: 12, title: "Trip planning", kind: "group" },
      ],
    });
    api.blockUser.mockResolvedValue({ detail: "Blocked.", is_blocked: true });

    renderAt("/u/2");
    await user.click(await screen.findByRole("button", { name: "Block" }));

    const dialog = await screen.findByRole("dialog", {
      name: /block confirmation/i,
    });
    expect(within(dialog).getByText("Book Club")).toBeInTheDocument();
    expect(within(dialog).getByText("Trip planning")).toBeInTheDocument();
    // Not fired just for showing the warning.
    expect(api.blockUser).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole("button", { name: "Confirm" }));

    await waitFor(() => expect(api.blockUser).toHaveBeenCalledWith(2));
  });

  it("warns about shared group chats before disconnecting, and only disconnects on Confirm", async () => {
    const user = userEvent.setup();
    api.getUser.mockResolvedValue({
      id: 2,
      display_name: "Priya",
      connection_status: "connected",
      is_blocked: false,
      bio: "",
    });
    api.getUserPosts.mockResolvedValue(page([]));
    api.getDisconnectImpact.mockResolvedValue({
      chats: [
        { id: 11, title: "Book Club", kind: "group" },
        { id: 12, title: "Trip planning", kind: "group" },
      ],
    });
    api.disconnect.mockResolvedValue({ connection_status: "none" });

    renderAt("/u/2");
    await user.click(await screen.findByRole("button", { name: "Connected" }));

    const dialog = await screen.findByRole("dialog", {
      name: /disconnect confirmation/i,
    });
    expect(within(dialog).getByText("Book Club")).toBeInTheDocument();
    expect(within(dialog).getByText("Trip planning")).toBeInTheDocument();
    expect(api.disconnect).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole("button", { name: "Confirm" }));

    await waitFor(() => expect(api.disconnect).toHaveBeenCalledWith(2));
  });

  it("cancels out of the disconnect warning without disconnecting", async () => {
    const user = userEvent.setup();
    api.getUser.mockResolvedValue({
      id: 2,
      display_name: "Priya",
      connection_status: "connected",
      is_blocked: false,
      bio: "",
    });
    api.getUserPosts.mockResolvedValue(page([]));
    api.getDisconnectImpact.mockResolvedValue({
      chats: [{ id: 11, title: "Book Club", kind: "group" }],
    });

    renderAt("/u/2");
    await user.click(await screen.findByRole("button", { name: "Connected" }));

    const dialog = await screen.findByRole("dialog", {
      name: /disconnect confirmation/i,
    });
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));

    expect(
      screen.queryByRole("dialog", { name: /disconnect confirmation/i })
    ).not.toBeInTheDocument();
    expect(api.disconnect).not.toHaveBeenCalled();
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
