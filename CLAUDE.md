# CLAUDE.md

Instructions for Claude Code when working in this repo.

## Current status

**Phase 3 (MVP timeline) — implemented. `Post` and `Follow` models (in the
`api` app) back a reverse-chronological feed: `GET /api/feed/` returns your own
posts plus those of everyone you follow, newest-first and paginated. Endpoints
to create a post, follow/unfollow, list people, and view a profile's posts. The
React app is off Phase 1's mock data and onto the real API via TanStack Query —
feed with compose box + "Load more", a People page, and profile pages keyed on
user id (`/u/:id`, no username). Author labels come from `User.display_name`
(real name, else email local-part — no emails leaked between members).
Accounts are private-by-default: a follow is a request the requestee approves
(`Follow.status` pending→accepted); feed and profile posts are both gated on an
accepted follow. There's a Requests inbox (nav badge) to approve/reject.
Backend + frontend test suites cover feed ordering, follow-scoping, and the
request/approval flow.

Phase 3a (connections & comments) — done. The one-directional follow is now a
symmetric *connection* (`Connection` model; approving a request connects both
accounts so each sees the other — no one-way follow), backed by
`connected_user_ids` (accepted rows either direction) feeding feed + profile.
Endpoints: `POST/DELETE /api/users/<id>/connect/`, `GET
/api/connection-requests/` + approve/reject; requesting someone who already
asked you auto-accepts. Posts have a threaded `Comment` tree
(`GET/POST /api/posts/<id>/comments/`) served pre-pruned to the connection
boundary — you only see comments/replies from people you're connected with, and
a not-connected author's comment takes its whole subtree with it. Frontend:
Connect/Requested/Connected(+Approve) button, "Connection requests" inbox,
collapsible comment thread on each post. See
`docs/phases/phase-3a-connections-comments.md`.

