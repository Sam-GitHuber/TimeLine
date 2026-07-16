import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Routes, Route } from "react-router-dom";
import PostCard from "./components/PostCard.jsx";
import ComposeBox from "./components/ComposeBox.jsx";
import FeedPage from "./pages/FeedPage.jsx";
import GroupsDrawer from "./components/GroupsDrawer.jsx";
import { GroupsDrawerProvider } from "./groups-drawer.jsx";
import GroupPage from "./pages/GroupPage.jsx";
import GroupFormPage from "./pages/GroupFormPage.jsx";
import GroupInvitePicker from "./components/GroupInvitePicker.jsx";
import { renderWithAuth } from "./test-utils.jsx";
import { api } from "./api.js";
import { useMessaging } from "./messaging.jsx";

// Phase 6: groups. The scoping/permission rules are enforced (and tested) on the
// backend; here we check the frontend wires the group UI to the API correctly —
// the feed "include groups" toggle, posting into a group, the group label on a
// post, listing/creating groups, and admin-only controls.
//
// GroupPage now also opens the messages drawer's new-chat picker scoped to the
// group (Phase 6a "Start a chat"), so useMessaging is mocked here too — a real
// MessagingProvider would need the drawer mounted, which is out of scope for
// these tests; we only need to assert openNew is called correctly.
vi.mock("./messaging.jsx", () => ({
  useMessaging: vi.fn(() => ({ openNew: vi.fn() })),
}));

// Group avatars reuse the same crop modal as profile avatars (issue #18);
// stubbed to a "Use photo" button so these tests stay about group wiring.
vi.mock("./components/AvatarCropModal.jsx", () => ({
  default: ({ onCropped }) => (
    <button
      type="button"
      onClick={() => onCropped(new File(["cropped"], "avatar.jpg", { type: "image/jpeg" }))}
    >
      Use photo
    </button>
  ),
}));

vi.mock("./api.js", () => ({
  api: {
    getFeed: vi.fn(),
    getPage: vi.fn(),
    createPost: vi.fn(),
    getComments: vi.fn().mockResolvedValue([]),
    getGroups: vi.fn(),
    getGroup: vi.fn(),
    getGroupPosts: vi.fn(),
    getGroupMembers: vi.fn(),
    getGroupInvites: vi.fn(),
    getGroupEvents: vi.fn(),
    getGroupCalendar: vi.fn(),
    createGroup: vi.fn(),
    listUsers: vi.fn(),
    inviteToGroup: vi.fn(),
    removeGroupMember: vi.fn(),
    deleteGroup: vi.fn(),
    setGroupMemberRole: vi.fn(),
    getUnreadNotificationCount: vi.fn(),
    getNotifications: vi.fn(),
    markNotificationsSeen: vi.fn(),
    markNotificationAddressed: vi.fn(),
  },
  NOTIFICATIONS_POLL_MS: 1_000_000,
}));

const emptyPage = { results: [], next: null };

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  api.getFeed.mockResolvedValue(emptyPage);
  api.getGroups.mockResolvedValue(emptyPage);
  api.getGroupPosts.mockResolvedValue(emptyPage);
  api.getGroupMembers.mockResolvedValue([]);
  api.getGroupInvites.mockResolvedValue({ count: 0, results: [] });
  api.getGroupEvents.mockResolvedValue([]);
  api.getGroupCalendar.mockResolvedValue([]);
  api.getUnreadNotificationCount.mockResolvedValue({ count: 0 });
  api.getNotifications.mockResolvedValue(emptyPage);
  api.markNotificationsSeen.mockResolvedValue({ updated: 0 });
  api.createPost.mockResolvedValue({});
  api.createGroup.mockResolvedValue({ id: 42 });
  api.getComments.mockResolvedValue([]);
});

describe("PostCard group label", () => {
  it('shows an "in <group>" link when a post belongs to a group', () => {
    const post = {
      id: 1,
      author: { id: 2, display_name: "Priya" },
      text: "hi group",
      created_at: "2026-07-04T08:00:00Z",
      images: [],
      group: { id: 7, name: "Book Club" },
    };
    renderWithAuth(<PostCard post={post} />);
    const link = screen.getByRole("link", { name: "Book Club" });
    expect(link).toHaveAttribute("href", "/g/7");
  });

  it("shows no group label for a personal post", () => {
    const post = {
      id: 1,
      author: { id: 2, display_name: "Priya" },
      text: "hi",
      created_at: "2026-07-04T08:00:00Z",
      images: [],
      group: null,
    };
    renderWithAuth(<PostCard post={post} />);
    expect(screen.queryByText(/^in$/)).toBeNull();
  });
});

