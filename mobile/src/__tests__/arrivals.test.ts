/**
 * Which transcript rows count as new (#395) — the rule that decides what is
 * allowed to animate in. Pinned here as arithmetic; `thread.test.tsx` pins that
 * the screen feeds it the right things.
 */
import { isArrival, isSettledSend, newestServerId } from '@/arrivals';
import type { Message } from '@/types';

function message(id: number): Message {
  return {
    id,
    sender: { id: 2, display_name: 'Ada Lovelace', avatar_thumb: null },
    text: `Message ${id}`,
    is_deleted: false,
    is_edited: false,
    created_at: '2026-07-22T10:00:00Z',
    edited_at: null,
    reactions: [],
    attachments: [],
  };
}

const NONE: ReadonlySet<number> = new Set();

describe('a message from the server', () => {
  const baseline = { newestOnOpen: 40, outboxOnOpen: 0 };

  it('is new when it is newer than everything the first load held', () => {
    expect(isArrival(message(41), baseline, NONE)).toBe(true);
  });

  it('is not new when the first load held it', () => {
    expect(isArrival(message(40), baseline, NONE)).toBe(false);
    expect(isArrival(message(21), baseline, NONE)).toBe(false);
  });

  it('is not new when it is older history paging in, however late', () => {
    expect(isArrival(message(3), baseline, NONE)).toBe(false);
  });

  it('is not new when it is the server’s copy of a message this screen sent', () => {
    // The outbox bubble it replaces already rose; this one mounting is a key
    // change, not an arrival.
    expect(isArrival(message(41), baseline, new Set([41]))).toBe(false);
  });

  it('is never new before the transcript has loaded', () => {
    expect(
      isArrival(message(41), { newestOnOpen: null, outboxOnOpen: 0 }, NONE)
    ).toBe(false);
  });

  it('is new as the first message of a conversation that loaded empty', () => {
    // Loaded-and-empty is 0, not "not loaded" — the two must not be confused,
    // or the first message ever sent to you would be the one that pops in.
    const empty = { newestOnOpen: newestServerId([]), outboxOnOpen: 0 };
    expect(empty.newestOnOpen).toBe(0);
    expect(isArrival(message(1), empty, NONE)).toBe(true);
  });
});

describe('an unsent message in the outbox', () => {
  it('is new when it was queued after the screen opened', () => {
    // Temp ids count down, so later is lower.
    expect(isArrival(message(-4), { newestOnOpen: 40, outboxOnOpen: -3 }, NONE)).toBe(true);
    expect(isArrival(message(-1), { newestOnOpen: 40, outboxOnOpen: 0 }, NONE)).toBe(true);
  });

  it('is not new when it was already waiting there', () => {
    // A failed send from an earlier visit: the outbox outlives the screen.
    const baseline = { newestOnOpen: 40, outboxOnOpen: -3 };
    expect(isArrival(message(-3), baseline, NONE)).toBe(false);
    expect(isArrival(message(-2), baseline, NONE)).toBe(false);
  });

  it('is new even while the transcript itself has failed to load', () => {
    // #325's case — a send with no transcript under it still leaves the composer.
    expect(isArrival(message(-1), { newestOnOpen: null, outboxOnOpen: 0 }, NONE)).toBe(true);
  });
});

it('finds the newest server id whatever order the pages are in', () => {
  expect(newestServerId([message(7), message(12), message(9)])).toBe(12);
});

describe('a row that has just taken over from its outbox bubble', () => {
  const baseline = { newestOnOpen: 40, outboxOnOpen: 0 };

  it('is one this screen sent since the view opened', () => {
    expect(isSettledSend(message(41), baseline, new Set([41]))).toBe(true);
  });

  it('is not someone else’s message arriving', () => {
    expect(isSettledSend(message(41), baseline, NONE)).toBe(false);
  });

  it('is not a send from before this view opened', () => {
    // A strand opened after the reply landed mounts it afresh. Its tick was a
    // clock minutes ago, not now — replaying the change would be a lie.
    expect(isSettledSend(message(41), { newestOnOpen: 41, outboxOnOpen: 0 }, new Set([41]))).toBe(false);
  });

  it('is nothing before the view has loaded', () => {
    expect(
      isSettledSend(message(41), { newestOnOpen: null, outboxOnOpen: 0 }, new Set([41]))
    ).toBe(false);
  });
});
