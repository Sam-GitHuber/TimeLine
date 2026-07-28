/**
 * Reading a message body before it's drawn (Phase 9b M5).
 *
 * Both halves are unit-tested rather than driven through a rendered bubble,
 * because the interesting cases are all about *strings* — a URL with a full stop
 * after it, an emoji made of four code points — and staging each one through a
 * screen would bury the thing under test.
 *
 * The bias worth knowing when reading these: for linkification, a **false
 * positive is the expensive failure**. Missing an exotic URL leaves it as plain
 * text, which is merely the status quo; underlining half a sentence and then
 * opening something nonsensical is a bug people notice and can't work around.
 */

import { isEmojiOnly, linkify } from '@/messageText';

describe('linkify', () => {
  it('leaves ordinary prose as a single run', () => {
    // The overwhelmingly common case, and the one the bubble fast-paths on.
    expect(linkify('meet you at half twelve')).toEqual([
      { kind: 'text', text: 'meet you at half twelve' },
    ]);
  });

  it('finds a URL in the middle of a sentence', () => {
    expect(linkify('look at https://example.com/x today')).toEqual([
      { kind: 'text', text: 'look at ' },
      {
        kind: 'link',
        text: 'https://example.com/x',
        url: 'https://example.com/x',
      },
      { kind: 'text', text: ' today' },
    ]);
  });

  it('leaves a sentence’s full stop out of the link', () => {
    // "have a look at https://example.com." — the stop is the writer's, and
    // including it gives a 404 on the one tap that mattered.
    const segments = linkify('have a look at https://example.com.');
    expect(segments[1]).toEqual({
      kind: 'link',
      text: 'https://example.com',
      url: 'https://example.com',
    });
    expect(segments[2]).toEqual({ kind: 'text', text: '.' });
  });

  it('keeps a bracket that belongs to the URL', () => {
    // Balanced, so it's part of the address rather than the writer's aside.
    const [link] = linkify('https://en.wikipedia.org/wiki/Foo_(bar)');
    expect(link).toEqual({
      kind: 'link',
      text: 'https://en.wikipedia.org/wiki/Foo_(bar)',
      url: 'https://en.wikipedia.org/wiki/Foo_(bar)',
    });
  });

  it('drops an unmatched closing bracket', () => {
    const segments = linkify('(see https://example.com/x)');
    expect(segments[1]).toEqual({
      kind: 'link',
      text: 'https://example.com/x',
      url: 'https://example.com/x',
    });
    expect(segments[2]).toEqual({ kind: 'text', text: ')' });
  });

  it('gives a bare www. address a scheme to open with', () => {
    const [link] = linkify('www.example.com');
    expect(link).toEqual({
      kind: 'link',
      text: 'www.example.com',
      url: 'https://www.example.com',
    });
  });

  it('turns an email address into a mailto', () => {
    const [link] = linkify('ada@example.com');
    expect(link).toEqual({
      kind: 'link',
      text: 'ada@example.com',
      url: 'mailto:ada@example.com',
    });
  });

  it('does not linkify a bare domain', () => {
    // `foo.co` is ambiguous with a missing space after a full stop, and getting
    // it wrong underlines normal writing. Deliberately left alone.
    expect(linkify('I read it on example.com yesterday')).toEqual([
      { kind: 'text', text: 'I read it on example.com yesterday' },
    ]);
  });

  it('finds more than one link in a message', () => {
    const segments = linkify('https://a.example vs https://b.example');
    expect(segments.filter((s) => s.kind === 'link').map((s) => s.text)).toEqual([
      'https://a.example',
      'https://b.example',
    ]);
  });

  it('does not carry state between calls', () => {
    // The pattern is module-level and global, so a shared `lastIndex` would
    // make the second call start halfway through the string — the classic
    // regex-reuse bug, and silent when it happens.
    const first = linkify('https://example.com');
    const second = linkify('https://example.com');
    expect(second).toEqual(first);
  });
});

describe('isEmojiOnly', () => {
  it('is true for a single emoji', () => {
    expect(isEmojiOnly('🎉')).toBe(true);
  });

  it('is true for three, spaced or not', () => {
    expect(isEmojiOnly('🎉🎉🎉')).toBe(true);
    // Someone spacing them out means the same thing as someone who didn't.
    expect(isEmojiOnly('🎉 🎉 🎉')).toBe(true);
  });

  it('is false at four', () => {
    // By four it has stopped reading as a gesture and become a sentence.
    expect(isEmojiOnly('🎉🎉🎉🎉')).toBe(false);
  });

  it('handles an emoji made of several code points', () => {
    // A skin tone is base + modifier; a family is several bases joined. Both are
    // one glyph and must count as one.
    expect(isEmojiOnly('👍🏽')).toBe(true);
    expect(isEmojiOnly('👨‍👩‍👧')).toBe(true);
    expect(isEmojiOnly('👍🏽👨‍👩‍👧')).toBe(true);
  });

  it('is false once there are words in it', () => {
    expect(isEmojiOnly('🎉 congrats')).toBe(false);
    expect(isEmojiOnly('congrats')).toBe(false);
  });

  it('is false for nothing at all', () => {
    expect(isEmojiOnly('')).toBe(false);
    expect(isEmojiOnly('   ')).toBe(false);
  });
});
