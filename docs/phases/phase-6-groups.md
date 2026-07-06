# Phase 6 — Groups

**Status:** not started — sketch only, refine before starting

> **Followed by Phase 6a — Group Messaging** (`phase-6a-group-messaging.md`):
> group *chat* is deliberately a sub-phase after groups, extending Phase 5's 1:1
> direct messaging. Keep that in mind when designing the group membership model
> here — 6a will build on it.

## Goal

Let users create and join **groups** with their own shared, reverse-chronological
timeline — e.g. a family group, a friend circle, a shared-interest group.

## Runnable product at the end of this phase

A user can create a group, invite/add members, post into the group's timeline,
and see a chronological feed scoped to that group.

## Likely definition of done (refine when we start)

- [ ] `Group` + `GroupMembership` tables via migrations
- [ ] Create a group; add/remove members; leave a group
- [ ] Group timeline: posts scoped to the group, reverse-chronological
- [ ] Group visibility model (private/invite-only to start — matches the
      privacy-first principle)
- [ ] Permissions: who can post, who can add members, who can delete the group

## Open questions to resolve before starting

- Do group posts also appear in members' main feeds, or stay inside the group?
- Roles (admin vs. member) — how simple can we keep it at first?

## Notes / decisions log

(Record deviations/gotchas here.)
