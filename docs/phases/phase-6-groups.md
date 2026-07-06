# Phase 6 — Groups

**Status:** **done** — implemented on branch `phase-6-groups`. Backend
(`Group`/`GroupMembership` + `Post.group`, endpoints, membership/admin gates) and
frontend (Groups list, group page with timeline + members + invite, create/edit
forms, group-invites inbox + nav badge, and an opt-in "include groups" feed
toggle) are in, with backend + frontend tests passing and an end-to-end smoke
test over HTTP green. Core decisions were confirmed with the user (2026-07-06);
see the notes log for what was built.

> **Followed by Phase 6a — Group Messaging** (`phase-6a-group-messaging.md`):
> group *chat* is deliberately a sub-phase after groups, extending Phase 5's 1:1
> direct messaging. The membership model designed here is what 6a builds on — see
> "Handoff to Phase 6a" at the end.

## Goal

Let users create and join **groups** — a family group, a friend circle, a
shared-interest group — each with its own private, shared, reverse-chronological
timeline you can post into. Still no algorithm anywhere: a group timeline is just
its members' posts newest-first, exactly like the home feed but scoped to the
group.

## Runnable product at the end of this phase

A logged-in user can create a group, invite members (who accept), post text +
photos into the group's timeline, and read a reverse-chronological feed scoped to
that group — with comments, the same as personal posts. Admins can manage
membership and delete the group; any member can leave.

## The two decisions that shape everything else

Both are "open questions" from the original sketch. Recommendations here; the
whole design assumes them, so **confirm before building**.

### 1. Group posts stay *inside* the group — they do **not** appear in the home feed

**Recommendation: keep group posts out of the personal home feed.** The home feed
stays exactly what it is today — your own personal posts plus your connections'
personal posts. A group is a separate space you deliberately open.

Why (this is the load-bearing decision):

- **It keeps each surface's meaning clean.** The home feed means "the people I'm
  connected with." A group timeline means "this group." Mixing them muddies both
  and pushes toward exactly the kind of "what should I show you" ranking the
  project forbids — if five groups all dumped into one feed, *something* would
  have to decide the mix.
- **The privacy/visibility rules are genuinely different, so they can't share one
  query.** Personal posts are visible to *your connections*, and the comment tree
  is pruned to *your connections* (`connected_user_ids` in `api/views.py`). Inside
  a group, the audience is *group members* — who are **not** necessarily connected
  to each other. So a group post's visibility, and its comments' visibility, key
  off **group membership**, not connections. That's a different rule, and trying to
  fold group posts into `visible_posts()` would force one function to mean two
  things. Separate surfaces keep each rule in one place (the same discipline
  `visible_posts` already applies).
- It matches how people expect groups to work (Facebook groups, WhatsApp groups)
  — you go *into* the group to see it.

Consequence for the code: the home feed query must **exclude** group posts
(`group__isnull=True`), and the group timeline is its own endpoint gated on
membership. Cheap to do; see Steps.

