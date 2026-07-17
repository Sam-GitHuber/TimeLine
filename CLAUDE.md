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

**Next up: Phase 9 (iPhone app).** Remaining planned work (9 iPhone → 13 short
video clips) lives as forward-looking plans in `docs/phases/`. The Phase 8
notification API was built push-ready (and the Phase 8b event kinds reuse it), so
the app phases add only the delivery channel (APNs/FCM), not a new notification
concept.

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
