import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App.jsx";
import { renderWithAuth, fakeUser } from "./test-utils.jsx";
import { api } from "./api.js";
import { MessagingProvider } from "./messaging.jsx";
import { clearDrafts } from "./drafts.js";
import { clearOutbox } from "./outbox.js";
import { clearQuotes } from "./quotes.js";
import { prepareChatPhoto } from "./chatPhotos.js";
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
    getMessagesByIds: vi.fn(),
    getThread: vi.fn(),
    sendMessage: vi.fn(),
    editMessage: vi.fn(),
    deleteMessage: vi.fn(),
    reportContent: vi.fn(),
    markConversationRead: vi.fn(),
    markConversationUnread: vi.fn(),
    renameConversation: vi.fn(),
    setConversationMuted: vi.fn(),
    getConversationMedia: vi.fn(),
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

/**
 * The photo pipeline is stubbed, because jsdom has no image decoder and no
 * `canvas.toBlob` — there is nothing for `prepareChatPhoto` to do in here and
 * nothing it could prove. What *is* testable is that the drawer runs a picked
 * file through it and sends the result rather than the raw file, which is the
 * privacy-relevant half (see `chatPhotos.js`), and that's what the tests below
 * assert. Its own arithmetic is unit-tested in `chatPhotos.test.js`, and the
 * EXIF strip needs a real browser and a real photo — the one check M9e's
 * "Done when" leaves to a human.
 */
vi.mock("./chatPhotos.js", () => ({
  prepareChatPhoto: vi.fn(),
}));

/** What the stub hands back — the shape `api.sendMessage` expects. */
const preparedPhoto = {
  photo: new File(["photo"], "photo-1.jpg", { type: "image/jpeg" }),
  thumbnail: new File(["thumb"], "thumb-1.jpg", { type: "image/jpeg" }),
  width: 1200,
  height: 900,
  previewUrl: "blob:preview",
};

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

/** The thread header's ⋯ (Phase 9b M9e) — Details · Mute · Add · Leave. */
async function openHeaderMenu(user) {
  await user.click(
    screen.getByRole("button", { name: "Conversation options" })
  );
}

