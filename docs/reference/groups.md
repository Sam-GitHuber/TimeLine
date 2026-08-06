# Groups

Private, invite-only shared timelines — a family group, a friend circle, a
shared-interest group — each with its own reverse-chronological timeline you can
post into, with comments, exactly like personal posts. Still no algorithm: a group
timeline is just its members' posts newest-first, scoped to the group. Group
*chat* is a separate feature — see [messaging](messaging.md); planning **events**
in a group is another — see [events](events.md), which reuses this doc's
membership + the connection gate below, keyed on the event's organiser. This doc
is the current-state reference.

Code: `Group` / `GroupMembership` models + `Post.group` FK + membership helpers
(`group_role` / `is_group_member` / `is_group_admin` / `can_add_to_group`) in
`backend/api/`. Frontend: the Groups companion drawer + the `/g/:id` group page,
create/edit forms, and the group-invites inbox.

## Two load-bearing decisions

### 1. Group posts stay *inside* the group

Group posts do **not** appear in the personal home feed by default. The home feed
means "the people I'm connected with"; a group is a separate space you deliberately
open. Mixing them would muddy both surfaces and push toward exactly the "what
should I show you" ranking the project forbids. So `visible_posts` adds
`group__isnull=True` for the home feed and profiles, and the group timeline is its
own membership-gated endpoint.

**Opt-in exception:** the home feed carries an **"include groups" toggle** (off by
default, remembered per-browser). When on, `GET /api/feed/?include_groups=1` merges
in posts from groups you're a member of, **strictly chronologically** — a pure
time-merge, no ranking. Each merged post is labelled "in &lt;group&gt;" in the UI.
Membership still gates *which* groups' posts merge; you only ever see group posts
from groups you're actually in.

### 2. Two roles only — admin & member

- **member** — read the timeline, post, comment, leave.
- **admin** — everything a member can, plus invite/remove members, edit the group,
  promote/demote, delete the group.

The **creator starts as sole admin**. There must always be **≥1 admin** — the
last admin can't leave, be removed, or self-demote without promoting someone first
(the **last-admin guardrail**, a 400), so a group is never orphaned. No read-only
or moderator tier in v1.

## In-group visibility is connection-gated

**Two gates apply, and this is the subtle part.** Membership gates *access* to a
group (non-members get 404 everywhere, so a private group's existence isn't
leaked; only members post). But *whose* posts and comments you see **inside** a
group is gated by **[connection](connections.md)**, not membership:

- Inside a group you see posts and comments only from members you're **connected**
  with. Two people commonly share a group without being connected (members invite
  their own connections, so the graph is connection-dense but not complete), and
  seeing a not-connected co-member's content would violate the app's "no content
  from people you haven't chosen a relationship with" principle.
- So the group timeline, the `include_groups` merge, **and** group-post comments
  all run through the *same* `visible_posts()` connection gate and comment-tree
  prune as the personal feed (with a `group` parameter selecting the timeline).
  One choke point, no group-specific visibility branch.
- **Consequence (accepted):** each member sees a **partial** group timeline — a
  group is effectively "my connections' posts under a shared label", not one
  identical shared feed. A member you aren't connected with still appears in the
  members roster, but their posts/comments aren't shown to you.
- This also resolves the block edge case for free: a block severs the connection,
  so a blocked co-member's posts and comments drop out of your group view
  automatically.

## Data model

- **`Group`** — `name`, `description` (the group "bio"), optional `avatar` (reuses
  the [imaging pipeline](feed-and-posts.md) — same validate/strip-EXIF/downscale
  as user avatars), `creator` (`SET_NULL`, so a group outlives its creator's
  account), `created_at`. Numeric URLs (`/g/:id`), no slug.
- **`GroupMembership`** — `group`, `user`, `role` (`admin`/`member`), `status`
  (`invited`/`active`), `invited_by` (nullable, for the "X invited you" inbox),
  `created_at`. `UniqueConstraint(group, user)` — an invite and an active
  membership are the *same* row moving `invited → active`. "Members" = `active`
  rows; a pending invite grants no access.
- **`Post.group`** — nullable FK (`on_delete=CASCADE`, indexed). A personal post
  has `group=NULL`. **Why extend `Post` rather than a separate `GroupPost` model:**
  a group post *is* a post — same text, photos (`PostImage`), comment tree
  (`Comment`), serializer, and imaging pipeline. A parallel model would duplicate
  all of it. One nullable FK + a scoping branch is the DRY choice, and it's why
  `POST /api/posts/` (not a new endpoint) takes an optional `group` (membership-
  checked in the view).