describe("ComposeBox posting into a group", () => {
  it("passes the group id to createPost", async () => {
    const user = userEvent.setup();
    renderWithAuth(<ComposeBox group={7} />);
    await user.type(
      screen.getByPlaceholderText("Share with the group…"),
      "hello"
    );
    await user.click(screen.getByRole("button", { name: "Post" }));
    await waitFor(() =>
      expect(api.createPost).toHaveBeenCalledWith("hello", [], 7)
    );
  });
});

describe("Feed include-groups toggle", () => {
  it("fetches with includeGroups when toggled on", async () => {
    const user = userEvent.setup();
    renderWithAuth(<FeedPage />);
    // First load: personal feed only.
    await waitFor(() =>
      expect(api.getFeed).toHaveBeenCalledWith({ includeGroups: false })
    );
    await user.click(screen.getByLabelText("Include groups"));
    await waitFor(() =>
      expect(api.getFeed).toHaveBeenCalledWith({ includeGroups: true })
    );
  });
});

describe("GroupsDrawer", () => {
  it("lists your groups and surfaces pending invitations", async () => {
    api.getGroups.mockResolvedValue({
      results: [
        {
          id: 3,
          name: "Family",
          avatar_thumb: null,
          member_count: 4,
          your_role: "admin",
        },
      ],
      next: null,
    });
    api.getGroupInvites.mockResolvedValue({ count: 2, results: [] });

    renderWithAuth(
      <GroupsDrawerProvider initialOpen>
        <GroupsDrawer />
      </GroupsDrawerProvider>
    );

    expect(await screen.findByText("Family")).toBeInTheDocument();
    expect(screen.getByText("4 members")).toBeInTheDocument();
    expect(
      await screen.findByText(/2 invitations to join a group/)
    ).toBeInTheDocument();
  });
});

function renderGroupAt(route) {
  return renderWithAuth(
    <Routes>
      <Route path="/g/:id" element={<GroupPage />} />
    </Routes>,
    { route }
  );
}

