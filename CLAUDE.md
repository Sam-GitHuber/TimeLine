# CLAUDE.md

Instructions for Claude Code when working in this repo.

## Current status

**Phases 0–8b are done** (0–7b are live on the box; Phase 8 and 8b are
code-complete — merge + continuous-deploy carries them to the box). The app is
deployed on a wiped home PC and reachable on public HTTPS at
https://your-timeline.net — real friends/family can be invited. Shipped:
accounts/auth, the reverse-chronological feed, photos + profiles, the symmetric
connection graph + pruned comment trees, direct + group messaging, groups, emoji
reactions, the unified **notifications / activity centre**, **group events + a
planning calendar** (advisory polls, month grid, personal `/calendar`), and full
home-server productionisation (backups, continuous deploy, security hardening,
uptime monitoring, ToS/privacy + account deletion). A site-wide **design system**
underpins the frontend (warm-modern "living line" look — see
`docs/design-system.md`).

**How each shipped feature works lives in `docs/reference/`** — one topic doc each
(accounts, feed-and-posts, connections, messaging, groups, reactions,
notifications, events), plus the ops runbooks `docs/deploy.md` and
`docs/backup-restore.md`. Read the relevant one before changing a feature; it has
the data model, endpoints, and the *why*.

**Phase 9 (iPhone app) is in progress — Milestones A–D are done.** The Expo app
in `mobile/` logs in against the real backend (bearer tokens + silent refresh),
and has the feed, compose, post detail, profiles, and **working push
notifications** — verified end to end on a real iPhone on 2026-07-21 (delivery,
cold-start delivery, deep-link taps, and preference gating all confirmed with a
real second person).

**Milestone E (parity fill-in) is complete** — all four chunks shipped: E1
connections/people, E2 messaging, E3 groups + events, E4 settings + safety
(report + block, settings, and the activity centre). Every web feature is now
present in the app. **Milestone F (TestFlight) is done — Phase 9 has shipped.**
The app is live in **external TestFlight beta** with real testers (brand icon +
launch screen included); a friend has downloaded and is using it, with the
admin-approval gate intact. **How to build and ship a new app version lives in
[`docs/mobile-release.md`](docs/mobile-release.md)** — read it before any app
release. Remaining housekeeping (not blocking): distil `phase-9-iphone-app.md`
into `docs/reference/` mobile docs and delete it, per the phase-ships convention
(the release half already lives in `mobile-release.md`).