/** A conversation row's ⋯ (M9e) — Mark read/unread · Mute · Leave. */
async function openRowMenu(user, name) {
  await user.click(screen.getByRole("button", { name: `Options for ${name}` }));
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
  // 🔒 So do resolved quotes (Phase 9b M9d) — and this one holds *other
  // people's* message text, so it's cleared here for exactly the reason
  // sign-out clears it.
  clearQuotes();
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
  api.getMessagesByIds.mockResolvedValue(page([]));
  api.getThread.mockResolvedValue(page([]));
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
    await user.click(await screen.findByRole("button", {
      name: /Open conversation with Priya/,
    }));

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
    await user.click(await screen.findByRole("button", {
      name: /Open conversation with Priya/,
    }));

    const box = await screen.findByPlaceholderText(/write a message/i);
    await user.type(box, "yo");
    await user.click(screen.getByRole("button", { name: "Send" }));

    // The explicit `null` is "not a reply" (Phase 9b M9d) — the transcript's
    // composer never sends one; replying goes through the strand.
    await waitFor(() =>
      expect(api.sendMessage).toHaveBeenCalledWith(7, "yo", null, null, [])
    );
  });

  it("hides the composer when you can no longer message", async () => {
    const user = userEvent.setup();
    api.getConversations.mockResolvedValue(page([convoRow()]));
    api.getConversation.mockResolvedValue(convoDetail({ can_send: false }));

    renderAt("/");
    await openDrawer(user);
    await user.click(await screen.findByRole("button", {
      name: /Open conversation with Priya/,
    }));

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
    await user.click(await screen.findByRole("button", {
      name: /Open conversation with Priya/,
    }));

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
    const user = userEvent.setup();
    api.getConversation.mockResolvedValue(groupConvoDetail());
    api.getMessages.mockResolvedValue(page([]));

    renderAt("/messages/11");

    expect(await screen.findByText("Book Club")).toBeInTheDocument();
    expect(
      await screen.findByPlaceholderText(/write a message/i)
    ).toBeInTheDocument();
    // Since M9e the header is identity + ⋯ — Add and Leave live in the menu,
    // and Details opens the info panel that holds the rest.
    await openHeaderMenu(user);
    expect(
      screen.getByRole("button", { name: /add people/i })
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /leave/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Details" })).toBeInTheDocument();
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

    // Leaving confirms first now that it's a menu item (M9e) — a one-click
    // "leave" sitting in a list of ordinary actions is too easy to hit.
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    await openHeaderMenu(user);
    await user.click(screen.getByRole("button", { name: /leave/i }));
    expect(confirm).toHaveBeenCalled();
    confirm.mockRestore();

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

    await openHeaderMenu(user);
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
    await user.click(await screen.findByRole("button", {
      name: /Open conversation with Priya/,
    }));

    await user.type(
      await screen.findByPlaceholderText(/write a message/i),
      "half a thought"
    );
    await user.click(screen.getByRole("button", { name: /back/i }));
    await user.click(await screen.findByRole("button", {
      name: /Open conversation with Priya/,
    }));

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
    await screen.findByRole("button", {
      name: /Open conversation with Priya/,
    });
    await user.click(screen.getByRole("button", {
      name: /Open conversation with Priya/,
    }));

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

// Phase 9b M9d — reply threads on the web. The strand is a panel beside the
// transcript rather than the app's blur over it, but everything below the layout
// is the same behaviour: one flat strand per root, quotes resolved through the
// clipped endpoint, and every route in landing in the same place.
describe("Messages drawer — reply threads (Phase 9b M9d)", () => {
  function msg(overrides = {}) {
    return {
      id: 1,
      sender: { id: 2, display_name: "Priya", avatar_thumb: null },
      text: "hey there",
      is_deleted: false,
      is_edited: false,
      created_at: new Date().toISOString(),
      reactions: [],
      reply_to: null,
      thread_root_id: null,
      reply_count: 0,
      ...overrides,
    };
  }
  const mineSender = { id: fakeUser.pk, display_name: "you", avatar_thumb: null };

  /** The open strand panel, or a failure that says which one is missing. */
  function strand() {
    return screen.getByRole("region", { name: "Reply thread" });
  }

  async function openMenu(user, text) {
    // The ⋯ lives inside the bubble, so scope to the row the text is in.
    const bubble = (await screen.findByText(text)).closest("li");
    await user.click(within(bubble).getByRole("button", { name: "Message options" }));
  }

  it("opens a strand from Reply, and sends the reply into it", async () => {
    const user = userEvent.setup();
    const root = msg({ id: 5, text: "dinner?" });
    const sent = msg({
      id: 9,
      sender: mineSender,
      text: "yes!",
      reply_to: { id: 5 },
      thread_root_id: 5,
    });
    api.getMessages.mockResolvedValue(page([root]));
    // The strand's second read is after the send, so it has the reply — the
    // send invalidates `['thread', 7]` precisely so an open strand doesn't sit a
    // poll cycle behind the transcript behind it.
    api.getThread
      .mockResolvedValueOnce(page([root]))
      .mockResolvedValue(page([root, sent]));
    api.sendMessage.mockResolvedValue(sent);

    renderAt("/messages/7");
    expect(await screen.findByText("dinner?")).toBeInTheDocument();
    await openMenu(user, "dinner?");
    await user.click(screen.getByRole("button", { name: "Reply" }));

    // Reply opens the strand — it does *not* aim the transcript's composer at
    // the message. That's M3's first settled point, and the one a future session
    // is most likely to reverse by accident.
    expect(api.getThread).toHaveBeenCalledWith(7, 5);
    expect(within(strand()).getByText("dinner?")).toBeInTheDocument();
    expect(screen.queryByText(/Replying to/)).toBeNull();

    const box = within(strand()).getByLabelText("Reply to thread");
    await user.type(box, "yes!");
    await user.click(within(strand()).getByRole("button", { name: "Send" }));

    await waitFor(() =>
      expect(api.sendMessage).toHaveBeenCalledWith(7, "yes!", 5, null, [])
    );
    // And it lands in the strand you sent it from, not only in the transcript.
    expect(await within(strand()).findByText("yes!")).toBeInTheDocument();
  });

  it("pages a strand rather than showing its oldest twenty", async () => {
    const user = userEvent.setup();
    api.getMessages.mockResolvedValue(page([msg({ id: 5, text: "dinner?" })]));
    api.getThread.mockResolvedValue(
      page(
        [msg({ id: 5, text: "dinner?" })],
        "http://localhost:8000/api/conversations/7/messages/?thread_root=5&page=2"
      )
    );
    api.getPage.mockResolvedValue(
      page([msg({ id: 6, text: "the newest reply", reply_to: { id: 5 }, thread_root_id: 5 })])
    );

    renderAt("/messages/7");
    await openMenu(user, "dinner?");
    await user.click(screen.getByRole("button", { name: "Reply" }));

    // A strand is short and bounded, so every page is pulled — unlike the
    // transcript, which pages lazily. Reading only page one would cut a busy
    // strand off at its *oldest* twenty and hide the reply you just sent.
    expect(await within(strand()).findByText("the newest reply")).toBeInTheDocument();
  });

  it("lands a reply-to-a-reply in the same strand, quoting who you answered", async () => {
    const user = userEvent.setup();
    const root = msg({ id: 5, text: "dinner?", reply_count: 1 });
    const reply = msg({
      id: 6,
      sender: { id: 3, display_name: "Sanjay", avatar_thumb: null },
      text: "where though",
      reply_to: { id: 5 },
      thread_root_id: 5,
    });
    api.getMessages.mockResolvedValue(page([reply, root]));
    api.getThread.mockResolvedValue(page([root, reply]));
    api.sendMessage.mockResolvedValue(
      msg({ id: 7, sender: mineSender, text: "the usual", reply_to: { id: 6 }, thread_root_id: 5 })
    );

    renderAt("/messages/7");
    await openMenu(user, "where though");
    await user.click(screen.getByRole("button", { name: "Reply" }));

    // `thread_root_id`, not the message's own id: replying to a reply joins that
    // strand rather than starting a nested one. The server flattens it either
    // way — this is the client not asking for something different.
    expect(api.getThread).toHaveBeenCalledWith(7, 5);
    // And the composer aims at the reply you clicked, so the quote names who you
    // actually answered rather than whoever started the strand.
    expect(within(strand()).getByText("Replying to Sanjay")).toBeInTheDocument();

    await user.type(within(strand()).getByLabelText("Reply to thread"), "the usual");
    await user.click(within(strand()).getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(api.sendMessage).toHaveBeenCalledWith(7, "the usual", 6, null, [])
    );
  });

  it("opens the strand from a root's reply count, aimed at the root", async () => {
    const user = userEvent.setup();
    api.getMessages.mockResolvedValue(
      page([msg({ id: 5, text: "dinner?", reply_count: 3 })])
    );
    api.getThread.mockResolvedValue(page([msg({ id: 5, text: "dinner?" })]));

    renderAt("/messages/7");
    await user.click(await screen.findByRole("button", { name: /3 replies/ }));

    expect(api.getThread).toHaveBeenCalledWith(7, 5);
    // No "Replying to" label: the target *is* the root, and naming it would just
    // restate the message at the top of the panel.
    expect(within(strand()).queryByText(/Replying to/)).toBeNull();
  });

  it("resolves a quote through the clipped endpoint, never off the reply", async () => {
    api.getMessages.mockResolvedValue(
      page([
        msg({
          id: 6,
          text: "where though",
          reply_to: { id: 5 },
          thread_root_id: 5,
        }),
      ])
    );
    // The quoted message hasn't paged in — so it's fetched by id. 🔒 This is the
    // whole privacy design: the reply's payload carries a bare `{ id }`, and the
    // body comes back through the same interval-clipped queryset the transcript
    // reads.
    api.getMessagesByIds.mockResolvedValue(
      page([msg({ id: 5, text: "dinner?" })])
    );

    renderAt("/messages/7");
    expect(await screen.findByText("where though")).toBeInTheDocument();
    await waitFor(() =>
      expect(api.getMessagesByIds).toHaveBeenCalledWith(7, [5])
    );
    // Both halves of the resolved quote: the words, and the author — which the
    // reply's own payload never carried.
    const quote = await screen.findByRole("button", {
      name: "In reply to Priya — open thread",
    });
    expect(within(quote).getByText("dinner?")).toBeInTheDocument();
    expect(within(quote).getByText("Priya")).toBeInTheDocument();
  });

  it("asks about an unresolvable quote once, then says so with no author name", async () => {
    api.getMessages.mockResolvedValue(
      page([
        msg({
          id: 6,
          sender: { id: 3, display_name: "Sanjay", avatar_thumb: null },
          text: "where though",
          reply_to: { id: 5 },
          thread_root_id: 5,
        }),
      ])
    );
    // Clipped out of this viewer's history: the id simply isn't in the response,
    // indistinguishable from one that never existed.
    api.getMessagesByIds.mockResolvedValue(page([]));

    renderAt("/messages/7");
    expect(
      await screen.findByText("Original message unavailable")
    ).toBeInTheDocument();
    // 🔒 No name above it. A client that couldn't resolve the message isn't
    // entitled to its author either — someone can join a group, post and leave
    // entirely inside your gap, and this would be the one payload handing you
    // their name. Sanjay wrote the *reply*, so his name is on that bubble; the
    // quote carries nobody's.
    const quote = screen.getByText("Original message unavailable").parentElement;
    expect(within(quote).queryByText("Priya")).toBeNull();

    // Asked once and never again: an unresolvable id is a fact about this
    // viewer, not a transient failure, so re-asking every poll would be a
    // request that can only ever return nothing.
    expect(api.getMessagesByIds).toHaveBeenCalledTimes(1);
  });

  it("opens a headless strand from a reply's quote, and says the head is missing", async () => {
    const user = userEvent.setup();
    const orphan = msg({
      id: 6,
      text: "where though",
      reply_to: { id: 5 },
      thread_root_id: 5,
    });
    api.getMessages.mockResolvedValue(page([orphan]));
    api.getMessagesByIds.mockResolvedValue(page([]));
    // The strand comes back with the replies this viewer may see and no root.
    api.getThread.mockResolvedValue(page([orphan]));

    renderAt("/messages/7");
    // The quote is the only way in here, and that's the point rather than a
    // convenience: with the root clipped out there's no bubble to carry a reply
    // count, so without this the strand would be unreachable for exactly the
    // person whose view of it is already partial.
    await user.click(
      await screen.findByRole("button", {
        name: /In reply to a message you can’t see/,
      })
    );

    expect(api.getThread).toHaveBeenCalledWith(7, 5);
    // Different wording from a quote's "Original message unavailable", which on
    // a whole strand reads as an error. Two different things to tell someone.
    expect(
      within(strand()).getByText(/The start of this thread isn’t available/)
    ).toBeInTheDocument();
  });

  it("keeps a failed reply in the strand, and retries it as a reply", async () => {
    const user = userEvent.setup();
    api.getMessages.mockResolvedValue(page([msg({ id: 5, text: "dinner?" })]));
    api.getThread.mockResolvedValue(page([msg({ id: 5, text: "dinner?" })]));
    api.sendMessage.mockRejectedValue(new Error("offline"));

    renderAt("/messages/7");
    await openMenu(user, "dinner?");
    await user.click(screen.getByRole("button", { name: "Reply" }));

    await user.type(within(strand()).getByLabelText("Reply to thread"), "yes!");
    await user.click(within(strand()).getByRole("button", { name: "Send" }));

    // The failure lands on the bubble, in the panel you sent it from — which is
    // the only thing on screen while a strand is open.
    expect(await within(strand()).findByText("Not sent")).toBeInTheDocument();
    expect(within(strand()).getByText("yes!")).toBeInTheDocument();

    api.sendMessage.mockResolvedValue(
      msg({ id: 9, sender: mineSender, text: "yes!", reply_to: { id: 5 }, thread_root_id: 5 })
    );
    await user.click(within(strand()).getByRole("button", { name: "Retry" }));
    // ⚠️ Still a reply. The `replyToId` is kept on the outbox entry precisely so
    // a retry can't quietly turn a failed reply into an ordinary message.
    await waitFor(() =>
      expect(api.sendMessage).toHaveBeenLastCalledWith(7, "yes!", 5, null, [])
    );
  });

  it("offers no Edit inside the strand — one composer, one job", async () => {
    const user = userEvent.setup();
    const own = msg({ id: 5, sender: mineSender, text: "dinner?" });
    api.getMessages.mockResolvedValue(page([own]));
    api.getThread.mockResolvedValue(page([own]));

    renderAt("/messages/7");
    await openMenu(user, "dinner?");
    // Offered in the transcript, on a recent message of your own.
    expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Reply" }));

    const bubble = within(strand()).getByText("dinner?").closest("li");
    await user.click(
      within(bubble).getByRole("button", { name: "Message options" })
    );
    // Editing needs a composer mode, and this composer already has a job. The
    // transcript keeps Edit — see `MessageStrandPanel`.
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument();
  });

  it("offers no Reply at all in a thread you can no longer send to", async () => {
    const user = userEvent.setup();
    api.getConversation.mockResolvedValue(convoDetail({ can_send: false }));
    api.getMessages.mockResolvedValue(page([msg({ id: 5, text: "dinner?" })]));

    renderAt("/messages/7");
    await openMenu(user, "dinner?");
    // The server refuses a reply from a severed connection exactly as it refuses
    // a message; the menu just doesn't offer what would come back 403.
    expect(screen.queryByRole("button", { name: "Reply" })).toBeNull();
  });

  // The next three are all one point: the strand reads a query of its *own*
  // (`['thread', id, rootId]`), so anything the thread view does to a message
  // has to reach that cache as well as the transcript's `['messages', id]`.
  // Reaching only the transcript isn't wrong-looking in the transcript — it's
  // invisible, because the transcript is hidden while a strand is open. The
  // click just appears to do nothing until the next poll.
  it("shows a reaction made inside the strand without waiting for a poll", async () => {
    const user = userEvent.setup();
    const root = msg({ id: 5, text: "dinner?" });
    api.getMessages.mockResolvedValue(page([root]));
    api.getThread.mockResolvedValue(page([root]));
    api.toggleReaction.mockResolvedValue({
      reactions: [{ emoji: "👍", count: 1, reacted: true }],
    });

    renderAt("/messages/7");
    await openMenu(user, "dinner?");
    await user.click(screen.getByRole("button", { name: "Reply" }));

    const bubble = within(strand()).getByText("dinner?").closest("li");
    await user.click(
      within(bubble).getByRole("button", { name: "Message options" })
    );
    await user.click(screen.getByRole("button", { name: "React with 👍" }));

    await waitFor(() =>
      expect(api.toggleReaction).toHaveBeenCalledWith({
        messageId: 5,
        emoji: "👍",
      })
    );
    // M2's fifth decision is that there's no *optimistic* write — the server
    // owns the rules — which is only tolerable because the response is written
    // straight in. In here that means writing it into the strand's cache too.
    expect(
      await within(strand()).findByRole("button", {
        name: /👍, 1, including you/,
      })
    ).toBeInTheDocument();
  });

  it("clears a message from the strand when you delete it there", async () => {
    const user = userEvent.setup();
    const root = msg({ id: 5, sender: mineSender, text: "dinner?" });
    const reply = msg({
      id: 6,
      sender: mineSender,
      text: "actually no",
      reply_to: { id: 5 },
      thread_root_id: 5,
    });
    api.getMessages.mockResolvedValue(page([reply, root]));
    api.getThread.mockResolvedValue(page([root, reply]));
    api.deleteMessage.mockResolvedValue({});

    renderAt("/messages/7");
    // In from the reply rather than the root: the root's words are also in the
    // reply's quote, so "dinner?" is on screen twice.
    await openMenu(user, "actually no");
    await user.click(screen.getByRole("button", { name: "Reply" }));

    const bubble = within(strand()).getByText("actually no").closest("li");
    await user.click(
      within(bubble).getByRole("button", { name: "Message options" })
    );
    // What the strand's re-read comes back with once the delete has landed.
    api.getThread.mockResolvedValue(
      page([root, { ...reply, is_deleted: true, text: "" }])
    );
    await user.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(api.deleteMessage).toHaveBeenCalledWith(7, 6));
    expect(
      await within(strand()).findByText("Message deleted")
    ).toBeInTheDocument();
  });

  it("closes the strand on Escape rather than the whole drawer", async () => {
    const user = userEvent.setup();
    api.getMessages.mockResolvedValue(page([msg({ id: 5, text: "dinner?" })]));
    api.getThread.mockResolvedValue(page([msg({ id: 5, text: "dinner?" })]));

    renderAt("/messages/7");
    await openMenu(user, "dinner?");
    await user.click(screen.getByRole("button", { name: "Reply" }));
    expect(strand()).toBeInTheDocument();

    await user.keyboard("{Escape}");

    // The nearer thing wins — the same call the composer's Escape already makes
    // for edit mode. Losing the whole panel (and the draft and edit the strand
    // is hidden *over*) because you wanted to leave a thread would be a
    // surprise, and Escape is the only key anyone tries first.
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "Reply thread" })).toBeNull()
    );
    expect(screen.getByRole("dialog", { name: "Messages" })).toBeInTheDocument();
    // And focus comes back into the transcript. The element it was on has just
    // unmounted, so left alone it falls to `<body>` — and the drawer is
    // deliberately not a focus trap, so the next Tab would start at the top of
    // the page, outside the panel entirely.
    expect(screen.getByPlaceholderText(/write a message/i)).toHaveFocus();
  });
});