describe("GroupPage admin controls", () => {
  it("shows Edit and Delete to an admin", async () => {
    api.getGroup.mockResolvedValue({
      id: 7,
      name: "Trip",
      description: "",
      avatar_thumb: null,
      member_count: 2,
      your_role: "admin",
    });
    renderGroupAt("/g/7");
    expect(await screen.findByText("Trip")).toBeInTheDocument();
    // The group actions live behind the "⋯" menu now.
    await userEvent.click(screen.getByRole("button", { name: "Group actions" }));
    expect(screen.getByRole("menuitem", { name: "Edit group" })).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: "Delete group" })
    ).toBeInTheDocument();
  });

  it("hides Edit and Delete from a plain member", async () => {
    api.getGroup.mockResolvedValue({
      id: 7,
      name: "Trip",
      description: "",
      avatar_thumb: null,
      member_count: 2,
      your_role: "member",
    });
    renderGroupAt("/g/7");
    expect(await screen.findByText("Trip")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Group actions" }));
    // A plain member's menu has no Edit or Delete…
    expect(screen.queryByRole("menuitem", { name: "Edit group" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Delete group" })).toBeNull();
    // …but can still invite and leave.
    expect(screen.getByRole("menuitem", { name: "Invite" })).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: "Leave group" })
    ).toBeInTheDocument();
  });

  it("opens the members panel from the menu", async () => {
    api.getGroup.mockResolvedValue({
      id: 7,
      name: "Trip",
      description: "",
      avatar_thumb: null,
      member_count: 2,
      your_role: "member",
    });
    renderGroupAt("/g/7");
    await screen.findByText("Trip");
    await userEvent.click(screen.getByRole("button", { name: "Group actions" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Members" }));
    expect(
      await screen.findByRole("heading", { name: /Members/ })
    ).toBeInTheDocument();
  });

  it("shows a cue pointing up to upcoming events", async () => {
    api.getGroup.mockResolvedValue({
      id: 7,
      name: "Trip",
      description: "",
      avatar_thumb: null,
      member_count: 2,
      your_role: "member",
    });
    api.getGroupEvents.mockImplementation((_gid, window) =>
      Promise.resolve(
        window === "upcoming"
          ? [
              {
                id: 1,
                group: { id: 7, name: "Trip" },
                organiser: { id: 1, display_name: "You" },
                title: "Picnic",
                event_date: "2026-08-01",
                status: "scheduled",
                is_past: false,
                dimensions: {
                  date: { state: "set" },
                  time: { state: "unset" },
                  location: { state: "unset" },
                },
                rsvp: { counts: { going: 0, maybe: 0, declined: 0, guests: 0 } },
                polls: [],
              },
            ]
          : []
      )
    );
    renderGroupAt("/g/7");
    await screen.findByText("Trip");
    expect(
      await screen.findByRole("button", { name: /1 upcoming event/ })
    ).toBeInTheDocument();
  });

  it("shows a 'not available' state on a 404 (non-member)", async () => {
    api.getGroup.mockRejectedValue({ status: 404 });
    renderGroupAt("/g/7");
    expect(
      await screen.findByText("Group not available")
    ).toBeInTheDocument();
  });
});

describe("GroupPage start a chat", () => {
  it("opens the new-chat picker scoped to the group's members", async () => {
    const user = userEvent.setup();
    const openNew = vi.fn();
    useMessaging.mockReturnValue({ openNew });
    api.getGroup.mockResolvedValue({
      id: 7,
      name: "Trip",
      description: "",
      avatar_thumb: null,
      member_count: 2,
      your_role: "member",
    });
    api.getGroupMembers.mockResolvedValue([
      { user: { id: 1, display_name: "You" }, role: "member" },
      { user: { id: 2, display_name: "Priya" }, role: "admin" },
    ]);

    renderGroupAt("/g/7");
    await screen.findByText("Trip");
    await user.click(screen.getByRole("button", { name: "Group actions" }));
    await user.click(
      await screen.findByRole("menuitem", { name: "Start a chat" })
    );

    expect(openNew).toHaveBeenCalledWith({
      groupId: 7,
      groupName: "Trip",
      memberIds: [1, 2],
    });
  });
});

describe("GroupInvitePicker", () => {
  it("finds a connection listed beyond the first page of users", async () => {
    // The people list is paginated; a connection can sort onto page 2. The
    // picker must pull every page so they're still invitable (regression: it
    // previously filtered only page 1 and reported "No connections match").
    api.listUsers.mockResolvedValue({
      results: [
        {
          id: 2,
          display_name: "Page One Pal",
          connection_status: "connected",
          avatar_thumb: null,
        },
      ],
      next: "/api/users/?page=2",
    });
    api.getPage.mockResolvedValue({
      results: [
        {
          id: 3,
          display_name: "Page Two Pal",
          connection_status: "connected",
          avatar_thumb: null,
        },
      ],
      next: null,
    });
    api.inviteToGroup.mockResolvedValue({});

    renderWithAuth(<GroupInvitePicker groupId={7} onClose={() => {}} />);

    // The page-2 connection becomes reachable once all pages load.
    expect(await screen.findByText("Page Two Pal")).toBeInTheDocument();
    const row = screen.getByText("Page Two Pal").closest("li");
    await userEvent.click(within(row).getByRole("button", { name: "Invite" }));
    expect(api.inviteToGroup).toHaveBeenCalledWith(7, 3);
  });
});

describe("GroupFormPage create", () => {
  it("creates a group from the entered name", async () => {
    const user = userEvent.setup();
    renderWithAuth(<GroupFormPage />, { route: "/groups/new" });
    await user.type(
      screen.getByPlaceholderText("Family, book club, five-a-side…"),
      "New Crew"
    );
    await user.click(screen.getByRole("button", { name: "Create group" }));
    await waitFor(() =>
      expect(api.createGroup).toHaveBeenCalledWith(
        expect.objectContaining({ name: "New Crew" })
      )
    );
  });

  it("reframes a chosen avatar through the crop modal before creating", async () => {
    const user = userEvent.setup();
    renderWithAuth(<GroupFormPage />, { route: "/groups/new" });
    await user.type(
      screen.getByPlaceholderText("Family, book club, five-a-side…"),
      "Photo Crew"
    );
    // Choosing a file opens the crop modal; confirming it sets the avatar.
    await user.upload(
      screen.getByTestId("group-avatar-input"),
      new File(["bytes"], "logo.png", { type: "image/png" })
    );
    await user.click(screen.getByRole("button", { name: "Use photo" }));
    await user.click(screen.getByRole("button", { name: "Create group" }));

    await waitFor(() => expect(api.createGroup).toHaveBeenCalledTimes(1));
    expect(api.createGroup.mock.calls[0][0].avatar).toBeInstanceOf(File);
  });
});
