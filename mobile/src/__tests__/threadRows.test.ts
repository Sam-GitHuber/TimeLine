/**
 * Shaping a transcript into rows (Phase 9b M5).
 *
 * Everything here is about *sequence* — where a day breaks, where a run of one
 * person's messages starts and ends, where you stopped reading — which is
 * exactly what's painful to stage through a rendered screen and trivial to state
 * as a list in, a list out.
 *
 * The direction is the thing to keep straight while reading: **newest-first, in
 * and out**, because the thread is an inverted `FlatList` where index 0 is the
 * bubble at the bottom of the screen. So a fixture's first message is the most
 * recent one, and a day separator appears *after* that day's messages in the
 * array, which puts it above them on screen.
 */

import { firstUnreadId, toThreadRows } from '@/threadRows';
import type { ThreadRow } from '@/threadRows';
import type { Message } from '@/types';

const ME = { id: 1, display_name: 'Me Myself', avatar_thumb: null };
const ADA = { id: 2, display_name: 'Ada Lovelace', avatar_thumb: null };

function message(overrides: Partial<Message> & { id: number }): Message {
  return {
    sender: ADA,
    text: `Message ${overrides.id}`,
    is_deleted: false,
    is_edited: false,
    created_at: '2026-07-28T10:00:00Z',
    edited_at: null,
    reactions: [],
    ...overrides,
  } as Message;
}

/** Just the message rows, for asserting run flags without the dividers. */
function messageRows(rows: ThreadRow[]) {
  return rows.filter(
    (row): row is Extract<ThreadRow, { kind: 'message' }> =>
      row.kind === 'message'
  );
}

describe('toThreadRows', () => {
  it('marks the first and last bubble of a run', () => {
    // Newest-first: Ada spoke twice, then earlier still it was me.
    const rows = toThreadRows({
      messages: [
        message({ id: 3, sender: ADA }),
        message({ id: 2, sender: ADA }),
        message({ id: 1, sender: ME }),
      ],
      meId: ME.id,
    });

    expect(
      messageRows(rows).map((row) => [
        row.message.id,
        row.startsRun,
        row.endsRun,
      ])
    ).toEqual([
      // Ada's run: id 2 opens it (it's the older of the two), id 3 closes it.
      [3, false, true],
      [2, true, false],
      // Mine is a run of one, so it both starts and ends.
      [1, true, true],
    ]);
  });

  it('puts a day separator above each day’s first message', () => {
    const rows = toThreadRows({
      // Exactly 24h apart at midday, so they land on different local days (and
      // on the right side of `now`) whatever the runner's timezone is. A
      // fixture straddling local midnight would pass in London and fail in
      // Sydney, which is the sort of test nobody thanks you for.
      messages: [
        message({ id: 2, created_at: '2026-07-28T12:00:00Z' }),
        message({ id: 1, created_at: '2026-07-27T12:00:00Z' }),
      ],
      meId: ME.id,
      now: new Date('2026-07-28T12:00:00Z'),
    });

    // Reading the array bottom-up (which is how the screen renders it): the
    // older day, its separator, then today's message under today's separator.
    expect(rows.map((row) => row.kind)).toEqual([
      'message',
      'day',
      'message',
      'day',
    ]);
    expect(rows.map((row) => (row.kind === 'day' ? row.label : null))).toEqual([
      null,
      'Today',
      null,
      'Yesterday',
    ]);
  });

  it('breaks a run across a day boundary', () => {
    // One person talking either side of midnight is two blocks, not one burst
    // — a run straddling "Yesterday" would read as a single sitting.
    const rows = toThreadRows({
      messages: [
        message({ id: 2, sender: ADA, created_at: '2026-07-28T12:00:00Z' }),
        message({ id: 1, sender: ADA, created_at: '2026-07-27T12:00:00Z' }),
      ],
      meId: ME.id,
      now: new Date('2026-07-28T12:00:00Z'),
    });

    expect(messageRows(rows).map((row) => row.startsRun)).toEqual([true, true]);
  });

  it('drops a message that two pages both sent', () => {
    // The endpoint pages by page *number* over a newest-first list, so a message
    // arriving mid-scroll shifts the window and page 2 re-sends what page 1
    // showed. Two rows sharing a key makes React warn and lets FlatList recycle
    // the wrong one.
    const rows = toThreadRows({
      messages: [message({ id: 2 }), message({ id: 1 }), message({ id: 1 })],
      meId: ME.id,
    });

    expect(messageRows(rows).map((row) => row.message.id)).toEqual([2, 1]);
  });

  it('puts the unread divider above the first message you hadn’t read', () => {
    const rows = toThreadRows({
      messages: [
        message({ id: 3, sender: ADA }),
        message({ id: 2, sender: ADA }),
        message({ id: 1, sender: ME }),
      ],
      meId: ME.id,
      unreadFrom: 2,
    });

    const divider = rows.find((row) => row.kind === 'unread');
    expect(divider).toMatchObject({ kind: 'unread', count: 2 });
    // Directly above message 2 on screen, which is directly after it in a
    // newest-first array.
    const at = rows.findIndex((row) => row.kind === 'unread');
    expect(rows[at - 1]).toMatchObject({ kind: 'message' });
    expect((rows[at - 1] as { message: Message }).message.id).toBe(2);
  });

  it('leaves the unread divider out when there’s nothing unread', () => {
    const rows = toThreadRows({
      messages: [message({ id: 1 })],
      meId: ME.id,
      unreadFrom: null,
    });
    expect(rows.some((row) => row.kind === 'unread')).toBe(false);
  });
});

describe('firstUnreadId', () => {
  it('counts back from the newest', () => {
    const messages = [
      message({ id: 3, sender: ADA }),
      message({ id: 2, sender: ADA }),
      message({ id: 1, sender: ADA }),
    ];
    expect(firstUnreadId(messages, 2, ME.id)).toBe(2);
  });

  it('skips your own messages and tombstones', () => {
    // The server's definition of unread, and the reason the count can't just be
    // an index: your own replies and deleted messages don't count toward it.
    const messages = [
      message({ id: 4, sender: ADA }),
      message({ id: 3, sender: ME }),
      message({ id: 2, sender: ADA, is_deleted: true }),
      message({ id: 1, sender: ADA }),
    ];
    expect(firstUnreadId(messages, 2, ME.id)).toBe(1);
  });

  it('gives up rather than guessing when the unread run is longer than what’s loaded', () => {
    // Better no divider than one at the top of whatever happened to page in,
    // which points at the wrong message. It resolves itself on the next page.
    expect(firstUnreadId([message({ id: 1, sender: ADA })], 5, ME.id)).toBeNull();
  });

  it('is null for a thread with nothing waiting', () => {
    expect(firstUnreadId([message({ id: 1 })], 0, ME.id)).toBeNull();
  });
});
