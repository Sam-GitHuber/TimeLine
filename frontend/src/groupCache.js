// Refetch everything a change to **your own** group membership invalidates.
//
// Membership isn't just a row on the Groups list — it's a **gate on two other
// queries**. The home feed filters group posts down to the groups you're an
// active member of (that's what the include-groups toggle merges in), and the
// personal calendar gates on the identical set (`feed_posts` and
// `PersonalCalendarView` in `backend/api/views.py`; see groups.md and
// events.md). So joining or leaving changes what those two screens are allowed
// to show, and a write that invalidates only `["groups"]` leaves both of them
// showing the old answer (#281 — the web half of #277).
//
// What that looks like here: with the include-groups toggle on, leave a group
// and click Home before anything else has refetched the feed. It renders from
// the `["feed", …]` cache, still listing the group's posts, and clicking one
// gives *Post not available* — `can_view_post` wants the membership you just
// gave up. The inverse is just as wrong: accept an invite and the group's posts
// and events don't arrive. It's a flash rather than a stuck state on the web —
// react-router unmounts the route and we set no `staleTime`, so the refetch is
// already on its way — which is the one thing making this milder than the
// mobile half, where the tabs stay mounted for the session.
//
// One helper rather than the list copied into each of the three writes (leave,
// delete, accept an invite), because copied lists drift — that drift *is*
// #215 / #273 / #275 / #277. Its mobile twin is `mobile/src/groupCache.ts`,
// and the two hold the same three keys deliberately.
//
// `["feed"]` is invalidated **bare**, not `["feed", { includeGroups }]`:
// invalidation prefix-matches on the key, so one entry covers both settings of
// the include-groups preference, including a cached entry for the value this
// browser isn't currently on (`postCache.js` relies on the same first-segment
// matching from the writer's side).
//
// **Deliberately not in here:** `["conversations"]` / `["unreadMessages"]` —
// leaving a group deactivates you in its chats and deleting one takes them with
// it through the FK cascade — and `["notificationsUnread"]`, which accepting an
// invite moves by addressing its notification. Those are all real, but every
// one of those keys is **polled** (the messages drawer, the nav's unread count,
// the activity bell), so they heal on their own cadence within a cycle. The
// feed and the personal calendar are the two that never do.

export function invalidateGroupMembership(queryClient) {
  for (const queryKey of [["groups"], ["feed"], ["personalCalendar"]]) {
    queryClient.invalidateQueries({ queryKey });
  }
}

// Refetch what a change to **someone else's** row on the roster invalidates.
//
// The narrow half, shared by both roster writes: the list itself, the group
// payload (whose `member_count` and `your_role` both move) and the groups list,
// which counts members too. `["groups"]` is the drift #290 also names — the
// app's roster had it and the web's didn't, for no reason either could state.
//
// Deliberately **not** the wider `invalidateGroupMembership` set: promoting,
// demoting or removing *someone else* changes no membership of yours, so the
// home feed and the personal calendar are still right. (The self-remove branch
// is a leave and calls that one instead; see the rosters.)

export function invalidateGroupRoster(queryClient, groupId) {
  for (const queryKey of [
    ["groupMembers", groupId],
    ["group", groupId],
    ["groups"],
  ]) {
    queryClient.invalidateQueries({ queryKey });
  }
}

// Refetch what **removing someone else from a group** invalidates (#290).
//
// The roster's own keys, plus the three an event cancellation moves — because
// that's what a removal is, server-side. `GroupMemberDetailView.delete` ends
// with `cancel_events_on_departure` (`backend/api/views.py`): an event's
// visibility gate hangs off a *present* organiser, so every event the departing
// member organises in this group is soft-cancelled in the same transaction.
// That's the same set `EventPage`'s own cancel handler invalidates, for the
// identical reason, and neither roster named one of them.
//
// What that looks like: an admin opens a group where Ada has a picnic planned,
// opens the members panel and removes her. Her row goes and the count drops —
// and the picnic stays on the spine directly above, in the "N upcoming events"
// count and on the Month grid, until you navigate away and back. On the app
// it's the sticky version: `/calendar` is a tab, mounted for the life of the
// session, so a cancelled plan sits there as a live one until a pull-to-refresh.
//
// **`["groupPosts"]` is not in here, and that's the point.** #290 was filed
// saying a removal drops the member's posts from the group timeline. It
// doesn't: `visible_posts(user, group=pk)` gates on the *author* being you or a
// connection and still active — it never asks whether they're still a member —
// and `can_view_post` only requires that **the viewer** is one. A removed
// member's posts stay visible to the co-members who could already see them, and
// clicking one still opens it. Invalidating that key would be a refetch we
// can't justify, on the strength of a rule the server doesn't have.

export function invalidateMemberRemoved(queryClient, groupId) {
  invalidateGroupRoster(queryClient, groupId);
  for (const queryKey of [
    ["groupEvents", groupId],
    ["groupCalendar", groupId],
    ["personalCalendar"],
  ]) {
    queryClient.invalidateQueries({ queryKey });
  }
}
