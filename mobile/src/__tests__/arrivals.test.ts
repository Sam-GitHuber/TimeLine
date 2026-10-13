/**
 * Which transcript rows count as new (#395) — the rule that decides what is
 * allowed to animate in. Pinned here as arithmetic; `thread.test.tsx` pins that
 * the screen feeds it the right things.
 */
import { renderHook, waitFor } from '@testing-library/react-native';

import {
  isArrival,
  isSettledSend,
  newestServerId,
  useArrivalBaseline,
} from '@/arrivals';
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
  const baseline = { newestDrawn: 40, outboxDrawn: 0 };

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
      isArrival(message(41), { newestDrawn: null, outboxDrawn: 0 }, NONE)
    ).toBe(false);
  });

  it('is new as the first message of a conversation that loaded empty', () => {
    // Loaded-and-empty is 0, not "not loaded" — the two must not be confused,
    // or the first message ever sent to you would be the one that pops in.
    const empty = { newestDrawn: newestServerId([]), outboxDrawn: 0 };
    expect(empty.newestDrawn).toBe(0);
    expect(isArrival(message(1), empty, NONE)).toBe(true);
  });
});

describe('an unsent message in the outbox', () => {
  it('is new when it was queued after the screen opened', () => {
    // Temp ids count down, so later is lower.
    expect(isArrival(message(-4), { newestDrawn: 40, outboxDrawn: -3 }, NONE)).toBe(true);
    expect(isArrival(message(-1), { newestDrawn: 40, outboxDrawn: 0 }, NONE)).toBe(true);
  });

  it('is not new when it was already waiting there', () => {
    // A failed send from an earlier visit: the outbox outlives the screen.
    const baseline = { newestDrawn: 40, outboxDrawn: -3 };
    expect(isArrival(message(-3), baseline, NONE)).toBe(false);
    expect(isArrival(message(-2), baseline, NONE)).toBe(false);
  });

  it('is new even while the transcript itself has failed to load', () => {
    // #325's case — a send with no transcript under it still leaves the composer.
    expect(isArrival(message(-1), { newestDrawn: null, outboxDrawn: 0 }, NONE)).toBe(true);
  });
});

it('finds the newest server id whatever order the pages are in', () => {
  expect(newestServerId([message(7), message(12), message(9)])).toBe(12);
});

describe('a row that has just taken over from its outbox bubble', () => {
  const baseline = { newestDrawn: 40, outboxDrawn: 0 };

  it('is one this screen sent since the view opened', () => {
    expect(isSettledSend(message(41), baseline, new Set([41]))).toBe(true);
  });

  it('is not someone else’s message arriving', () => {
    expect(isSettledSend(message(41), baseline, NONE)).toBe(false);
  });

  it('is not a send from before this view opened', () => {
    // A strand opened after the reply landed mounts it afresh. Its tick was a
    // clock minutes ago, not now — replaying the change would be a lie.
    expect(isSettledSend(message(41), { newestDrawn: 41, outboxDrawn: 0 }, new Set([41]))).toBe(false);
  });

  it('is nothing before the view has loaded', () => {
    expect(
      isSettledSend(message(41), { newestDrawn: null, outboxDrawn: 0 }, new Set([41]))
    ).toBe(false);
  });
});

describe('the baseline a view keeps', () => {
  type Inputs = Parameters<typeof useArrivalBaseline>[0];
  const view = (initial: Inputs) =>
    renderHook((inputs: Inputs) => useArrivalBaseline(inputs), {
      initialProps: initial,
    });

  it('is nothing until the view says its first load is whole', async () => {
    // A reopened thread starts from its cached copy with a refetch in flight;
    // a strand starts on page one of several. Neither is the first load yet.
    const hook = await view({ loaded: [message(40)], outgoing: [], ready: false });
    expect(hook.result.current.newestDrawn).toBeNull();

    await hook.rerender({ loaded: [message(44), message(40)], outgoing: [], ready: true });
    // Taken from what it held when it became ready — so the four that came in
    // with that refetch are not arrivals.
    expect(hook.result.current.newestDrawn).toBe(44);
  });

  it('still answers "new" in the render that draws an arrival, then moves up behind it', async () => {
    const hook = await view({ loaded: [message(40)], outgoing: [], ready: true });

    await hook.rerender({ loaded: [message(41), message(40)], outgoing: [], ready: true });
    expect(isArrival(message(41), hook.result.current, NONE)).toBe(true);

    // A frame on, 41 has been drawn. A row for it that mounts again — scrolled
    // out of the render window and back by jump-to-latest — must not rise twice.
    await waitFor(() => expect(hook.result.current.newestDrawn).toBe(41));
    expect(isArrival(message(41), hook.result.current, NONE)).toBe(false);
    expect(isSettledSend(message(41), hook.result.current, new Set([41]))).toBe(false);
  });

  it('does the same for the outbox', async () => {
    const hook = await view({ loaded: [], outgoing: [message(-3)], ready: true });
    expect(hook.result.current.outboxDrawn).toBe(-3);

    await hook.rerender({ loaded: [], outgoing: [message(-3), message(-4)], ready: true });
    expect(isArrival(message(-4), hook.result.current, NONE)).toBe(true);
    await waitFor(() => expect(hook.result.current.outboxDrawn).toBe(-4));
  });

  it('hands back the same object until it changes', async () => {
    const inputs = { loaded: [message(40)], outgoing: [], ready: true };
    const hook = await view(inputs);
    const first = hook.result.current;
    await hook.rerender({ ...inputs, loaded: [message(40)] });
    expect(hook.result.current).toBe(first);
  });
});
