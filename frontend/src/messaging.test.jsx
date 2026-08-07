import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App.jsx";
import {
  renderWithAuth,
  fakeUser,
  apiError,
  unauthoredError,
} from "./test-utils.jsx";
import { api } from "./api.js";
import { MessagingProvider } from "./messaging.jsx";
import { clearDrafts } from "./drafts.js";
import { clearOutbox } from "./outbox.js";
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

// Turn the event loop over enough times that a *repeating* request has room to
// show itself as more than one call (#214). A single `waitFor` can't tell "asked
// once and stopped" from "asked once so far" — the hot loop it guards against
// re-fires on the failure itself, so it needs no timer to keep going, just
// another turn. Anything still looping is hundreds of calls by the time this
// returns; anything that stopped is still on one.
async function settle(turns = 20) {
  for (let i = 0; i < turns; i += 1) {
    // A real macrotask each turn, not just a microtask flush: the loop this
    // guards against is one request per *commit*, and a rejection that resolves
    // inside the same batch as the render that caused it never produces the
    // second commit the effect needs to see. That's an artefact of a mock
    // rejecting instantly — a real failed request always spans commits — so the
    // turn has to be long enough for one to land.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
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
  // The drawer's header compose icon (the first "New message" control) opens
  // the picker.
  async function openPicker(user) {
    renderAt("/");
    await openDrawer(user);
    const composeButtons = await screen.findAllByRole("button", {
      name: "New message",
    });
    await user.click(composeButtons[0]);
  }

  const chatNameField = () =>
    screen.queryByRole("textbox", { name: "Chat name" });

  beforeEach(() => {
    api.listUsers.mockResolvedValue(
      page([
        { id: 2, display_name: "Priya", connection_status: "connected" },
        { id: 3, display_name: "Sanjay", connection_status: "connected" },
        { id: 4, display_name: "Stranger", connection_status: "none" },
      ])
    );
  });

  it("stops paging your connections when a page fails, instead of looping on it", async () => {
    const user = userEvent.setup();
    api.listUsers.mockResolvedValue(
      page(
        [{ id: 2, display_name: "Priya", connection_status: "connected" }],
        "http://localhost:8000/api/users/?page=2"
      )
    );
    api.getPage.mockImplementation(
      () =>
        new Promise((_resolve, reject) =>
          setTimeout(() => reject(unauthoredError(500)), 0)
        )
    );

    renderAt("/");
    await openDrawer(user);
    const composeButtons = await screen.findAllByRole("button", {
      name: "New message",
    });
    await user.click(composeButtons[0]);

    expect(
      await screen.findByText("Couldn’t load your connections.")
    ).toBeInTheDocument();
    // A stopped walk still leaves you the pages that did land, rather than an
    // empty picker.
    expect(screen.getByText("Priya")).toBeInTheDocument();

    // #214: the failure re-armed the effect that asks for the page — the server
    // never said there was no page 2, so `hasNextPage` stayed true, and
    // `isFetchingNextPage` going false again *is* the condition it waits for.
    await settle();
    expect(api.getPage).toHaveBeenCalledTimes(1);
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

  // The name field is what turns a chat into a group — `createGroupChat` makes a
  // `kind=group` row, which the `unique_conversation_pair` constraint never sees
  // and a disconnect can sever. So it's only offered once the chat really is a
  // group (#156).
  it("offers no name field until a second connection is checked", async () => {
    const user = userEvent.setup();
    api.getConversations.mockResolvedValue(page([]));

    await openPicker(user);

    // Nothing checked, and one checked, are both potential 1:1s.
    expect(await screen.findByText("Priya")).toBeInTheDocument();
    expect(chatNameField()).toBeNull();

    await user.click(screen.getByRole("checkbox", { name: "Priya" }));
    expect(chatNameField()).toBeNull();

    await user.click(screen.getByRole("checkbox", { name: "Sanjay" }));
    expect(chatNameField()).toBeInTheDocument();
  });

  it("ignores a name typed at two checks once one is unchecked", async () => {
    const user = userEvent.setup();
    api.getConversations.mockResolvedValue(page([]));
    api.openConversation.mockResolvedValue({ id: 7 });

    await openPicker(user);
    await user.click(await screen.findByRole("checkbox", { name: "Priya" }));
    await user.click(screen.getByRole("checkbox", { name: "Sanjay" }));
    await user.type(chatNameField(), "Book club");

    // Back down to one: the name goes off screen with the field, and off the
    // request with it — a plain 1:1, not a titled two-person group.
    await user.click(screen.getByRole("checkbox", { name: "Sanjay" }));
    expect(chatNameField()).toBeNull();

    await user.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(api.openConversation).toHaveBeenCalledWith(2));
    expect(api.createGroupChat).not.toHaveBeenCalled();
  });

  it("gives the name back if a second connection is re-checked", async () => {
    // The title is read at send time rather than cleared on untick, so a
    // mis-tap doesn't silently bin what you typed. It's visible again the
    // moment it can be used, which is what keeps "on screen" and "sent" the
    // same thing.
    const user = userEvent.setup();
    api.getConversations.mockResolvedValue(page([]));

    await openPicker(user);
    await user.click(await screen.findByRole("checkbox", { name: "Priya" }));
    await user.click(screen.getByRole("checkbox", { name: "Sanjay" }));
    await user.type(chatNameField(), "Book club");

    await user.click(screen.getByRole("checkbox", { name: "Sanjay" }));
    await user.click(screen.getByRole("checkbox", { name: "Sanjay" }));

    expect(chatNameField()).toHaveValue("Book club");
  });

  it("keeps the name on a group of two", async () => {
    const user = userEvent.setup();
    api.getConversations.mockResolvedValue(page([]));
    api.createGroupChat.mockResolvedValue({ id: 9 });

    await openPicker(user);
    await user.click(await screen.findByRole("checkbox", { name: "Priya" }));
    await user.click(screen.getByRole("checkbox", { name: "Sanjay" }));
    await user.type(chatNameField(), "Book club");
    await user.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() =>
      expect(api.createGroupChat).toHaveBeenCalledWith({
        participantIds: [2, 3],
        title: "Book club",
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

  // Leaving a chat is the same call from three places on the web — the locked
  // panel's Decline, the thread header's Leave, and the Details panel's — and
  // all three land you on the conversation list. `ConversationLeaveView`
  // tombstones your participant row and `user_conversations` filters on
  // `left_at__isnull=True`, so the chat is off that list server-side
  // immediately; a copy that refreshes nothing hands you a cache still showing
  // it, still styled Pending, and clicking it 404s. Only the Details panel got
  // this right (issue #286).
  //
  // Both polls are effectively off in these tests, so a second call to either
  // fetcher can only be an invalidation.
  describe.each([
    [
      "the locked panel's Decline",
      { my_status: "pending", can_send: false, must_connect_with: [] },
      /decline|leave/i,
      false,
    ],
    ["the header menu's Leave", {}, /leave/i, true],
  ])("declining or leaving via %s", (_name, detail, buttonName, viaMenu) => {
    it("refreshes the conversation list and the unread badge", async () => {
      const user = userEvent.setup();
      api.getConversation.mockResolvedValue(groupConvoDetail(detail));
      api.getMessages.mockResolvedValue(page([]));
      api.getConversations.mockResolvedValue(page([]));
      api.leaveConversation.mockResolvedValue({});

      renderAt("/messages/11");
      // The header title renders for both the locked panel and the open thread,
      // where the Leave button only exists once its menu is open.
      await screen.findByText("Book Club");
      const listLoads = api.getConversations.mock.calls.length;
      const badgeLoads = api.getUnreadMessageCount.mock.calls.length;

      const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
      if (viaMenu) await openHeaderMenu(user);
      await user.click(screen.getByRole("button", { name: buttonName }));
      confirm.mockRestore();

      await waitFor(() => expect(api.leaveConversation).toHaveBeenCalledWith(11));
      await waitFor(() =>
        expect(api.getConversations.mock.calls.length).toBeGreaterThan(listLoads)
      );
      await waitFor(() =>
        expect(api.getUnreadMessageCount.mock.calls.length).toBeGreaterThan(
          badgeLoads
        )
      );
    });
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
      apiError("You can only use 4 different emoji here.", 400)
    );

    renderAt("/messages/7");
    await screen.findByText("big news");
    await user.click(screen.getByRole("button", { name: "Message options" }));
    await user.click(screen.getByRole("button", { name: "React with 👍" }));

    // There's no optimistic pill to take away, so silence would leave the click
    // looking as though it had worked.
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/only use 4 different emoji/i);
    // And it says so *on the bubble it failed on*, not down at the composer
    // (#251). The composer belongs to the transcript column, which is hidden
    // whole while a reply strand is open — so a message rendered there is
    // unreachable from one of the two places you can react from.
    expect(alert.closest("li")).toBe(screen.getByText("big news").closest("li"));
  });

  it("keeps one message per emoji, and retires one the server later confirms", async () => {
    const user = userEvent.setup();
    api.getMessages.mockResolvedValue(page([msg({ id: 3, text: "big news" })]));
    api.toggleReaction.mockRejectedValue(apiError("Nope.", 400));

    renderAt("/messages/7");
    await screen.findByText("big news");
    await user.click(screen.getByRole("button", { name: "Message options" }));
    await user.click(screen.getByRole("button", { name: "React with 👍" }));
    await screen.findByRole("alert");

    await user.click(screen.getByRole("button", { name: "Message options" }));
    await user.click(screen.getByRole("button", { name: "React with ❤️" }));

    // Two failed taps, two messages, each naming its own emoji. One slot for the
    // whole bubble would have let ❤️ retire 👍's message and leave that tap
    // silent again — the bug, back for whichever emoji lost.
    await waitFor(() => expect(screen.getAllByRole("alert")).toHaveLength(2));
    expect(screen.getAllByRole("alert")[0]).toHaveTextContent("👍");
    expect(screen.getAllByRole("alert")[1]).toHaveTextContent("❤️");

    // Now 👍 turns out to have landed all along — only its response was lost —
    // and the server says so in the summary it answers the *next* toggle with.
    // That message goes, because its own emoji moved; ❤️'s stays, because a
    // summary changing for some other reason is no evidence about your ❤️ tap
    // (the swallow #231 describes).
    api.toggleReaction.mockResolvedValue({
      reactions: [
        { emoji: "👍", count: 1, reacted: true },
        { emoji: "😂", count: 1, reacted: true },
      ],
    });
    await user.click(screen.getByRole("button", { name: "Message options" }));
    await user.click(screen.getByRole("button", { name: "React with 😂" }));

    await waitFor(() => expect(screen.getAllByRole("alert")).toHaveLength(1));
    expect(screen.getByRole("alert")).toHaveTextContent("❤️");
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

  it("stops a strand's page walk when a page fails, instead of looping on it", async () => {
    const user = userEvent.setup();
    api.getMessages.mockResolvedValue(page([msg({ id: 5, text: "dinner?" })]));
    api.getThread.mockResolvedValue(
      page(
        [msg({ id: 5, text: "dinner?" })],
        "http://localhost:8000/api/conversations/7/messages/?thread_root=5&page=2"
      )
    );
    api.getPage.mockImplementation(
      () =>
        new Promise((_resolve, reject) =>
          setTimeout(() => reject(unauthoredError(500)), 0)
        )
    );

    renderAt("/messages/7");
    await openMenu(user, "dinner?");
    await user.click(screen.getByRole("button", { name: "Reply" }));

    await waitFor(() => expect(api.getPage).toHaveBeenCalledTimes(1));
    // What did load stays readable — the strand keeps its root.
    expect(await within(strand()).findByText("dinner?")).toBeInTheDocument();

    // #214, the other half: this panel polls, so a loop here runs for as long as
    // the strand is open, against a server that just failed.
    await settle();
    expect(api.getPage).toHaveBeenCalledTimes(1);
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

  it("marks a reply with a strand edge, and quotes nothing to do it", async () => {
    api.getMessages.mockResolvedValue(
      page([
        msg({ id: 5, text: "dinner?", reply_count: 1 }),
        msg({
          id: 6,
          text: "where though",
          reply_to: { id: 5 },
          thread_root_id: 5,
        }),
      ])
    );

    renderAt("/messages/7");
    const reply = (await screen.findByText("where though")).closest("li");
    // The mark, and the whole of what it says (M9g). Not whose thread and not
    // which — a bar can't say that, and the point of the bar is that it doesn't
    // try: the words it answers are one click away in the strand.
    expect(
      within(reply).getByRole("button", { name: "Part of a thread — open thread" })
    ).toBeInTheDocument();
    // The root is right there in the transcript and the reply no longer repeats
    // it: "dinner?" appears once, on the message that said it.
    expect(screen.getAllByText("dinner?")).toHaveLength(1);
    // 🔒 And nothing was fetched to draw it. The transcript used to resolve
    // every quote by id through the clipped endpoint; a bar is drawn from
    // `reply_to`'s bare `{ id }` alone, so that call was removed from the client
    // altogether — asserted here rather than "wasn't called", because a method
    // that doesn't exist can't be reintroduced by accident without this failing.
    expect(api.getMessagesByIds).toBeUndefined();
  });

  it("leaves the strand shut for a click that belongs to something else", async () => {
    const user = userEvent.setup();
    const root = msg({ id: 5, text: "dinner?", reply_count: 1 });
    const reply = msg({
      id: 6,
      text: "where though",
      reply_to: { id: 5 },
      thread_root_id: 5,
    });
    api.getMessages.mockResolvedValue(page([root, reply]));
    api.getThread.mockResolvedValue(page([root, reply]));

    renderAt("/messages/7");
    const bubble = (await screen.findByText("where though")).closest(
      ".msg-bubble-body"
    );

    // A double-click is how you select a word, and its *first* click arrives
    // while the selection is still collapsed — indistinguishable from a single
    // click at the moment it happens. The open is deferred past the
    // double-click window for exactly this, so the wait is the assertion:
    // nothing must have opened once the grace period has come and gone.
    await user.dblClick(bubble);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(api.getThread).not.toHaveBeenCalled();

    // ⚠️ And a click inside the ⋯ menu. It's portalled to `<body>`, but React
    // events travel the React tree, so a click on the panel's own padding
    // arrives at the bubble that rendered it — which would open the strand
    // *under* the open menu and hide the transcript from beneath it.
    await user.click(
      within(bubble).getByRole("button", { name: "Message options" })
    );
    const menu = await screen.findByRole("dialog", { name: "Message options" });
    await user.click(menu);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(api.getThread).not.toHaveBeenCalled();
  });

  it("opens the strand when you click a reply itself", async () => {
    const user = userEvent.setup();
    const root = msg({ id: 5, text: "dinner?", reply_count: 1 });
    const reply = msg({
      id: 6,
      text: "where though",
      reply_to: { id: 5 },
      thread_root_id: 5,
    });
    api.getMessages.mockResolvedValue(page([root, reply]));
    api.getThread.mockResolvedValue(page([root, reply]));

    renderAt("/messages/7");
    await user.click(await screen.findByText("where though"));

    // The strand it belongs to, not the message clicked: the server owns the
    // flattening and `thread_root_id` is a read of it. Awaited because the open
    // is deferred past the double-click window — see `handleBubbleClick`.
    await waitFor(() => expect(api.getThread).toHaveBeenCalledWith(7, 5));
    expect(within(strand()).getByText("where though")).toBeInTheDocument();
  });

  it("draws plain bubbles inside the strand — no quotes, no edges", async () => {
    const user = userEvent.setup();
    const root = msg({ id: 5, text: "dinner?", reply_count: 2 });
    const answered = msg({
      id: 6,
      sender: { id: 3, display_name: "Sanjay", avatar_thumb: null },
      text: "where though",
      reply_to: { id: 5 },
      thread_root_id: 5,
    });
    // A reply to a message the *strand* doesn't carry — the clipped case, and
    // the one where what the quote won't say matters.
    const orphanReply = msg({
      id: 7,
      text: "the usual place",
      reply_to: { id: 4 },
      thread_root_id: 5,
    });
    api.getMessages.mockResolvedValue(page([root, answered, orphanReply]));
    api.getThread.mockResolvedValue(page([root, answered, orphanReply]));

    renderAt("/messages/7");
    await user.click(await screen.findByText("where though"));
    // The open is deferred past the double-click window, so wait for the panel
    // rather than assuming it's up — see `handleBubbleClick`.
    await screen.findByRole("region", { name: "Reply thread" });

    // Everything in here belongs to this one strand, so a mark saying so on
    // each bubble would say nothing, and a quote would repeat words already on
    // screen a few rows up. The root's words appear once — on the root.
    await within(strand()).findByText("where though");
    expect(within(strand()).getAllByText("dinner?")).toHaveLength(1);
    expect(
      within(strand()).queryByRole("button", {
        name: "Part of a thread — open thread",
      })
    ).toBeNull();
    // And nothing announces a message the viewer can't see: the reply to a
    // clipped message is just a bubble.
    expect(
      within(strand()).queryByText("Original message unavailable")
    ).toBeNull();
    expect(within(strand()).getByText("the usual place")).toBeInTheDocument();
  });

  it("opens a headless strand from a reply, and says the head is missing", async () => {
    const user = userEvent.setup();
    const orphan = msg({
      id: 6,
      text: "where though",
      reply_to: { id: 5 },
      thread_root_id: 5,
    });
    api.getMessages.mockResolvedValue(page([orphan]));
    // The strand comes back with the replies this viewer may see and no root.
    api.getThread.mockResolvedValue(page([orphan]));

    renderAt("/messages/7");
    // The reply itself is the only way in here, and that's the point rather
    // than a convenience: with the root clipped out there's no bubble to carry
    // a reply count, so without this the strand would be unreachable for
    // exactly the person whose view of it is already partial.
    await user.click(await screen.findByText("where though"));

    await waitFor(() => expect(api.getThread).toHaveBeenCalledWith(7, 5));
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

  it("says so inside the strand when a reaction taken there is refused", async () => {
    const user = userEvent.setup();
    const root = msg({ id: 5, text: "dinner?" });
    api.getMessages.mockResolvedValue(page([root]));
    api.getThread.mockResolvedValue(page([root]));
    api.toggleReaction.mockRejectedValue(
      apiError("You can only use 4 different emoji here.", 400)
    );

    renderAt("/messages/7");
    await openMenu(user, "dinner?");
    await user.click(screen.getByRole("button", { name: "Reply" }));

    const bubble = within(strand()).getByText("dinner?").closest("li");
    await user.click(
      within(bubble).getByRole("button", { name: "Message options" })
    );
    await user.click(screen.getByRole("button", { name: "React with 👍" }));

    // 🔒 Scoped to the strand, and that scoping is the whole test (#251). The
    // rejection *was* rendered before this fix — into the transcript's composer,
    // which sits in a column the thread view gives Tailwind `hidden` the moment
    // a strand opens. jsdom loads no CSS, so an unscoped `findByRole("alert")`
    // passed against code that painted the message into a `display: none`
    // subtree, where nobody could read it.
    expect(await within(strand()).findByRole("alert")).toHaveTextContent(
      /only use 4 different emoji/i
    );
    // Reacting is deliberately non-optimistic (M2's fifth decision), so with
    // nothing drawn on the tap and nothing taken away, this line is the only
    // thing separating a refusal from a success. And exactly one of them: the
    // transcript's copy of the same message is a separate bubble that wasn't
    // tapped, and it has nothing to say.
    expect(screen.getAllByRole("alert")).toHaveLength(1);
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

  // Issue #253. The transcript column is `hidden` — a real `display: none` —
  // for as long as a strand is open, so nothing rendered inside it can be the
  // only place a write reports its refusal. #251 fixed that for reactions by
  // moving the message onto the bubble; these two have no bubble to move to, so
  // they report from a bar outside the column instead.
  //
  // Both tests assert the same two things, because either alone passes on a
  // broken build: that the column really is hidden (or the test proves nothing),
  // and that the message is not inside it. `toBeVisible` can't stand in — jsdom
  // loads no stylesheet, so Tailwind's `hidden` is just a class name here.
  /** The transcript column, if a strand has been given `display: none` over it. */
  function hiddenColumn() {
    return screen.getByRole("log", { name: "Conversation" }).closest(".hidden");
  }

  it("says a bulk delete failed even though a strand opened over the transcript", async () => {
    const user = userEvent.setup();
    const root = msg({ id: 5, sender: mineSender, text: "dinner?", reply_count: 2 });
    const doomed = msg({ id: 6, sender: mineSender, text: "delete this" });
    api.getMessages.mockResolvedValue(page([doomed, root]));
    api.getThread.mockResolvedValue(page([root]));
    // Held open, so the DELETE is genuinely still out while the strand opens —
    // which is the whole window. In the real thing it's a loop of them, one at a
    // time, so the window is as long as the selection.
    let refuse;
    api.deleteMessage.mockReturnValue(
      new Promise((_, reject) => {
        refuse = reject;
      })
    );
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);

    renderAt("/messages/7");
    await openMenu(user, "delete this");
    await user.click(screen.getByRole("button", { name: "Select" }));
    await user.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(api.deleteMessage).toHaveBeenCalledWith(7, 6));

    // `confirmDeleteSelected` ends select mode on the line after `mutate()`, so
    // there is no race to win here: the transcript is fully interactive again,
    // reply counts and all, while the deletes are still going out.
    await user.click(await screen.findByRole("button", { name: /2 replies/ }));
    expect(strand()).toBeInTheDocument();
    expect(hiddenColumn()).not.toBeNull();

    await act(async () => {
      refuse(apiError("Nope.", 500));
      await Promise.resolve();
    });

    // The line that says the action was *partial* — some of what you deleted is
    // still there. Lose it and the only way to find out is to notice; and
    // backing out to the conversation list instead of closing the strand
    // unmounts this view (keyed on the conversation id), taking it for good.
    const alert = await screen.findByText("Some messages are still there. Try again.");
    expect(alert).toHaveAttribute("role", "alert");
    expect(alert.closest(".hidden")).toBeNull();
    confirm.mockRestore();
  });

  it("says an edit failed even though a strand opened over the transcript", async () => {
    const user = userEvent.setup();
    const original = msg({
      id: 5,
      sender: mineSender,
      text: "helo",
      reply_count: 2,
    });
    api.getMessages.mockResolvedValue(page([original]));
    api.getThread.mockResolvedValue(page([original]));
    let refuse;
    api.editMessage.mockReturnValue(
      new Promise((_, reject) => {
        refuse = reject;
      })
    );

    renderAt("/messages/7");
    await openMenu(user, "helo");
    await user.click(screen.getByRole("button", { name: "Edit" }));
    const box = screen.getByPlaceholderText(/edit your message/i);
    await user.clear(box);
    await user.type(box, "hello");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(api.editMessage).toHaveBeenCalledWith(7, 5, "hello")
    );

    // Edit mode doesn't stand the reply count down — only select mode does — so
    // a strand can open on top of an edit that hasn't answered yet.
    await user.click(screen.getByRole("button", { name: /2 replies/ }));
    expect(hiddenColumn()).not.toBeNull();

    await act(async () => {
      refuse(apiError("You can no longer edit this message.", 403));
      await Promise.resolve();
    });

    // The server's own words, since it has some (`serverMessage`) — the edit
    // window is the rule people run into and "Couldn't save the edit" wouldn't
    // say which rule. The bubble still reads "helo" with no Edited marker, so
    // silence here is indistinguishable from having cancelled.
    const alert = await screen.findByText(/no longer edit this message/i);
    expect(alert).toHaveAttribute("role", "alert");
    expect(alert.closest(".hidden")).toBeNull();
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
      apiError("Each photo must be under 4 MB.", 400)
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

  it("retries a failed mention *with its ids*, not as an ordinary message", async () => {
    const user = userEvent.setup();
    api.getConversation.mockResolvedValue(groupConvoDetail());
    api.getMessages.mockResolvedValue(page([]));
    api.sendMessage.mockRejectedValue(new Error("offline"));

    renderAt("/messages/11");
    const box = await screen.findByPlaceholderText(/write a message/i);
    await user.type(box, "@Pr");
    await user.click(screen.getByRole("button", { name: "Mention Priya" }));
    await user.type(box, "the book?");
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByText("Not sent")).toBeInTheDocument();

    api.sendMessage.mockResolvedValue(
      msg({ id: 9, sender: mineSender, text: "@Priya the book?", mentions: [2] })
    );
    await user.click(screen.getByRole("button", { name: "Retry" }));

    // ⚠️ The ids come off the *entry*, not recomputed — and the composer was
    // cleared and the picker reset the moment the first attempt went out, so
    // anything recomputed here would be empty. A retry that dropped them would
    // leave the `@Priya` in the words with nothing behind it: no notification
    // through her muted thread, and not even a highlight. Asserting the
    // **second** call is the only place that shows. (Same rule as a retried
    // reply's `replyToId` and a retried photo's file.)
    await waitFor(() => expect(api.sendMessage).toHaveBeenCalledTimes(2));
    expect(api.sendMessage).toHaveBeenLastCalledWith(
      11,
      "@Priya the book?",
      null,
      null,
      [2]
    );
  });

  it("sends a mention from the strand's composer too", async () => {
    const user = userEvent.setup();
    const root = msg({ id: 5, text: "who's bringing what?" });
    api.getConversation.mockResolvedValue(groupConvoDetail());
    api.getMessages.mockResolvedValue(page([root]));
    api.getThread.mockResolvedValue(page([root]));
    api.sendMessage.mockResolvedValue(
      msg({ id: 9, sender: mineSender, text: "@Priya the pudding", reply_to: { id: 5 } })
    );

    renderAt("/messages/11");
    await openMenu(user, "who's bringing what?");
    await user.click(screen.getByRole("button", { name: "Reply" }));

    const strand = screen.getByRole("region", { name: "Reply thread" });
    const box = within(strand).getByLabelText("Reply to thread");
    await user.type(box, "@Pr");
    // A strand is where a group's side-conversations happen, so it's if anything
    // the *more* likely place to name someone — leaving the picker out of one of
    // the two composers would be the seam M9 exists to close.
    await user.click(
      within(strand).getByRole("button", { name: "Mention Priya" })
    );
    await user.type(box, "the pudding");
    await user.click(within(strand).getByRole("button", { name: "Send" }));

    await waitFor(() =>
      expect(api.sendMessage).toHaveBeenCalledWith(
        11,
        "@Priya the pudding",
        5,
        null,
        [2]
      )
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

  it("leaves an unsent message out of a selection entirely", async () => {
    const user = userEvent.setup();
    api.getConversation.mockResolvedValue(convoDetail());
    api.getMessages.mockResolvedValue(
      page([msg({ id: 5, text: "sent one", sender: mineSender })])
    );
    // Never resolves: the send stays in flight, so the bubble stays unsent.
    api.sendMessage.mockReturnValue(new Promise(() => {}));

    renderAt("/messages/7");
    const box = await screen.findByPlaceholderText(/write a message/i);
    await user.type(box, "still going");
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText("still going")).toBeInTheDocument();

    await startSelecting(user, "sent one");

    // One tick-box, on the message the server has actually accepted. An unsent
    // one has no id to copy or delete by, so a box on it would be offering to
    // include it in an action it can't be part of — and clicking it does
    // nothing rather than silently ticking a message the bulk actions ignore.
    expect(screen.getAllByRole("checkbox", { name: /^Select message/ })).toHaveLength(1);
    await user.click(screen.getByText("still going"));
    expect(screen.getByText("1 selected")).toBeInTheDocument();
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

  // --- Issue #236: a rejected write must not look like one that worked -------
  //
  // All three of these controls fired a mutation with no error path at all, so
  // a POST that never landed left the screen exactly as it was. On the block
  // that isn't a cosmetic problem: you walk away believing someone can no longer
  // message you or see your posts, and they can.

  function profile(overrides = {}) {
    api.getUser.mockResolvedValue({
      id: 2,
      display_name: "Priya",
      connection_status: "none",
      is_blocked: false,
      bio: "",
      ...overrides,
    });
    api.getUserPosts.mockResolvedValue(page([]));
    api.getDisconnectImpact.mockResolvedValue({ chats: [] });
  }

  it("holds the block dialog open on a rejection and says they are not blocked", async () => {
    const user = userEvent.setup();
    profile();
    api.blockUser.mockRejectedValue(apiError("Request failed (500)", 500));

    renderAt("/u/2");
    await user.click(await screen.findByRole("button", { name: "Block" }));
    const dialog = await screen.findByRole("dialog", {
      name: /block confirmation/i,
    });
    await user.click(within(dialog).getByRole("button", { name: "Confirm" }));

    // The failure lands where you pressed Confirm, and says the thing that
    // matters rather than repeating the server's 500 — which says nothing about
    // whether you're safe.
    expect(
      await within(dialog).findByText(
        "Couldn’t block Priya — they’re not blocked. Try again."
      )
    ).toBeInTheDocument();
    // Dismissing on confirm is what left the message nowhere to go; staying up
    // also makes the same button the retry.
    expect(
      within(dialog).getByRole("button", { name: "Try again" })
    ).toBeInTheDocument();
    // And nothing anywhere claims the block landed.
    expect(screen.getByRole("button", { name: "Block" })).toBeInTheDocument();
    expect(screen.queryByText(/You’ve blocked Priya/)).not.toBeInTheDocument();
  });

  it("keeps saying so after you close the dialog on a failed block", async () => {
    const user = userEvent.setup();
    profile();
    api.blockUser.mockRejectedValue(apiError("Request failed (500)", 500));

    renderAt("/u/2");
    await user.click(await screen.findByRole("button", { name: "Block" }));
    const dialog = await screen.findByRole("dialog", {
      name: /block confirmation/i,
    });
    await user.click(within(dialog).getByRole("button", { name: "Confirm" }));
    await within(dialog).findByText(/they’re not blocked/);
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));

    // The dialog is gone but the profile must not look untouched: the message
    // moves to the button you pressed, which still reads "Block".
    expect(
      screen.queryByRole("dialog", { name: /block confirmation/i })
    ).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Couldn’t block Priya — they’re not blocked. Try again."
    );
  });

  // Offline is the likeliest way any of these fails, and `fetch` rejects with a
  // bare TypeError carrying the *browser's* words ("Failed to fetch") — never
  // fit to show a person. See `errors.js`.
  it("says what is still true when an unblock never reaches the server", async () => {
    const user = userEvent.setup();
    profile({ is_blocked: true });
    api.unblockUser.mockRejectedValue(new TypeError("Failed to fetch"));

    renderAt("/u/2");
    await user.click(await screen.findByRole("button", { name: "Unblock" }));

    expect(
      await screen.findByText(
        "Couldn’t unblock Priya — they’re still blocked. Try again."
      )
    ).toBeInTheDocument();
    expect(screen.queryByText("Failed to fetch")).not.toBeInTheDocument();
  });

  it("reports a refused connection change in the server's own words", async () => {
    const user = userEvent.setup();
    profile({ connection_status: "requested" });
    api.disconnect.mockRejectedValue(
      apiError("That request no longer exists.", 404)
    );

    renderAt("/u/2");
    await user.click(await screen.findByRole("button", { name: "Requested" }));

    // Without this the button simply re-enabled, still reading "Requested" —
    // nothing repaints, because no invalidation runs on the failure path.
    expect(
      await screen.findByText("That request no longer exists.")
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Requested" })).toBeInTheDocument();
  });

  it("names which connection action failed when the server never spoke", async () => {
    const user = userEvent.setup();
    profile({ connection_status: "requested" });
    api.disconnect.mockRejectedValue(new TypeError("Failed to fetch"));

    renderAt("/u/2");
    await user.click(await screen.findByRole("button", { name: "Requested" }));

    expect(
      await screen.findByText("Couldn’t withdraw that request — try again.")
    ).toBeInTheDocument();
    expect(screen.queryByText("Failed to fetch")).not.toBeInTheDocument();
  });

  // The other half of "the server never spoke": it answered, but with nothing a
  // person can read. api.js synthesizes "Request failed (500)" for that, which
  // carries a status and a message and would sail through any check that only
  // asked "is this an ApiError?" — putting a stack-trace-shaped string under a
  // button. `fromServer` is what keeps it out.
  it("never shows the synthesized message from a body-less server error", async () => {
    const user = userEvent.setup();
    profile({ connection_status: "requested" });
    api.disconnect.mockRejectedValue(unauthoredError(500));

    renderAt("/u/2");
    await user.click(await screen.findByRole("button", { name: "Requested" }));

    expect(
      await screen.findByText("Couldn’t withdraw that request — try again.")
    ).toBeInTheDocument();
    expect(screen.queryByText(/Request failed/)).not.toBeInTheDocument();
  });

  // The rule for *retiring* one of these messages — that it goes only when the
  // server itself moves to the answer the attempt was reaching for — is pinned
  // at component level in `connection-buttons.test.jsx`, where the server's
  // answer can be changed under a mounted button without remounting it.

  it("says so when Message can't open the thread", async () => {
    const user = userEvent.setup();
    profile({ connection_status: "connected" });
    api.openConversation.mockRejectedValue(
      apiError("You can’t message this person.", 403)
    );

    renderAt("/u/2");
    await user.click(await screen.findByRole("button", { name: "Message" }));

    // The label used to flip back to "Message" with no drawer — a tap that
    // silently did nothing.
    expect(
      await screen.findByText("You can’t message this person.")
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("dialog", { name: "Messages" })
    ).not.toBeInTheDocument();
  });
});

/**
 * Issues #257 and #258 — **the drawer may not be dismissed while a panel inside
 * it has a write out.**
 *
 * The same rule as the dialogs in #254/#255, but the routes out belong to the
 * *chrome*: Escape (`MessagesDrawer`), the ✕ and Back (`PanelHeader`), and the
 * nav button (`Layout`) — every one of them a level above the panel doing the
 * writing, with no way to see its mutation. So the panel declares the write
 * (`useHoldMessagesOpen`) and the chrome holds until the answer lands.
 *
 * #257 is the same defect reached differently again: nothing unmounts, but
 * `stopEditing()` ends with `editMutation.reset()`, which detaches the observer
 * from the running PATCH — so a rejection arriving after you'd pressed Escape
 * had nothing left to paint it.
 *
 * Each test drives the whole sequence rather than asserting a disabled
 * attribute: press the write, try to leave, *then* let the server refuse, and
 * insist the message is on screen. That's the sequence people actually perform,
 * and the swallow only shows up at the end of it.
 */
describe("Messages drawer — a write in flight holds it open (#257, #258)", () => {
  function msg(overrides = {}) {
    return {
      id: 1,
      sender: { id: 2, display_name: "Priya", avatar_thumb: null },
      text: "hi",
      is_deleted: false,
      created_at: new Date().toISOString(),
      ...overrides,
    };
  }

  const mineSender = { id: fakeUser.pk, display_name: "you", avatar_thumb: null };

  /** A request that hangs until the test refuses it. */
  function hanging() {
    let refuse;
    const promise = new Promise((_resolve, reject) => {
      refuse = reject;
    });
    promise.catch(() => {});
    return {
      promise,
      reject: async (error) => {
        refuse(error);
        // Macrotasks, not a microtask flush: React Query walks a rejection
        // through its own settle machinery before the observer repaints.
        await act(async () => {
          for (let i = 0; i < 3; i += 1) {
            await new Promise((resolve) => setTimeout(resolve, 0));
          }
        });
      },
    };
  }

  const drawer = () => screen.queryByRole("dialog", { name: "Messages" });

  it("holds Escape, ✕ and Back while people are being added to a chat", async () => {
    const user = userEvent.setup();
    const add = hanging();
    api.getConversation.mockResolvedValue(groupConvoDetail());
    api.getMessages.mockResolvedValue(page([]));
    api.listUsers.mockResolvedValue(
      page([{ id: 4, display_name: "Nadia", connection_status: "connected" }])
    );
    api.addParticipants.mockReturnValue(add.promise);

    renderAt("/messages/11");
    await screen.findByText("Book Club");
    await openHeaderMenu(user);
    await user.click(screen.getByRole("button", { name: /add people/i }));
    await user.click(await screen.findByRole("checkbox", { name: "Nadia" }));
    await user.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(api.addParticipants).toHaveBeenCalled());

    // All three ways out of the picker, which is the only thing that will ever
    // render this rejection.
    expect(screen.getByRole("button", { name: "Close messages" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Back" })).toBeDisabled();
    await user.keyboard("{Escape}");
    expect(drawer()).toBeInTheDocument();

    await add.reject(apiError("Nadia has blocked you.", 400));

    // Without the hold this ended with the drawer shut, the participant list
    // unchanged, and you certain Nadia had been added.
    expect(await screen.findByText("Nadia has blocked you.")).toBeInTheDocument();
  });

  it("holds the drawer while a group rename is out, and lets go when it lands", async () => {
    const user = userEvent.setup();
    const rename = hanging();
    api.getConversation.mockResolvedValue(groupConvoDetail());
    api.getMessages.mockResolvedValue(page([]));
    api.getConversationMedia.mockResolvedValue(page([]));
    api.renameConversation.mockReturnValue(rename.promise);

    renderAt("/messages/11");
    await screen.findByText("Book Club");
    await openHeaderMenu(user);
    await user.click(screen.getByRole("button", { name: "Details" }));
    await user.click(await screen.findByRole("button", { name: "Rename" }));
    const field = screen.getByRole("textbox", { name: "Chat name" });
    await user.clear(field);
    await user.type(field, "Reading Club");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.renameConversation).toHaveBeenCalled());

    await user.keyboard("{Escape}");
    expect(drawer()).toBeInTheDocument();

    await rename.reject(apiError("You’re no longer in this chat.", 403));
    expect(
      await screen.findByText("You’re no longer in this chat.")
    ).toBeInTheDocument();

    // And the gate lets go the moment the answer lands — it exists so a
    // rejection has somewhere to go, not to seal you into a panel afterwards.
    expect(screen.getByRole("button", { name: "Close messages" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Close messages" }));
    expect(drawer()).not.toBeInTheDocument();
  });

  it("keeps a refused message edit that Escape used to throw away", async () => {
    const user = userEvent.setup();
    const save = hanging();
    api.getConversation.mockResolvedValue(convoDetail());
    api.getMessages.mockResolvedValue(
      page([msg({ id: 5, text: "helo", sender: mineSender })])
    );
    api.editMessage.mockReturnValue(save.promise);

    renderAt("/messages/7");
    await screen.findByText("helo");
    await user.click(screen.getByRole("button", { name: "Message options" }));
    await user.click(screen.getByRole("button", { name: "Edit" }));
    const box = screen.getByPlaceholderText(/edit your message/i);
    await user.clear(box);
    await user.type(box, "hello");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.editMessage).toHaveBeenCalledWith(7, 5, "hello"));

    // Escape does nothing at all here — leaving edit mode calls `reset()`,
    // which detaches the observer from the PATCH still on its way back.
    await user.keyboard("{Escape}");
    expect(screen.getByText("Editing message")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /cancel editing/i })
    ).toBeDisabled();

    await save.reject(
      apiError("Editing is only allowed for 15 minutes.", 403)
    );

    // The bubble still reads "helo" with no Edited marker, so silence here is
    // indistinguishable from having cancelled — you'd leave believing the typo
    // was fixed.
    expect(
      await screen.findByText("Editing is only allowed for 15 minutes.")
    ).toBeInTheDocument();
    expect(screen.getAllByText("helo").length).toBeGreaterThan(0);
    expect(screen.queryByText(/Edited/)).toBeNull();
  });

  it("holds the drawer's own Escape while an edit is out, wherever focus is", async () => {
    const user = userEvent.setup();
    const save = hanging();
    api.getConversation.mockResolvedValue(convoDetail());
    api.getMessages.mockResolvedValue(
      page([msg({ id: 5, text: "helo", sender: mineSender })])
    );
    api.editMessage.mockReturnValue(save.promise);

    renderAt("/messages/7");
    await screen.findByText("helo");
    await user.click(screen.getByRole("button", { name: "Message options" }));
    await user.click(screen.getByRole("button", { name: "Edit" }));
    const box = screen.getByPlaceholderText(/edit your message/i);
    await user.clear(box);
    await user.type(box, "hello");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.editMessage).toHaveBeenCalled());

    // Away from the textarea, so the composer's own handler never sees the key
    // and `MessagesDrawer`'s document listener catches it instead — which used
    // to tear the whole panel down, error bar and all.
    await act(async () => {
      document.body.focus();
    });
    fireEvent.keyDown(document, { key: "Escape" });

    expect(drawer()).toBeInTheDocument();
    await save.reject(apiError("Editing is only allowed for 15 minutes.", 403));
    expect(
      await screen.findByText("Editing is only allowed for 15 minutes.")
    ).toBeInTheDocument();
  });

  it("stands Details and Add people down while an edit is saving", async () => {
    const user = userEvent.setup();
    const save = hanging();
    api.getConversation.mockResolvedValue(groupConvoDetail());
    api.getMessages.mockResolvedValue(
      page([msg({ id: 5, text: "helo", sender: mineSender })])
    );
    api.editMessage.mockReturnValue(save.promise);

    renderAt("/messages/11");
    await screen.findByText("helo");
    await user.click(screen.getByRole("button", { name: "Message options" }));
    await user.click(screen.getByRole("button", { name: "Edit" }));
    const box = screen.getByPlaceholderText(/edit your message/i);
    await user.clear(box);
    await user.type(box, "hello");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.editMessage).toHaveBeenCalled());

    // Both switch `view`, which unmounts the thread and the error bar with it.
    // Absent rather than greyed, the way Delete leaves the selection bar.
    await openHeaderMenu(user);
    const menu = within(screen.getByRole("dialog", { name: "Conversation options" }));
    expect(menu.queryByRole("button", { name: "Details" })).toBeNull();
    expect(menu.queryByRole("button", { name: /add people/i })).toBeNull();
    // Mute doesn't leave the view, so it stays.
    expect(menu.getByRole("button", { name: /mute/i })).toBeInTheDocument();

    await save.reject(apiError("Editing is only allowed for 15 minutes.", 403));
    expect(
      await screen.findByText("Editing is only allowed for 15 minutes.")
    ).toBeInTheDocument();
  });

  // Not in #258's list — found sweeping for the same root cause while the fix
  // was open. The locked panel is inside the drawer like any other, and its
  // Connect is the one write on it that reports itself.
  it("holds the drawer while a locked chat's Connect request is out", async () => {
    const user = userEvent.setup();
    const connect = hanging();
    api.getConversation.mockResolvedValue(
      groupConvoDetail({
        my_status: "pending",
        must_connect_with: [{ id: 5, display_name: "Amara", avatar_thumb: null }],
        can_send: false,
      })
    );
    api.connect.mockReturnValue(connect.promise);

    renderAt("/messages/11");
    await screen.findByText(/connect with/i);
    await user.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(api.connect).toHaveBeenCalledWith(5));

    await user.keyboard("{Escape}");
    expect(drawer()).toBeInTheDocument();

    await connect.reject(apiError("You can’t connect with this person.", 400));
    expect(
      await screen.findByText("You can’t connect with this person.")
    ).toBeInTheDocument();
  });

  // The edit isn't the only write reported in that bar. A bulk delete is the
  // *longer* window of the two — its mutation walks the selection one DELETE at
  // a time — and leaving the thread mid-way swallowed it exactly the same way.
  it("holds the drawer while a bulk delete is still working through the selection", async () => {
    const user = userEvent.setup();
    api.getConversation.mockResolvedValue(convoDetail());
    api.getMessages.mockResolvedValue(
      page([
        msg({ id: 6, text: "and this", sender: mineSender }),
        msg({ id: 5, text: "delete this", sender: mineSender }),
      ])
    );
    // The first DELETE lands, the second hangs — the middle of the walk.
    const second = hanging();
    api.deleteMessage
      .mockResolvedValueOnce({})
      .mockReturnValueOnce(second.promise);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);

    renderAt("/messages/7");
    const bubble = (await screen.findByText("delete this")).closest("li");
    await user.click(
      within(bubble).getByRole("button", { name: "Message options" })
    );
    await user.click(screen.getByRole("button", { name: "Select" }));
    await screen.findByText("1 selected");
    await user.click(screen.getByText("and this"));
    await user.click(screen.getByRole("button", { name: "Delete" }));
    confirm.mockRestore();
    await waitFor(() => expect(api.deleteMessage).toHaveBeenCalledTimes(2));

    expect(screen.getByRole("button", { name: "Close messages" })).toBeDisabled();
    await user.keyboard("{Escape}");
    expect(drawer()).toBeInTheDocument();

    await second.reject(apiError("That message is already gone.", 404));

    // Its own wording, not the server's: a partial failure means *some* of them
    // are still there, which is what you need to know and not what any one
    // response says.
    expect(
      await screen.findByText("Some messages are still there. Try again.")
    ).toBeInTheDocument();
  });

  // Regression: the drawer's four exits held for the bulk delete, but the three
  // controls *inside* the view that switch `view` still gated on the edit alone
  // — and this is the case where that shows, because `confirmDeleteSelected`
  // clears the selection the moment it fires. The header drops straight out of
  // "N selected" and back to the group's name button with every DELETE still in
  // flight, so the one route that looked safest was the one standing open.
  it("stands the in-view routes down while a bulk delete is working, too", async () => {
    const user = userEvent.setup();
    api.getConversation.mockResolvedValue(groupConvoDetail());
    api.getMessages.mockResolvedValue(
      page([
        msg({ id: 6, text: "and this", sender: mineSender }),
        msg({ id: 5, text: "delete this", sender: mineSender }),
      ])
    );
    const second = hanging();
    api.deleteMessage
      .mockResolvedValueOnce({})
      .mockReturnValueOnce(second.promise);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);

    renderAt("/messages/11");
    const bubble = (await screen.findByText("delete this")).closest("li");
    await user.click(
      within(bubble).getByRole("button", { name: "Message options" })
    );
    await user.click(screen.getByRole("button", { name: "Select" }));
    await screen.findByText("1 selected");
    await user.click(screen.getByText("and this"));
    await user.click(screen.getByRole("button", { name: "Delete" }));
    confirm.mockRestore();
    await waitFor(() => expect(api.deleteMessage).toHaveBeenCalledTimes(2));

    // The selection is already gone, so the group's name button is back — and
    // it opens the info panel, which unmounts the bar this delete reports into.
    expect(screen.getByTitle("Conversation details")).toBeDisabled();

    await openHeaderMenu(user);
    const menu = within(
      screen.getByRole("dialog", { name: "Conversation options" })
    );
    expect(menu.queryByRole("button", { name: "Details" })).toBeNull();
    expect(menu.queryByRole("button", { name: /add people/i })).toBeNull();
    expect(menu.getByRole("button", { name: /mute/i })).toBeInTheDocument();
    await user.keyboard("{Escape}");

    await second.reject(apiError("That message is already gone.", 404));
    expect(
      await screen.findByText("Some messages are still there. Try again.")
    ).toBeInTheDocument();
  });

  // Regression: the hold made `close`'s identity depend on `isWriting`, and the
  // drawer's Escape effect — keyed on `close` — also called `panelRef.focus()`.
  // Left together, starting a write threw focus onto the drawer container, and
  // its settling did it a second time, mid-typing.
  it("doesn't throw focus around when a write starts and settles", async () => {
    const user = userEvent.setup();
    const save = hanging();
    api.getConversation.mockResolvedValue(convoDetail());
    api.getMessages.mockResolvedValue(
      page([msg({ id: 5, text: "helo", sender: mineSender })])
    );
    api.editMessage.mockReturnValue(save.promise);

    renderAt("/messages/7");
    await screen.findByText("helo");
    await user.click(screen.getByRole("button", { name: "Message options" }));
    await user.click(screen.getByRole("button", { name: "Edit" }));
    const box = screen.getByPlaceholderText(/edit your message/i);
    await user.clear(box);
    await user.type(box, "hello");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.editMessage).toHaveBeenCalled());

    const panel = drawer();
    expect(document.activeElement).not.toBe(panel);

    await save.reject(apiError("Editing is only allowed for 15 minutes.", 403));
    expect(document.activeElement).not.toBe(panel);
  });

  it("holds the nav's Messages button, rather than letting it close the drawer", async () => {
    const user = userEvent.setup();
    const rename = hanging();
    api.getConversation.mockResolvedValue(groupConvoDetail());
    api.getMessages.mockResolvedValue(page([]));
    api.getConversationMedia.mockResolvedValue(page([]));
    api.renameConversation.mockReturnValue(rename.promise);

    renderAt("/messages/11");
    await screen.findByText("Book Club");
    await openHeaderMenu(user);
    await user.click(screen.getByRole("button", { name: "Details" }));
    await user.click(await screen.findByRole("button", { name: "Rename" }));
    const field = screen.getByRole("textbox", { name: "Chat name" });
    await user.clear(field);
    await user.type(field, "Reading Club");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.renameConversation).toHaveBeenCalled());

    // Shown as held, not silently ignored: a nav button that does nothing when
    // pressed reads as broken.
    const nav = screen.getByRole("button", { name: /^Messages$/ });
    expect(nav).toBeDisabled();
    await user.click(nav);
    expect(drawer()).toBeInTheDocument();

    await rename.reject(apiError("You’re no longer in this chat.", 403));
    expect(
      await screen.findByText("You’re no longer in this chat.")
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Messages$/ })).toBeEnabled();
  });
});

