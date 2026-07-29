# Phase 9b — Messaging Overhaul

**Status:** planned, not started. Written 2026-07-25 off a real user report:
*"there's no way to edit messages to correct spelling mistakes."*

**Why "9b" and not "14".** The number says *when*, not *what*. This is the next
thing we build — after the iPhone app (9), before Android (10) — so it sits with
the neighbouring phase, the same way 6a bolted group chat onto messaging and 7b
bolted reactions onto the beta. It ships into
[`../reference/messaging.md`](../reference/messaging.md) and this file is deleted,
per the phase-ships convention.

---

## How to use this document

**Each milestone below is written to be picked up cold by a fresh session that
has never seen this project.** Every one carries its own *Read first*, *Files*,
*Build*, *Test*, and *Done when* — so a session only needs this file, the
milestone, and the docs the milestone names. Nothing in a milestone depends on
knowledge from a previous session's conversation.

**Session boot sequence** (do this every time, it takes two minutes):

1. Read `CLAUDE.md` and [`../SHARED.md`](../SHARED.md) — the standing rules.
2. Read [`../reference/messaging.md`](../reference/messaging.md) — the data
   model, the safety gate, interval clipping. **Everything below is constrained
   by it.**
3. Read the **Privacy** and **Real-time** sections of *this* file. They set
   constraints that several milestones silently obey, and a session that skips
   them will make a wrong call and not know it.
4. Read the milestone you're doing, top to bottom, before writing any code.
5. Check **Progress** below to confirm the milestone's dependencies are done —
   and if it disagrees with `git log`, **trust git**.

**Standing rules for every milestone** (so they aren't repeated eight times):

- **Branch + PR, never commit to `main`.** Branch name is given per milestone.
- **Bring the stack up with `docker compose up --build`** — never a plain `up`.
  Add `--renew-anon-volumes` when you change a dependency.
- **Tests are not optional.** Backend `backend/api/tests.py`; mobile
  `mobile/src/__tests__/*.test.tsx` (`npm test`); web tests sit beside the
  component as `*.test.jsx`. In mobile tests, **`await fireEvent`** whenever a
  later assertion depends on state that event set — otherwise the update never
  flushes and the test silently passes on stale output.
- **Update [`../reference/messaging.md`](../reference/messaging.md) in the same
  PR as the code**, not at the end of the phase. Each milestone names the section
  to write.
- **Every migration here is additive** (nullable column, new table, widened
  constraint) except the one flagged in M0. There are real messages in the
  database — **take a backup before deploying**
  ([`../backup-restore.md`](../backup-restore.md)).
- The box deploys **only on publishing a GitHub Release**; merging to `main` does
  not deploy. The app ships separately via TestFlight
  ([`../mobile-release.md`](../mobile-release.md)).

## Progress

Tick as each merges. If this table and `git log` disagree, git is right.

| | Milestone | Depends on | Size | Done |
|---|---|---|---|---|
| **M0** | Close the admin message window | — | **S** | ☑ |
| **M1** | Long-press menu + edit | — | **S–M** | ☑ |
| **M2** | Message reactions | M1 | **S** | ☑ |
| **M3** | Reply threads | M1 | **M–L** | ☑ |
| **M4** | Send status + read receipts | — | **M** | ☑ |
| **M5** | Thread mechanics | — (do before M7) | **M–L** | ☑ |
| **M6** | Conversation list + thread info | — | **M** | ☑ |
| **M7** | Photo messages | M5 | **L** | ☑ |
| **M8** | Text, mentions & quick actions | M1 | **M** | ☑ |
| **M9** | Web parity | M1–M8 | **L** | ☐ |

M0/M1 first. After that only the listed dependencies bind — M4, M5, M6 and M8 can
be done in any order. **M6's media gallery is the one piece left behind**: it
needs M7's photos, so build it as part of M7 rather than reopening M6. *(Done —
it shipped with M7.)*

---

## Goal

Messaging is the part of TimeLine people compare against something they already
use every day. The feed can be deliberately different — that's the product. A
messenger can't be: if it's missing the affordances muscle memory expects,
"missing" reads as "broken."

The bar is **as good as any high-end messaging app**: long-press a bubble for a
menu, reply into a thread, react with an emoji, edit a typo, see when it was read.
These are conventions the whole category has converged on, and users arrive
already knowing them. We match that *interaction grammar* while keeping our own
data model, our safety gate, and our own look
([`../design-system.md`](../design-system.md)) — meeting a standard, not cloning
a product.

*(This doc deliberately doesn't name competitor apps. Where it says "the standard
pattern" or "what people expect," that's the convention shared across mainstream
messengers — open two or three on your phone before building a milestone; it's
faster than any description here.)*

## What we are deliberately **not** building

Stated up front, because "as good as the big messengers" is otherwise unbounded.

| Not doing | Why |
| --- | --- |
| **Typing indicators / "online" / "last seen"** | Presence is a surveillance feature with a much worse value-to-creepiness ratio than read receipts, and on polling it needs a write per keystroke-ish plus a poll to read it. Revisit only alongside real-time. |
| **Forwarding** | It's the mechanic that makes chain messages and misinformation move. We're a friends-and-family app; nobody needs one-tap broadcast. Copy + paste still exists. |
| **Ephemeral broadcast ("stories"/"status")** | A different product. We have a timeline. |
| **Disappearing messages** | Sounds privacy-first, isn't: it implies a deletion guarantee we can't make (server reads plaintext, backups exist, screenshots exist). Promising it would be dishonest. |
| **Starred messages, archive, chat wallpaper** | Real features, low value at family scale. Cheap to add later if anyone asks. |
| **Link previews** | The server would fetch every URL anyone pastes — a tracking leak and an SSRF surface, for a thumbnail. |
| **Voice notes, calls** | Separate phases with real infra (media pipeline, WebRTC). Not this. |
| **Server-side message search** | Dies under E2E anyway (see Privacy). Don't build toward it. |
| **Stickers / GIF search** | GIF search means a third-party API on every keystroke — a tracker in the composer, straight against the privacy principle. Emoji and photos cover the need. |
| **Video in chat** | Not "never" — it's **Phase 13** (`phase-13-video-clips.md`), which builds the whole video pipeline. M7 lays the attachment groundwork it will reuse. |
| **A "delivered" tick** | The category shows sending → sent → **delivered** → read; we do three states, not four. Delivery means a device acknowledged receipt, and with polling + push nothing reports that. Faking it from the push receipt would be a lie with a tick on it. Decided in M4, not overlooked. |

---

## Privacy: where E2E encryption fits, and what changes *now*

The user's stated goal: **messages should be end-to-end encrypted**, prompted by
a specific and entirely reasonable discomfort — *"I can see people's messages in
the admin console."*

Those are two different problems with two very different price tags, and it's
worth separating them, because one is fixable this week and one is a phase.

### The admin console is fixable now — that's M0

Right now `backend/api/admin.py` has a `MessageInline` on `ConversationAdmin`
that renders message text (`short_text`), and the class docstring cheerfully
documents this as deliberate. **That's the thing that actually bothers you, and
it isn't load-bearing** — it's a moderation convenience, and there's a better
design for moderation that doesn't involve browsing anyone's private thread.
**M0 removes it**, in about half a day, and gates content access behind an
explicit report. Do it first; it's the smallest change in this document and the
one that most directly answers what you asked.

Be clear about what M0 does and doesn't achieve. It removes **casual** access —
which is the honest risk here, because the realistic failure mode isn't a
determined attacker, it's a bored maintainer clicking through a thread they
shouldn't read. It does **not** stop someone with a shell on the box: the rows
are still plaintext in Postgres. That's real, and only E2E fixes it.

### Optional hardening: encrypting the message column at rest

Worth explicitly *not* overselling. Off-box backups are **already** encrypted
before they leave the house (`deploy/backup.sh`, rclone `crypt`), so the usual
headline benefit is already banked. Column encryption would additionally cover
locally staged dumps, direct `psql` access, and a stolen disk — but the key
would live in the environment **on the same box**, so anyone who can read the
database can almost certainly read the key too.

Verdict: **a modest, honest improvement, not a substitute for E2E, and not
recommended as a priority.** It also costs the one non-additive migration in this
phase (rewriting every existing row) and makes key loss equal permanent message
loss. If you want it, it's a small self-contained job — but M0 buys most of the
comfort for a fraction of the risk.

### Real E2E is its own phase — sketched as 9c