// Phase 9b M9e — photos, the conversation list's search and row actions, and
// the info panel. The web's half of M7 + M6.
describe("Messages drawer — photos (Phase 9b M9e)", () => {
  function photoMessage(overrides = {}) {
    return {
      id: 1,
      sender: { id: 2, display_name: "Priya", avatar_thumb: null },
      text: "",
      is_deleted: false,
      created_at: new Date().toISOString(),
      attachments: [
        {
          id: 44,
          kind: "image",
          url: "/media/messages/full.jpg",
          thumbnail: "/media/messages/thumb.jpg",
          width: 1200,
          height: 900,
        },
      ],
      ...overrides,
    };
  }

  it("runs a picked file through the client-side pipeline and sends what comes out", async () => {
    const user = userEvent.setup();
    api.getConversation.mockResolvedValue(convoDetail());
    api.getMessages.mockResolvedValue(page([]));
    prepareChatPhoto.mockResolvedValue(preparedPhoto);
    api.sendMessage.mockResolvedValue(photoMessage({ id: 9, text: "look" }));

    renderAt("/messages/7");
    await screen.findByPlaceholderText(/write a message/i);

    const file = new File(["raw"], "IMG_4686.jpg", { type: "image/jpeg" });
    await user.upload(screen.getByTestId("chat-photo-input"), file);

    // The preview appears once the photo is prepared, and the attach button
    // closes: one attachment per message, which is the server's cap.
    expect(await screen.findByAltText("Photo to send")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add a photo" })).toBeDisabled();

    await user.type(screen.getByPlaceholderText(/write a message/i), "look");
    await user.click(screen.getByRole("button", { name: "Send" }));

    // 🔒 The *prepared* photo, never the file off the input. The server doesn't
    // open a chat attachment, so this pass is the only thing that strips the
    // EXIF — including the GPS a phone stamps on every shot.
    await waitFor(() =>
      expect(api.sendMessage).toHaveBeenCalledWith(
        7,
        "look",
        null,
        preparedPhoto,
        []
      )
    );
    expect(prepareChatPhoto).toHaveBeenCalledWith(file);
    // And the composer is empty again — the photo went with the message rather
    // than staying queued for the next one.
    await waitFor(() =>
      expect(screen.queryByAltText("Photo to send")).toBeNull()
    );
  });

  it("sends a photo with no caption at all", async () => {
    const user = userEvent.setup();
    api.getConversation.mockResolvedValue(convoDetail());
    api.getMessages.mockResolvedValue(page([]));
    prepareChatPhoto.mockResolvedValue(preparedPhoto);
    api.sendMessage.mockResolvedValue(photoMessage({ id: 9 }));

    renderAt("/messages/7");
    await screen.findByPlaceholderText(/write a message/i);

    // Send is dead with an empty composer and nothing attached…
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();

    await user.upload(
      screen.getByTestId("chat-photo-input"),
      new File(["raw"], "beach.jpg", { type: "image/jpeg" })
    );
    await screen.findByAltText("Photo to send");

    // …and live once a photo is attached: a picture with no words is an
    // ordinary message, and the server agrees.
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(api.sendMessage).toHaveBeenCalledWith(7, "", null, preparedPhoto, [])
    );
  });

  it("takes a queued photo back off the composer", async () => {
    const user = userEvent.setup();
    api.getConversation.mockResolvedValue(convoDetail());
    api.getMessages.mockResolvedValue(page([]));
    prepareChatPhoto.mockResolvedValue(preparedPhoto);

    renderAt("/messages/7");
    await screen.findByPlaceholderText(/write a message/i);
    await user.upload(
      screen.getByTestId("chat-photo-input"),
      new File(["raw"], "beach.jpg", { type: "image/jpeg" })
    );
    await screen.findByAltText("Photo to send");

    await user.click(screen.getByRole("button", { name: "Remove photo" }));

    expect(screen.queryByAltText("Photo to send")).toBeNull();
    expect(screen.getByRole("button", { name: "Add a photo" })).toBeEnabled();
  });

  it("frees an abandoned photo's preview when the thread goes away", async () => {
    const user = userEvent.setup();
    api.getConversation.mockResolvedValue(convoDetail());
    api.getMessages.mockResolvedValue(page([]));
    api.getConversations.mockResolvedValue(page([]));
    prepareChatPhoto.mockResolvedValue(preparedPhoto);
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});

    renderAt("/messages/7");
    await screen.findByPlaceholderText(/write a message/i);
    await user.upload(
      screen.getByTestId("chat-photo-input"),
      new File(["raw"], "beach.jpg", { type: "image/jpeg" })
    );
    await screen.findByAltText("Photo to send");
    expect(revoke).not.toHaveBeenCalled();

    // Back to the list unmounts the thread with the photo still queued. An
    // object URL is a document-lifetime reference, so left alone every
    // abandoned pick pins its thumbnail's bytes until the tab closes.
    await user.click(screen.getByRole("button", { name: "Back" }));

    await waitFor(() =>
      expect(revoke).toHaveBeenCalledWith(preparedPhoto.previewUrl)
    );
    revoke.mockRestore();
  });

  it("does not free the preview when the photo is handed to the outbox", async () => {
    const user = userEvent.setup();
    api.getConversation.mockResolvedValue(convoDetail());
    api.getMessages.mockResolvedValue(page([]));
    prepareChatPhoto.mockResolvedValue(preparedPhoto);
    // Left in flight, so the entry — and the URL its bubble is drawing — stays.
    api.sendMessage.mockReturnValue(new Promise(() => {}));
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});

    renderAt("/messages/7");
    await screen.findByPlaceholderText(/write a message/i);
    await user.upload(
      screen.getByTestId("chat-photo-input"),
      new File(["raw"], "beach.jpg", { type: "image/jpeg" })
    );
    await screen.findByAltText("Photo to send");
    await user.click(screen.getByRole("button", { name: "Send" }));

    // ⚠️ Ownership passes to the outbox on send, and revoking here would blank
    // the in-flight bubble now drawing it — which is why the composer clears its
    // state without revoking, and why the unmount cleanup is keyed on nothing.
    await waitFor(() =>
      expect(screen.queryByAltText("Photo to send")).toBeNull()
    );
    expect(revoke).not.toHaveBeenCalled();
    revoke.mockRestore();
  });

  it("says so when a photo can't be prepared, and sends nothing", async () => {
    const user = userEvent.setup();
    api.getConversation.mockResolvedValue(convoDetail());
    api.getMessages.mockResolvedValue(page([]));
    prepareChatPhoto.mockRejectedValue(new Error("nope"));

    renderAt("/messages/7");
    await screen.findByPlaceholderText(/write a message/i);
    await user.upload(
      screen.getByTestId("chat-photo-input"),
      new File(["raw"], "broken.jpg", { type: "image/jpeg" })
    );

    // It never reached the outbox, so there's no bubble to fail on — the
    // composer is the only place left to say it.
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /couldn’t use that photo/i
    );
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it("draws the thumbnail at the size the sender declared, and opens it full-size", async () => {
    const user = userEvent.setup();
    api.getConversation.mockResolvedValue(convoDetail());
    api.getMessages.mockResolvedValue(page([photoMessage()]));

    renderAt("/messages/7");

    const thumb = await screen.findByAltText("Photo");
    expect(thumb).toHaveAttribute("src", "/media/messages/thumb.jpg");
    // 1200×900 fitted into the bubble's 224px of content width — the point being
    // that the box exists *before* the image loads, so a photo arriving while
    // you're scrolled back doesn't shove what you were reading.
    expect(thumb).toHaveAttribute("width", "224");
    expect(thumb).toHaveAttribute("height", "168");

    await user.click(screen.getByRole("button", { name: "Open photo" }));

    // The shared viewer, on the full-size file rather than the thumbnail.
    const viewer = await screen.findByRole("dialog", { name: "Photo viewer" });
    expect(within(viewer).getByRole("img")).toHaveAttribute(
      "src",
      "/media/messages/full.jpg"
    );
  });

  it("retries a failed photo send *with the photo*, not the caption alone", async () => {
    const user = userEvent.setup();
    api.getConversation.mockResolvedValue(convoDetail());
    api.getMessages.mockResolvedValue(page([]));
    prepareChatPhoto.mockResolvedValue(preparedPhoto);
    api.sendMessage.mockRejectedValue(new Error("offline"));

    renderAt("/messages/7");
    await screen.findByPlaceholderText(/write a message/i);
    await user.upload(
      screen.getByTestId("chat-photo-input"),
      new File(["raw"], "beach.jpg", { type: "image/jpeg" })
    );
    await screen.findByAltText("Photo to send");
    await user.type(screen.getByPlaceholderText(/write a message/i), "look");
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByText("Not sent")).toBeInTheDocument();

    api.sendMessage.mockResolvedValue(photoMessage({ id: 9, text: "look" }));
    await user.click(screen.getByRole("button", { name: "Retry" }));

    // ⚠️ The photo comes off the *entry*, not recomputed — a retry that dropped
    // it would send the caption alone and silently lose the picture, which is
    // the one thing this whole path exists to prevent. (The same reason a
    // retried reply keeps its `replyToId`, and a retried mention its ids.)
    await waitFor(() =>
      expect(api.sendMessage).toHaveBeenLastCalledWith(
        7,
        "look",
        null,
        preparedPhoto,
        []
      )
    );
  });

  it("shows the server's reason on a send it will never accept", async () => {
    const user = userEvent.setup();
    api.getConversation.mockResolvedValue(convoDetail());
    api.getMessages.mockResolvedValue(page([]));
    prepareChatPhoto.mockResolvedValue(preparedPhoto);
    api.sendMessage.mockRejectedValue(
      new Error("Each photo must be under 4 MB.")
    );

    renderAt("/messages/7");
    await screen.findByPlaceholderText(/write a message/i);
    await user.upload(
      screen.getByTestId("chat-photo-input"),
      new File(["raw"], "huge.jpg", { type: "image/jpeg" })
    );
    await screen.findByAltText("Photo to send");
    await user.click(screen.getByRole("button", { name: "Send" }));

    // Beside "Not sent", never instead of it: a refusal will fail again however
    // often it's retried, so without the reason Retry is a button that can only
    // disappoint.
    expect(await screen.findByText("Not sent")).toBeInTheDocument();
    expect(
      screen.getByText("Each photo must be under 4 MB.")
    ).toBeInTheDocument();
  });

  it("won't let a queued photo turn an emptied edit into a PATCH", async () => {
    const user = userEvent.setup();
    api.getConversation.mockResolvedValue(convoDetail());
    api.getMessages.mockResolvedValue(
      page([
        {
          id: 5,
          sender: { id: fakeUser.pk, display_name: "you", avatar_thumb: null },
          text: "teh plan",
          is_deleted: false,
          created_at: new Date().toISOString(),
        },
      ])
    );
    prepareChatPhoto.mockResolvedValue(preparedPhoto);

    renderAt("/messages/7");
    await screen.findByText("teh plan");
    await user.upload(
      screen.getByTestId("chat-photo-input"),
      new File(["raw"], "beach.jpg", { type: "image/jpeg" })
    );
    await screen.findByAltText("Photo to send");

    await user.click(screen.getByRole("button", { name: "Message options" }));
    await user.click(screen.getByRole("button", { name: "Edit" }));
    await user.clear(screen.getByPlaceholderText(/edit your message/i));

    // ⚠️ The queued photo made `!value` false, so the send-side guard let an
    // empty edit through — a `PATCH` the server answers "A message can't be
    // empty". A `PATCH` can't carry an attachment, so the composer's photo has
    // nothing to do with whether an edit has something to say.
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    await user.keyboard("{Enter}");
    expect(api.editMessage).not.toHaveBeenCalled();
  });

  it("lets a photo message's caption be edited away, as the server does", async () => {
    const user = userEvent.setup();
    api.getConversation.mockResolvedValue(convoDetail());
    api.getMessages.mockResolvedValue(
      page([
        photoMessage({
          id: 5,
          text: "look",
          sender: { id: fakeUser.pk, display_name: "you", avatar_thumb: null },
        }),
      ])
    );
    api.editMessage.mockResolvedValue({});

    renderAt("/messages/7");
    await screen.findByText("look");

    await user.click(screen.getByRole("button", { name: "Message options" }));
    await user.click(screen.getByRole("button", { name: "Edit" }));
    await user.clear(screen.getByPlaceholderText(/edit your message/i));
    await user.click(screen.getByRole("button", { name: "Save" }));

    // A photo with no caption is an ordinary message, so editing one down to
    // nothing is legitimate — `MessageSerializer.validate` allows exactly this
    // via `has_attachments`, and the composer mustn't be stricter than it.
    await waitFor(() => expect(api.editMessage).toHaveBeenCalledWith(7, 5, ""));
  });

  it("closes the photo on Escape without taking the drawer with it", async () => {
    const user = userEvent.setup();
    api.getConversation.mockResolvedValue(convoDetail());
    api.getMessages.mockResolvedValue(page([photoMessage()]));

    renderAt("/messages/7");
    await screen.findByAltText("Photo");
    await user.click(screen.getByRole("button", { name: "Open photo" }));
    await screen.findByRole("dialog", { name: "Photo viewer" });

    await user.keyboard("{Escape}");

    // ⚠️ Both listen on `document`, so before M9e made the viewer capture the
    // key, one press shut the photo *and* the panel behind it — dumping you back
    // on the timeline for wanting to stop looking at a picture.
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Photo viewer" })).toBeNull()
    );
    expect(screen.getByRole("dialog", { name: "Messages" })).toBeInTheDocument();
  });

  it("previews a captionless photo in the list as “📷 Photo”", async () => {
    const user = userEvent.setup();
    api.getConversations.mockResolvedValue(
      page([
        convoRow({
          last_message: {
            text: "",
            is_deleted: false,
            sender_id: 2,
            attachment_count: 1,
            created_at: new Date().toISOString(),
          },
        }),
      ])
    );

    renderAt("/");
    await openDrawer(user);

    // A count, not a rendered string: the phrasing is the client's, and a count
    // is the one fact about an attachment that survives the server not being
    // able to see it. Without this the row would be a blank line.
    expect(await screen.findByText("📷 Photo")).toBeInTheDocument();
  });
});

