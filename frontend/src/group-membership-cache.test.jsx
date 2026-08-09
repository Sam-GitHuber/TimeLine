import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useQuery } from "@tanstack/react-query";
import { Routes, Route } from "react-router-dom";
import GroupPage from "./pages/GroupPage.jsx";
import GroupInvitesPage from "./pages/GroupInvitesPage.jsx";
import { renderWithAuth, apiError, unauthoredError } from "./test-utils.jsx";
import { api } from "./api.js";

// What each write to a group's membership *refreshes*, not just what it calls
// (issue #281 — the web half of #277 — and #290 for the roster's half).
//
// Membership gates the home feed and the personal calendar as well as the groups
// list (`groupCache.js`), so a leave that refreshes only `["groups"]` leaves the
// feed listing posts the server will now refuse — click one and you get *Post
// not available*, because `can_view_post` wants the membership you just gave up.
//
// The two gated surfaces are **mounted alongside** the page doing the write
// rather than seeded into the cache, because a seeded but unobserved entry
// refetches on its next mount whatever we do, and would pass against the broken
// build. They sit outside the `<Routes>` so that navigating away — which every
// one of these writes does — doesn't take the thing under test with it. Same
// reasoning as the app's `groupActions.test.tsx`.

vi.mock("./messaging.jsx", () => ({
  useMessaging: vi.fn(() => ({ openNew: vi.fn() })),
}));

vi.mock("./api.js", () => ({
  api: {
    getPage: vi.fn(),
    getGroup: vi.fn(),
    getGroupPosts: vi.fn(),
    getGroupMembers: vi.fn(),
    getGroupEvents: vi.fn(),
    getGroupCalendar: vi.fn(),
    getGroupInvites: vi.fn(),
    acceptGroupInvite: vi.fn(),
    rejectGroupInvite: vi.fn(),
    removeGroupMember: vi.fn(),
    setGroupMemberRole: vi.fn(),
    deleteGroup: vi.fn(),
    getComments: vi.fn(),
  },
}));

const emptyPage = { results: [], next: null };

// The three surfaces a membership write has to refresh, each with a counting
// fetcher so "loaded once" and "refetched" are distinguishable.
let loads;

function GatedSurfaces() {
  // `{ includeGroups: true }` is the include-groups-in-feed preference turned
  // on — the setting that puts a group's posts on the home feed in the first
  // place. The key carries the same suffix FeedPage uses, so a fix that
  // invalidated `["feed"]` as an *exact* key wouldn't pass here.
  useQuery({ queryKey: ["feed", { includeGroups: true }], queryFn: loads.feed });
  useQuery({ queryKey: ["personalCalendar"], queryFn: loads.calendar });
  useQuery({ queryKey: ["groups"], queryFn: loads.groups });
  return null;
}

/** How many times each surface has loaded, keyed by name for a readable diff. */
function loadCounts() {
  return Object.fromEntries(
    Object.entries(loads).map(([name, fn]) => [name, fn.mock.calls.length])
  );
}

async function renderOverGatedSurfaces(ui, route) {
  const utils = renderWithAuth(
    <>
      <GatedSurfaces />
      <Routes>
        {ui}
        <Route path="/groups" element={<p>Groups list</p>} />
      </Routes>
    </>,
    { route }
  );
  // Their first load, so a later call is unambiguously a refetch.
  await waitFor(() =>
    expect(loadCounts()).toEqual({ feed: 1, calendar: 1, groups: 1 })
  );
  return utils;
}

const groupPageRoute = <Route path="/g/:id" element={<GroupPage />} />;
const invitesRoute = (
  <Route path="/group-invites" element={<GroupInvitesPage />} />
);

