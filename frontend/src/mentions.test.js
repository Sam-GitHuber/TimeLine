/**
 * Typing an `@mention` (Phase 9b M9f) — the string half.
 *
 * A port of `mobile/src/__tests__/mentions.test.ts`, and deliberately the same
 * cases: the whole point of M9 is that the two clients agree about what a
 * message is, so the two suites agreeing is what would catch one of them
 * drifting. These are unit tests because every interesting case is about
 * *characters and a caret* (an email address that isn't a mention, a name
 * deleted after being picked), and staging each one through a rendered composer
 * would bury the thing under test. The drawer-level flow — type, pick, send,
 * highlight — is pinned in `messaging.test.jsx`.
 *
 * The bias here mirrors the parser's: **a false positive is the expensive
 * failure**. A picker that doesn't open is a feature nobody noticed; a mention
 * sent for someone whose name isn't in the message buzzes a phone that asked for
 * quiet, which is a promise broken.
 */

import { describe, it, expect } from "vitest";
import {
  applyMention,
  matchMentionable,
  mentionIdsIn,
  mentionQuery,
} from "./mentions.js";

const ADA = { id: 2, display_name: "Ada Lovelace" };
const GRACE = { id: 3, display_name: "Grace Hopper" };
const PEOPLE = [ADA, GRACE];

describe("mentionQuery", () => {
  it("finds the half-typed name before the cursor", () => {
    expect(mentionQuery("can @ad", 7)).toEqual({ query: "ad", from: 4 });
  });

  it('treats a bare @ as "offer everyone"', () => {
    expect(mentionQuery("@", 1)).toEqual({ query: "", from: 0 });
  });

  it("ignores an @ that is part of a word", () => {
    // An email address must not open the picker while it's being typed.
    expect(mentionQuery("write to ada@exa", 16)).toBeNull();
  });

  it("stops at whitespace", () => {
    // The name is settled and the sentence has moved on; reopening the picker
    // over the next word would put a strip over the thread for no reason.
    expect(mentionQuery("@Ada can you", 12)).toBeNull();
  });

  it("only looks behind the cursor", () => {
    // Going back to fix a typo earlier in the message must not reopen a picker
    // for an @ that's already been dealt with further along.
    expect(mentionQuery("hi @Ada there", 2)).toBeNull();
  });
});

describe("matchMentionable", () => {
  it("matches any part of a name", () => {
    expect(matchMentionable(PEOPLE, "lov")).toEqual([ADA]);
    expect(matchMentionable(PEOPLE, "gra")).toEqual([GRACE]);
  });

  it("is case-insensitive and offers everyone for an empty query", () => {
    expect(matchMentionable(PEOPLE, "ADA")).toEqual([ADA]);
    expect(matchMentionable(PEOPLE, "")).toEqual(PEOPLE);
  });
});

describe("applyMention", () => {
  it("replaces the query with the whole name and a space", () => {
    expect(applyMention("can @ad", 4, 7, "Ada Lovelace")).toEqual({
      text: "can @Ada Lovelace ",
      cursor: 18,
    });
  });

  it("keeps whatever followed the cursor", () => {
    expect(applyMention("@ad bring the book", 0, 3, "Ada Lovelace")).toEqual({
      text: "@Ada Lovelace  bring the book",
      cursor: 14,
    });
  });
});

describe("mentionIdsIn", () => {
  it("names only the people still in the text", () => {
    // Picked, then thought better of it and deleted the name. Sending her id
    // anyway would buzz a muted thread about a message that doesn't mention her.
    expect(mentionIdsIn("never mind", [ADA])).toEqual([]);
    expect(mentionIdsIn("@Ada Lovelace can you?", [ADA, GRACE])).toEqual([ADA.id]);
  });

  it("names someone once however many times they appear", () => {
    expect(mentionIdsIn("@Ada Lovelace and @Ada Lovelace", [ADA])).toEqual([
      ADA.id,
    ]);
  });
});