## Membership & consent

- **Private / invite-only, always.** No public or discoverable groups. Non-member
  endpoints 404 (same discipline as a non-connection's profile).
- **Consent to join:** invite → accept, not silent add — you choose to be in a
  group, mirroring connection requests. No one can drop you into a group.
- **Any active member can invite, but only their own connections**
  (`can_add_to_group` reuses `connected_user_ids` + block checks). This keeps "no
  cold contact from strangers" at the point of entry — you pull in people *you*
  already have a relationship with. Removing members stays **admin-only**. You
  can't invite or be invited by someone you've blocked (either direction).

### Membership is a gate on two *other* screens, so its writes refresh them

Joining or leaving doesn't only change the groups list. `feed_posts` filters group
posts down to the groups you're an **active** member of (that's what the
include-groups toggle merges in), and `PersonalCalendarView` gates on the
identical set — so a membership write changes what the **home feed** and the
**personal calendar** are allowed to show. Every write that ends or starts your
membership — leave, delete, accepting an invite, and (on mobile) an admin
removing their **own** row from the members roster — therefore invalidates
`['groups']`, `['feed']` *and* `['personalCalendar']` together. Each client keeps
the rule in one helper — `mobile/src/groupCache.ts`, `frontend/src/groupCache.js`
— rather than copying it into each write; copied lists are what drifted in
#215 / #273 / #275. The web roster isn't a fourth site: its admin controls render
only on *other* people's rows (`isAdmin && !isSelf`), so leaving from there isn't
possible and the ⋯ menu is the only way out of a group.

Refreshing only the acting screen's list was #277 on mobile and #281 on the web,
and on the app it isn't a flash: the tabs stay mounted for the session, so the
feed query keeps a live observer and never remounts, and a `staleTime` of 0 buys
nothing without something marking it stale. A leave left the feed listing posts
the server would then refuse — tap one and you get *Post not available*, because
`can_view_post` wants the membership you just gave up. On the web the same wrong
render is a flash rather than a stuck state, since react-router unmounts the
route and nothing sets a `staleTime`, so the refetch is already on its way.
Declining an invite is deliberately *not* in this set: it deletes the invite row
and joins nothing — which is why both invite inboxes pass the decision to the
success handler as a boolean it can fork on, rather than as an opaque function.

The mobile roster is the one site where the rule has to be applied
**conditionally**, and #282 is what that costs. Its single mutation covers
promote, demote and remove, so it forks on the action rather than on the screen:
only `remove` *with your own id* ends a membership of yours — removing someone
else, or giving up your own admin badge, leaves the two gated surfaces correct.
That branch is a leave in every other respect too, since it is literally the call
`useGroupActions.leave` makes (`GroupMemberDetailView.delete` allows `is_self`
for any member): the menu says *Leave group*, the confirm carries Leave's wording,
and it `router.replace`s back to the Groups tab rather than leaving you on the
roster of a group you're no longer in — where `['group', id]` would 404 on its
next fetch. It deliberately doesn't invalidate `['group', id]` /
`['groupMembers', id]` on that branch for the same reason.