async function openGroupMenu() {
  expect(await screen.findByText("Book Club")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Group actions" }));
}

beforeEach(() => {
  vi.clearAllMocks();
  loads = {
    feed: vi.fn(async () => emptyPage),
    calendar: vi.fn(async () => []),
    groups: vi.fn(async () => emptyPage),
  };
  api.getGroup.mockResolvedValue({
    id: 7,
    name: "Book Club",
    description: "",
    avatar_thumb: null,
    member_count: 2,
    your_role: "admin",
  });
  api.getGroupPosts.mockResolvedValue(emptyPage);
  api.getGroupMembers.mockResolvedValue([]);
  api.getGroupEvents.mockResolvedValue([]);
  api.getGroupCalendar.mockResolvedValue([]);
  api.getComments.mockResolvedValue([]);
  api.getGroupInvites.mockResolvedValue({
    count: 1,
    results: [
      {
        id: 12,
        group: { id: 7, name: "Book Club", avatar_thumb: null },
        invited_by: { id: 2, display_name: "Priya" },
      },
    ],
    next: null,
  });
  api.removeGroupMember.mockResolvedValue({});
  api.setGroupMemberRole.mockResolvedValue({});
  api.deleteGroup.mockResolvedValue({});
  api.acceptGroupInvite.mockResolvedValue({});
  api.rejectGroupInvite.mockResolvedValue({});
  vi.spyOn(window, "confirm").mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("leaving or deleting a group", () => {
  it("refreshes the feed and the calendar when you leave", async () => {
    await renderOverGatedSurfaces(groupPageRoute, "/g/7");
    await openGroupMenu();

    await userEvent.click(screen.getByRole("menuitem", { name: "Leave group" }));

    // Leaving is the member-remove endpoint with your own id (groups.md).
    await waitFor(() => expect(api.removeGroupMember).toHaveBeenCalledWith(7, 1));
    // The feed is the regression: it filters group posts down to your active
    // memberships, so every post from this group is now one the server refuses.
    await waitFor(() =>
      expect(loadCounts()).toEqual({ feed: 2, calendar: 2, groups: 2 })
    );
    expect(await screen.findByText("Groups list")).toBeInTheDocument();
  });

  it("refreshes the feed and the calendar when you delete", async () => {
    await renderOverGatedSurfaces(groupPageRoute, "/g/7");
    await openGroupMenu();

    await userEvent.click(
      screen.getByRole("menuitem", { name: "Delete group" })
    );

    // Deleting takes the group's posts and events with it for everyone, so the
    // two gated surfaces are just as wrong afterwards as they are after a leave.
    await waitFor(() => expect(api.deleteGroup).toHaveBeenCalledWith(7));
    await waitFor(() =>
      expect(loadCounts()).toEqual({ feed: 2, calendar: 2, groups: 2 })
    );
  });

  it("refreshes nothing when you cancel the confirmation", async () => {
    window.confirm.mockReturnValue(false);
    await renderOverGatedSurfaces(groupPageRoute, "/g/7");
    await openGroupMenu();

    await userEvent.click(screen.getByRole("menuitem", { name: "Leave group" }));

    expect(api.removeGroupMember).not.toHaveBeenCalled();
    expect(loadCounts()).toEqual({ feed: 1, calendar: 1, groups: 1 });
  });

  it("refreshes nothing when the server refuses the leave", async () => {
    // The last-admin guardrail is server-side, and the page surfaces its words
    // rather than swallowing them; that message is also the tell that the
    // failure has settled, so the counts are read after the mutation finished
    // rather than before it started.
    api.removeGroupMember.mockRejectedValue(
      Object.assign(new Error("Promote another member to admin first."), {
        name: "ApiError",
        status: 400,
        fromServer: true,
      })
    );
    await renderOverGatedSurfaces(groupPageRoute, "/g/7");
    await openGroupMenu();

    await userEvent.click(screen.getByRole("menuitem", { name: "Leave group" }));

    expect(
      await screen.findByText("Promote another member to admin first.")
    ).toBeInTheDocument();
    // Nothing changed on the server, so nothing is refreshed — and you stay put
    // rather than being sent to a list of groups you're still in.
    expect(loadCounts()).toEqual({ feed: 1, calendar: 1, groups: 1 });
    expect(screen.queryByText("Groups list")).toBeNull();
  });
});

/**
 * Issue #290 — **the roster and the events it silently cancels.**
 *
 * `GroupMemberDetailView.delete` ends with `cancel_events_on_departure`: an
 * event's visibility gate hangs off a *present* organiser, so removing someone
 * soft-cancels every event they organise in that group, in the same
 * transaction. The panel refreshed only its own two keys, so the group's
 * upcoming spine — rendered by the very page the panel sits on — went on
 * offering the removed member's plans as live ones, along with the "N upcoming
 * events" cue counting them and the personal calendar listing them.
 *
 * The group's event queries are observed by `GroupPage` itself, so they're
 * counted through `api.getGroupEvents` rather than the mounted surfaces above.
 *
 * The two *negative* assertions are the point as much as the positive ones:
 * `feed` and `getGroupPosts` must not move. #290 was filed believing a removal
 * drops the member's posts from the group timeline, and the server doesn't do
 * that — `visible_posts(user, group=pk)` gates on the author being you or a
 * connection and still *active*, never on their membership, and `can_view_post`
 * only asks whether the **viewer** is a member. Their posts stay, and stay
 * clickable.
 */
describe("managing another member from the roster", () => {
  const roster = [
    { user: { id: 1, display_name: "You" }, role: "admin" },
    { user: { id: 2, display_name: "Ada" }, role: "member" },
  ];

  async function openMembersPanel() {
    api.getGroupMembers.mockResolvedValue(roster);
    await renderOverGatedSurfaces(groupPageRoute, "/g/7");
    await openGroupMenu();
    await userEvent.click(screen.getByRole("menuitem", { name: "Members" }));
    // The upcoming and past lists, both loaded once — so a later call is
    // unambiguously a refetch.
    await waitFor(() => expect(api.getGroupEvents).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("Ada")).toBeInTheDocument();
  }

  it("refreshes the events a removal cancels", async () => {
    await openMembersPanel();

    await userEvent.click(screen.getByRole("button", { name: "Remove" }));

    await waitFor(() => expect(api.removeGroupMember).toHaveBeenCalledWith(7, 2));
    // The regression: Ada's picnic is cancelled on the server the moment her
    // membership row goes, and it was still on the spine beside this panel.
    await waitFor(() => expect(api.getGroupEvents).toHaveBeenCalledTimes(4));
    // The personal calendar merges the same events under a group label, and
    // `["groups"]` counts members. The feed does neither.
    await waitFor(() =>
      expect(loadCounts()).toEqual({ feed: 1, calendar: 2, groups: 2 })
    );
    expect(api.getGroupPosts).toHaveBeenCalledTimes(1);
  });

  it("leaves the events alone when you only change a role", async () => {
    await openMembersPanel();

    await userEvent.click(screen.getByRole("button", { name: "Make admin" }));

    await waitFor(() =>
      expect(api.setGroupMemberRole).toHaveBeenCalledWith(7, 2, "admin")
    );
    // A role change cancels nothing and moves no visibility boundary — only the
    // roster and the badge on it. `groups: 2` is the tell that the success
    // handler ran, so the untouched counts beside it are a real negative.
    await waitFor(() =>
      expect(loadCounts()).toEqual({ feed: 1, calendar: 1, groups: 2 })
    );
    expect(api.getGroupEvents).toHaveBeenCalledTimes(2);
  });
});

describe("deciding on a group invitation", () => {
  it("refreshes the feed and the calendar when you accept", async () => {
    await renderOverGatedSurfaces(invitesRoute, "/group-invites");
    expect(await screen.findByText("Book Club")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Accept" }));

    // Accepting makes you an active member, so the group's posts and events are
    // now yours to see — the inverse of the leave case, and just as wrong if
    // the two gated surfaces keep the old answer.
    await waitFor(() => expect(api.acceptGroupInvite).toHaveBeenCalledWith(12));
    await waitFor(() =>
      expect(loadCounts()).toEqual({ feed: 2, calendar: 2, groups: 2 })
    );
  });

  it("leaves the feed and the calendar alone when you decline", async () => {
    await renderOverGatedSurfaces(invitesRoute, "/group-invites");
    expect(await screen.findByText("Book Club")).toBeInTheDocument();
    expect(api.getGroupInvites).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByRole("button", { name: "Decline" }));

    // Declining deletes the invite row and joins nothing, so it stays on the
    // narrow set. The invite list refetching is the signal that the success
    // handler has run — every invalidation in it happens in that same tick, so
    // if the feed were in the set it would have refetched by now too.
    await waitFor(() => expect(api.getGroupInvites).toHaveBeenCalledTimes(2));
    expect(loadCounts()).toEqual({ feed: 1, calendar: 1, groups: 2 });
  });

  /**
   * Issue #239 — **the error this page rendered belonged to the query, not to
   * the write.**
   *
   * The read has a failure line ("Couldn't load invitations.") and the write had
   * none, which is worse than having neither: a reviewer grepping for `isError`
   * finds one and ticks the box. It can't fire in the case that matters — the
   * list arrived fine and it's the Accept that failed. `onSuccess` is the only
   * place an invalidation runs, so a revoked invite answered 404 and the row
   * stayed exactly where it was, leaving you to press it again or to walk away
   * believing you'd joined.
   *
   * Bundled into this file rather than a suite of its own because these are its
   * subject twice over: the two gated surfaces prove the refusal changed nothing
   * on the server either, which is the other half of "nothing happened".
   */
  it("says so when accepting an invitation is refused", async () => {
    api.acceptGroupInvite.mockRejectedValue(
      apiError("That invitation is no longer available.", 404)
    );
    await renderOverGatedSurfaces(invitesRoute, "/group-invites");
    expect(await screen.findByText("Book Club")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Accept" }));

    expect(
      await screen.findByText("That invitation is no longer available.")
    ).toBeInTheDocument();
    // Not the query's line, which was never about this.
    expect(screen.queryByText("Couldn't load invitations.")).toBeNull();
    // Nothing joined, so nothing gated is refreshed — and the row is still
    // there, which is exactly why the silence read as a broken button.
    expect(loadCounts()).toEqual({ feed: 1, calendar: 1, groups: 1 });
    expect(screen.getByText("Book Club")).toBeInTheDocument();
  });

  it("names the decision when a decline is refused with nothing readable", async () => {
    api.rejectGroupInvite.mockRejectedValue(unauthoredError(500));
    await renderOverGatedSurfaces(invitesRoute, "/group-invites");
    expect(await screen.findByText("Book Club")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Decline" }));

    // Per state, never generic (connections.md) — and a 500 with no DRF body
    // leaves nothing of the server's to show.
    expect(
      await screen.findByText("Couldn’t decline that invitation.")
    ).toBeInTheDocument();
  });
});