describe("Messages drawer — list search and row actions (Phase 9b M9e)", () => {
  function manyConversations() {
    return page([
      convoRow({ id: 1, other: { id: 21, display_name: "Priya", avatar_thumb: null } }),
      convoRow({ id: 2, other: { id: 22, display_name: "Sanjay", avatar_thumb: null } }),
      convoRow({ id: 3, other: { id: 23, display_name: "Amara", avatar_thumb: null } }),
      convoRow({ id: 4, other: { id: 24, display_name: "Nadia", avatar_thumb: null } }),
      convoRow({ id: 5, other: { id: 25, display_name: "Tom", avatar_thumb: null } }),
      convoRow({
        id: 6,
        kind: "group",
        title: "",
        other: null,
        participants: [
          { id: fakeUser.pk, display_name: "you", avatar_thumb: null },
          { id: 26, display_name: "Rosa", avatar_thumb: null },
        ],
      }),
    ]);
  }

  it("offers search once the list is long enough, matching names and group members", async () => {
    const user = userEvent.setup();
    api.getConversations.mockResolvedValue(manyConversations());

    renderAt("/");
    await openDrawer(user);
    await screen.findByText("Priya");

    const search = screen.getByRole("searchbox", {
      name: "Search conversations",
    });
    await user.type(search, "sanj");
    expect(screen.getByText("Sanjay")).toBeInTheDocument();
    expect(screen.queryByText("Priya")).toBeNull();

    // An *untitled* group is displayed as its members, so it has to be findable
    // by the name on the screen in front of you.
    await user.clear(search);
    await user.type(search, "rosa");
    expect(screen.getByText("Rosa")).toBeInTheDocument();
    expect(screen.queryByText("Sanjay")).toBeNull();

    await user.clear(search);
    await user.type(search, "zzz");
    expect(screen.getByText(/No conversations match/)).toBeInTheDocument();
  });

  it("keeps the search field out of a short list", async () => {
    const user = userEvent.setup();
    api.getConversations.mockResolvedValue(page([convoRow()]));

    renderAt("/");
    await openDrawer(user);
    await screen.findByText("Priya");

    // Below six you can see every chat you have, so the box is chrome.
    expect(
      screen.queryByRole("searchbox", { name: "Search conversations" })
    ).toBeNull();
  });

  it("marks a read thread unread from the row menu", async () => {
    const user = userEvent.setup();
    api.getConversations.mockResolvedValue(
      page([convoRow({ unread_count: 0 })])
    );
    api.markConversationUnread.mockResolvedValue({ unread_count: 1 });

    renderAt("/");
    await openDrawer(user);
    await screen.findByText("Priya");

    await openRowMenu(user, "Priya");
    await user.click(screen.getByRole("button", { name: "Mark unread" }));

    await waitFor(() =>
      expect(api.markConversationUnread).toHaveBeenCalledWith(7)
    );
  });

  it("offers Mark read instead when the thread already has unread", async () => {
    const user = userEvent.setup();
    api.getConversations.mockResolvedValue(page([convoRow()]));
    api.markConversationRead.mockResolvedValue({});

    renderAt("/");
    await openDrawer(user);
    await screen.findByText("Priya");

    await openRowMenu(user, "Priya");
    expect(screen.queryByRole("button", { name: "Mark unread" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Mark read" }));

    await waitFor(() =>
      expect(api.markConversationRead).toHaveBeenCalledWith(7)
    );
  });

  it("doesn't offer Mark unread on a thread whose last message is yours", async () => {
    const user = userEvent.setup();
    api.getConversations.mockResolvedValue(
      page([
        convoRow({
          last_message: {
            text: "on my way",
            is_deleted: false,
            sender_id: fakeUser.pk,
            created_at: new Date().toISOString(),
          },
        }),
      ])
    );

    renderAt("/");
    await openDrawer(user);
    await screen.findByText("Priya");

    // The row carries only `last_message`, so it can't tell "I replied last"
    // from "I've been talking to myself" — and the second is a 400. An action
    // that sometimes errors is worse than one offered slightly less often.
    await openRowMenu(user, "Priya");
    expect(screen.queryByRole("button", { name: "Mark unread" })).toBeNull();
    expect(screen.getByRole("button", { name: "Mute" })).toBeInTheDocument();
  });

  it("mutes from the row, and the row then reads as muted", async () => {
    const user = userEvent.setup();
    api.getConversations.mockResolvedValueOnce(page([convoRow()]));
    api.getConversations.mockResolvedValue(page([convoRow({ muted: true })]));
    api.setConversationMuted.mockResolvedValue({});

    renderAt("/");
    await openDrawer(user);
    await screen.findByText("Priya");

    await openRowMenu(user, "Priya");
    await user.click(screen.getByRole("button", { name: "Mute" }));

    await waitFor(() =>
      expect(api.setConversationMuted).toHaveBeenCalledWith(7, true)
    );

    // The success invalidates the list, so the refetch below is what the row
    // redraws from — the same round trip a real mute makes.
    await waitFor(() =>
      expect(api.getConversations).toHaveBeenCalledTimes(2)
    );

    // Mute reads as its *state* on the second open, not as an imperative — the
    // whole risk of muting is forgetting you did.
    await openRowMenu(user, "Priya");
    expect(
      await screen.findByRole("button", { name: "Unmute" })
    ).toBeInTheDocument();
  });

  it("clears a failed row action when the next menu opens", async () => {
    const user = userEvent.setup();
    api.getConversations.mockResolvedValue(page([convoRow()]));
    api.markConversationRead.mockRejectedValue(new Error("Couldn’t do that."));

    renderAt("/");
    await openDrawer(user);
    await screen.findByText("Priya");

    await openRowMenu(user, "Priya");
    await user.click(screen.getByRole("button", { name: "Mark read" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /couldn’t do that/i
    );

    // One mutation is shared by every row, so without a reset a single failure
    // left a red line over the list until some *other* action happened to
    // succeed — long after it had stopped being true.
    await openRowMenu(user, "Priya");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("confirms before leaving from the row", async () => {
    const user = userEvent.setup();
    api.getConversations.mockResolvedValue(page([convoRow()]));
    api.leaveConversation.mockResolvedValue({});
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);

    renderAt("/");
    await openDrawer(user);
    await screen.findByText("Priya");

    await openRowMenu(user, "Priya");
    await user.click(screen.getByRole("button", { name: "Leave" }));

    // Declined at the prompt: nothing happens at all.
    expect(confirm).toHaveBeenCalled();
    expect(api.leaveConversation).not.toHaveBeenCalled();
    confirm.mockRestore();
  });
});

describe("Messages drawer — the info panel (Phase 9b M9e)", () => {
  async function openInfo(user) {
    await openHeaderMenu(user);
    await user.click(screen.getByRole("button", { name: "Details" }));
  }

  it("lists the participants, badging anyone still pending", async () => {
    const user = userEvent.setup();
    api.getConversation.mockResolvedValue(
      groupConvoDetail({
        participants: [
          { id: fakeUser.pk, display_name: "you", avatar_thumb: null, status: "active" },
          { id: 2, display_name: "Priya", avatar_thumb: null, status: "active" },
          { id: 3, display_name: "Sanjay", avatar_thumb: null, status: "pending" },
        ],
      })
    );
    api.getMessages.mockResolvedValue(page([]));
    api.getConversationMedia.mockResolvedValue(page([]));

    renderAt("/messages/11");
    await screen.findByText("Book Club");
    await openInfo(user);

    expect(await screen.findByText("3 people")).toBeInTheDocument();
    expect(screen.getByText("you (you)")).toBeInTheDocument();
    // A pending member is waiting on *connections* (the clique invariant), not
    // ignoring an invitation — so the badge is a fact, not a nudge.
    expect(screen.getByText("Pending")).toBeInTheDocument();
  });

  it("renames a group in place and shows the new name in the thread header", async () => {
    const user = userEvent.setup();
    api.getConversation.mockResolvedValue(groupConvoDetail());
    api.getMessages.mockResolvedValue(page([]));
    api.getConversationMedia.mockResolvedValue(page([]));
    api.renameConversation.mockResolvedValue(
      groupConvoDetail({ title: "Reading Club" })
    );

    renderAt("/messages/11");
    await screen.findByText("Book Club");
    await openInfo(user);

    await user.click(await screen.findByRole("button", { name: "Rename" }));
    const field = screen.getByRole("textbox", { name: "Chat name" });
    await user.clear(field);
    await user.type(field, "Reading Club");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(api.renameConversation).toHaveBeenCalledWith(11, "Reading Club")
    );
    // The response is written straight into the `['conversation', id]` cache the
    // thread header reads, so the new name is up before any refetch lands —
    // which is what this asserts: the panel is still showing the *old* mocked
    // payload from the server's point of view.
    expect(await screen.findByText("Reading Club")).toBeInTheDocument();

    api.getConversation.mockResolvedValue(
      groupConvoDetail({ title: "Reading Club" })
    );
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(await screen.findByText("Reading Club")).toBeInTheDocument();
  });

  it("offers no rename on a 1:1 — its name is the other person", async () => {
    const user = userEvent.setup();
    api.getConversation.mockResolvedValue(convoDetail());
    api.getMessages.mockResolvedValue(page([]));
    api.getConversationMedia.mockResolvedValue(page([]));
    api.getUser.mockResolvedValue({
      id: 2,
      display_name: "Priya",
      connection_status: "connected",
      is_blocked: false,
      bio: "",
    });

    renderAt("/messages/7");
    await screen.findByPlaceholderText(/write a message/i);
    await openInfo(user);

    expect(await screen.findByText("In this chat")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Rename" })).toBeNull();
    // Block belongs here as much as on a profile: the moment you want to block
    // someone is usually the moment you're looking at what they sent.
    expect(
      await screen.findByRole("button", { name: "Block" })
    ).toBeInTheDocument();
  });

  it("shows the chat's photos, newest first, and opens them as a gallery", async () => {
    const user = userEvent.setup();
    api.getConversation.mockResolvedValue(groupConvoDetail());
    api.getMessages.mockResolvedValue(page([]));
    api.getConversationMedia.mockResolvedValue({
      count: 42,
      next: null,
      results: [
        {
          id: 2,
          attachments: [
            {
              id: 91,
              kind: "image",
              url: "/media/new-full.jpg",
              thumbnail: "/media/new-thumb.jpg",
              width: 800,
              height: 600,
            },
          ],
        },
        {
          id: 1,
          attachments: [
            {
              id: 90,
              kind: "image",
              url: "/media/old-full.jpg",
              thumbnail: "/media/old-thumb.jpg",
              width: 800,
              height: 600,
            },
          ],
        },
      ],
    });

    renderAt("/messages/11");
    await screen.findByText("Book Club");
    await openInfo(user);

    // The heading counts what the *chat* holds, not what fits on a page —
    // telling someone with forty-two photos that they have two, confidently,
    // would be worse than saying nothing.
    expect(await screen.findByText("42 photos")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Photo 1 of 2" }));
    const viewer = await screen.findByRole("dialog", { name: "Photo viewer" });
    expect(within(viewer).getByRole("img")).toHaveAttribute(
      "src",
      "/media/new-full.jpg"
    );
    // Here the viewer *is* a gallery — you flip between the chat's photos,
    // which is what you came to this panel to do.
    await user.click(within(viewer).getByRole("button", { name: "Next photo" }));
    expect(within(viewer).getByRole("img")).toHaveAttribute(
      "src",
      "/media/old-full.jpg"
    );
  });

  it("renders no gallery at all in a chat with no photos", async () => {
    const user = userEvent.setup();
    api.getConversation.mockResolvedValue(groupConvoDetail());
    api.getMessages.mockResolvedValue(page([]));
    api.getConversationMedia.mockResolvedValue(page([]));

    renderAt("/messages/11");
    await screen.findByText("Book Club");
    await openInfo(user);

    // A heading over an empty grid is a feature announcing it has nothing for
    // you. The section appears the first time a photo is sent, and not before.
    expect(await screen.findByText("3 people")).toBeInTheDocument();
    expect(screen.queryByText(/^\d+ photos?$/)).toBeNull();
  });

  it("keeps “Muted” visible in the thread header", async () => {
    api.getConversation.mockResolvedValue(convoDetail({ muted: true }));
    api.getMessages.mockResolvedValue(page([]));

    renderAt("/messages/7");

    // The one thing that stayed beside the name when the header emptied into a
    // menu: mute is a *state*, and the whole risk of it is forgetting you did.
    expect(await screen.findByText("Muted")).toBeInTheDocument();
  });
});

describe("Messages drawer — mentions and multi-select (Phase 9b M9f)", () => {
  function msg(overrides = {}) {
    return {
      id: 1,
      sender: { id: 2, display_name: "Priya", avatar_thumb: null },
      text: "hey there",
      is_deleted: false,
      is_edited: false,
      created_at: new Date().toISOString(),
      reactions: [],
      mentions: [],
      ...overrides,
    };
  }
  const mineSender = { id: fakeUser.pk, display_name: "you", avatar_thumb: null };

  /** The ⋯ on the bubble holding `text` — it lives inside the bubble, so this
   * scopes to that row rather than picking whichever trigger came first. */
  async function openMenu(user, text) {
    const bubble = (await screen.findByText(text)).closest("li");
    await user.click(
      within(bubble).getByRole("button", { name: "Message options" })
    );
  }

  /** Enter select mode from a message's menu, the only way in. */
  async function startSelecting(user, text) {
    await openMenu(user, text);
    await user.click(screen.getByRole("button", { name: "Select" }));
  }

  it("offers the group's other members after an @ and sends their id, not their name", async () => {
    const user = userEvent.setup();
    api.getConversation.mockResolvedValue(groupConvoDetail());
    api.getMessages.mockResolvedValue(page([]));
    api.sendMessage.mockResolvedValue(
      msg({ id: 9, sender: mineSender, text: "@Priya Lovelace?" })
    );

    renderAt("/messages/11");
    const box = await screen.findByPlaceholderText(/write a message/i);
    await user.type(box, "@Pr");

    // You are not on your own list, and the picker matches on any part of a
    // name rather than only the start of it.
    expect(
      screen.getByRole("button", { name: "Mention Priya" })
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Mention you" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Mention Priya" }));
    // The whole name goes in, with a trailing space — you've finished naming
    // someone and the next thing you type is a word.
    expect(box).toHaveValue("@Priya ");
    // And the strip stands down: there's no half-typed @ any more.
    expect(screen.queryByRole("button", { name: "Mention Priya" })).toBeNull();

    await user.type(box, "the book?");
    await user.click(screen.getByRole("button", { name: "Send" }));

    // 🔒 A user id, worked out from what was picked — never left for the server
    // to find by matching names in the text, which is impossible under E2E and
    // wrong the day two people share a name.
    await waitFor(() =>
      expect(api.sendMessage).toHaveBeenCalledWith(
        11,
        "@Priya the book?",
        null,
        null,
        [2]
      )
    );
  });

  it("drops the id again when the name is deleted before sending", async () => {
    const user = userEvent.setup();
    api.getConversation.mockResolvedValue(groupConvoDetail());
    api.getMessages.mockResolvedValue(page([]));
    api.sendMessage.mockResolvedValue(msg({ id: 9, sender: mineSender }));

    renderAt("/messages/11");
    const box = await screen.findByPlaceholderText(/write a message/i);
    await user.type(box, "@Pr");
    await user.click(screen.getByRole("button", { name: "Mention Priya" }));
    await user.clear(box);
    await user.type(box, "never mind");
    await user.click(screen.getByRole("button", { name: "Send" }));

    // Picking someone and then thinking better of it must not buzz their muted
    // thread about a message that doesn't name them — the ids are reconciled
    // against the words actually sent.
    await waitFor(() =>
      expect(api.sendMessage).toHaveBeenCalledWith(11, "never mind", null, null, [])
    );
  });

  it("offers no picker in a 1:1, or while editing", async () => {
    const user = userEvent.setup();
    api.getConversation.mockResolvedValue(convoDetail());
    api.getMessages.mockResolvedValue(
      page([msg({ id: 5, text: "helo", sender: mineSender })])
    );

    renderAt("/messages/7");
    const box = await screen.findByPlaceholderText(/write a message/i);
    await user.type(box, "@");

    // 🔒 Not a UI preference: the server *refuses* `mention_ids` on a direct
    // conversation, because in a 1:1 the one person you might have muted is the
    // only person who can send you anything.
    expect(screen.queryByRole("group", { name: "Mention someone" })).toBeNull();

    // And in a group thread the picker still stands down while editing: an edit
    // carries no `mention_ids`, so a name picked there would notify nobody and
    // wouldn't even highlight.
    await user.clear(box);
    api.getConversation.mockResolvedValue(groupConvoDetail());
    api.getMessages.mockResolvedValue(
      page([msg({ id: 5, text: "helo", sender: mineSender })])
    );
    renderAt("/messages/11");
    await openMenu(user, "helo");
    await user.click(screen.getByRole("button", { name: "Edit" }));
    await user.type(screen.getByPlaceholderText(/edit your message/i), " @Pr");
    expect(screen.queryByRole("button", { name: "Mention Priya" })).toBeNull();
  });

  it("highlights a mention in the bubble, and leaves an unresolvable one as words", async () => {
    api.getConversation.mockResolvedValue(groupConvoDetail());
    api.getMessages.mockResolvedValue(
      page([
        msg({ id: 6, text: "@Priya and @Nobody, chapter 3?", mentions: [2, 99] }),
      ])
    );

    renderAt("/messages/11");

    // The named participant is split out of the run and drawn heavier.
    const mention = await screen.findByText("@Priya");
    expect(mention).toHaveClass("font-bold");
    // 🔒 An id the viewer can't resolve — someone who has since left, or who was
    // never visible to them — renders as the words the sender typed, with no
    // name invented for it. `@Nobody` therefore stays inside a plain run.
    expect(screen.queryByText("@Nobody")).toBeNull();
  });

  it("selects several messages and deletes them in one action", async () => {
    const user = userEvent.setup();
    api.getConversation.mockResolvedValue(convoDetail());
    api.getMessages.mockResolvedValue(
      page([
        msg({ id: 6, text: "and this", sender: mineSender }),
        msg({ id: 5, text: "delete this", sender: mineSender }),
      ])
    );
    api.deleteMessage.mockResolvedValue({});
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);

    renderAt("/messages/7");
    await startSelecting(user, "delete this");

    // The message you acted on comes with you into the mode — a burst is
    // exactly where you already know you want the next one too.
    expect(await screen.findByText("1 selected")).toBeInTheDocument();
    // The composer's slot holds the bulk actions now; the header carries a way
    // out instead of the person you're talking to.
    expect(screen.queryByPlaceholderText(/write a message/i)).toBeNull();

    // A click anywhere on a bubble ticks it — the one state where a message's
    // own click does something.
    await user.click(screen.getByText("and this"));
    expect(screen.getByText("2 selected")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(confirm).toHaveBeenCalled();
    await waitFor(() => expect(api.deleteMessage).toHaveBeenCalledWith(7, 5));
    expect(api.deleteMessage).toHaveBeenCalledWith(7, 6);
    // The mode ends with the action.
    expect(
      await screen.findByPlaceholderText(/write a message/i)
    ).toBeInTheDocument();
    confirm.mockRestore();
  });

  it("offers Copy but not Delete once the selection includes someone else's message", async () => {
    const user = userEvent.setup();
    api.getConversation.mockResolvedValue(groupConvoDetail());
    api.getMessages.mockResolvedValue(
      page([
        msg({ id: 6, text: "did you read it?" }),
        msg({ id: 5, text: "not yet", sender: mineSender }),
      ])
    );

    renderAt("/messages/11");
    await startSelecting(user, "not yet");
    expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();

    await user.click(screen.getByText("did you read it?"));

    // Absent, not greyed: a bulk action that silently did *part* of what it says
    // is worse than one that isn't there, and absent reads as "not yours".
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
    // Copy stays either way — quoting an exchange is exactly what you'd select
    // someone else's messages for.
    await user.click(screen.getByRole("button", { name: "Copy" }));

    // Oldest-first, with names in a group: an exchange between several people is
    // unreadable pasted without them, and only reads right in the order it
    // happened. (`userEvent.setup()` stubs the clipboard.)
    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toBe(
        "you: not yet\nPriya: did you read it?"
      )
    );
  });

  it("stands the menu and the strand links down while selecting", async () => {
    const user = userEvent.setup();
    api.getConversation.mockResolvedValue(convoDetail());
    api.getMessages.mockResolvedValue(
      page([
        msg({
          id: 5,
          text: "dinner?",
          sender: mineSender,
          reply_count: 2,
        }),
      ])
    );

    renderAt("/messages/7");
    expect(await screen.findByText("2 replies")).toBeInTheDocument();
    await startSelecting(user, "dinner?");

    // While selecting, a click means one thing everywhere on screen — so the ⋯
    // and both ways into a strand step aside rather than racing it.
    expect(screen.queryByRole("button", { name: "Message options" })).toBeNull();
    expect(screen.queryByText("2 replies")).toBeNull();

    // Escape leaves the selection rather than closing the drawer: the nearer
    // thing wins, and the composer that would normally catch the key has been
    // replaced by the bulk bar.
    await user.keyboard("{Escape}");
    expect(await screen.findByText("2 replies")).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Messages" })).toBeInTheDocument();
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
