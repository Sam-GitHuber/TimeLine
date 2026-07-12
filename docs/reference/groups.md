# Groups

Private, invite-only shared timelines — a family group, a friend circle, a
shared-interest group — each with its own reverse-chronological timeline you can
post into, with comments, exactly like personal posts. Still no algorithm: a group
timeline is just its members' posts newest-first, scoped to the group. Group
*chat* is a separate feature — see [messaging](messaging.md). This doc is the
current-state reference.

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
(opening one closes the other below 800px, via a `useMediaQuery` hook).

## Known limitations (documented, as planned)

- An admin can't yet cancel a *pending* invite (the invitee can decline).
- Not end-to-end encrypted (same as all app data — see [messaging](messaging.md)).
