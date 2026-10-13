/**
 * The pending layer's arithmetic (#393) — the part of an optimistic reaction,
 * edit or delete that is pure, and so the part worth pinning without a screen.
 *
 * What the screen does with it is in `thread.test.tsx`.
 */

import { asTombstone, present, withReaction } from '@/pendingWrites';
import type { Message } from '@/types';

const ADA = { id: 2, display_name: 'Ada Lovelace', avatar_thumb: null };

function message(overrides: Partial<Message> = {}): Message {
  return {
    id: 1,
    sender: ADA,
    text: 'hello',
    is_deleted: false,
    is_edited: false,
    created_at: '2026-01-01T10:00:00Z',
    edited_at: null,
    reactions: [],
    ...overrides,
  } as Message;
}

describe('withReaction', () => {
  it('adds a pill for an emoji nobody has used', () => {
    expect(withReaction([], '👍', true)).toEqual([
      { emoji: '👍', count: 1, reacted: true },
    ]);
  });

  it('joins a pill someone else started', () => {
    expect(
      withReaction([{ emoji: '👍', count: 2, reacted: false }], '👍', true)
    ).toEqual([{ emoji: '👍', count: 3, reacted: true }]);
  });

  it('leaves the others’ count when yours comes off', () => {
    expect(
      withReaction([{ emoji: '👍', count: 2, reacted: true }], '👍', false)
    ).toEqual([{ emoji: '👍', count: 1, reacted: false }]);
  });

  it('drops the pill when yours was the only one', () => {
    expect(
      withReaction([{ emoji: '👍', count: 1, reacted: true }], '👍', false)
    ).toEqual([]);
  });

  /**
   * The property the whole layer rests on. A poll can land carrying the write
   * while its own response is still on the way; applied to that list the
   * pending entry has to change nothing, or the count is doubled (or the pill
   * you just added is taken off again).
   */
  it('changes nothing when the list already says so', () => {
    const on = [{ emoji: '👍', count: 1, reacted: true }];
    expect(withReaction(on, '👍', true)).toBe(on);
    const off = [{ emoji: '👍', count: 1, reacted: false }];
    expect(withReaction(off, '👍', false)).toBe(off);
    expect(withReaction(undefined, '👍', false)).toEqual([]);
  });

  it('orders like the server: by count, then by emoji', () => {
    expect(
      withReaction(
        [
          { emoji: '😂', count: 2, reacted: false },
          { emoji: '👍', count: 1, reacted: false },
        ],
        '👍',
        true
      ).map((r) => r.emoji)
    ).toEqual(['👍', '😂']);
  });

  it('doesn’t mutate the list it was given', () => {
    const before = [
      { emoji: '😂', count: 1, reacted: false },
      { emoji: '👍', count: 1, reacted: false },
    ];
    const copy = JSON.parse(JSON.stringify(before));
    withReaction(before, '👍', true);
    expect(before).toEqual(copy);
  });
});

describe('present', () => {
  it('hands back the same list when nothing touches it', () => {
    const messages = [message({ id: 1 }), message({ id: 2 })];
    expect(present(messages, {})).toBe(messages);
    expect(present(messages, { 99: { deleted: true } })).toBe(messages);
  });

  it('keeps the identity of every message nothing is pending against', () => {
    const messages = [message({ id: 1 }), message({ id: 2 })];
    const shown = present(messages, { 2: { edit: { text: 'fixed', token: 1 } } });
    expect(shown[0]).toBe(messages[0]);
    expect(shown[1]).toMatchObject({ text: 'fixed', is_edited: true });
  });

  it('draws a pending delete as the tombstone the server would send', () => {
    const photo = message({
      id: 1,
      text: 'caption',
      attachments: [{ id: 9 }] as Message['attachments'],
      reactions: [{ emoji: '👍', count: 1, reacted: false }],
    });
    const [shown] = present([photo], { 1: { deleted: true } });
    expect(shown).toEqual(asTombstone(photo));
    expect(shown).toMatchObject({ text: '', is_deleted: true, attachments: [] });
    // A tombstone keeps the reactions left before the delete (reactions.md).
    expect(shown.reactions).toHaveLength(1);
  });

  it('applies an edit and a reaction to the same message together', () => {
    const [shown] = present([message({ id: 1 })], {
      1: {
        edit: { text: 'fixed', token: 1 },
        reactions: [{ emoji: '👍', on: true, token: 2 }],
      },
    });
    expect(shown.text).toBe('fixed');
    expect(shown.reactions).toEqual([{ emoji: '👍', count: 1, reacted: true }]);
  });
});
