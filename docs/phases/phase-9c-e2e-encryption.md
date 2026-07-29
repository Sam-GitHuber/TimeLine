# Phase 9c — End-to-End Encrypted Messaging

**Status: SKETCH.** Not a plan yet. Per the repo convention, flesh this into a
full plan — definition of done, milestones, steps — and **confirm it with the
user before writing any code.** Do not start from this file as-is.

**Prerequisite: Phase 9b (the messaging overhaul) — shipped 2026-07-29.** It
removed the admin's message window (the immediate concern), and three of its
decisions were made E2E-ready: reference-only reply quotes, client-side image
processing, and reactions knowingly left as plaintext metadata. Read
[`../reference/messaging.md`](../reference/messaging.md) → *Not end-to-end
encrypted (yet)* before making any design call here; it states those three and
what they cost to undo.

**Sequencing note (2026-07-29):** this phase is deliberately scheduled **after
Phase 10 (Android)** — there are friends waiting on an Android build. The cost of
that order is that E2E then has to land on three clients (iOS, Android, web)
rather than two; the work is larger, not harder.

## Why this phase exists

Stated goal, from the user: *"I'd like messages to be E2E encrypted. I'm not
really a fan of the fact I can see people's messages in the admin console."*

9b's M0 addresses the console. **This phase addresses the underlying fact**: the
messages are plaintext rows in Postgres, and anyone with server access — the
maintainer, an attacker who gets a shell, or anyone presenting a legal demand —
can read every private conversation in the app. E2E is the only thing that
changes that, and `../reference/messaging.md` has named it a long-term goal since
Phase 5.

## Be clear-eyed about the size of this

This is **comparable in scope to the entire iPhone app**, and it is the
highest-risk work in the project, because both failure modes are worse than the
status quo:

- **Lose the keys and the messages are gone.** Not "restore from backup" gone —
  mathematically gone. The backups contain ciphertext nobody can open.
- **Get it subtly wrong and you've shipped a promise you don't keep**, which is
  worse than today's honest "we store plaintext, and here's who can read it."

Neither is a reason not to do it. Both are reasons to do it deliberately, on a
proven protocol, with a fleshed plan — and never to hand-roll the cryptography.

## What E2E does and doesn't buy

**Does:** the server stores ciphertext it cannot read. Maintainer can't read
messages. A database dump is useless. A shell on the box doesn't yield message
content. A legal demand yields metadata only.

**Doesn't:** hide **metadata** — who talks to whom, how often, when, message
sizes, group membership. That remains readable server-side and is genuinely
sensitive. Say so in the privacy policy rather than letting "end-to-end
encrypted" imply more than it delivers. It also doesn't protect against a
compromised *device*, or against the other person screenshotting.

## The hard parts (in rough order of difficulty)

1. **Multi-device.** One person has an iPhone, maybe Android, and a browser. Each
   device needs its own key pair, and every message must be encrypted to every
   one of the recipient's devices. This is the part that makes E2E a phase rather
   than a feature.
2. **The web client.** Keys in the browser via WebCrypto (non-extractable) +
   IndexedDB is standard, but **the server serves the JavaScript** — so a
   compromised server can serve key-exfiltrating code, and the guarantee is only
   as strong as trust in the server we were trying to remove from the trust
   model. Real options: accept and document the weaker guarantee for web; make
   web read-only for encrypted threads; or drop web messaging. **This needs an
   explicit decision, and it's the most likely thing to change the product.**
3. **Group rekeying against our clique churn.** Group E2E needs the key rotated
   whenever membership changes, so a leaver can't read future messages. Our
   membership state machine (`messaging.md` → *Membership state machine*) churns
   constantly — promote on connection-accept, sever on disconnect/block,
   auto-return, leave/decline. **Every one of those transitions becomes a
   rekey.** Map them all before choosing a protocol.
4. **History on a new device.** With no key escrow, a fresh install can't read
   old messages. Users find this genuinely shocking. Options: encrypted backup
   behind a passphrase, device-to-device transfer, or accept and explain. The
   passphrase route means a lost passphrase = lost history, permanently.
5. **Abuse reporting.** The server can't verify a report about content it can't
   read, so a report must carry a client-attached plaintext excerpt. 9b's M0
   already moves reporting to that shape — build on it rather than reinventing.
6. **Key verification.** Without a way to compare safety numbers, the server can
   silently insert its own key and read everything. An unverifiable E2E system is
   theatre. Needs a real UI, however simple.

## What breaks in the product

| Breaks | Fix |
| --- | --- |
| Conversation-list previews (server computes them today) | Return the last message's ciphertext; client decrypts for the preview |
| Server-side message search | Never build it — 9b already avoids it |
| Push bodies | **Nothing to do** — they already never quote text, only the sender's name. The existing design is E2E-compatible |
| Read receipts | **Nothing to do** — metadata, not content |
| Reactions | 9b keeps them plaintext metadata by decision. Revisit here, but the case for encrypting a bare emoji is weak |
| Media | 9b already moves processing client-side; here the bytes get encrypted before upload |
| Admin moderation | Already report-only after 9b M0 |

## Approach

**Do not design a protocol.** Use a proven one:

- **libsignal** — the well-trodden option, solves multi-device and group sender
  keys, but bindings into React Native + a browser build are real work.
- **MLS (RFC 9420)** — designed for groups, better rekeying story, younger
  ecosystem.

Evaluate both against the group-churn map from hard part 3 before committing.
Whichever wins, the Django side becomes mostly **key distribution and opaque blob
storage**, which is a smaller backend change than it sounds — the interesting
work is nearly all client-side.

## Rough milestone shape (to be fleshed out)

1. Protocol choice + a written threat model, including the web decision.
2. Key infrastructure: per-device identity keys, prekeys, a distribution
   endpoint, device registration/revocation.
3. 1:1 encrypted messaging on iOS only, behind a flag, new threads only.
4. Key verification UI.
5. Group threads + rekeying on every membership transition.
6. Media.
7. Web (or the documented decision not to).
8. Migration: what happens to existing plaintext history. **Probably: leave it
   plaintext and encrypt from a cutover date**, since retro-encrypting needs keys
   for devices that didn't exist when the messages were sent. Needs a clear
   in-product explanation.
9. Privacy-policy rewrite — including what E2E does *not* cover (metadata).

## Open questions for the fleshing-out session

- **Web messaging under E2E: weaker guarantee, read-only, or dropped?** The
  biggest product decision in the phase.
- Existing plaintext history: cutover, or migrate?
- Key backup: passphrase-protected, device-transfer, or no recovery at all?
- Does this land before or after Phase 10 (Android)? Adding a second platform
  mid-E2E multiplies the multi-device work; doing E2E first means Android
  inherits it.
- Do we still need Phase 11's AWS migration under E2E? (Yes — but "the host
  can't read messages" changes the calculus about *where* the box lives, and
  that's worth a moment's thought.)

## Until this ships

`../reference/messaging.md` and `frontend/src/pages/legal/PrivacyPage.jsx` state
plainly that messages are stored in plaintext and are not end-to-end encrypted.
**That wording is correct and must stay until the encryption actually ships** —
including after 9b's M0, which narrows who looks without changing what's stored.
