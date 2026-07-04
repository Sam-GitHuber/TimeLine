# CLAUDE.md

Instructions for Claude Code when working in this repo.

## Current status

**Phase 1 (wireframe) — done. The React/Vite frontend is a clickable timeline
wireframe on mock data: reverse-chronological feed, working compose box, and
per-user profile pages, with react-router navigation and a Vitest suite
(`npm test`). Phase 2 (accounts & auth) is next.** Keep this line current:
update it whenever a phase starts or finishes, but keep the detail in the phase
docs, not here.

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
- Every phase already has a doc in `docs/phases/`. Phases 0–5 are detailed;
  phases 6–10 are marked "sketch only" — flesh those out into a full plan
  (definition of done, steps) *before* starting work on them, following the
  pattern of the detailed phase files, and confirm the plan with the user.
- Keep this file small and stable — it loads into every session's context.
  It should stay a short pointer to the docs, not a copy of them. Put stack
  details in `docs/SHARED.md` and phase details in `docs/phases/`; only the
  "Current status" line above changes often.