**Phase 9b — the messaging overhaul — is in progress; M0–M8 are done.**
It came off the first real beta feedback (no way to edit a message) and brings
messaging up to the standard of a high-end messaging app: a long-press action
menu, edit, reply, message reactions, read receipts + send status, thread
mechanics, photos, then web parity. Shipped so far: the admin can no longer read
anyone's messages (a report is the only window); the app has an anchored
long-press menu with Copy/Edit/Delete/Report plus a 15-minute edit window;
messages can be reacted to with any emoji; **reply threads** — Reply in the
long-press menu opens a focused strand that blurs the transcript and brings the
whole back-and-forth forward (mobile only until M9); and **optimistic send +
read receipts** — a message appears instantly with a clock, a failed send keeps
its place with Retry, and your own bubbles carry sent/read ticks governed by a
symmetric `send_read_receipts` setting (the toggle is on both clients; the ticks
are mobile-only until M9); and **thread mechanics** — the transcript now opens on
one page and pages history in as you scroll up (it used to load a chat's *entire*
history), with day separators, clock times, grouped runs, an unread divider,
jump-to-latest, tappable links, large emoji-only messages and per-chat drafts;
and **the conversation list + a thread info screen** — rows swipe for
mute/mark-unread/leave, the list searches by name, and Mute/Add/Leave moved off
the cramped thread header into `/messages/[id]/info`, which also renames a group
chat; and **photo messages** — send from the camera or the library, with or
without a caption, tap to view full-screen, plus the media gallery M6 left
behind. Chat photos are resized and EXIF-stripped **on the phone**, not the
server, so the pipeline survives E2E — read `messaging.md`'s *Photo messages*
before touching them; and **text, mentions & quick actions** — `*bold*`/
`_italic_`/`~strike~`/`` `mono` `` render at draw time (the stored text keeps its
markup), `@mentions` in a group notify **through a muted thread** unless you turn
that override off, several messages can be selected for one Copy/Delete, and a
message push can be **replied to from the notification** (built and unit-tested;
the on-device pass is the one M8 item still outstanding, since it needs a
TestFlight build). **M9 (web parity) is in progress** — the big one: every
mobile-only feature above lands on the web. It's split into **six PRs, M9a–M9f**,
each written up in the phase doc to be picked up cold. **M9a and M9b are done**:
the 602-line `MessagesDrawer.jsx` is now a shell over
`frontend/src/components/messages/` (a pure code move), and the web transcript
has caught up with the app's — one page on open with older messages paging in as
you scroll back (it used to load a chat's *entire* history), day separators,
clock times, run grouping, a latched unread divider, jump-to-latest, clickable
links, big emoji, per-chat drafts, and a `⋯` menu on hover carrying
Copy/Edit/Delete or Copy/Report. **The `⋯` stays visible under
`@media (hover: none)`** — the drawer is read in phone browsers, and a hover-only
affordance would hide every message action from them; read `messaging.md`'s
*The web transcript* before touching it, the rule is a cascade trap.
Full plan in [`docs/phases/phase-9b-messaging-overhaul.md`](docs/phases/phase-9b-messaging-overhaul.md)
— read it before touching messaging. Its milestones are written to be picked up
cold by a fresh session; follow the "How to use this document" section at the top.
**E2E encryption is a committed goal**, sketched as
[`docs/phases/phase-9c-e2e-encryption.md`](docs/phases/phase-9c-e2e-encryption.md);
three 9b decisions are already shaped by it, so read 9b's *Privacy* section
before making messaging design calls.

Push specifics live in [`docs/reference/notifications.md`](docs/reference/notifications.md);
release/build steps live in `docs/mobile-release.md`; everything else Phase 9 is
still in `docs/phases/phase-9-iphone-app.md`, which gets distilled into reference
docs and deleted when the phase ships. Later phases (10 Android → 13 short video
clips) remain sketches in `docs/phases/`.

## Before doing any work

1. Read `docs/SHARED.md` first — project mission, non-negotiable principles
   (reverse-chronological only, no ads/algorithm, privacy-first), the tech stack,
   repo conventions, and codebase layout. Don't introduce a different
   stack/library without raising it with the user first.
2. For a change to an existing feature, read its `docs/reference/` doc. For new
   work, check `docs/phases/` for the current phase's "Definition of done" — work
   should map to that phase's scope; don't pull later-phase features in early.
3. The user is new to web/backend/frontend development and hosting. Explain
   *why*, not just *what*, and prefer well-trodden, boring solutions over
   clever ones. Flag security/privacy implications explicitly since this app
   holds real friends'/family's data — don't let that slide because it's
   "just a small private project."

## While working

- **When you finish or materially change a shipped feature, update its
  `docs/reference/` topic doc** (data model, endpoints, and the *why* of any
  non-obvious decision) — that's the durable reference. Don't reintroduce
  per-phase status logs; git history is the changelog.
- **Future phases (9–13) each have a plan in `docs/phases/`.** They're all
  sketches — flesh a sketch into a full plan (definition
  of done, steps) and confirm it with the user *before* starting. When a phase
  ships, distil its plan into a `docs/reference/` doc and delete the phase file.
- When a feature spans topics, cross-link the reference docs rather than
  duplicating (e.g. visibility rules live in `connections.md`; messaging/groups
  link to it).
- Keep this file small and stable — it loads into every session's context. It's
  a short pointer to the docs, not a copy of them. Stack details live in
  `docs/SHARED.md`, feature details in `docs/reference/`, future plans in
  `docs/phases/`; only the "Current status" section above changes often.
