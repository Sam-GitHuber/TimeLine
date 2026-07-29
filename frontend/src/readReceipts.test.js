/**
 * Which tick a message gets (Phase 9b M9c).
 *
 * A port of `mobile/src/__tests__/readReceipts.test.ts` alongside the module
 * itself. A unit test rather than a drawer test, because the interesting cases
 * are all about *who counts* — a member added after the message, one who opted
 * out, one between spells of membership — and staging those through a rendered
 * thread would bury the rule under fixtures. It's also what makes the port
 * checkable: the point of M9 is that the two clients stop diverging, and JS
 * won't tell us if they have.
 */

import { describe, it, expect } from "vitest";
import { readStateFor, receiptsVisible } from "./readReceipts.js";

const ME = 1;
const T0 = "2026-07-20T10:00:00Z";
const SENT = "2026-07-20T12:00:00Z";
const LATER = "2026-07-20T13:00:00Z";

function mine(created_at = SENT) {
  return {
    id: 100,
    sender: { id: ME, display_name: "Me", avatar_thumb: null },
    text: "hello",
    is_deleted: false,
    is_edited: false,
    created_at,
  };
}

function member(overrides) {
  return {
    display_name: `User ${overrides.id}`,
    avatar_thumb: null,
    status: "active",
    active_since: T0,
    last_read_at: null,
    ...overrides,
  };
}

/** A participant the server withheld read state for — the *key* is absent,
 * which is what "they've opted out" looks like on the wire. */
function withheld(id) {
  const person = member({ id });
  delete person.last_read_at;
  delete person.active_since;
  return person;
}

it("is read once everyone in the audience has read past it", () => {
  const people = [
    member({ id: ME, last_read_at: LATER }),
    member({ id: 2, last_read_at: LATER }),
    member({ id: 3, last_read_at: LATER }),
  ];
  expect(readStateFor(mine(), people, ME)).toBe("read");
});

it("stays sent while one of them is behind", () => {
  const people = [
    member({ id: 2, last_read_at: LATER }),
    member({ id: 3, last_read_at: T0 }),
  ];
  expect(readStateFor(mine(), people, ME)).toBe("sent");
});

it("never waits on you", () => {
  // Sending is self-evidently reading. Counting yourself would leave every
  // message you sent from another browser stuck on one tick.
  const people = [
    member({ id: ME, last_read_at: T0 }),
    member({ id: 2, last_read_at: LATER }),
  ];
  expect(readStateFor(mine(), people, ME)).toBe("read");
});

it("never waits on a pending member", () => {
  // They're in the waiting room and genuinely can't read the thread, so waiting
  // on one means a tick that never completes for as long as an invitation sits
  // unanswered — days, realistically.
  const people = [
    member({ id: 2, last_read_at: LATER }),
    member({ id: 3, status: "pending", last_read_at: null }),
  ];
  expect(readStateFor(mine(), people, ME)).toBe("read");
});

it("never waits on someone who joined after the message", () => {
  // Someone added yesterday was not shown last week's message, so requiring
  // them to have "read" it means a tick that can never complete — and crediting
  // them with it would be a lie.
  const people = [
    member({ id: 2, last_read_at: LATER }),
    member({ id: 3, active_since: LATER, last_read_at: null }),
  ];
  expect(readStateFor(mine(), people, ME)).toBe("read");
});

it("never waits on a member who has opted out", () => {
  // A missing key means "we're not telling you". Blocking on it would let one
  // person's setting silently disable ticks for a whole group, which is what
  // would make the setting antisocial to use. The cost — that the double tick
  // means "everyone who shares read state" — is the documented trade.
  const people = [member({ id: 2, last_read_at: LATER }), withheld(3)];
  expect(readStateFor(mine(), people, ME)).toBe("read");
});

it("never waits on a member who is between intervals", () => {
  // No open interval = they can't read the thread right now, the same reason a
  // pending member is skipped.
  const people = [
    member({ id: 2, last_read_at: LATER }),
    member({ id: 3, active_since: null, last_read_at: T0 }),
  ];
  expect(readStateFor(mine(), people, ME)).toBe("read");
});

it("distinguishes never-read from withheld", () => {
  // `null` is a real answer — they share receipts and haven't opened it — so
  // the tick correctly stays at one. This is the pair to the test above, and
  // the reason the field is absent rather than nulled when it's withheld.
  const people = [member({ id: 2, last_read_at: null })];
  expect(readStateFor(mine(), people, ME)).toBe("sent");
});

it("stays sent when there is nobody to have read it", () => {
  // An empty audience must not read as "read" — claiming a message was read by
  // a group of nobody is the one wrong answer here.
  expect(readStateFor(mine(), [member({ id: ME })], ME)).toBe("sent");
  expect(readStateFor(mine(), [], ME)).toBe("sent");
});

it("counts a read marker exactly on the message as read", () => {
  // The server stamps the read marker with `timezone.now()`, so a marker equal
  // to a message's timestamp is a real possibility rather than a curiosity —
  // and "read at the same instant it arrived" is read.
  const people = [member({ id: 2, last_read_at: SENT })];
  expect(readStateFor(mine(), people, ME)).toBe("read");
});

describe("receiptsVisible", () => {
  it("is false when you have turned receipts off", () => {
    // The server withholds *every* marker in that case, including your own, so
    // the absence of any is the signal. The thread then shows no ticks at all
    // rather than a column frozen on "sent", which would read as "nobody is
    // ever opening these".
    expect(receiptsVisible([withheld(ME), withheld(2)])).toBe(false);
  });

  it("is true when anyone reports", () => {
    expect(receiptsVisible([member({ id: 2, last_read_at: null })])).toBe(true);
  });
});
