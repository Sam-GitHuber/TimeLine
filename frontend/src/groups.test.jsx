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
import {
  renderWithAuth,
  failRefetch,
  unauthoredError,
} from "./test-utils.jsx";
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

  it("opens the plan-event form from the menu", async () => {
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
    await userEvent.click(
      screen.getByRole("menuitem", { name: "Plan an event" })
    );
    expect(
      await screen.findByPlaceholderText(/Grandma's 80th/)
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

  it("puts upcoming events on the line, nearest closest to now", async () => {
    api.getGroup.mockResolvedValue({
      id: 7,
      name: "Trip",
      description: "",
      avatar_thumb: null,
      member_count: 2,
      your_role: "member",
    });
    const mk = (id, title, date) => ({
      id,
      group: { id: 7, name: "Trip" },
      organiser: { id: 1, display_name: "You" },
      title,
      event_date: date,
      starts_at: `${date}T10:00:00Z`,
      status: "scheduled",
      is_past: false,
      dimensions: {
        date: { state: "set" },
        time: { state: "unset" },
        location: { state: "unset" },
      },
      rsvp: { counts: { going: 0, maybe: 0, declined: 0, guests: 0 } },
      polls: [],
    });
    api.getGroupEvents.mockImplementation((_gid, window) =>
      Promise.resolve(
        window === "upcoming"
          ? [mk(1, "Near picnic", "2026-08-01"), mk(2, "Far trip", "2026-09-01")]
          : []
      )
    );
    renderGroupAt("/g/7");
    await screen.findByText("Trip");
    const near = await screen.findByRole("link", { name: /Near picnic/ });
    const far = screen.getByRole("link", { name: /Far trip/ });
    // Furthest-future is higher up the page; the nearest sits lower, just above
    // the now-node — so `near` follows `far` in document order.
    expect(
      far.compareDocumentPosition(near) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it("keeps cancelled events off the upcoming spine and the cue count", async () => {
    api.getGroup.mockResolvedValue({
      id: 7,
      name: "Trip",
      description: "",
      avatar_thumb: null,
      member_count: 2,
      your_role: "member",
    });
    const mk = (id, title, status) => ({
      id,
      group: { id: 7, name: "Trip" },
      organiser: { id: 1, display_name: "You" },
      title,
      event_date: "2026-08-01",
      starts_at: "2026-08-01T10:00:00Z",
      status,
      is_past: false,
      dimensions: {
        date: { state: "set" },
        time: { state: "unset" },
        location: { state: "unset" },
      },
      rsvp: { counts: { going: 0, maybe: 0, declined: 0, guests: 0 } },
      polls: [],
    });
    api.getGroupEvents.mockImplementation((_gid, window) =>
      Promise.resolve(
        window === "upcoming"
          ? [mk(1, "Real picnic", "scheduled"), mk(2, "Scrapped trip", "cancelled")]
          : []
      )
    );
    renderGroupAt("/g/7");
    await screen.findByText("Trip");
    // Cue counts only the live event, and the cancelled one isn't on the spine.
    expect(
      await screen.findByRole("button", { name: /1 upcoming event/ })
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Real picnic/ })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Scrapped trip/ })).toBeNull();
  });

  it("shows a 'not available' state on a 404 (non-member)", async () => {
    api.getGroup.mockRejectedValue({ status: 404 });
    renderGroupAt("/g/7");
    expect(
      await screen.findByText("Group not available")
    ).toBeInTheDocument();
  });

  // Issue #310. A failed *refetch* keeps the data the query already has —
  // `query-core`'s error action writes `status`, `error` and `isInvalidated` and
  // never touches `data` — and this page refetches on window focus with a
  // `staleTime` of 0. Reading `isError` before the data threw away the timeline,
  // the upcoming events and the calendar over one lost request.
  it("keeps a loaded group on screen when a refresh fails", async () => {
    api.getGroup.mockResolvedValue({
      id: 7,
      name: "Trip",
      description: "",
      avatar_thumb: null,
      member_count: 2,
      your_role: "member",
    });
    const { queryClient } = renderGroupAt("/g/7");
    await screen.findByText("Trip");

    api.getGroup.mockRejectedValue({ status: 500, message: "Server error" });
    await failRefetch(queryClient, ["group", 7]);

    expect(screen.getByText("Trip")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /try again/i })).toBeNull();
  });

  // The one error that still outranks the cached copy: removed from the group,
  // or the group deleted, is an answer about *now*.
  it("still takes the group away when a refresh 404s", async () => {
    api.getGroup.mockResolvedValue({
      id: 7,
      name: "Trip",
      description: "",
      avatar_thumb: null,
      member_count: 2,
      your_role: "member",
    });
    const { queryClient } = renderGroupAt("/g/7");
    await screen.findByText("Trip");

    api.getGroup.mockRejectedValue({ status: 404 });
    await failRefetch(queryClient, ["group", 7]);

    expect(await screen.findByText("Group not available")).toBeInTheDocument();
    expect(screen.queryByText("Trip")).toBeNull();
  });
});