The keys that a membership write *also* moves but that aren't invalidated here
are `['conversations']` / `['unreadMessages']` (leaving deactivates you in the
group's chats; deleting cascades them away) and `['notificationsUnread']`
(accept/decline addresses the invite's notification). Every one of those is
polled — by the Messages tab / drawer, the tab bar / nav count and the activity
bell respectively — so they heal within a cycle on their own. The feed and the
calendar are the two that never do.

## API

- `POST /api/groups/` — create (creator written as `active` `admin`).
- `GET /api/groups/` — groups you're an active member of (name, `avatar_thumb`,
  `member_count`, `your_role`).
- `GET /api/groups/<id>/` — detail (members only, 404 otherwise).
- `PATCH /api/groups/<id>/` — edit name/description/avatar (admin).
- `DELETE /api/groups/<id>/` — delete (admin); cascades to memberships + posts +
  their photos/comments.
- `GET /api/groups/<id>/members/` — list members (members only).
- `POST /api/groups/<id>/members/` — invite `{ user_id }` (any active member; the
  invitee must be the inviter's connection).
- `DELETE /api/groups/<id>/members/<user_id>/` — remove a member (admin), or
  yourself = **leave**. Blocked by the last-admin guardrail.
- `POST /api/groups/<id>/members/<user_id>/role/` — promote/demote (admin).
- `GET /api/groups/<id>/posts/` — the group timeline, newest-first, paginated
  (members only, connection-pruned as above).
- Posting: **extend `POST /api/posts/`** with an optional `group` id.
- Comments: reuse `GET/POST /api/posts/<id>/comments/` — members only, and
  connection-pruned like personal posts.
- Group-invites inbox (mirrors connection-requests): `GET /api/group-invites/`,
  `POST /api/group-invites/<id>/accept|reject/`.

## Frontend

The Groups list is a **left-docked companion drawer**
(`GroupsDrawer.jsx` / `GroupsDrawerProvider`) — the mirror image of the
right-docked [messages](messaging.md) drawer. It's a *switcher*, not a reading
surface: picking a group closes the drawer and navigates the main column to the
full-width `/g/:id` timeline (so the group feed isn't squeezed into a 400px panel
beside the home feed). The group-invites nav badge lives on the toggle. The
`/g/:id` page reuses the design-system components (`Timeline` spine, `PostCard`,
`ComposeBox`, `CommentThread`, `Avatar`); admin controls (invite/remove/edit/
delete) show only to admins. On narrow viewports the two drawers coordinate
(opening one closes the other below 800px, via a `useMediaQuery` hook) — and
since #258 that coordination can be *refused*, because the messages drawer holds
itself open while a panel inside it has a write out; `Layout` then holds the
Groups button rather than opening a full-width drawer over the message the
refusal exists to show.

Two of this feature's forms were part of #259's sweep, both on the web: the
invite picker's **"Close"** and the create/edit page's **Cancel** are now held
while their write is in flight. The second is the one worth remembering, because
the dismissal is a **navigation** rather than a collapse — press Create then
Cancel, and a 400 used to land on a page that had already been left, so you
arrived at `/groups` with no new group and nothing said. The rule and every site
it covers are in
[connections.md](connections.md#reporting-a-refused-write).

Group invitations generate a `group_invite` notification in the unified activity
centre (accepting or rejecting **addresses** it) — see
[notifications](notifications.md).

## Mobile (Phase 9 E3a)

The iPhone app is a **client port of this API — no backend change.** It drops the
web's left-docked *switcher drawer* for a **Groups tab** (4th bottom tab) with two
segments — your **Groups** and your pending **Invites** (accept/reject) — mirroring
the People hub, with a group-invites badge on the tab (shared `['groupInvites']`
query key). A group opens full-screen at `groups/[groupId]` (a root-stack sibling
of the tabs): the connection-pruned group timeline through the shared
`TimelineList`, capped by a **group-scoped `ComposeBox`** (`createPost` gains an
optional `group` id; the box takes a `groupId`, and decides for itself which
timelines to refresh on success — see
[feed-and-posts](feed-and-posts.md#posts)). The group
actions live behind a **⋯ menu** (ActionSheetIOS): Invite, Members, Leave, and —
for admins — Edit, Delete. Members is its own roster screen (admin controls via a
per-row action sheet; the last-admin guardrail surfaces the server's 400); invite
and create/edit are pushed screens reusing the connection-picker and the profile
editor's round avatar cropper. The group photo can be **taken with the camera as
well as picked from the library** — that step is the shared `usePhotoPicker`, and
its contract (one `await`, assets or `null`, plus a `{photoMenu}` to render) is
written up in
[`mobile-app.md`](mobile-app.md#taking-a-photo-camera-or-library). The **include-groups feed preference**
(`?include_groups=1`, off by default) is a switch in **Settings → Feed**, not a
header control — it's a low-frequency choice, persisted per-device via
`expo-secure-store` (the web's per-browser `localStorage` equivalent); it merges
group **posts** only, never events. (E4b moved it there from the feed header,
where E3a first shipped it.) The `group_invite` push notification deep-links to
the Groups tab.

**Events (the group's upcoming-events section, event detail, RSVP, polls, the
calendar) are E3b/E3c** — E3a is groups only.

## Known limitations (documented, as planned)

- An admin can't yet cancel a *pending* invite (the invitee can decline).
- Not end-to-end encrypted (same as all app data — see [messaging](messaging.md)).