E2E means the server stores ciphertext it genuinely cannot read. It is
achievable and it is the right long-term goal. It is **not** a milestone here;
it's comparable in size to the entire iPhone app, and it's the highest-risk work
in the project, because the failure modes are *permanently unreadable messages*
and *a false sense of security* — both worse than the status quo. It needs
per-device keys, key exchange and verification, multi-device sync, group key
rotation on every membership change (and our clique state machine churns
membership a *lot*), and an answer for the web client that doesn't amount to
"trust the server that serves you the JavaScript."

Sketched separately in
[`phase-9c-e2e-encryption.md`](phase-9c-e2e-encryption.md). Flesh it out and
confirm it before starting, per the repo convention.

### Three decisions in *this* phase change because E2E is the goal

This is the practical payoff of deciding E2E now rather than later — it stops us
building things we'd have to demolish.

1. **M3 reply quotes: reference by ID, never embed text in the reply's payload.**
   A reply serializes its target as a bare `{ id }` — not the text, and not even
   the author; both come from the client's own copy or from a fetch through the
   interval-clipped messages endpoint, never from anything the server attached to
   the reply. Under E2E the server couldn't embed quote text even if we wanted it
   to, and refusing to embed it now removes the interval-clipping leak described
   in M3 entirely, because there's no server-side text to leak. Strictly better on
   both counts. **M3's *Visibility rule* section states the exact line** and why
   fetching through the clipped endpoint sits on the right side of it.
2. **M7 media: process images on the client, not the server.** Under E2E the
   server stores opaque bytes and cannot EXIF-strip or downscale them. Building
   M7 on the server-side `api/imaging.py` path would mean tearing it out later.
   `expo-image-manipulator` is already a dependency (the avatar cropper uses it)
   and the web has canvas, so this is available today. The server keeps enforcing
   byte-size and count limits, which work fine on opaque blobs.
3. **M2 reactions stay server-side plaintext — a knowing exception.** Encrypting
   them would kill server-side aggregation for very little gain: a bare emoji,
   detached from the message it's on, reveals close to nothing. Document it as a
   deliberate carve-out rather than letting a future session discover it and
   assume it was an oversight.

Two things need no change at all, which is worth knowing: **read receipts are
metadata** and survive E2E untouched, and **push bodies already never quote
message text** — the existing design is E2E-compatible as-is.

**Keep the privacy policy honest throughout.** `frontend/src/pages/legal/PrivacyPage.jsx`
currently states plainly that messages are plaintext and not end-to-end
encrypted. That wording is correct today. **It must not change until the
encryption actually ships** — M0 narrows *who looks*, not *what's stored*, so
after M0 the sentence still stands and should stay.

---

## Real-time: no, we're not leaving polling (yet)

Short answer: **polling stays for all of 9b.** Nothing in this phase needs
WebSockets, and E2E doesn't change the calculus either way — the two are
orthogonal.

The current cadences are `MESSAGE_POLL_MS = 4000` for an open thread and
`CONVERSATION_LIST_POLL_MS = 12000` for the list, in both
`mobile/src/api.ts` and `frontend/src/api.js`, and they pause when the app is
backgrounded.

**Why 4 seconds is fine, and getting better in this phase:**

- **Push already covers the case that matters.** When the app is closed, delivery
  is a push notification, not a poll — that's instant and already shipped. Polling
  only covers "the thread is open on screen right now."
- **M4's optimistic send removes the latency you personally feel.** Your own
  messages will appear the instant you hit send. The 4-second window then only
  affects how fast *incoming* messages land, in a thread you're actively staring
  at — where a couple of seconds reads as normal.
- **The infrastructure cost is real and lands on your home PC.** Channels needs
  an ASGI server, a Redis channel layer, WebSocket auth, reconnection handling,
  and socket lifecycle management across mobile background/foreground. That's a
  meaningful new operational surface on a box you maintain personally, for a
  latency improvement most users won't be able to name.
- **The swap stays non-breaking**, exactly as `messaging.md` describes: same REST
  endpoints, same data model, add a consumer and replace an interval. Delaying
  costs nothing.

**The one honest caveat, and the trigger to revisit:** reactions (M2) are the
feature whose value decays fastest with latency — a one-tap gesture whose entire
payoff is the other person seeing it land. **After M2 ships, use it with someone
for a week.** If reactions feel laggy in real use, that's the signal, and
real-time becomes its own phase alongside or after 9c. Don't pre-empt it on
theory.

If you want a cheap middle option later: tighten the open-thread poll when the
thread is focused *and* there's been a message in the last minute, and let it
back off when idle. Adaptive polling gets most of the perceived improvement for
one function and no new infrastructure.

---

## The shape of the change

**No change to the safety model.** The clique invariant, `can_send`, interval
clipping, and blocking are untouched — every feature is layered on
`visible_messages(conversation, viewer)` and inherits its guarantees.

**No change to the push rules.** Editing, reacting, replying and deleting never
enqueue a push, and no push body ever quotes message text. The only addition is
M7's `"Ada sent a photo"`, which still says nothing about content.

---

# Milestones

## M0 — Close the admin message window

**Branch:** `messaging/m0-admin-privacy` · **Depends on:** nothing · **Size:** S

The smallest change here and the one that answers the stated concern. Do it first
and merge it on its own.

**Read first**
- This file's **Privacy** section (above) — especially what M0 does *not* fix.
- `backend/api/admin.py` lines ~78–110 (`MessageInline`, `ConversationAdmin`).
- [`../reference/messaging.md`](../reference/messaging.md) → *Not end-to-end
  encrypted (yet)*.

**Files:** `backend/api/admin.py`, `backend/api/models.py` (maybe),
`backend/api/tests.py`, [`../reference/messaging.md`](../reference/messaging.md).

**Build**
1. **Remove `MessageInline` from `ConversationAdmin`.** Keep the conversation row
   itself — participants, timestamps, kind — that metadata is genuinely useful
   for support ("why can't Dad see this chat?") and reveals no content.
2. **Do not register `Message` as its own admin model.** No list, no search, no
   detail. If a `Message` admin already exists anywhere, remove it.
3. **Replace the moderation path, don't just delete it.** Abuse reports are the
   legitimate reason to ever read a message, and removing the inline without a
   replacement leaves you unable to act on a report. Extend the existing `Report`
   flow so a **reporter attaches the specific message**, and the report stores
   its own snapshot of that text. Access then becomes *reported content only*,
   which is the correct shape: you see what someone deliberately showed you, not
   whatever you feel like browsing.
   - Check what `Report` currently targets (`backend/api/models.py`, search
     `class Report`) and add a nullable `message` FK the same way.
   - **This overlaps with the "reporting a message" open question below** — M0 is
     where it gets answered. It's plausibly an App Review expectation for a
     messaging app anyway.
4. **Rewrite the `ConversationAdmin` docstring.** It currently states message
   readability as a deliberate design property. Replace it with why the inline
   was removed and where moderation now lives, so nobody helpfully adds it back.

**Test**
- Django admin has no route that renders message text.
- Reporting a message stores the snapshot; the report admin shows it.
- Existing messaging tests still pass (this touches no API path).

**Done when** — ✅ all done; `messaging.md` → *Moderation: a report is the only
window* is the durable record. The one thing M0 deliberately left for M1: the
**Report** item in the long-press menu (no menu existed yet), so the endpoint and
both clients' `reportContent({ messageId })` shipped without a UI entry point.
- [x] Message text cannot be reached from any admin page except via a report.
- [x] Conversation metadata is still visible for support.
- [x] A reported message is readable by the maintainer, with a test proving it.
- [x] `messaging.md` records the new moderation path and repeats — unchanged —
      that messages are still stored in plaintext.

---

## M1 — The long-press menu + edit a message

**Branch:** `messaging/m1-edit` · **Depends on:** nothing · **Size:** S–M

The reported problem, and the foundation M2 and M3 hang off.

**Read first**
- [`../reference/messaging.md`](../reference/messaging.md) → *Data model*, *API*.
- `mobile/src/app/messages/[conversationId].tsx` (the whole file — ~500 lines).
- `mobile/src/components/MessageBubble.tsx`.
- `mobile/src/components/PostMenu.tsx` — the app's *existing* menu pattern, which
  M1 deliberately departs from (see below).

**Files:** `backend/api/{models,serializers,views,urls}.py`, a migration,
`backend/api/tests.py`, `mobile/src/api.ts`,
`mobile/src/app/messages/[conversationId].tsx`,
`mobile/src/components/MessageBubble.tsx`, new
`mobile/src/components/MessageActionMenu.tsx`,
`mobile/src/__tests__/thread.test.tsx`.