// #314. `groupQuery` has had an error branch since #310; the four queries beside
// it had none, so a page with a perfectly good header could simultaneously claim
// the group had no posts, no events and an empty calendar — none of which anyone
// had asked the server about.
describe("GroupPage — a failed load is not an empty group", () => {
  const group = {
    id: 7,
    name: "Trip",
    description: "",
    avatar_thumb: null,
    member_count: 2,
    your_role: "admin",
  };

  beforeEach(() => {
    api.getGroup.mockResolvedValue(group);
  });

  // The loudest one: "Be the first to share something" on a group with two
  // years of history, whose natural response is to post into it again.
  it("says the posts failed instead of claiming the group is empty", async () => {
    api.getGroupPosts.mockRejectedValue(unauthoredError(500));
    renderGroupAt("/g/7");
    await screen.findByText("Trip");

    expect(
      await screen.findByText("Couldn’t load this group’s posts.")
    ).toBeInTheDocument();
    expect(screen.queryByText(/Be the first to share/)).toBeNull();
  });

  it("keeps the posts it has when a later page fails", async () => {
    api.getGroupPosts.mockResolvedValue({
      results: [
        {
          id: 1,
          author: { id: 2, display_name: "Priya" },
          text: "hi group",
          created_at: "2026-07-04T08:00:00Z",
          images: [],
          group: { id: 7, name: "Trip" },
        },
      ],
      next: null,
    });
    const { queryClient } = renderGroupAt("/g/7");
    await screen.findByText("hi group");

    api.getGroupPosts.mockRejectedValue(unauthoredError(500));
    await failRefetch(queryClient, ["groupPosts", 7]);

    expect(screen.getByText("hi group")).toBeInTheDocument();
    expect(screen.queryByText("Couldn’t load this group’s posts.")).toBeNull();
  });

  // The invisible one: a failed upcoming fetch makes the count compute 0, which
  // hides the "↑ N upcoming events" cue along with the events — so without a
  // line of its own nothing distinguishes "nothing planned" from "couldn't ask".
  it("says so when the upcoming events fail, since the cue hides itself", async () => {
    api.getGroupEvents.mockImplementation((_id, window) =>
      window === "upcoming"
        ? Promise.reject(unauthoredError(500))
        : Promise.resolve([])
    );
    renderGroupAt("/g/7");
    await screen.findByText("Trip");

    expect(
      await screen.findByText(/Couldn’t load what’s coming up/)
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /upcoming event/ })).toBeNull();
  });

  it("says so when the past events fail, rather than dropping them silently", async () => {
    api.getGroupEvents.mockImplementation((_id, window) =>
      window === "past"
        ? Promise.reject(unauthoredError(500))
        : Promise.resolve([])
    );
    renderGroupAt("/g/7");
    await screen.findByText("Trip");

    expect(
      await screen.findByText("Couldn’t load this group’s past events.")
    ).toBeInTheDocument();
  });

  // A drawn month with nothing in it is the most confident possible lie about
  // a calendar.
  it("doesn't draw an empty month grid when the calendar fails", async () => {
    const user = userEvent.setup();
    api.getGroupCalendar.mockRejectedValue(unauthoredError(500));
    renderGroupAt("/g/7");
    await screen.findByText("Trip");

    await user.click(screen.getByRole("button", { name: "Calendar" }));

    expect(
      await screen.findByText("Couldn’t load this group’s calendar.")
    ).toBeInTheDocument();
    // The grid names its weekdays; none of them are on screen.
    expect(screen.queryByText("Mon")).toBeNull();
  });

  // A "Members" heading over an empty list reads as a group with no members —
  // and the admin controls simply aren't there to press.
  it("says the member list failed instead of showing an empty roster", async () => {
    const user = userEvent.setup();
    api.getGroupMembers.mockRejectedValue(unauthoredError(500));
    renderGroupAt("/g/7");
    await screen.findByText("Trip");

    await user.click(screen.getByRole("button", { name: "Group actions" }));
    await user.click(await screen.findByRole("menuitem", { name: "Members" }));

    expect(
      await screen.findByText("Couldn’t load the members.")
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

  // #314, the half that reaches a *write*. `(membersQuery.data ?? [])` turned
  // "we couldn't ask who's in this group" into "this group has nobody in it",
  // so this created a group chat with an empty member list rather than the
  // action refusing.
  it("refuses rather than starting a chat with nobody in it", async () => {
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
    api.getGroupMembers.mockRejectedValue(unauthoredError(500));

    renderGroupAt("/g/7");
    await screen.findByText("Trip");
    await user.click(screen.getByRole("button", { name: "Group actions" }));
    await user.click(
      await screen.findByRole("menuitem", { name: "Start a chat" })
    );

    expect(openNew).not.toHaveBeenCalled();
    expect(
      await screen.findByText(/Couldn’t check who’s in this group/)
    ).toBeInTheDocument();
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

  it("says so when a page of connections fails, rather than looking short", async () => {
    // The walk stops on a failed page instead of retrying it forever (#214), so
    // the list can end early — and a list that stopped short looks exactly like
    // a list that ended. Here that would read as "you aren't connected to them",
    // which is a wrong answer rather than a missing one.
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
    api.getPage.mockRejectedValue(new Error("boom"));

    renderWithAuth(<GroupInvitePicker groupId={7} onClose={() => {}} />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Couldn’t load your connections."
    );
    // And what did load is still invitable.
    expect(screen.getByText("Page One Pal")).toBeInTheDocument();
  });

  it("doesn't claim you have no connections when the load failed", async () => {
    // Nothing loaded at all: the empty state is the same lie in stronger terms.
    api.listUsers.mockRejectedValue(new Error("boom"));

    renderWithAuth(<GroupInvitePicker groupId={7} onClose={() => {}} />);

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(
      screen.queryByText(/You can only invite people you're connected with/)
    ).not.toBeInTheDocument();
  });
});

/**
 * Issue #310, at the only site in this PR that destroys something the user
 * typed. `name` and `description` are component state seeded once from
 * `existing.data`, plus a chosen avatar and its crop; the early return unmounts
 * the form and takes all of it, and nothing persists a draft. Meanwhile
 * `["group", id]` refetches on window focus with a `staleTime` of 0 and is
 * invalidated by any membership write.
 */
describe("GroupFormPage edit — a failed refetch doesn't eat your typing", () => {
  const group = {
    id: 7,
    name: "Trip",
    description: "Weekend away",
    avatar_thumb: null,
    member_count: 2,
    your_role: "admin",
  };

  function renderEdit() {
    return renderWithAuth(
      <Routes>
        <Route path="/g/:id/edit" element={<GroupFormPage />} />
      </Routes>,
      { route: "/g/7/edit" }
    );
  }

  it("keeps the form, and the rewritten description, through a failed refetch", async () => {
    const user = userEvent.setup();
    api.getGroup.mockResolvedValue(group);
    const { queryClient } = renderEdit();
    const description = await screen.findByDisplayValue("Weekend away");

    await user.clear(description);
    await user.type(description, "Now a fortnight, and the ferry is booked");

    api.getGroup.mockRejectedValue({ status: 500, message: "Server error" });
    await failRefetch(queryClient, ["group", 7]);

    expect(
      screen.getByDisplayValue("Now a fortnight, and the ferry is booked")
    ).toBeInTheDocument();
    expect(screen.queryByText(/Couldn't load the group/)).toBeNull();
  });

  // A 404 still wins: the group is gone, or you're no longer in it, and there is
  // nothing left to save the edit to.
  it("still gives up the form when the refetch 404s", async () => {
    api.getGroup.mockResolvedValue(group);
    const { queryClient } = renderEdit();
    await screen.findByDisplayValue("Weekend away");

    api.getGroup.mockRejectedValue({ status: 404 });
    await failRefetch(queryClient, ["group", 7]);

    expect(
      await screen.findByText(/This group doesn't exist, or you're not in it/)
    ).toBeInTheDocument();
  });

  it("says the load failed when there's no group to show at all", async () => {
    api.getGroup.mockRejectedValue({ status: 500, message: "Server error" });
    renderEdit();

    expect(
      await screen.findByText(/Couldn't load the group/)
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