**Refinement (added at the user's request, 2026-07-06):** the home feed carries
an **opt-in "include groups" toggle** (off by default). When on, `GET
/api/feed/?include_groups=1` merges in posts from groups you're a member of,
still **strictly chronological** — a pure time-merge, no ranking, so the
no-algorithm rule holds. This doesn't undermine the decision above: the default
feed is unchanged, the merge is an explicit user choice, and membership still
gates it (you only ever see group posts from groups you're actually in). The
comment-visibility point also still holds — a group post's comments stay
membership-scoped wherever the post is shown. Each merged post is labelled "in
&lt;group&gt;" in the UI so the stream stays legible.

### 2. Roles: just **admin** and **member**

Keep it to two roles.

- **member** — can read the group timeline, post, comment, and leave.
- **admin** — everything a member can, plus: invite/remove members, edit the
  group (name/description/avatar), promote another member to admin, and delete
  the group.

The **creator starts as the sole admin.** Admins can promote others, and there
must always be **at least one admin** (the last admin can't leave or self-demote
without promoting someone first — otherwise a group is orphaned). No read-only or
"moderator" tier in v1 — add later only if a real need appears.

## Definition of done

- [x] `Group` + `GroupMembership` tables via migrations (`0007`, in the `api`
      app)
- [x] Add a nullable `group` FK to `Post` — a `null` group is a personal post
      (today's behaviour, unchanged); a set group is a group post. Reuses all the
      existing post machinery (photos, comments, serializer, imaging pipeline)
- [x] Create a group (creator becomes admin); edit it (admin); delete it (admin)
- [x] Private/invite-only membership: **invite → accept** (a member you invite
      approves joining — consent-first, mirroring connection requests); **any
      member** can invite one of their own connections. A group-invites inbox with
      a nav badge, like the connection-requests inbox
- [x] Post text + photos into a group (members only); group timeline
      reverse-chronological + paginated (members only — non-member gets 404)
- [x] Comments on group posts, visible to **all group members** (not
      connection-pruned) — a member-scoped variant of the existing comment tree
- [x] Remove a member (admin); **leave a group** (any member); last-admin
      guardrail; promote/demote between admin/member (admin)
- [x] Home feed **excludes** group posts by default (personal feed meaning
      unchanged), with an **opt-in "include groups" toggle** that merges them in
      chronologically (see the decisions log — added at the user's request)
- [x] Frontend: Groups list, a group page (timeline + compose + members + invite),
      create + edit flows, group-invites inbox with badge — all built from the
      existing design-system components (`PostCard`, `ComposeBox`, `CommentThread`,
      `Timeline` spine, `Avatar`)
- [x] Backend + frontend tests, following the established pattern

## Data model

Two new tables in the `api` app, plus one FK on `Post`.

- **`Group`** — a named shared space.
  - `name` (required), `description` (blank ok, the group "bio"), optional
    `avatar` (reuse `api/imaging.py` — same validate/strip-EXIF/downscale
    pipeline as user avatars and post photos; **don't** hand-roll image handling),
    `creator` (FK, for the record/admin), `created_at`.
  - Numeric URLs (`/g/:id`), no slug — consistent with the profile decision
    (`identity-model-no-username`, `/u/:id`).
- **`GroupMembership`** — who is in a group and in what role/state.
  - `group` (FK, `related_name="memberships"`), `user` (FK,
    `related_name="group_memberships"`), `role` (`admin`/`member`, TextChoices),
    `status` (`invited`/`active`, TextChoices), `invited_by` (FK, nullable — for
    the invite inbox "X invited you"), `created_at`.
  - `UniqueConstraint(group, user)` — one membership row per person per group
    (an invite and an active membership are the *same* row moving `invited →
    active`, so no duplicates).
  - "Members of a group" = rows with `status=active`. A pending invite is
    `status=invited` and grants no access until accepted.
- **`Post.group`** — nullable FK to `Group`
  (`on_delete=CASCADE`, `related_name="posts"`, `null=True`, `db_index=True`).
  Deleting a group deletes its posts (and, via existing cascades, their photos +
  comments). A personal post has `group=NULL`; nothing about existing posts
  changes (the migration backfills `NULL`).

Why extend `Post` rather than a separate `GroupPost` table: a group post *is* a
post — same text, same photos (`PostImage`), same comment tree (`Comment`), same
serializer, same imaging pipeline. A parallel model would duplicate all of that.
One nullable FK + a scoping branch is the boring, DRY choice.

## API sketch (REST, reuses Phase 2 auth + the Phase 3a patterns)

Membership is checked on every group endpoint — a non-member gets **404** (not
403), so a private group's very existence isn't leaked. Mirrors how the profile
of a non-connection reveals nothing.

Groups & membership:

- `POST /api/groups/` — create a group `{ name, description?, avatar? }`; the
  creator is written as an `active` `admin`. Returns the group.
- `GET  /api/groups/` — groups you're an **active** member of (for the Groups
  list); each with `name`, `avatar_thumb`, `member_count`, `your_role`.
- `GET  /api/groups/<id>/` — group detail (members only): name, description,
  avatar, `member_count`, `your_role`. 404 if not a member.
- `PATCH /api/groups/<id>/` — edit name/description/avatar (**admin** only).
- `DELETE /api/groups/<id>/` — delete the group (**admin** only). Cascades to
  memberships + posts + their photos/comments.
- `GET  /api/groups/<id>/members/` — list members (members only): each user's
  `display_name`, `avatar_thumb`, `role`.
- `POST /api/groups/<id>/members/` — invite a member `{ user_id }` (**any active
  member** may invite). The invitee must be one of the **inviter's connections**
  and not blocked (see safety notes). Creates a `status=invited` row. 403
  otherwise.
- `DELETE /api/groups/<id>/members/<user_id>/` — remove a member (**admin**), or
  the caller removing themselves = **leave**. Blocked by the last-admin guardrail.
- `POST /api/groups/<id>/members/<user_id>/role/` — promote/demote between
  admin/member (**admin** only) — *optional for v1; include if cheap.*

Group timeline:

- `GET  /api/groups/<id>/posts/` — the group's timeline, newest-first, paginated
  (members only; 404 otherwise). Same `PostSerializer` payload as the home feed.
- Posting: **extend the existing `POST /api/posts/`** to accept an optional
  `group` id. The view checks the author is an active member of that group before
  creating; personal posts (no `group`) behave exactly as today. This reuses the
  existing multipart photo-upload path rather than duplicating it. (Alternative:
  a group-scoped `POST /api/groups/<id>/posts/` — same logic, more surface; the
  shared `/api/posts/` is the lighter choice.)

Comments on group posts:

- Reuse `GET/POST /api/posts/<id>/comments/`, but the visibility rule branches on
  whether the post has a group: **for a group post, all comments are visible to
  every group member** (no connection-pruning), and only members may read/post.
  For a personal post it's unchanged (connection-pruned). One extra branch in
  `PostCommentsView`, keyed on `post.group_id`.

Group-invites inbox (mirrors `connection-requests/`):

- `GET  /api/group-invites/` — invites awaiting your acceptance (`status=invited`
  rows where `user == you`): each with the group + who invited you.
- `POST /api/group-invites/<id>/accept/` — become an `active` member.
- `POST /api/group-invites/<id>/reject/` — delete the invite row.

## Steps

1. Models + migration: `Group`, `GroupMembership`, and the nullable `Post.group`
   FK. Backfill is trivial (existing posts → `NULL`).
2. A small membership helper layer in `api/views.py`, in the spirit of
   `connected_user_ids` / `can_message`:
   - `group_member_ids(group)` / `is_member(user, group)` — active membership.
   - `is_group_admin(user, group)`.
   - `can_add_to_group(inviter, invitee)` — invitee is inviter's connection,
     both active, not blocked (reuses `connected_user_ids` + `is_blocked_between`).
   Keep the rules in these helpers so views can't drift.
3. Serializers + views for the endpoints above. Wire the membership check as the
   single gate; return 404 to non-members everywhere.
4. Extend `PostCreateView` to accept and validate `group`; add the group-timeline
   `get_queryset`. Add `group__isnull=True` to the **home** feed query
   (`visible_posts` / `FeedView`) so group posts don't leak into it.
5. Branch `PostCommentsView` on `post.group_id`: member-scoped, unpruned tree for
   group posts; unchanged for personal posts.
6. Frontend:
   - `GroupsPage` (`/groups`) — your groups + a "Create group" affordance.
   - `GroupPage` (`/g/:id`) — the group timeline (reuse `Timeline` + `PostCard` +
     `ComposeBox`), a members panel, and admin controls (invite/remove/edit/
     delete) shown only to admins.
   - Create + edit forms (reuse `ProfileEditPage`'s avatar/bio pattern for the
     group avatar/description).
   - A group-invites inbox + a nav badge, cloned from the connection-requests
     inbox and `Layout.jsx`'s badge pattern.
   - Data fetching via TanStack Query, same as the rest of the app.
7. Tests, both sides:
   - **Backend:** non-member 404s on detail/timeline/comments; only members post;
     admin-only invite/remove/edit/delete; invite→accept→member; leave; last-admin
     guardrail; can't invite a non-connection / blocked user; group comments
     visible to all members (not connection-pruned); **home feed excludes group
     posts**.
   - **Frontend:** create group, see it listed; invite flow + inbox badge; post
     appears in the group timeline; members list; admin controls hidden from
     non-admins; leave.

## Privacy / safety notes

- **Private / invite-only, always.** No public or discoverable groups in v1
  (matches the privacy-first principle and the "no public sign-ups yet" stage).
  You can't find a group you're not in; non-member endpoints 404.
- **Consent to join.** Invite → accept, not silent add — you choose to be in a
  group, the same way a connection is a request you approve. No one can drop you
  into a group without your say-so.
- **You can only invite your own connections.** Adding is gated on
  `can_add_to_group` (invitee is the inviter's connection, not blocked). This
  keeps the "no cold contact from strangers" rule at the point of entry: you pull
  in people *you* already have a relationship with. (Note the deliberate
  consequence: once in a group, members who aren't connected to *each other* can
  see each other's group posts — that's the nature of a shared space, and it's why
  in-group visibility is membership-scoped, not connection-scoped.)
- **Blocking.** You can't invite, or be invited by, someone you've blocked or who
  has blocked you (either direction). **Open edge case to decide when we build:** what happens to an
  existing co-membership if two members later block each other — hide their posts
  from each other inside the group, force one out, or leave it (documented) as a
  known limitation? Recommend: leave it as a documented limitation for v1 (block
  still cuts off DMs and connecting); revisit if it actually bites.
- **Comment visibility inside a group is membership-scoped, not
  connection-scoped** — every member sees every comment. This is correct for a
  shared space, but it *is* a different rule from personal posts, so it's called
  out here and enforced in one place (`PostCommentsView`'s group branch).
- **Not end-to-end encrypted** (same as all app data — see the Phase 5 note).
  Group posts/comments are readable by the maintainer via the Django admin.
- **Account deletion** (a Phase 7 concern) must cascade to memberships and group
  posts; the last-admin-leaving case interacts with this — note for Phase 7.

## Decisions (recommended — confirm before building)

- **Group posts stay in the group, not the home feed** (decision 1 above). The
  single biggest design choice; everything downstream assumes it.
- **Two roles, admin/member; creator is admin; ≥1 admin always** (decision 2).
- **Invite → accept** for joining (consent-first, mirrors connection requests).
- **Any member can invite, but only their own connections** (confirmed with user,
  2026-07-06). Friendlier for a family/friends group than admin-only, while still
  keeping the "no cold contact from strangers" rule — you can only pull in people
  *you* already have a relationship with. Removing members stays **admin-only**.
- **Extend `Post` with a nullable `group` FK** rather than a separate model, and
  **extend `POST /api/posts/`** with an optional `group` rather than a new create
  endpoint — reuse over duplication.

## Resolved with the user (2026-07-06)

- **Group posts stay in the group**, not the home feed — confirmed.
- **Invite → accept** to join — confirmed.
- **Any member can invite their own connections** (not admin-only) — confirmed;
  differs from the first draft's admin-only recommendation. Removing members
  stays admin-only.
- **Promote/demote included in v1** (≥1 admin always) — confirmed.

## Open questions still to resolve while building

- Blocked-users-already-co-members edge case (see safety notes) — recommend
  "documented limitation for v1"; confirm when we hit it.
- Optional group avatar in v1, or defer to keep the first cut lean? (Cheap —
  reuses the imaging pipeline — but skippable.)

## Handoff to Phase 6a (group messaging)

`GroupMembership` (participant set + roles + active/invited status) is exactly
what 6a's group *conversations* build on. The open 6a question — are group
threads **ad-hoc** (any set of connected users) or **tied to a group's
membership** (or both) — is decided against this model in 6a, not here. The
`status`/participant shape from Phase 5's `ConversationRead` was already chosen to
generalise from 1:1 to N participants; this phase adds the group *membership* side
of that story. "Leave a conversation" ships in 6a alongside "leave a group" here.

## Notes / decisions log

- **Fleshed out from sketch (2026-07-06)**, then built the same day on branch
  `phase-6-groups`. The four confirmed decisions (group posts stay in the group,
  invite→accept, any member invites their own connections, promote/demote in v1)
  all shipped as planned.
- **Opt-in "include groups" feed toggle (added mid-build at the user's
  request).** A checkbox on the feed (remembered per-browser in `localStorage`)
  drives `?include_groups=1`, backed by `feed_posts(user, include_groups)` in
  `api/views.py` — one unified queryset (personal posts `OR` posts from groups
  you're in), still `-created_at` ordered, so pagination stays stable and there's
  no ranking. `PostSerializer.group` became `{id, name}` (was a bare id) so the
  feed can label a merged post "in &lt;group&gt;"; `PostCard` renders that label.
- **`Post.group` is one nullable FK, reused end-to-end.** Group posts go through
  the *same* `POST /api/posts/` (now taking an optional `group`, membership-checked
  in the view) and the same `PostImage`/`Comment`/serializer/imaging paths — no
  parallel model. `visible_posts` gained `group__isnull=True` so the home feed
  *and* profiles show personal posts only.
- **`PostCommentsView` branches on `post.group_id`.** Group post → members-only,
  and the tree is built with every present author marked visible (no
  connection-pruning), so all members see all comments; personal post → unchanged
  connection-pruned tree. Non-members 404 on read and write.
- **Membership gates live in small helpers** (`group_role`, `is_group_member`,
  `is_group_admin`, `can_add_to_group`) mirroring Phase 5's `can_message`, so the
  member/admin/invite rules can't drift across views. `can_add_to_group` reuses
  `connected_user_ids` + `is_blocked_between` — invites are connection-gated and
  blocked-safe, exactly like messaging.
- **Non-members get 404 everywhere** (detail, timeline, members, comments) so a
  private group's existence isn't leaked — same discipline as a non-connection's
  profile.
- **Groups list moved from a page to a left companion drawer (post-Phase-6 UX
  change, 2026-07-06, at the user's request).** It's the mirror image of the
  Phase 5 messages drawer (docked right): a non-modal panel docked to the *left*
  edge, driven by `GroupsDrawerProvider`/`useGroupsDrawer` (`groups-drawer.jsx`,
  open/closed only — no sub-views) with a nav "Groups" toggle, portalled to
  `<body>` so it docks to the viewport edge over the centred column. It's a
  *switcher*, not a reading surface: picking a group closes the drawer and
  navigates the main column to the existing full-width `/g/:id` timeline — so the
  group feed isn't squeezed into 400px beside the home feed (the deciding factor
  vs. rendering the timeline inside the drawer like messages). `GroupsPage` was
  deleted; the old `/groups` URL now opens the drawer and redirects to `/` via
  `GroupsRoute` (mirroring `MessagesRoute`). The group-invites nav badge moved
  onto the toggle unchanged. `GroupsDrawerProvider` takes an `initialOpen` prop
  used only by tests. See `components/GroupsDrawer.jsx`.
- **Last-admin guardrail** blocks leaving, being removed, or being demoted when
  you're the only admin (400) — a group can never be orphaned. Verified by an
  end-to-end HTTP smoke test alongside the create→invite→accept→post→feed flow.
- **`Group.creator` is `SET_NULL`** (not CASCADE) — a group outlives its
  creator's account; the ≥1-admin rule keeps it governable regardless.
- **Group avatar included in v1** (one of the open questions) — it reuses the
  user-avatar imaging pipeline (`process_image`, square thumb) with its own
  `group_avatar_upload_to` helpers, so it was cheap; deferring would only have
  meant a later migration.
- **Still open (documented limitations, as planned):** two members who block each
  other *after* both are in a group still see each other's group posts (block
  cuts DMs + connecting, not co-membership); an admin can't yet cancel a *pending*
  invite (the invitee can decline). Revisit if either bites.
