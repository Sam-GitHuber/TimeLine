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

Phase 4 (photos & profiles) is next.** Keep this line current: update it
whenever a phase starts or finishes, but keep the detail in the phase docs, not
here.

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
- Every phase already has a doc in `docs/phases/`. Phases 0–4 and 7
  (productionisation) are detailed; the rest — 5 (messaging), 6 (groups), and
  8–10 — are marked "sketch only". Flesh those out into a full plan (definition
  of done, steps) *before* starting work on them, following the pattern of the
  detailed phase files, and confirm the plan with the user. (Messaging and
  groups were deliberately moved ahead of productionisation — see the "Why this
  order" note in `docs/SHARED.md`.)
- Keep this file small and stable — it loads into every session's context.
  It should stay a short pointer to the docs, not a copy of them. Put stack
  details in `docs/SHARED.md` and phase details in `docs/phases/`; only the
  "Current status" line above changes often.
