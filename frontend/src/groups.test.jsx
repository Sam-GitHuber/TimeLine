import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Routes, Route } from "react-router-dom";
import PostCard from "./components/PostCard.jsx";
import ComposeBox from "./components/ComposeBox.jsx";
import FeedPage from "./pages/FeedPage.jsx";
import GroupsDrawer from "./components/GroupsDrawer.jsx";
import { GroupsDrawerProvider } from "./groups-drawer.jsx";
import GroupPage from "./pages/GroupPage.jsx";
import GroupFormPage from "./pages/GroupFormPage.jsx";
import { renderWithAuth } from "./test-utils.jsx";
import { api } from "./api.js";

// Phase 6: groups. The scoping/permission rules are enforced (and tested) on the
// backend; here we check the frontend wires the group UI to the API correctly —
// the feed "include groups" toggle, posting into a group, the group label on a
// post, listing/creating groups, and admin-only controls.
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
    createGroup: vi.fn(),
    listUsers: vi.fn(),
    inviteToGroup: vi.fn(),
    removeGroupMember: vi.fn(),
    deleteGroup: vi.fn(),
    setGroupMemberRole: vi.fn(),
  },
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
    expect(screen.getByRole("link", { name: "Edit" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Delete group" })
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
    expect(screen.queryByRole("link", { name: "Edit" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Delete group" })
    ).toBeNull();
    // But a member can still invite and leave.
    expect(screen.getByRole("button", { name: "Invite" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Leave" })).toBeInTheDocument();
  });

  it("shows a 'not available' state on a 404 (non-member)", async () => {
    api.getGroup.mockRejectedValue({ status: 404 });
    renderGroupAt("/g/7");
    expect(
      await screen.findByText("Group not available")
    ).toBeInTheDocument();
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
});
