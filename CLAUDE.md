# CLAUDE.md

Instructions for Claude Code when working in this repo.

## Current status

**Phases 0–9b are done.** The app is deployed on a wiped home PC on public HTTPS
at https://your-timeline.net, and there is an **iOS app in external TestFlight
beta** with real testers. Shipped: accounts/auth, the reverse-chronological feed,
photos + profiles, the symmetric connection graph + pruned comment trees, direct +
group messaging, groups, emoji reactions, the unified **notifications / activity
centre**, **group events + a planning calendar**, full home-server
productionisation (backups, continuous deploy, security hardening, uptime
monitoring, ToS/privacy + account deletion), the **iPhone app** (full parity +
push), and the **messaging overhaul** that brought messaging up to the standard of
a high-end messenger on both clients. A site-wide **design system** underpins the
frontend (warm-modern "living line" look — see `docs/design-system.md`).

**How each shipped feature works lives in `docs/reference/`** — one topic doc each
(accounts, feed-and-posts, connections, messaging, groups, reactions,
notifications, events, mobile-app), plus the runbooks `docs/deploy.md`,
`docs/backup-restore.md` and `docs/mobile-release.md`. **Read the relevant one
before changing a feature** — it has the data model, endpoints, and the *why*.
Two that are easy to skip and shouldn't be: `messaging.md` is large and its
*Frontend* / *Mobile* sections are the record of the finished clients, and
`mobile-release.md` is required reading before any app release.

**Next up: Phase 10 (Android).** Because the app is Expo, Android adds no new
screens — the work is toolchain, FCM credentials, notification channels, the back
button, and Android-only layout bugs. **E2E encryption (9c) is deliberately
scheduled after Android**, at the user's call: friends are waiting on an Android
build. Phases 11–13 (AWS migration → short video clips) remain sketches in
`docs/phases/`.

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
- **Future phases (10–13) each have a plan in `docs/phases/`.** They're all
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