**Build — backend**
1. `Message.edited_at` — nullable `DateTimeField`, plus an `is_edited` property
   mirroring the existing `is_deleted`.
2. `PATCH /api/conversations/<id>/messages/<msg_id>/` — sender only, not deleted,
   within the window. Body `{ text }`, validated by the same rules as create
   (non-blank, `MESSAGE_MAX_LENGTH`). Add it beside the existing `DELETE` on that
   route in `urls.py`.
3. `MessageSerializer` gains `is_edited` and `edited_at`.
4. **Edit window: 15 minutes** — `MESSAGE_EDIT_WINDOW`, one constant.
   *Why a window at all:* a thread is a record two people share. Unlimited
   editing lets someone rewrite what you already read and replied to, so your
   reply now sits under words that were never said. Fifteen minutes covers "I
   typed teh" and excludes "I rewrote yesterday." One constant — change it if it
   annoys people more than it protects them.
5. **An edit must not bump `Conversation.updated_at`.** Fixing a typo shouldn't
   jump the thread to the top of everyone's list. The list preview updates
   anyway — it's a `DISTINCT ON` over the latest message, so it reads the new
   text with no bump. **Assert this in a test**; it's the kind of thing that
   regresses quietly.
6. Nothing to do about a queued push — the body never quoted the text.

**Build — mobile**
1. **`MessageActionMenu.tsx` — a menu anchored under the bubble**, *not*
   `ActionSheetIOS`. The app uses action sheets for post menus, and reusing that
   would be the easy call, but it's wrong here: a sheet slides up from the bottom
   detached from the message it acts on, so with the wrong message selected you
   can't tell. Instead: long-press → dim the thread, keep the pressed bubble at
   full brightness, float a small menu directly beneath it (flip above when the
   bubble is near the bottom of the screen). Transparent `Modal` + backdrop
   `Pressable`, positioned from the bubble's `measureInWindow()`, animated with
   Reanimated (already a dependency).
2. **Add `expo-haptics`** — light impact on long-press. Small dep, and most of
   what makes the gesture feel deliberate rather than accidental. Remember
   `--renew-anon-volumes` after adding it; mobile deps are separate from
   `frontend`'s.
3. Menu items — own message: **Copy · Edit · Delete**. Someone else's: **Copy ·
   Report**. **Build the item list data-driven**, because M2 and M3 insert React
   and Reply into this same menu.
   - **Report is already built end-to-end by M0** — `POST /api/reports/` takes
     `{ message }`, `api.reportContent({ messageId })` exists in both clients, and
     `ReportModal` renders the message wording. M1 only has to add the menu item
     that opens it. (M0 deliberately shipped no UI: backend first, per
     *Compatibility* below.)
4. **Edit mode in the composer:** an "Editing message" bar above the input
   showing the original, with an ✕ to cancel; input pre-filled and focused; Send
   becomes a confirm. Escape hatches everywhere — cancelling, or clearing the
   text, must never be an accidental delete.
5. Bubble shows **"Edited"** beside the timestamp when `is_edited`.
6. No menu on a deleted message's tombstone.

**Test**
- Backend: edit own ✓; someone else's → 403; deleted → 400; past the window →
  403; blank/oversized → 400; `updated_at` unchanged; list preview shows new text.
- Mobile: long-press opens the menu; Edit prefills and `PATCH`es; Cancel restores
  the composer; someone else's message offers no Edit.

**Done when** — ✅ all done; `messaging.md` → *Editing a message* and *The
long-press action menu* are the durable record.
- [x] Long-press your own message → anchored menu with Copy/Edit/Delete.
- [x] Edit within 15 minutes; "Edited" shows; thread doesn't jump the list.
- [x] `messaging.md` *API* + *Mobile* sections updated.

**Three decisions M1 made that the plan above didn't anticipate** — read these
before M2/M3, which build on the same menu:

1. **The edit gate also requires `can_send`.** The plan listed sender / not
   deleted / in-window; a fourth was needed. Without it the 15 minutes after a
   disconnect or sever are a back door for writing fresh text into a thread
   you've lost access to. `_assert_can_send` was extracted so send and edit share
   one gate rather than two that drift.
2. **The menu animates with React Native's `Animated`, not Reanimated.** Both are
   in the app, but Reanimated's worklet runtime can't be loaded by Jest, and the
   existing workaround elsewhere (`profile.test.tsx`) is to mock the component
   away — which would have meant mocking away the component under test. A 120ms
   opacity + scale runs on the native driver either way.
3. **The edit lookup is interval-clipped, like the report gate.** Caught in
   review: the first cut looked the message up in the whole conversation, which
   let a gap member distinguish 403 ("not yours") from 404 ("no such message")
   and so learn which ids landed while they were away. `_messages_for_viewer` is
   the one rule the thread, the report gate and now the edit route all share —
   **M2 and M3 must resolve a target message the same way.**
4. **`src/measure.ts` exists as a seam for `measureInWindow`.** Measuring a view
   is native; under Node the callback never fires, and RN's Jest preset installs
   the no-op as a per-instance `jest.fn()` reached through `requireActual`, so it
   cannot be mocked from outside. A seam we own can be, which is what lets the
   menu keep the correct measure-then-position shape with no timers or
   test-shaped fallbacks in the UI. **M2/M3 get this for free** — anything else
   needing a rect should use it.

Also added, both small: `expo-haptics` (light impact on long-press) and
`expo-clipboard` (Copy) — `react-native`'s built-in `Clipboard` is deprecated and
slated for removal, so it wasn't the boring choice it looked like.

---

## M2 — Reactions on messages

**Branch:** `messaging/m2-reactions` · **Depends on:** M1 · **Size:** S

**Read first**
- [`../reference/reactions.md`](../reference/reactions.md) — the whole model.
- `backend/api/models.py` → `class Reaction` (~line 748) and its constraints.
- `mobile/src/components/{ReactionBar,ReactionTray,ReactorsSheet}.tsx`.
- This file's **Privacy** section, decision 3 — reactions stay plaintext, and
  that's deliberate.

**Files:** `backend/api/{models,serializers,views,urls}.py`, a migration,
`backend/api/tests.py`, `mobile/src/api.ts`,
`mobile/src/components/{MessageActionMenu,MessageBubble}.tsx`, a new mobile test.

**Build**
1. **Widen `Reaction`; don't build a parallel model.** Add a nullable `message`
   FK, extend `reaction_targets_post_xor_comment` to exactly-one-of-three
   (renaming it), and add a partial `unique_user_message_emoji` constraint — use
   the same conditional-unique trick as post/comment, because a plain unique
   tuple treats NULLs as distinct and lets duplicates through.
2. `POST /api/messages/<id>/react/` (toggle) + `GET /api/messages/<id>/reactions/`,
   mirroring the post/comment route pair exactly. Reuse `normalise_emoji` — the
   server validates, never trusts the client.
3. **Visibility is simpler here, and knowing why saves you work.** Post reactions
   are pruned per viewer because a reactor might be someone you can't see. In a
   conversation the active participants are a clique *by construction*, so anyone
   who can see the message can see everyone who reacted. No pruning — just clip
   on whether the message itself is visible.
4. **No push, no `Notification` row.** Messaging stays out of the bell
   (`messaging.md` explains why), and buzzing a phone for a 👍 is how people end
   up turning notifications off.
5. Mobile: a **quick-reaction row** across the top of M1's menu — six emoji plus
   a `＋` opening the existing `rn-emoji-keyboard` picker (already a dep, already
   used by `ReactionTray`). Reuse the existing reaction components rather than
   forking chat-only copies.
6. Reactions render as a small pill overlapping the bubble's lower edge; tapping
   it opens the reactors sheet.

**Watch for:** the pill must not make M5's run-grouping go ragged. If you're
doing both, keep an eye on the spacing together.

**Done when** — ✅ code complete; `reactions.md` → *Message reactions* +
*Mobile*, and `messaging.md` → *Reacting to a message*, are the durable record.
- [x] React from the long-press menu; toggle off by re-tapping there, or via
      "Tap to remove" in the who-reacted sheet.
- [x] Reactor list correct; no push and no `Notification` row (both tested).
- [x] `messaging.md` + `reactions.md` both updated — reactions.md owns the model,
      messaging.md links to it.