/**
 * Issue #238 — **a write that is refused has to say so.**
 *
 * Six writes across three of the drawer's panels reported nothing at all when
 * they failed, and in every case a sibling mutation in the same file already
 * did: the thread view rendered its edit and its bulk delete, the info panel its
 * rename, the locked panel its Connect. Omissions, not a house style.
 *
 * Mute is the one that lies hardest, and it's why these are worth a block of
 * their own rather than a line in the fix. The menu closes on the click and both
 * controls read `detail.muted` straight from the server — deliberately, so
 * nothing moves before the write lands — so a mute that 500'd was
 * pixel-identical to a mute that worked. You believe a noisy group chat is
 * silenced and your phone buzzes all evening with no reason to suspect the app.
 *
 * Each test drives the whole sequence and insists on the message, rather than
 * asserting a handler was wired: the swallow only shows at the end of it.
 */
describe("Messages drawer — a refused write says so (#238)", () => {
  function msg(overrides = {}) {
    return {
      id: 1,
      sender: { id: 2, display_name: "Priya", avatar_thumb: null },
      text: "hi",
      is_deleted: false,
      created_at: new Date().toISOString(),
      ...overrides,
    };
  }

  const mineSender = { id: fakeUser.pk, display_name: "you", avatar_thumb: null };

  async function openInfo(user) {
    await openHeaderMenu(user);
    await user.click(screen.getByRole("button", { name: "Details" }));
  }

  /** A request that hangs until the test refuses it — see the #257/#258 block. */
  function hanging() {
    let refuse;
    const promise = new Promise((_resolve, reject) => {
      refuse = reject;
    });
    promise.catch(() => {});
    return {
      promise,
      reject: async (error) => {
        refuse(error);
        await act(async () => {
          for (let i = 0; i < 3; i += 1) {
            await new Promise((resolve) => setTimeout(resolve, 0));
          }
        });
      },
    };
  }

  it("says so when the thread header's Mute is refused", async () => {
    const user = userEvent.setup();
    api.getConversation.mockResolvedValue(convoDetail());
    api.getMessages.mockResolvedValue(page([]));
    api.setConversationMuted.mockRejectedValue(
      apiError("You’re no longer in this chat.", 403)
    );

    renderAt("/messages/7");
    await screen.findByText("Priya");
    await openHeaderMenu(user);
    await user.click(screen.getByRole("button", { name: "Mute" }));

    await waitFor(() =>
      expect(api.setConversationMuted).toHaveBeenCalledWith(7, true)
    );
    // The server's own words where it wrote any (connections.md).
    expect(
      await screen.findByText("You’re no longer in this chat.")
    ).toBeInTheDocument();
    // And the thread is still unmuted, because it always was — the switch never
    // moved. That's the half that made this invisible.
    expect(screen.queryByText("Muted")).toBeNull();
  });

  it("names the direction when Mute is refused with nothing readable", async () => {
    const user = userEvent.setup();
    api.getConversation.mockResolvedValue(convoDetail({ muted: true }));
    api.getMessages.mockResolvedValue(page([]));
    api.setConversationMuted.mockRejectedValue(unauthoredError(500));

    renderAt("/messages/7");
    await screen.findByText("Priya");
    await openHeaderMenu(user);
    await user.click(screen.getByRole("button", { name: "Unmute" }));

    await waitFor(() =>
      expect(api.setConversationMuted).toHaveBeenCalledWith(7, false)
    );
    // Per state, never generic: which of the two didn't happen is most of the
    // value, and a 500 with no DRF body has no words of its own to use.
    expect(
      await screen.findByText("Couldn’t unmute this chat.")
    ).toBeInTheDocument();
  });

  it("says so when the thread header's Leave is refused, and keeps you there", async () => {
    const user = userEvent.setup();
    api.getConversation.mockResolvedValue(groupConvoDetail());
    api.getMessages.mockResolvedValue(page([]));
    api.leaveConversation.mockRejectedValue(unauthoredError(500));

    renderAt("/messages/11");
    await screen.findByText("Book Club");
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    await openHeaderMenu(user);
    await user.click(screen.getByRole("button", { name: /leave/i }));
    confirm.mockRestore();

    await waitFor(() => expect(api.leaveConversation).toHaveBeenCalledWith(11));
    // `openList()` runs only on success, so you're still looking at the thread
    // you just confirmed leaving — which said nothing about why.
    expect(
      await screen.findByText("Couldn’t leave this chat.")
    ).toBeInTheDocument();
    expect(screen.getByText("Book Club")).toBeInTheDocument();
  });

  it("says so when a single-message delete is refused", async () => {
    const user = userEvent.setup();
    api.getConversation.mockResolvedValue(convoDetail());
    api.getMessages.mockResolvedValue(
      page([msg({ id: 5, text: "helo", sender: mineSender })])
    );
    api.deleteMessage.mockRejectedValue(unauthoredError(500));

    renderAt("/messages/7");
    await screen.findByText("helo");
    await user.click(screen.getByRole("button", { name: "Message options" }));
    await user.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(api.deleteMessage).toHaveBeenCalledWith(7, 5));
    // The bubble simply stayed put before this — and the natural response is to
    // delete it again, against a server that may have succeeded the first time.
    expect(
      await screen.findByText("Couldn’t delete that message.")
    ).toBeInTheDocument();
    expect(screen.getByText("helo")).toBeInTheDocument();
  });

  it("says so when the Details panel's Mute is refused", async () => {
    const user = userEvent.setup();
    api.getConversation.mockResolvedValue(groupConvoDetail());
    api.getMessages.mockResolvedValue(page([]));
    api.getConversationMedia.mockResolvedValue(page([]));
    api.setConversationMuted.mockRejectedValue(unauthoredError(500));

    renderAt("/messages/11");
    await screen.findByText("Book Club");
    await openInfo(user);
    await user.click(
      await screen.findByRole("switch", { name: "Mute notifications" })
    );

    await waitFor(() =>
      expect(api.setConversationMuted).toHaveBeenCalledWith(11, true)
    );
    expect(
      await screen.findByText("Couldn’t mute this chat.")
    ).toBeInTheDocument();
    // The switch is driven by the server's answer, so it correctly hasn't
    // moved — which is exactly why it had to be said out loud.
    expect(
      screen.getByRole("switch", { name: "Mute notifications" })
    ).toHaveAttribute("aria-checked", "false");
  });

  it("says so when the Details panel's Leave is refused, and keeps you there", async () => {
    const user = userEvent.setup();
    api.getConversation.mockResolvedValue(groupConvoDetail());
    api.getMessages.mockResolvedValue(page([]));
    api.getConversationMedia.mockResolvedValue(page([]));
    api.leaveConversation.mockRejectedValue(
      apiError("You’re no longer in this chat.", 403)
    );

    renderAt("/messages/11");
    await screen.findByText("Book Club");
    await openInfo(user);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    await user.click(await screen.findByRole("button", { name: /leave chat/i }));
    confirm.mockRestore();

    await waitFor(() => expect(api.leaveConversation).toHaveBeenCalledWith(11));
    expect(
      await screen.findByText("You’re no longer in this chat.")
    ).toBeInTheDocument();
    // Still on Details rather than back at the list, because `openList()` only
    // runs on success — so this is the panel that has to carry the message.
    expect(screen.getByText("Details")).toBeInTheDocument();
  });

  it("says so when the locked panel's Decline is refused", async () => {
    const user = userEvent.setup();
    api.getConversation.mockResolvedValue(
      groupConvoDetail({
        my_status: "pending",
        can_send: false,
        must_connect_with: [{ id: 5, display_name: "Amara", avatar_thumb: null }],
      })
    );
    api.getMessages.mockResolvedValue(page([]));
    api.leaveConversation.mockRejectedValue(unauthoredError(500));

    renderAt("/messages/11");
    await screen.findByText("Book Club");
    await user.click(screen.getByRole("button", { name: /decline|leave/i }));

    await waitFor(() => expect(api.leaveConversation).toHaveBeenCalledWith(11));
    // The button went back from "Leaving…" to "Decline / Leave" and the invite
    // was still there next time — with nothing to say it hadn't worked.
    expect(
      await screen.findByText("Couldn’t leave this chat.")
    ).toBeInTheDocument();
  });

  // The other half of the rule (#258): these panels are now the only renderer of
  // three more rejections apiece, so the drawer's chrome has to hold for them
  // too. Reporting a refusal into a panel the ✕ can tear down first is the same
  // bug one step along.
  it("holds the drawer's ✕ while a mute is out", async () => {
    const user = userEvent.setup();
    const mute = hanging();
    api.getConversation.mockResolvedValue(convoDetail());
    api.getMessages.mockResolvedValue(page([]));
    api.setConversationMuted.mockReturnValue(mute.promise);

    renderAt("/messages/7");
    await screen.findByText("Priya");
    await openHeaderMenu(user);
    await user.click(screen.getByRole("button", { name: "Mute" }));
    await waitFor(() => expect(api.setConversationMuted).toHaveBeenCalled());

    const close = screen.getByRole("button", { name: "Close messages" });
    expect(close).toBeDisabled();
    await user.click(close);
    expect(screen.queryByRole("dialog", { name: "Messages" })).toBeInTheDocument();

    await mute.reject(unauthoredError(500));
    expect(
      await screen.findByText("Couldn’t mute this chat.")
    ).toBeInTheDocument();
    // And it lets go the moment the answer lands, so the message isn't a trap.
    expect(
      screen.getByRole("button", { name: "Close messages" })
    ).toBeEnabled();
  });

  // Found in review of this fix, not in the issue. The drawer's chrome is not
  // the only way out of the Details panel: its own "Add people" row calls
  // `openNew`, which switches `view` — and `openInfo`/`openNew` are deliberately
  // *not* gated centrally (`messaging.jsx`), so a control that calls one is a
  // hold site in its own right. The thread view closes that hatch by dropping
  // Details and Add people from its ⋯; this panel never had the equivalent.
  it("holds the Details panel's own Add people while its mute is out", async () => {
    const user = userEvent.setup();
    const mute = hanging();
    api.getConversation.mockResolvedValue(groupConvoDetail());
    api.getMessages.mockResolvedValue(page([]));
    api.getConversationMedia.mockResolvedValue(page([]));
    api.setConversationMuted.mockReturnValue(mute.promise);

    renderAt("/messages/11");
    await screen.findByText("Book Club");
    await openInfo(user);
    await user.click(
      await screen.findByRole("switch", { name: "Mute notifications" })
    );
    await waitFor(() => expect(api.setConversationMuted).toHaveBeenCalled());

    const add = screen.getByRole("button", { name: /add people/i });
    expect(add).toBeDisabled();
    await user.click(add);

    // Still on Details — the picker would have unmounted the one thing that can
    // report the mute, and the mute is the write that lies hardest when it does.
    await mute.reject(unauthoredError(500));
    expect(
      await screen.findByText("Couldn’t mute this chat.")
    ).toBeInTheDocument();
  });

  it("holds the Details panel's Back while its mute is out", async () => {
    const user = userEvent.setup();
    const mute = hanging();
    api.getConversation.mockResolvedValue(groupConvoDetail());
    api.getMessages.mockResolvedValue(page([]));
    api.getConversationMedia.mockResolvedValue(page([]));
    api.setConversationMuted.mockReturnValue(mute.promise);

    renderAt("/messages/11");
    await screen.findByText("Book Club");
    await openInfo(user);
    await user.click(
      await screen.findByRole("switch", { name: "Mute notifications" })
    );
    await waitFor(() => expect(api.setConversationMuted).toHaveBeenCalled());

    // Back switches `view` to the transcript, which unmounts this panel just as
    // completely as the ✕ closes the drawer.
    expect(screen.getByRole("button", { name: "Back" })).toBeDisabled();

    await mute.reject(unauthoredError(500));
    expect(
      await screen.findByText("Couldn’t mute this chat.")
    ).toBeInTheDocument();
  });
});