A site-wide **design system** now underpins the frontend (done before Phase 4 so
later phases don't trigger a redesign): a warm-modern "living line" look —
token-first via Tailwind v4 `@theme`, self-hosted fonts (Bricolage Grotesque /
Hanken Grotesk / IBM Plex Mono), a single emerald-teal accent, and a literal
timeline spine down the feed (`components/Timeline.jsx`). Build new UI from these
tokens — see `docs/design-system.md`.

Phase 4 (photos & profiles) — done. Posts carry **photos** (`PostImage` table,
many per post) uploaded as multipart to `POST /api/posts/`; the feed/profile
embed each as `{image, thumbnail, width, height}`. Users have **avatar + bio**
and edit their own name/avatar/bio at `/settings` (rides dj-rest-auth's
`PATCH /api/auth/user/`). **Real name is now collected at sign-up** (required
first/last), so every account has a display name from day one. All image
handling funnels through `api/imaging.py`: validate-by-decoding (SVG rejected),
strip EXIF/GPS, size/count caps, downscale + thumbnail. Media goes through
**`django-storages`** — local disk now, an S3 bucket at Phase 7b by config
(`STORAGES` seam on `DJANGO_MEDIA_STORAGE`); dev serves `/media/` openly, real
private/signed media is a Phase 7b task. Profile URLs stay numeric (`/u/:id`) —
name-based slugs deferred. See `docs/phases/phase-4-photos-profiles.md`.

Phase 5 (direct messaging) — done. Private 1:1 messaging between **connected**
users: `Conversation`/`Message`/`ConversationRead`/`Block` models (in the `api`
app) back get-or-create conversations (`POST /api/conversations/`, connection-
gated), a thread served oldest-first + paginated
(`GET/POST /api/conversations/<id>/messages/`), soft-delete your own message,
per-conversation + total-nav unread counts (`ConversationRead` marker +
`/api/messages/unread-count/`, cleared via `.../read/`), and **blocking** (either
direction hides the thread, stops messaging, severs + bars connecting). A shared
`can_message(me, other)` gate (active + connected + not blocked) drives both
create and send. Near-real-time is **polling** (TanStack Query `refetchInterval`;
cadence in `frontend/src/api.js`) — the swap to Channels later is non-breaking.
Frontend: messaging is a **non-modal companion drawer** (`MessagesDrawer.jsx`,
driven by `MessagingProvider` — not a route), docked to the edge so the feed
stays scrollable behind it; it walks list → thread → new-message (compose +
connection picker in-panel), with a nav "Messages" toggle + unread badge and
Message/Block controls on connected profiles. Legacy `/messages[/:id]` URLs open
the drawer; a catch-all route avoids blank screens. Backend + frontend tests
cover send/scope/read/block. See `docs/phases/phase-5-messaging.md`.

Phase 6 (groups) — done. Private/invite-only shared timelines: a nullable
`Post.group` FK reuses all post machinery (photos, comments, serializer, imaging);
`Group`/`GroupMembership` models back create/edit/delete, invite→accept membership
(any member invites their own connections; group-invites inbox + nav badge),
member-gated group timelines, admin-only remove/delete + promote/demote with a
last-admin guardrail, and membership-scoped (not connection-pruned) group
comments. Group posts stay *out* of the home feed by default, with an **opt-in
"include groups" toggle** that merges them in chronologically (labelled "in
&lt;group&gt;"). Small membership helpers (`group_role`/`is_group_member`/
`is_group_admin`/`can_add_to_group`) mirror Phase 5's gates. Backend + frontend
tests pass. See `docs/phases/phase-6-groups.md`.

Phase 6a (group messaging) — done. Phase 5's pair-shaped `Conversation`
generalised to an N-participant set via new `Participant` + `ParticipantInterval`
tables (kept additive — `user_a`/`user_b` made nullable, so Phase 5 stayed green;
`0008` schema + `0009` backfill). A small event-driven membership state machine
holds the **clique invariant** (every active participant is mutually connected):
invitees land `pending` and `promote` one-at-a-time once connected to all actives;
disconnect/block `sever`s the *initiator* to pending (with a warning modal listing
the chats they'll leave) and auto-returns them on reconnect; leaving a `Group`
drops you from its chats. History is **interval-clipped** — you never see messages
sent while you were pending/away, but keep everything from before. Endpoints
extend Phase 5: `POST /api/conversations/` takes `participant_ids`(+`title`/
`group_id`); `.../participants/` (add), `.../leave/` (leave/decline),
`users/<id>/disconnect-impact/`. `can_message`→`can_send` in the payload; unread
(per-thread + nav badge) counts the interval-clipped set. Frontend extends the
companion drawer: multi-select `NewChatPicker`, group thread header + add/leave,
locked `PendingChatPanel`, `DisconnectWarningModal`, and a "Start a chat" entry on
the group page. Polling unchanged. A dev-only `seed_demo` management command
rebuilds a full demo world. Backend 147 + frontend 98 tests pass. See
`docs/phases/phase-6a-group-messaging.md`.

**Phase 7 (self-hosted home-server beta) — in progress; the app is LIVE on
public HTTPS.** As of 2026-07-10 it's deployed on the wiped home PC and reachable
from outside at https://your-timeline.net (Caddy + Let's Encrypt, verified on
mobile data): prod compose on the box, reboot-survival proven, Postgres+media on
the 1 TB NVMe (`/srv/timeline`), DHCP reservation, Cloudflare DDNS, ports 80/443
forwarded, secure cookies, `deploy/deploy.sh` + `docs/deploy.md` runbook. 10/15
DoD done. **Nightly off-box backups are LIVE** (encrypted to Cloudflare R2 via
`rclone crypt`, systemd timer) with a **restore tested on the box** (DB counts
matched, media restored byte-for-byte) — see `docs/backup-restore.md`.
**`/security-review` done (2026-07-11): full-app review, no HIGH; three gaps fixed
— uploaded media now auth-gated (Caddy `forward_auth` → `/api/media-auth/`,
logged-in active members only), Django `/admin/` restricted to the LAN (fail-closed),
and sign-up account-enumeration closed. Pending merge + on-box verification (media
loads in-session / 401s out; admin 403s from mobile data). Remaining (priority
order): ToS/privacy + delete-my-data → CI auto-deploy (pull/GHCR), uptime
monitoring, cost note.** Hard gate: no real invites until ToS/privacy are done. See
`docs/phases/phase-7-productionisation.md` (top has a "RESUME HERE" block) and
`docs/deploy.md`.

Keep this line current: update it whenever a phase starts or finishes, but keep
the detail in the phase docs, not here.

## Before doing any work

1. Read `docs/SHARED.md` first — it has the project mission, non-negotiable
   principles (reverse-chronological only, no ads/algorithm, privacy-first),
   the chosen tech stack, and repo conventions. Don't suggest or introduce a
   different stack/library without raising it with the user first.
2. Check `docs/phases/` for the phase currently being worked on and its
   "Definition of done" checklist. Work should map to the current phase's
   scope — don't pull in later-phase features early.
3. The user is new to web/backend/frontend development and hosting. Explain
   *why*, not just *what*, and prefer well-trodden, boring solutions over
   clever ones. Flag security/privacy implications explicitly since this app
   will hold real friends'/family's data — don't let that slide because it's
   "just a small private project."

## While working

- Update the relevant `docs/phases/phase-N-*.md` checklist as steps are
  completed, and add anything non-obvious to that file's "Notes / decisions
  log" section.
- When a phase is finished, mark its status as done in that file.
- Every phase already has a doc in `docs/phases/`. Phases 0–4 and 7 are
  detailed (productionisation is split into **7 — self-hosted home-server beta**
  and **7b — migrate to AWS**, both detailed); the rest — 5 (messaging), 6
  (groups), and 8–10 — are marked "sketch only". Flesh those out into a full plan (definition
  of done, steps) *before* starting work on them, following the pattern of the
  detailed phase files, and confirm the plan with the user. (Messaging and
  groups were deliberately moved ahead of productionisation — see the "Why this
  order" note in `docs/SHARED.md`.)
- Keep this file small and stable — it loads into every session's context.
  It should stay a short pointer to the docs, not a copy of them. Put stack
  details in `docs/SHARED.md` and phase details in `docs/phases/`; only the
  "Current status" line above changes often.
