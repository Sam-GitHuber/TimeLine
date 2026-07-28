/**
 * How a message's body is read before it's drawn (Phase 9b M5).
 *
 * Two small questions the bubble asks about a string, kept out of the component
 * because both are fiddly enough to be worth unit tests of their own and neither
 * has anything to do with rendering:
 *
 *   - **Are there links in it**, so they can be tapped instead of retyped.
 *   - **Is it nothing but emoji**, in which case it drops the bubble and gets
 *     drawn large.
 *
 * 🔒 **Linkifying is not link *previews*.** The distinction matters, because
 * previews are on the phase's explicit "not building" list: a preview means the
 * *server* fetches every URL anyone pastes, which is a tracking leak and an SSRF
 * surface for a thumbnail. Nothing here fetches anything or renders anything
 * from the target — it decides which characters get an underline and what
 * `Linking.openURL` is handed when one is tapped. The message text is untouched
 * and stays the source of truth, which is also what keeps it a single opaque
 * blob once E2E lands.
 */

export type TextSegment =
  | { kind: 'text'; text: string }
  | { kind: 'link'; text: string; url: string };

/**
 * A URL or an email address inside ordinary prose.
 *
 * Deliberately conservative. The failure that matters is a *false positive* —
 * underlining half a sentence and then opening something nonsensical when it's
 * tapped is far worse than leaving an exotic URL as plain text, which is merely
 * the status quo. So: an explicit scheme, or a bare `www.`, or something that
 * looks like an email; nothing clever about bare domains (`see foo.co` is
 * ambiguous with a missing space after a full stop, and guessing wrong there
 * would linkify normal writing).
 */
const LINK_PATTERN =
  /(?:https?:\/\/|www\.)[^\s<>"']+|[\w.!#$%&'*+/=?^`{|}~-]+@[\w-]+(?:\.[\w-]+)+/gi;

/**
 * Punctuation that ends a *sentence* rather than a URL.
 *
 * "have a look at https://example.com." — the full stop is the writer's, not the
 * link's, and including it gives a 404. Brackets are trimmed only when unmatched,
 * because a closing one can legitimately belong to the URL.
 */
function trimTrailingPunctuation(match: string): string {
  let end = match.length;
  while (end > 0) {
    const char = match[end - 1];
    if ('.,;:!?'.includes(char)) {
      end -= 1;
      continue;
    }
    if (char === ')' || char === ']') {
      const open = char === ')' ? '(' : '[';
      // Everything *before* this bracket: if it left one open, this one closes
      // it and belongs to the URL (Wikipedia does this a lot). If it didn't,
      // the bracket is the writer's, wrapped around the link.
      const body = match.slice(0, end - 1);
      if (body.split(open).length > body.split(char).length) break;
      end -= 1;
      continue;
    }
    break;
  }
  return match.slice(0, end);
}

/** What `Linking.openURL` gets for a matched span. */
function hrefFor(text: string): string {
  if (/^https?:\/\//i.test(text)) return text;
  if (/^www\./i.test(text)) return `https://${text}`;
  return `mailto:${text}`;
}

/**
 * Split a message body into plain runs and tappable ones.
 *
 * Returns a single `text` segment when there's nothing to link, so the bubble
 * can render one `<Text>` in the overwhelmingly common case rather than paying
 * for a map over an array of one.
 */
export function linkify(text: string): TextSegment[] {
  const segments: TextSegment[] = [];
  let cursor = 0;
  // `matchAll` rather than a `while (exec)` loop: the regex is module-level and
  // global, so a shared `lastIndex` across calls is a genuine hazard — this
  // resets it per call by construction.
  for (const match of text.matchAll(LINK_PATTERN)) {
    const raw = match[0];
    const trimmed = trimTrailingPunctuation(raw);
    // Wholly punctuation after trimming (an email match can't be), or the
    // remains of something like "https://" alone — not worth a link.
    if (!/[a-z0-9]/i.test(trimmed) || /^https?:\/\/$/i.test(trimmed)) continue;
    const start = match.index;
    if (start > cursor) {
      segments.push({ kind: 'text', text: text.slice(cursor, start) });
    }
    segments.push({ kind: 'link', text: trimmed, url: hrefFor(trimmed) });
    cursor = start + trimmed.length;
  }
  if (segments.length === 0) return [{ kind: 'text', text }];
  if (cursor < text.length) {
    segments.push({ kind: 'text', text: text.slice(cursor) });
  }
  return segments;
}

/**
 * How many emoji a message can be and still be drawn large.
 *
 * Three is the number the category converged on, and it's the right one: a
 * single 🎉 is the clearest case, and by four the "this is a gesture, not a
 * sentence" reading has gone.
 */
const MAX_LARGE_EMOJI = 3;

/**
 * Built lazily and behind a `try`, which is not defensive clutter.
 *
 * `\p{...}` property escapes need RegExp Unicode property support. Every engine
 * we run on has it, but "every engine we run on" includes whatever Hermes ships
 * in a future Expo SDK, and a module-level `new RegExp` that throws takes the
 * *app* down at import — for a typographic nicety. `null` means "we couldn't
 * ask", which falls through to an ordinary bubble.
 */
let emojiOnlyPattern: RegExp | null | undefined;

function emojiOnlyRegExp(): RegExp | null {
  if (emojiOnlyPattern !== undefined) return emojiOnlyPattern;
  try {
    // One "emoji" = a pictographic base, optionally a skin-tone modifier or a
    // presentation selector, optionally joined to more of the same (a family is
    // several code points and one glyph). Between one and MAX_LARGE_EMOJI of
    // those, and nothing else at all.
    emojiOnlyPattern = new RegExp(
      '^(?:\\p{Extended_Pictographic}(?:\\p{Emoji_Modifier}|\\uFE0F)?' +
        '(?:\\u200D\\p{Extended_Pictographic}(?:\\p{Emoji_Modifier}|\\uFE0F)?)*)' +
        `{1,${MAX_LARGE_EMOJI}}$`,
      'u'
    );
  } catch {
    emojiOnlyPattern = null;
  }
  return emojiOnlyPattern;
}

/**
 * Whether this message is a reaction-in-a-message: one to three emoji and
 * nothing else, which every mainstream messenger draws big and bubble-less.
 *
 * Whitespace is stripped first, so "🎉 🎉" counts as two — someone spacing them
 * out means the same thing as someone who didn't.
 */
export function isEmojiOnly(text: string): boolean {
  const pattern = emojiOnlyRegExp();
  if (!pattern) return false;
  const stripped = text.replace(/\s/g, '');
  if (!stripped) return false;
  return pattern.test(stripped);
}
