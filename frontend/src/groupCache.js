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
