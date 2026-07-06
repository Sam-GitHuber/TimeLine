# Phase 6a — Group Messaging

**Status:** not started — sketch only, refine before starting

A sub-phase that lands **after Phase 6 (groups)**: extend the 1:1 direct
messaging from Phase 5 into **group conversations**. Deliberately sequenced here
(not folded into Phase 5) so the 1:1 case ships simple first, and so group
threads can build on the group model from Phase 6.

## Goal

Let several connected users (or the members of a group) hold a shared
chronological conversation — the same messaging experience as Phase 5, but with
more than two participants. Still no algorithm; messages are time-ordered.

## Runnable product at the end of this phase

A user can start a group conversation with several people, everyone sees
messages in order (near-real-time via polling, as in Phase 5), and a member can
**leave** the conversation.

## Likely definition of done (refine when we start)

- [ ] Group conversations: 3+ participants, built on the Phase 5 model
- [ ] Create a group conversation; add participants (within the connection/
      group rules); view the thread oldest-first
- [ ] **Leave a conversation** (the piece deferred from Phase 5)
- [ ] Per-member unread counts still work (the `ConversationRead` table from
      Phase 5 was shaped for this)
- [ ] Sensible group-safety behaviour (who can add whom; blocked users)
- [ ] Tests both sides

## Why this is an extension, not a rewrite

Phase 5's data model was chosen with this in mind:

- **Participants as their own concept.** The 1:1 `Conversation` (symmetric pair)
  generalises to a participant set; `ConversationRead` (`conversation, user,
  last_read_at`) already gives per-member unread without change.
- **Messages** already hang off a `conversation`, so a group thread is the same
  `Message` table with more participants.
- **Delete-your-own-message** carries over; **"delete for everyone" vs "for me"**
  gets its group nuance here.

## Open questions to resolve before starting

- Are group conversations **ad-hoc** (any set of connected users) or tied to a
  **Phase 6 group's membership** (or both)? Decide against the Phase 6 model.
- Who can add/remove participants — creator only, or anyone in it?
- Real-time: still polling (Phase 5 default), or revisit WebSockets by now?

## Notes / decisions log

- **Sequenced after Phase 6, split out of Phase 5 (confirmed 2026-07-06).** Keeps
  Phase 5 to a simple, shippable 1:1 MVP; group chat design can then lean on the
  group model. See `docs/phases/phase-5-messaging.md` for the shared messaging
  foundation and the E2E-encryption long-term goal.
