/**
 * Reading a message body before it's drawn (Phase 9b M5, extended in M8).
 *
 * Every half is unit-tested rather than driven through a rendered bubble,
 * because the interesting cases are all about *strings* — a URL with a full stop
 * after it, an emoji made of four code points, an underscore in the middle of a
 * filename — and staging each one through a screen would bury the thing under
 * test.
 *
 * The bias worth knowing when reading these: a **false positive is the expensive
 * failure**, for both halves of the parse. Missing an exotic URL leaves it as
 * plain text, which is merely the status quo; underlining half a sentence and
 * opening something nonsensical is a bug people notice and can't work around.
 * Likewise, leaving `*` on screen is a shrug — italicising half of someone's
 * `snake_case_variable` is the app corrupting what they wrote.
 */

import { isEmojiOnly, parseMessageText } from '@/messageText';

describe('parseMessageText — links', () => {
  it('leaves ordinary prose as a single run', () => {
    // The overwhelmingly common case, and the one the bubble fast-paths on.
    expect(parseMessageText('meet you at half twelve')).toEqual([
      { kind: 'text', text: 'meet you at half twelve' },
    ]);
  });

  it('finds a URL in the middle of a sentence', () => {
    expect(parseMessageText('look at https://example.com/x today')).toEqual([
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
    const segments = parseMessageText('have a look at https://example.com.');
    expect(segments[1]).toEqual({
      kind: 'link',
      text: 'https://example.com',
      url: 'https://example.com',
    });
    expect(segments[2]).toEqual({ kind: 'text', text: '.' });
  });

  it('keeps a bracket that belongs to the URL', () => {
    // Balanced, so it's part of the address rather than the writer's aside.
    const [link] = parseMessageText('https://en.wikipedia.org/wiki/Foo_(bar)');
    expect(link).toEqual({
      kind: 'link',
      text: 'https://en.wikipedia.org/wiki/Foo_(bar)',
      url: 'https://en.wikipedia.org/wiki/Foo_(bar)',
    });
  });

  it('drops an unmatched closing bracket', () => {
    const segments = parseMessageText('(see https://example.com/x)');
    expect(segments[1]).toEqual({
      kind: 'link',
      text: 'https://example.com/x',
      url: 'https://example.com/x',
    });
    expect(segments[2]).toEqual({ kind: 'text', text: ')' });
  });

  it('gives a bare www. address a scheme to open with', () => {
    const [link] = parseMessageText('www.example.com');
    expect(link).toEqual({
      kind: 'link',
      text: 'www.example.com',
      url: 'https://www.example.com',
    });
  });

  it('turns an email address into a mailto', () => {
    const [link] = parseMessageText('ada@example.com');
    expect(link).toEqual({
      kind: 'link',
      text: 'ada@example.com',
      url: 'mailto:ada@example.com',
    });
  });

  it('does not linkify a bare domain', () => {
    // `foo.co` is ambiguous with a missing space after a full stop, and getting
    // it wrong underlines normal writing. Deliberately left alone.
    expect(parseMessageText('I read it on example.com yesterday')).toEqual([
      { kind: 'text', text: 'I read it on example.com yesterday' },
    ]);
  });

  it('finds more than one link in a message', () => {
    const segments = parseMessageText('https://a.example vs https://b.example');
    expect(segments.filter((s) => s.kind === 'link').map((s) => s.text)).toEqual([
      'https://a.example',
      'https://b.example',
    ]);
  });

  it('does not carry state between calls', () => {
    // The pattern is module-level and global, so a shared `lastIndex` would
    // make the second call start halfway through the string — the classic
    // regex-reuse bug, and silent when it happens.
    const first = parseMessageText('https://example.com');
    const second = parseMessageText('https://example.com');
    expect(second).toEqual(first);
  });
});

describe('parseMessageText — formatting', () => {
  it('renders the four marks, without their delimiters', () => {
    expect(parseMessageText('*bold*')).toEqual([
      { kind: 'text', text: 'bold', marks: ['bold'] },
    ]);
    expect(parseMessageText('_italic_')).toEqual([
      { kind: 'text', text: 'italic', marks: ['italic'] },
    ]);
    expect(parseMessageText('~gone~')).toEqual([
      { kind: 'text', text: 'gone', marks: ['strike'] },
    ]);
    expect(parseMessageText('`code`')).toEqual([
      { kind: 'text', text: 'code', marks: ['mono'] },
    ]);
  });

  it('marks a run inside a sentence', () => {
    expect(parseMessageText('it is *very* good')).toEqual([
      { kind: 'text', text: 'it is ' },
      { kind: 'text', text: 'very', marks: ['bold'] },
      { kind: 'text', text: ' good' },
    ]);
  });

  it('nests marks rather than letting one win', () => {
    expect(parseMessageText('*bold _and italic_*')).toEqual([
      { kind: 'text', text: 'bold ', marks: ['bold'] },
      { kind: 'text', text: 'and italic', marks: ['bold', 'italic'] },
    ]);
  });

  it('leaves snake_case and arithmetic alone', () => {
    // The delimiter has a word character before it, so it opens nothing. This is
    // the rule that stops the feature corrupting ordinary writing, and it's the
    // one worth breaking a test over.
    expect(parseMessageText('call read_file_sync twice')).toEqual([
      { kind: 'text', text: 'call read_file_sync twice' },
    ]);
    expect(parseMessageText('2*3*4 = 24')).toEqual([
      { kind: 'text', text: '2*3*4 = 24' },
    ]);
  });

  it('needs something to close, and something inside', () => {
    // A lone asterisk is someone typing an asterisk.
    expect(parseMessageText('*not closed')).toEqual([
      { kind: 'text', text: '*not closed' },
    ]);
    expect(parseMessageText('5 * 3')).toEqual([{ kind: 'text', text: '5 * 3' }]);
    expect(parseMessageText('**')).toEqual([{ kind: 'text', text: '**' }]);
  });

  it('does not close mid-word', () => {
    // `*not*here` would otherwise swallow the rest of the sentence into bold.
    expect(parseMessageText('*not*here')).toEqual([
      { kind: 'text', text: '*not*here' },
    ]);
  });

  it('treats a code span as literal — no emphasis, no links inside it', () => {
    expect(parseMessageText('`a_b_c`')).toEqual([
      { kind: 'text', text: 'a_b_c', marks: ['mono'] },
    ]);
    // The one place a URL is deliberately *not* tappable: it's being quoted.
    expect(parseMessageText('`https://example.com`')).toEqual([
      { kind: 'text', text: 'https://example.com', marks: ['mono'] },
    ]);
  });

  it('does not format inside a URL', () => {
    // Links and marks are found in one walk, so the URL is consumed whole and
    // its underscores never reach the emphasis rules.
    expect(parseMessageText('https://example.com/a_b_c_d')).toEqual([
      {
        kind: 'link',
        text: 'https://example.com/a_b_c_d',
        url: 'https://example.com/a_b_c_d',
      },
    ]);
  });

  it('carries the marks onto a link inside a formatted run', () => {
    expect(parseMessageText('*see https://example.com*')).toEqual([
      { kind: 'text', text: 'see ', marks: ['bold'] },
      {
        kind: 'link',
        text: 'https://example.com',
        url: 'https://example.com',
        marks: ['bold'],
      },
    ]);
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