- [ ] **Then use it for a week** — see the polling trigger above. *(Needs a
      TestFlight build; can't be ticked from the repo.)*

**Five decisions M2 made that the plan above didn't anticipate:**

1. **Reacting requires `can_send`, not just visibility.** The plan said "clip on
   whether the message itself is visible". That's necessary but not sufficient: a
   reaction is content everyone in the thread sees, so the same back door M1
   closed for editing was open here. `_assert_can_send` gates the toggle too;
   reading the reactor list stays open, because losing the ability to write isn't
   losing the history. A **deleted** message also can't be reacted to (400),
   matching the edit route and the report gate.
2. **The no-pruning opt-out is an explicit `EVERYONE` sentinel**, and
   `_toggle_reaction` / `_reactors_grouped` now take the pruning decision as a
   **required** argument. Reusing `visible_ids=None` would have been shorter, but
   `None` already means the opposite (fail closed, show nothing) — so one
   forgotten argument would have turned into a silent leak on *posts*. M3 and M7
   should keep the same shape: make the caller state the privacy decision.
3. **The chat's quick-emoji set isn't the feed's.** `ReactionTray`'s four are
   deliberately all positive, which is right for a post and wrong for a
   conversation — 😮 and 😢 are the warm replies to someone's news. The chat row
   is 👍 ❤️ 😂 😮 😢 🙏. The full picker's theme moved to `theme.ts`
   (`emojiPickerTheme`) so the two entry points can't drift.
4. **A pill has one gesture — tap opens "who reacted", it never toggles.** The
   first cut had tap-toggle plus long-press-for-reactors, matching the feed's
   chips; **trying it in the simulator settled it the other way**, and the
   reasoning generalises. A pill is a *display* of what the thread said, so a tap
   belongs on the detail of it, not on silently changing it — and a target that
   small doing two things depending on press duration is where a mis-timed press
   does the wrong thing. A post's chip has to toggle because a post has no
   long-press menu; a message has two better homes for it (the menu's emoji row,
   and "Tap to remove" on your own row in the sheet). **M3 puts more affordances
   on the same bubble — keep gestures one-per-target there too.**
5. **No optimistic toggle**, deliberately, even though M4 brings optimistic send.
   Simulating the toggle locally means a second copy of rules the server owns (the
   per-target cap, emoji validation, count-then-emoji ordering) that can show a
   pill and then take it away. The "use it for a week" instruction above is
   exactly the evidence needed before optimising for the latency — don't pre-empt
   it.

---

## M3 — Reply threads

**Branch:** `messaging/m3-reply` · **Depends on:** M1 · **Size:** M–L

**Read first**
- [`../reference/messaging.md`](../reference/messaging.md) → *History is
  interval-clipped* — **the diagram, properly**. This milestone is where getting
  it wrong leaks private history.
- This file's **Privacy** section, decision 1.
- [`../design-system.md`](../design-system.md) → the branching-line comment
  thread, and `mobile/src/components/CommentThread.tsx`. The focused view below
  is that same living line, and should look like it.

**The shape: a focused thread, not a collapsed quote.** This milestone was
re-specified on 2026-07-27 after the original plan (a quote bar attached to each
reply, and nothing more) was tried against what the user actually wanted. In that
design a reply shows only the *one* message it answers, so a back-and-forth
inside a busy thread can never be read as a conversation — you reconstruct it by
scrolling and matching quotes. Instead: replies still sit in the transcript in
chronological order, and **tapping into one brings the whole mini-thread
forward** over a blurred transcript, scrollable, with its own composer. The
collapsed quote still exists — it's the thing you tap.

**Files:** `backend/api/{models,serializers,views,urls}.py`, a migration,
`backend/api/tests.py`, `mobile/src/{api,types}.ts`,
`mobile/src/components/MessageBubble.tsx`, a new
`mobile/src/components/MessageThreadView.tsx`,
`mobile/src/app/messages/[conversationId].tsx`, new mobile tests.

**Build — backend first**

1. `Message.reply_to` — self-FK, `null=True`, **`on_delete=SET_NULL`**. Not
   CASCADE: deleting a quoted message must not delete the replies to it. This
   holds the message you *actually* replied to, which is what the focused view
   shows and what the collapsed quote renders.
2. `Message.thread_root` — a second self-FK, `null=True`, `SET_NULL`, **indexed**,
   set on save to `reply_to.thread_root_id or reply_to_id`. This is the plan's
   original "depth 1 always" rule, stored rather than implied.
   - *Why denormalise:* it's what makes "give me this thread" and "how many
     replies does this root have" single indexed queries instead of a recursive
     walk, and it's what flattens a reply-to-a-reply into the same thread rather
     than growing a tree. **Never render a quote inside a quote.**
3. `POST messages/` accepts `reply_to_id`; validate it belongs to **this**
   conversation and is visible to the *sender* — resolve it through
   `_messages_for_viewer`, never a bare `Message.objects.get`, so an invisible
   target is a validation error and not a way to test which ids exist.
4. `MessageSerializer` gains `reply_to` (a **bare id**: `{ id }` — no text and no
   author, see settled point 6), `thread_root_id`, and `reply_count` — non-zero
   only on a root, so the transcript knows which bubbles open a thread.
5. `GET /api/conversations/<id>/messages/?thread_root=<id>` — the whole
   mini-thread, root included, **through the same
   `_messages_for_viewer` queryset** as the transcript. One visibility rule, a
   fifth call site, never a second copy.

**🔒 The visibility rule, stated once and precisely**

> **Quote text must pass through the same interval clipping as the thread.**

Both the original design ("client renders the quote from its own copy") and this
one satisfy that. They differ in *where* the text comes from: the client's cache,
or a fetch through the clipped endpoint. The original plan chose the strictest
form on the grounds that embedding quote text in the reply's payload **server-side**
walks straight around `visible_messages(conversation, viewer)` — which is still
true, and still forbidden. **Never embed the quoted text in the reply's own
serialization.** But *fetching* the quoted message by id through a clipped
endpoint doesn't walk around anything; it goes through the front door. So M3
takes the fetch:

- It fixes a real defect in the strict version — "Original message unavailable"
  would show whenever the original merely hadn't paged in yet, which is
  indistinguishable to the user from a genuine privacy clip. Reserve that message
  for the case where it's *true*.
- It survives E2E unchanged: the server hands over ciphertext, the client holds
  the key. Fetching a message by id was never the thing E2E takes away.
- The focused view needs a thread endpoint regardless, so this costs nothing new.

6. **Test from the gap scenario, not a happy path.** A member who was pending
   across a range and returned must, for a root inside their gap: not see its
   text in the transcript, not get it from `?thread_root=`, and see the focused
   view open with the root missing but their own visible replies intact. Assert
   at the **API** level that the text is absent from the payload — a UI test
   proving a bubble didn't render proves nothing about what crossed the wire.

**Build — mobile**

7. ~~**Swipe-right-to-reply** on a bubble~~ — **built and removed; do not
   reinstate.** See settled point 3 below. **Reply** lives in the M1 menu and
   that is the only route. The menu item list is already data
   (`messageActions()`), which is what it was built as for exactly this.
8. **Reply opens the focused thread** (item 10) rather than aiming this screen's
   composer at a message — including when the message has no replies yet, which
   opens a strand one bubble long. *This replaced a "Replying to X" bar above the
   transcript composer, which was built, used, and rejected:* it shows the one
   message you're answering and none of the exchange around it, which is the same
   limitation that made collapsed-quotes-only wrong. The transcript composer
   therefore keeps its two modes (write, edit) and never competes with replying.
9. A reply in the transcript renders a small collapsed quote above its bubble. A
   **root** renders a reply-count affordance ("3 replies") on the branch line.
10. **The focused thread view** (`MessageThreadView.tsx`) — `expo-blur`'s
    `BlurView` over the transcript, the thread's messages in their own scrollable
    list on top, composer pinned below, tap-outside or a close control to dismiss.
    Sending from here sets `reply_to` to the message you entered from.
    - `expo-blur` is a **new dependency** — an official Expo SDK module, agreed
      with the user on 2026-07-27. Remember `--renew-anon-volumes`.
    - *Why blur rather than a plain dim scrim:* dim-only reads as "a modal over a
      list". The blur is most of what makes it read as the same conversation
      brought into focus, which is the entire point of the pattern.

11. **Gesture budget — one gesture per target, the rule M2 settled.** Long-press =
    the M1 menu (Reply is in it). **Tap the reply-count affordance** or a reply's
    quote = open the focused view. The bubble's own tap stays free. Do not make
    the bubble open the thread on tap, and do not add a swipe (point 3 below).
    - All routes *land in the same place*; they differ only in what the strand's
      composer aims at and whether the keyboard comes up. See `messaging.md` →
      *Every route to a reply goes through the strand* for the table.

**Two things this supersedes**, so a future session doesn't reinstate them: the
original item 7 ("tapping a quote scrolls to the original if loaded, else no-op")
and its load-until-found follow-up. The focused view *is* the answer to "show me
the context", and it needs neither.

**Done when**
- [x] Reply in the long-press menu composes a reply. (A swipe was built too, and
      removed — point 3 below.)
- [x] A root shows its reply count; tapping it opens the focused thread over a
      blurred transcript, scrollable, and you can reply from inside it.
- [x] A reply to a reply lands in the same thread — no nesting, anywhere.
- [x] The gap-scenario test passes at the API level and is committed.
- [x] `messaging.md` documents `thread_root`, the thread endpoint, and the
      visibility rule above **with the reason the strict form was relaxed**.

**Eight things M3 settled that the plan above didn't anticipate:**

0. **Reply opens the strand; there is no reply mode on the transcript's
   composer.** Built the conventional way first (a quote bar above the composer),
   used it on a simulator, replaced it. The bar answers "which message is this
   for" and nothing else, when the reason for the whole milestone was that a
   reply needs its *conversation* visible. Once every route lands in the strand,
   the transcript composer goes back to two modes and stops fighting edit mode
   for the same input. Recorded first because it's the decision a future session
   is most likely to reverse by accident, reaching for the familiar pattern.


1. **A reply's quote is a second way into the thread, and it's load-bearing.**
   The plan had one entry point, the root's reply count. A test written for the
   gap scenario exposed the hole: when the root is clipped out of your view, its
   replies stand alone in the transcript with **no root to carry a count**, so
   the strand was unreachable for exactly the person whose view of it was already
   partial. Tapping the quote opens the thread by `thread_root_id`. This is also
   what iMessage does, but it was arrived at from the privacy case.
2. **`reply_count` had to be clipped per viewer**, not `Count("thread_messages")`.
   A count is small but it's still existence — "3 replies" on a message you can't
   see tells a gap member how much happened while they were out. `_with_reply_counts`
   subqueries the viewer's own visible set. Easy to get wrong by writing the
   obvious annotation, so there's a test for it.
3. **Swipe-to-reply was built, used on a real phone, and removed. Don't bring it
   back.** A rightward drag starting on a bubble is also the navigator's
   interactive back gesture, and the two raced for the same touch: in practice
   the swipe usually lost, closing the conversation instead of starting a reply.
   No threshold fixes that — both gestures legitimately claim the drag, so the
   winner is whichever responder takes the touch on the day. Long-press → Reply
   is one unambiguous route that never fights the navigator, and the affordance
   isn't worth disabling the screen's back gesture to reclaim. (The
   implementation, since it's the part a future session would redo: it was
   `PanResponder` + RN `Animated` rather than gesture-handler + Reanimated,
   because Reanimated's worklet runtime can't load under Jest — the same trade
   `MessageActionMenu` made for its animation. That reasoning still holds if a
   *non-conflicting* gesture is ever wanted here.)
4. **The focused view has no long-press menu, deliberately.** It's a `Modal`, and
   `MessageActionMenu` is a `Modal` — presenting one from inside the other is the
   iOS trap the emoji picker documents. Close the strand and act on the message
   in the transcript.
5. **A missing thread head gets different wording from a missing quote.**
   "Original message unavailable" is right on a quote; on a headless strand it
   reads as an error, so that says "The start of this thread isn't available to
   you". Two different things to tell someone, and only one of them is about the
   message in front of them.
6. 🔒 **The quote reference dropped `sender` too.** M3 first shipped
   `{ id, sender }`, reasoning that naming an author isn't handing over history.
   In a group it is: someone can join, post and leave entirely inside your
   interval gap, and `participants` lists only *current* members — so a reply
   quoting them was the one payload carrying a name and an avatar for a person
   you were never in a chat with. It costs nothing to drop, because a client that
   resolved the quoted message already has its author, and one that couldn't
   isn't entitled to either. An unresolved quote now renders with no name above
   it. `MessageReplyGapTests` has the test, and it fails loudly against the old
   serializer.
7. **The strand pages, and its composer clears on success, not on send.** Two
   bugs from the same habit of treating the focused view as a small thing rather
   than a screen. `?thread_root=` is the ordinary message list with a filter, so
   it paginates at 20 like everything else — reading only page one cut a busy
   strand off at its *oldest* 20 and hid the reply you'd just sent. And both
   composers run off one mutation, so clearing text in its success handler wiped
   a half-typed message in the transcript underneath, while clearing the strand's
   own box on dispatch lost a failed reply outright. The strand now awaits the
   send, keeps the words when it fails, and shows why — the transcript's error
   line is behind the blur where nobody can read it.

**One debt this leaves, recorded in M5 step 1:** the transcript resolves a
quote's body from loaded messages, which is complete only because the screen
still eagerly loads every page. M5 makes paging lazy and must fetch the missing
message through the clipped endpoint at the same time — or
"Original message unavailable" starts lying. Note this now costs the *author*
too, not just the body (point 6), so the fetch is the only way to get either.

---

## M4 — Send status + read receipts

**Branch:** `messaging/m4-receipts` · **Depends on:** nothing · **Size:** M

Two independent halves — ship either alone if the other stalls.

**Read first**
- [`../reference/messaging.md`](../reference/messaging.md) → *Data model*
  (`ConversationRead`) and *Push notifications* (the `enqueue_message_pushes`
  population table).
- `backend/api/models.py` → `class NotificationPreference` (~line 974), to
  understand why the setting does **not** go there.

**Files:** `backend/accounts/models.py` (+migration), `backend/api/serializers.py`,
`backend/api/tests.py`, `mobile/src/api.ts`,
`mobile/src/app/messages/[conversationId].tsx`,
`mobile/src/components/{MessageBubble,settings/*}.tsx`.

**Build — optimistic send (do this even if receipts slip)**

Today a message only appears after the round-trip. Render it immediately with a
**clock** via TanStack `onMutate` on `['messages', id]`, reconcile on response,
and on failure **leave it in place with a retry affordance** — never drop text
the user typed. This is most of what makes a polling app feel instant, and it's
why we can stay on polling at all.

**Build — read receipts**
1. Ticks: clock (sending) → single (sent) → double, accented (read). **Three
   states, not the four you may be used to** — there is no "delivered" tick,
   because nothing in our stack reports that a device received a message.
   Inferring it from an Expo push receipt would mean showing a tick that means
   "we handed it to Apple", which is not what the user would read it as. Better
   to show one fewer state honestly.
2. Compute read client-side from data we nearly have: put each participant's
   `last_read_at` on the **conversation detail** payload and compare against each
   message's `created_at`. One small field, zero per-message cost.
3. "Read" in a group means every other **active** participant whose interval
   spans the message — that's the same population `enqueue_message_pushes`
   already computes. **Reuse that predicate**; a second copy will drift from the
   first.
4. `User.send_read_receipts` on `accounts.User`, **default on** (it's what people
   expect, and a feature nobody discovers is a feature nobody has). Surface it in
   Settings on both clients with plain wording.
5. **Symmetric and enforced server-side.** With it off, your `last_read_at` is
   omitted from everyone else's payload *and* theirs from yours. Not a
   client-side hide — the client must never *receive* data the setting says it
   shouldn't have.
6. **It belongs on `accounts.User`, not `NotificationPreference`** — there's no
   notification *kind* to hang it off, the same reasoning that put
   `Participant.muted_at` on the participant. Worth a sentence in the reference
   doc so it doesn't look arbitrary.
7. **Applies in groups too.** Some messengers carve groups out; we don't — "you
   can't turn this off in groups" is exactly the exception that makes a privacy
   setting untrustworthy.

**Test the off-state at the API level**, asserting the field is *absent* from the
response. A UI test that checks a tick isn't rendered proves nothing about what
was sent over the wire.

**Done when**
- [x] Message appears instantly on send; failure offers retry.
- [x] Ticks show sending/sent/read.
- [x] Setting off ⇒ field absent both directions, proven by an API test.
- [x] `messaging.md` documents receipts + the setting's home and rationale.

**Two things came out differently from the sketch above — both settled, and
recorded here because the reasoning matters more than the instruction did:**

1. **The optimistic send is an outbox in component state, not a `onMutate`
   write into the query cache.** The plan's shape doesn't survive contact with
   the poll: a refetch *replaces* an infinite query's pages, so anything written
   optimistically lives about four seconds. Fine for the in-flight moment, fatal
   for a *failed* send, which is precisely the message that must not be lost.
   `mobile/src/outbox.ts` holds unsent messages outside server truth, and the two
   never need reconciling.
2. **The "who has read this" predicate is computed client-side, from two fields
   per participant** (`last_read_at` + `active_since`), rather than by reusing
   `enqueue_message_pushes` server-side. Reuse isn't literally available: the
   plan also required zero per-message cost, and the push predicate is
   per-message by construction. What's reused is the *definition* — one place on
   the client (`readReceipts.ts`, unit-tested), one place on the server
   (`attach_read_receipts`), and the ticks are explicitly a display heuristic
   that no access control leans on. `active_since` is the smallest fact that
   keeps a late arrival from stalling the tick forever.

Both are written up in `messaging.md` with the trade-offs stated (notably: the
double tick means "everyone who *shares read state* has read it").

---

## M5 — Thread mechanics

**Branch:** `messaging/m5-thread` · **Depends on:** nothing; **do before M7** ·
**Size:** M–L

Where the current implementation's real defects get fixed. Nothing here is a
*feature*, and all of it is why the thread feels off today. Lowest visible payoff,
highest value — don't skip it.

**Read first**
- `mobile/src/app/messages/[conversationId].tsx` in full, especially lines 83–98
  (the paging effect) and 295–333 (the list).
- `mobile/src/components/TimelineList.tsx` + `useDayBoundary` — the feed already
  solved day dividers; match them.

**Build, in this order**
1. **Fix the eager full-history load — first, before anything else here.** The
   screen currently walks `fetchNextPage` in a `useEffect` until *every* page is
   loaded: opening a chat pulls its entire history, forever. Invisible at today's
   volumes, worse every month. Replace with the standard chat shape — an
   **inverted `FlatList`** (newest-first) where `onEndReached` pages *older*
   messages upward. This also deletes the `scrollToEnd`-on-content-change hack
   and the `flex: 1` comment explaining why the list was fighting the composer.
   Everything below sits on top of this.
   - 🔒 **This breaks one of M3's assumptions — fix it in the same commit.** The
     transcript resolves a reply's quoted body from the messages it has already
     loaded, which is complete *only* because every page is loaded today. Once
     paging is lazy, a miss also means "not paged in yet", and "Original message
     unavailable" — which is supposed to mean *you were clipped out of this* —
     starts lying part of the time. The fix is to fetch the missing message
     through the same interval-clipped endpoint the focused thread view already
     uses. **Never widen the reply payload to carry the text**; that's the one
     thing `messaging.md`'s visibility rule forbids outright.
2. **Day separators** — "Today" / "Yesterday" / "12 March", matching the feed.
3. **Clock times, not relative.** `formatRelativeTime` on every bubble is wrong
   for a chat; the convention is `14:32` with the separator carrying the date.
   The conversation *list* keeps relative time — correct there, wrong here.
4. **Run grouping.** Tighter spacing within a run, timestamp on the run's last
   bubble only, tail corner on the last bubble only. Sender attribution already
   computes runs — extend that, don't recompute it.
5. **Unread divider** — "12 unread messages" at the boundary, opening the thread
   *there* rather than at the bottom. Needs your `last_read_at` captured **once
   on open**, before the existing mark-read effect moves it.
6. **Jump-to-latest** floating button when scrolled up, with a new-message count.
7. **Keyboard handling** — the current `KeyboardAvoidingView` is blunt; the list
   should stay pinned while the keyboard animates.
8. Light haptic on send.
9. **Make URLs tappable.** A message body renders as a plain `<Text>` today, so a
   link someone sends is dead text you have to retype. This is the single
   cheapest "feels broken" fix in the phase — linkify URLs (and email addresses)
   and open them in the system browser. **Linkifying is not link *previews***:
   no server-side fetch, nothing rendered from the target, so none of the
   tracking/SSRF objection applies.
10. **Emoji-only messages render large.** A message that is nothing but one to
    three emoji drops the bubble and renders at ~3× size. A few lines of code,
    and one of the most-noticed details in any messenger.
11. **Per-chat draft persistence.** Type half a message, navigate away, come back
    — the text should still be there. It isn't today; the composer state dies
    with the screen. Keep drafts keyed by conversation id (in-memory is enough to
    start; persist across app restarts if it's cheap).

**Done when** — ✅ all done; `messaging.md` → *The transcript (Phase 9b M5)* is
the durable record, with the two new query parameters in *API*.
- [x] Opening a thread loads **one page**; older messages page in on scroll-up.
- [x] Day separators, clock times, grouped runs, unread divider, jump-to-latest.
- [x] Links are tappable; emoji-only messages render large; drafts survive
      leaving and returning to a thread.
- [x] `messaging.md` *Mobile* section rewritten to match.

**Five things M5 settled that the plan above didn't anticipate:**

1. **It needed a backend change, which the plan didn't budget for.** "Replace
   with an inverted `FlatList` where `onEndReached` pages *older* messages
   upward" isn't reachable from the endpoint as it stood: the thread is served
   **oldest-first**, so the newest messages are on the *last* page and the eager
   full-history load wasn't laziness, it was the only way to reach the bottom of
   a chat. `?order=desc` fixes it as one more filter on the same clipped
   queryset — opt-in, because the web still reads the default order and
   *Compatibility* forbids reordering a payload under an old client.
2. **The quote fix is a second query parameter, `?ids=`, not a thread fetch.**
   Step 1's sub-bullet says to fetch the missing message "through the same
   interval-clipped endpoint the focused thread view already uses", which reads
   like `?thread_root=`. That would work — a quoted message is always in the
   quoting reply's strand — but it means pulling a whole paginated strand to
   render two lines, and chasing pages until the one id turns up, which is the
   load-until-found pattern M3 explicitly superseded. A batch id filter is one
   request for every unresolved quote on screen. **Each id is asked about once**:
   an unresolvable id is a *fact* about this viewer, so re-asking every poll
   would be a request every four seconds that can only ever return nothing.
3. **The unread divider is positioned from `unread_count`, not `last_read_at`.**
   The plan says to capture your `last_read_at` on open. You can't reliably: the
   conversation detail withholds **every** read marker, your own included, when
   you have receipts off (M4's symmetry rule), so the divider would silently stop
   working for anyone who opted out of an unrelated setting. The count is on the
   same payload and always present. It also forced a real ordering fix — the
   mark-read POST fired on mount and raced the detail it now depends on, so it
   waits for it. **Capturing the count is not enough on its own**: it locates the
   divider by counting back from the newest message, so re-deriving the position
   on every render slides the marker one further down for each message that
   arrives while you're reading. The anchor is latched too, and the label is the
   number that was waiting on open rather than the run re-counted.
4. **Run grouping has two exemptions from hiding the timestamp**, and one is a
   privacy-adjacent rule rather than a nicety: the **"Edited" marker** is the
   disclosure that makes editing safe (`messaging.md` says so in as many words),
   so it cannot be suppressed by where a bubble sits in a run. The other is an
   unsent message, which must show its clock or its failure wherever it lands.
5. **`onEndReached` is not reachable from React Native Testing Library**, and the
   workaround is worth knowing before someone burns an afternoon on it.
   `VirtualizedList` only fires it once the last cell has been **laid out**
   (`cellsAroundViewport.last === count - 1`), and that number is fixed at
   construction and can only ever *shrink* — so a list that mounts empty, as
   every query-backed list does, sits at "no cells" forever under Node. The test
   renders the screen twice against one `QueryClient` so the second mount has its
   rows from the first frame, and serves a short page so the row count stays
   inside `initialNumToRender`. Both are documented at the test.

---

## M6 — Conversation list + thread info

**Branch:** `messaging/m6-info` · **Depends on:** nothing · **Size:** M

**Read first**
- `mobile/src/app/(tabs)/messages.tsx`.
- `mobile/src/app/messages/[conversationId].tsx` header block (lines ~184–267) —
  the cramped actions this milestone relocates.
- [`../reference/groups.md`](../reference/groups.md) for how group membership
  interacts with group-scoped chats.

**Build**
1. **Swipe actions on a list row** — Mute (endpoint exists) and Leave.
2. **Search the conversation list by name**, client-side. *Message-content*
   search is deliberately **not** here — it dies under E2E, so don't build toward
   it (see Privacy).
3. **Thread info screen** (`/messages/[conversationId]/info`) — participants,
   mute, add people, leave, block, and **rename a group chat**. Today `title` is
   only settable at creation (`backend/api/views.py:1882`) and the header carries
   Mute/Add/Leave as cramped text buttons. Moving them here is both the standard
   shape and simply better; the header becomes identity + `⋯`.
4. Rename needs a small `PATCH /api/conversations/<id>/` — any active member,
   group chats only.
5. **Mark as unread.** Small, and used constantly by people who treat the badge
   as a to-do list ("I'll reply properly later"). It's just moving
   `ConversationRead.last_read_at` back behind the last message — a `DELETE` on
   the read row, effectively. Put it on the row's swipe menu.
6. **Media gallery in the info screen** — every photo in this chat, in a grid,
   tapping into the existing `PhotoLightbox`. Natural home, and the first place
   anyone looks for a picture someone sent last week. *(Do this after M7, or
   leave the section out until the photos exist.)*

**Done when** — ✅ all done bar the media gallery, which waits on M7 (there are
no photo messages to put in it). `messaging.md` → *Renaming a group chat*,
*Marking a thread unread*, *The conversation list* and *The info screen* are the
durable record.
- [x] Info screen exists with all actions moved into it; header is clean.
- [x] Group chats can be renamed; list rows swipe to mute and mark-unread.
- [x] `messaging.md` *API* + *Mobile* updated.
- [ ] Media gallery — **deferred to M7**, per step 6.

**Four things M6 settled that the plan above didn't anticipate:**

1. **"Mark unread" is not a `DELETE` of the read row**, which is what step 5
   says it is ("effectively"). Dropping the marker means *every* message in the
   thread counts as unread, so flagging a chat you'd read to the end returns it
   wearing "99+" — the badge stops meaning "waiting for you" in exactly the
   moment someone reached for it as a to-do list. The marker moves to a
   microsecond behind the newest **visible, incoming, undeleted** message
   instead, so it comes back as one. All three adjectives are load-bearing:
   your own messages and tombstones don't count toward unread (so aiming at one
   is a silent no-op), and a message from inside an interval gap would give a
   gap member an unread count for something the thread then refuses to show.
   Nothing to aim at is a 400, and the clients hide the action rather than
   offering something that errors.
2. **The swipe uses gesture-handler's *deprecated* `Swipeable`, deliberately**,
   behind a `SwipeableRow` seam. `ReanimatedSwipeable` is the current component
   and it cannot be imported under Jest — Reanimated's worklet runtime fails at
   `require` — so the only way to use it is `jest.mock`-ing the swipe away,
   which here would mock away *the actions*, leaving nothing to prove that Leave
   leaves. Same trade M1 made for the menu's animation. Worth also recording
   that **M3's swipe lesson doesn't apply here**: the list is a tab root, so
   there's no back gesture to race.
3. **Search needed a threshold, and it's keyed off the *unfiltered* count.**
   Below six threads a search field is chrome that makes the screen busier
   without making anything findable. Keying its presence off the filtered list
   instead would pull the field out from under whoever was typing the moment a
   query matched nothing — which is precisely when you need to correct a typo.
4. **Leaving from the info screen can't just `goBack()`.** The thread's Leave
   did, because the thread was one screen from the list; from the info screen
   going back lands on the thread of a conversation you're no longer in. It
   dismisses to the list instead.

---

## M7 — Photo messages

**Branch:** `messaging/m7-photos` · **Depends on:** M5 · **Size:** L

Sequenced last of the feature work: biggest chunk, nothing depends on it.

**Read first**
- This file's **Privacy** section, decision 2 — **image processing moves to the
  client.** This inverts how posts do it; read the reasoning before writing code.
- `backend/api/models.py` → `class PostImage`, and `backend/api/imaging.py`.
- `mobile/src/components/{AuthedImage,PhotoLightbox,AvatarCropModal}.tsx` —
  the crop modal already does client-side manipulation via
  `expo-image-manipulator`.

**Build**
1. **`MessageImage`**, shaped like `PostImage` — including stored `width`/`height`
   so the bubble reserves space and the thread doesn't reflow as images load.
2. **Process on the client**: resize, strip EXIF, and generate the thumbnail with
   `expo-image-manipulator` before upload. The server stores the bytes and
   enforces **size and count limits only** — those work on opaque blobs, which is
   what it'll be handed once E2E lands. Do **not** route this through
   `api/imaging.py`; that path stays for posts and avatars.
   - Accept the trade: the server can no longer verify a blob is really an image.
     Byte caps and per-message count caps are the mitigation.
3. `POST messages/` accepts multipart, as posts do.
4. **Offer the camera, not just the library.** "Take a photo" is at least half of
   what people send in a chat, and routing them out to the camera app and back is
   the kind of friction that makes an app feel like a website.
   `expo-image-picker` (already a dep) does both.
5. Bubble renders via the existing `AuthedImage`; tap opens the existing
   `PhotoLightbox`.
6. List preview: "📷 Photo".
   - **Also finish M6's media gallery here** — a grid of this chat's photos in
     the info screen (`mobile/src/app/messages/[conversationId]/info.tsx`),
     tapping into the same `PhotoLightbox`. M6 shipped without it on purpose:
     an empty grid promising a feature that doesn't exist is worse than the
     absence.
7. **Push body: `"Ada sent a photo"`** — names the sender, says nothing about
   content, consistent with the existing rule.
8. **Storage needs no new decision** — it rides the `django-storages` seam: local
   disk volume now, S3 bucket at Phase 11, same as every other image.
9. **Leave a seam for video.** Phase 13 (`phase-13-video-clips.md`) adds video
   clips. Shape `MessageImage` and the attachment endpoint so a second media type
   slots in rather than forcing a parallel path — but **don't build video here**;
   it needs a transcode pipeline this phase has no business growing.
10. ✅ **Verify [`../backup-restore.md`](../backup-restore.md) and
   `deploy/backup.sh` cover the whole media directory**, not an enumerated list
   of subdirectories. If they enumerate, message images silently aren't backed up
   — a data-loss bug that only surfaces the day you need the backup.

**Done when**
- [x] Send and view photos in a chat; push reads "sent a photo".
- [x] Images are stripped and downscaled **client-side** — pipeline pinned by
      `chatPhotos.test.ts`. ⚠️ **The device check is still outstanding**: the
      re-encode is what drops the EXIF, and no Node test can prove that on a real
      photo. Send one with GPS EXIF from a real phone and confirm the stored file
      carries none before calling this closed.
- [x] Backups confirmed to include message media — `backup.sh` and `restore.sh`
      both sync the whole media tree, so `media/messages/` was already covered.
      The prose in both (and in `backup-restore.md`) now says *whole tree, never
      an enumerated list*, which is the failure mode the step was guarding
      against.
- [x] `messaging.md` documents the client-side pipeline and why it differs.

**Two deliberate departures from the steps above**, both recorded in
`messaging.md` so a later reader doesn't take them for drift:

1. **The model is `MessageAttachment`, not `MessageImage`** (step 1's name).
   Step 9 asks for a seam so Phase 13's video slots in rather than forcing a
   parallel path, and a model whose name means *picture* fights that. It carries
   a `kind` (only `image` today) and a `thumbnail` that doubles as a video's
   poster frame.
2. **One attachment per message**, with the wire format already a list of
   parallel fields. A multi-photo pick sends several messages, which is the
   better chat shape as well as the smaller one — each photo gets its own bubble,
   reactions, replies and delete. Raising the cap is a server constant, not an
   API change.

**Two things done here that the steps didn't name**, both because M7 created the
gap:

- **A forced `.jpg` filename + `nosniff` on the media route.** Once the server
  stops decoding an upload it can't know a blob isn't markup, and Caddy picks the
  Content-Type from the extension — a file stored as `.html` would have been
  stored XSS on our own origin. Step 2 accepted "the server can't verify it's an
  image" but didn't follow that through to how the file is *served*.
- **Reported photos are visible in the admin.** M0 made a report the only window
  onto a private message; M7 made a message able to be nothing but a photo, so
  without this, photo abuse was the one thing moderation couldn't act on.
- **A 6 MB body cap at the proxy** (`deploy/Caddyfile`, `@chat_upload`). Django
  buffers a multipart upload to disk before DRF looks at it, so step 2's byte cap
  limited what we *store*, not what we *accept*. The only route on the box with
  its own body limit, because it's the only upload the server never decodes.

**Three bugs found in review and fixed on the branch**, each worth knowing about
because none of them were visible from the code that caused them:

- **The camera was unusable.** M7 added the app's first camera call, but
  `mobile/app.json` still carried `cameraPermission: false` from when nothing
  used it — which tells the `expo-image-picker` plugin to *delete*
  `NSCameraUsageDescription` and block `android.permission.CAMERA`. iOS
  terminates an app that reaches for the camera without that string, so "Take
  Photo" was a hard crash while every Jest test stayed green (they mock the
  picker). `thread.test.tsx` now asserts the config file itself.
- **The admin's reported-photo thumbnails 401'd.** They were `<img src="/media/…">`,
  and that route is `forward_auth`ed to an endpoint that takes the JWT cookie,
  not the admin's Django session. Now inlined as `data:` URIs — nothing fetched,
  nothing to authorise, and no navigable URL for bytes we never decoded.
- **A `PATCH` omitting `text` wiped a photo's caption.** Making `text` optional
  for photos gave it a `""` default, which turned "the client forgot the field"
  into "make it empty". The edit path now requires the key.

---

## M8 — Text, mentions & quick actions

**Branch:** `messaging/m8-text` · **Depends on:** M1 · **Size:** M

Four features that don't fit the other milestones and are, between them, most of
the remaining distance to the bar. Each is independently shippable — if the
milestone runs long, land them one at a time.

**Read first**
- `mobile/src/components/MessageBubble.tsx` (text rendering).
- [`../reference/notifications.md`](../reference/notifications.md) → the push
  payload shape, for quick-reply.
- `mobile/src/components/MessageActionMenu.tsx` (from M1) — multi-select
  reuses its actions.

**Build**

1. **Inline text formatting** — `*bold*`, `_italic_`, `~strikethrough~`,
   `` `monospace` ``. People type these out of habit and it looks broken when the
   asterisks just sit there. Parse to styled `<Text>` runs at render time; **do
   not store markup-processed text** — the raw string stays the source of truth,
   which also keeps it a single opaque blob under E2E. Watch the interaction with
   linkification (M5 #9): one pass producing both, not two passes fighting.
2. **@mentions in group chats.** Type `@`, pick from the thread's active
   participants, and the name renders highlighted.
   - **A mention notifies even in a muted thread — but only if you allow it.**
     That's the whole point of mentioning someone, and it's the one justified
     exception to `Participant.muted_at`. It's also, unavoidably, a way to punch
     through the quiet someone deliberately asked for. So the override is
     **opt-out, per user, in notification settings**, phrased as exactly what it
     does: *"Let @mentions notify me in muted chats."* Default **on**.
   - Be precise about what the setting controls — it is **not** a blanket
     mentions on/off. It governs only whether a mention *overrides mute*. A muted
     chat with the setting off stays fully silent; an unmuted chat notifies
     either way. Getting this wrong gives someone a setting that silences
     mentions they wanted.
   - **This one belongs in `NotificationPreference`** — it's a genuine
     notification kind, so it fits the existing per-kind rows and their
     absence-means-enabled rule. (Contrast M4's read-receipt setting, which lives
     on `accounts.User` because there's no notification kind behind it. Both
     placements are deliberate; note them together in the reference doc so the
     pair reads as a rule rather than an inconsistency.)
   - Store mentions as a real relation, not by parsing display names out of text
     at read time — names change, and text parsing under E2E is impossible
     server-side.
3. **Multi-select messages.** Tap-select several (entering select mode from the
   M1 long-press menu), then bulk **Copy** or **Delete**. Deleting a burst of
   messages one long-press at a time is genuinely irritating.
4. **Reply from the notification.** iOS supports a text field directly in the
   push, and `expo-notifications` supports notification categories with a text
   input action. High delight for moderate effort, and it makes the push actually
   useful rather than just a doorbell. The reply posts to the existing send
   endpoint; the thread's mark-read-on-open already handles the badge.
   - Verify it against the real device, not the simulator — this is push, and
     Phase 9's Milestone D notes apply.

**Done when**
- [x] `*bold*`/`_italic_` render; raw text unchanged in the database.
- [x] @mention a group member; they're notified even if the thread is muted.
- [x] Turning off *"Let @mentions notify me in muted chats"* silences it in muted
      threads **only** — mentions in unmuted threads still notify.
- [x] Select several messages and delete them in one action.
- [ ] Reply to a message from the notification without opening the app
      (**device-tested**) — built and unit-tested on both sides (the category on
      the wire, the send-and-don't-navigate decision, and the failed reply
      landing in the outbox). **The device pass is still outstanding**: whether
      iOS draws the text field is native behaviour no Node test reaches, and it
      needs a TestFlight build.
- [x] `messaging.md` + `notifications.md` updated.

---

## M9 — Web parity

**Branch:** `messaging/m9-web` · **Depends on:** M1–M8 · **Size:** L

**Read first**
- `frontend/src/components/MessagesDrawer.jsx` — all 566 lines.
- Every preceding milestone's *Done when*, to build the checklist.

**Build**
1. **Split `MessagesDrawer.jsx` as the very first commit**, before adding
   anything. It holds the list, thread, rows, bubbles and avatar stack in one
   file and this phase touches all of them; splitting first keeps the
   feature diff from tangling with the code-move diff.
2. Port: edit + edited marker, reply, reactions, ticks + the setting, day
   separators and clock times, the unread divider, photos, tappable links,
   large emoji-only messages, drafts, formatting, mentions, multi-select.
   **Build the checklist from each milestone's *Done when*** rather than from
   this line — it's a summary, and summaries drift.
3. The interaction differs because the medium does — the web has hover, so the
   menu is a hover `⋯` on the bubble rather than a long-press, the same way
   delete already works there. **M3's focused thread is the biggest of these
   differences**: a phone blurs the transcript because it has one screen, but a
   desktop has width, so the right shape there is a **side panel beside the
   transcript**, not a blur over it. Same endpoint, same data, different medium —
   don't port the blur.
4. Sanity-check the drawer against the app side by side. The point of this
   milestone is that the two stop diverging.

**Done when**
- [ ] Every 9b behaviour present on web; `MessagesDrawer.jsx` split up.
- [ ] `messaging.md` *Frontend* section rewritten.

---

## Compatibility (the rule that keeps M1–M8 safe to ship without the web)

The box deploys **only on publishing a GitHub Release**, and the app ships
separately via TestFlight — so backend and clients are never in lockstep, and
**an old client talks to a new backend for as long as it takes people to update.**

Two rules make that safe, and they're the difference between "web is behind" and
"web is broken":

1. **Additive only.** New response fields, never changed or removed ones. An old
   client ignores `is_edited` and `reply_to`; it just doesn't render them.
2. **Backend ships first.** A new app version may rely on new fields; a new
   backend must never rely on a new client. Release the backend, *then* submit
   the build.

The one visible degradation is an edited message, which the web renders as its
new text with no "Edited" marker until **M9** (web parity). Acceptable, and
better said out loud than discovered — it's now recorded in `messaging.md`'s
*Frontend* section too.

## Definition of done (whole phase)

- [ ] All ten milestones ticked in **Progress**.
- [ ] Message text unreachable from the admin except via a report.
- [ ] Backend + mobile + frontend tests green in CI.
- [ ] Every milestone deployed after a backup.
- [ ] `../reference/messaging.md` reflects the finished state, and **this file is
      deleted**, per the phase-ships convention.

**The real acceptance test, and it isn't a checkbox:** hand the app to someone who
uses a mainstream messenger daily and watch them use it for a week without
prompting. If they never once reach for something that isn't there, and never
have to think about how to do something, it's done. Every milestone above exists
because of a specific moment where they'd otherwise notice.

## Open questions (settle when you reach them, not now)

- **Edit window length** — 15 minutes matches the common default and is a guess
  for us. One constant; revisit after real use.
- **Delete for me vs delete for everyone.** The category generally has both; we
  have only "delete for everyone" (soft-delete + tombstone). Two-mode deletion is
  more concept than it's worth at family scale unless someone asks.
- **Adaptive polling** — see **Real-time** above. Only if M2 feels laggy in real
  use.
- **Pinned chats.** Deliberately left out: it's user-controlled ordering, not an
  algorithm, so it doesn't offend the principles — it's just low value until
  someone has enough conversations to lose one. Revisit if that happens.
- **Search within a conversation.** Client-side over loaded messages is possible
  and survives E2E; server-side doesn't. Not scoped here.
- **Per-person read state in a group** ("message info"). The data exists after
  M4; it's a small screen if anyone asks for it.
- *(Message reporting was an open question and is now answered in **M0**.)*
