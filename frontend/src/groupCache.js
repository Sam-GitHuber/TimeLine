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
// payload (whose `member_count` and `your_role` both move) and the groups list.
// `["groups"]` is the drift #290 also names — the app's roster had it and the
// web's didn't, for no reason either could state. It earns its place on a
// *removal* (the list carries `member_count`) and on the app's **self**-demote
// (it carries `your_role` too); on a web role change, where the controls only
// ever render on someone else's row, it's a cheap refetch of an unchanged list,
// kept so the two clients state one rule rather than two.
//
// Deliberately **not** the wider `invalidateGroupMembership` set: promoting,
// demoting or removing *someone else* changes no membership of yours, so the
// home feed is still right. (The self-remove branch is a leave and calls that
// one instead; see the rosters.)

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
// A removal is not only a membership write, and that's the whole bug.
// `GroupMemberDetailView.delete` does two more things in the same transaction:
//
// 1. **It soft-cancels the departing member's events in this group**
//    (`cancel_events_on_departure`). Nothing in `visible_events` or
//    `can_view_event` checks the organiser's *membership* — they gate on the
//    viewer being a member and the organiser being active and connected — which
//    is precisely why the server has to cancel them by hand, rather than their
//    falling out of the query on their own.
// 2. **It drops them from every chat scoped to the group** — participant
//    deactivated, `left_at` stamped, `promote_participants` re-run for the rest.
//
// So this names the same five keys as an event write (`EventPage`'s
// `invalidate`, and events.md's rule that every event write moves all five),
// plus `["conversation"]`. `["event"]` / `["eventPhotos"]` / `["conversation"]`
// go in **bare**: invalidation prefix-matches, and we can't enumerate which
// events or which chats the server touched — the same reason and the same shape
// as `connectionCache.js`, which reaches for those keys for its own severing.
//
// **A cancellation is a status change, not a disappearance.** Cancelled events
// stay visible on purpose, so anyone who RSVP'd gets the tombstone rather than a
// plan that silently evaporates. They drop off the *upcoming* spine (which
// filters `status !== "cancelled"`) and out of its "N upcoming events" count,
// and everywhere else they stay put wearing a Cancelled tag. Both are wrong
// until something refetches: an admin removes Ada and her picnic sits on the
// spine above the panel, still counted, still openable as a live plan from the
// cached `["event", id]` — and on the app it's the sticky version, because
// `/calendar` is a tab mounted for the life of the session.
//
// **`["groupPosts"]` is not in here, and that's the point.** #290 was filed
// saying a removal drops the member's posts from the group timeline. It
// doesn't: `visible_posts(user, group=pk)` gates on the *author* being you or a
// connection and still active — it never asks whether they're still a member —
// and `can_view_post` only requires that **the viewer** is one. A removed
// member's posts stay visible to the co-members who could already see them, and
// clicking one still opens it. Invalidating that key would be a refetch we
// can't justify, on the strength of a rule the server doesn't have.
//
// `["conversations"]` / `["unreadMessages"]` stay out for the reason at the top
// of this file: both are polled, so they heal within a cycle. `["conversation"]`
// is the one that isn't — the info panel says so in as many words, and on the
// web the messages drawer is a companion of `Layout` rather than a route, so it
// can be open over the very group page doing the removal.

export function invalidateMemberRemoved(queryClient, groupId) {
  invalidateGroupRoster(queryClient, groupId);
  for (const queryKey of [
    ["event"],
    ["eventPhotos"],
    ["groupEvents", groupId],
    ["groupCalendar", groupId],
    ["personalCalendar"],
    ["conversation"],
  ]) {
    queryClient.invalidateQueries({ queryKey });
  }
}
