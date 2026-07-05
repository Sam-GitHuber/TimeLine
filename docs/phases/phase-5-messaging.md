# Phase 5 — Direct Messaging

**Status:** not started — sketch only, refine before starting

## Goal

Add private one-to-one messaging between users, layered onto the timeline app
built in Phases 2–4. Still no algorithm anywhere — messages are simply
chronological conversations.

## Runnable product at the end of this phase

Two logged-in users can open a conversation, send messages back and forth, and
see them appear in order (ideally in near-real-time).

## Likely definition of done (refine when we start)

- [ ] `Conversation` + `Message` tables via migrations
- [ ] Send a message to another user; view a conversation thread (chronological)
- [ ] A list of your conversations
- [ ] Near-real-time delivery (WebSockets via Django Channels) OR simple
      polling to start — decide based on effort vs. payoff
- [ ] Unread indicator
- [ ] Basic abuse/safety consideration (e.g. block a user) — even at small scale

## Open questions to resolve before starting

- Real-time (WebSockets) now, or start with polling and upgrade later?
- Any message privacy expectations to document (retention, deletion)?

## Notes / decisions log

(Record deviations/gotchas here.)
