/**
 * How a message's body is read before it's drawn (Phase 9b M9b).
 *
 * A port of `mobile/src/messageText.ts` — the same parser the app has run since
 * M5, retyped rather than rewritten, comments included. The whole point of M9 is
 * that the two clients stop diverging on what a message *says*, and two parsers
 * with the same job and different edge cases is precisely how that starts. If
 * one of these changes, change the other.
 *
 * Two small questions the bubble asks about a string, kept out of the component
 * because both are fiddly enough to be worth unit tests of their own and neither
 * has anything to do with rendering:
 *
 *   - **What is in it** — links to be clicked, and `*bold*` / `_italic_` /
 *     `~strikethrough~` / `` `monospace` `` runs to be styled.
 *   - **Is it nothing but emoji**, in which case it drops the bubble and gets
 *     drawn large.
 *
 * 🔒 **Nothing here rewrites the message.** The raw string stays the source of
 * truth — the markup characters are *not* stripped on the way into the database,
 * they're simply not drawn — which keeps an edit round-tripping exactly what was
 * typed and keeps the body a single opaque blob once E2E lands. It's also why
 * this is a render-time parse and not a send-time transform.
 *
 * 🔒 **Linkifying is not link *previews*.** The distinction matters, because
 * previews are on the phase's explicit "not building" list: a preview means the
 * *server* fetches every URL anyone pastes, which is a tracking leak and an SSRF
 * surface for a thumbnail. Nothing here fetches anything or renders anything
 * from the target — it decides which characters get an underline and what an
 * `<a href>` points at when one is clicked.
 *
 * Mentions are parsed here too (the app's M8), but nothing on the web passes
 * `mentions` yet: the drawer has no `@` picker and no name map until M9f, which
 * is what turns a message's bare mention ids back into names to look for.
 */

/**
 * A URL or an email address inside ordinary prose.
 *
 * Deliberately conservative. The failure that matters is a *false positive* —
 * underlining half a sentence and then opening something nonsensical when it's
 * clicked is far worse than leaving an exotic URL as plain text, which is merely
 * the status quo. So: an explicit scheme, or a bare `www.`, or something that
 * looks like an email; nothing clever about bare domains (`see foo.co` is
 * ambiguous with a missing space after a full stop, and guessing wrong there
 * would linkify normal writing).
 *
 * **Sticky (`y`), not global.** The scanner below asks "does a link start *here*"
 * at each index rather than searching the whole string, which is what lets links
 * and formatting be found in one walk instead of two passes fighting over the
 * same characters. `lastIndex` is assigned before every use, so the shared state
 * a sticky regex carries can't leak between calls.
 */
const LINK_AT =
  /(?:https?:\/\/|www\.)[^\s<>"']+|[\w.!#$%&'*+/=?^`{|}~-]+@[\w-]+(?:\.[\w-]+)+/iy;

/**
 * Punctuation that ends a *sentence* rather than a URL.
 *
 * "have a look at https://example.com." — the full stop is the writer's, not the
 * link's, and including it gives a 404. Brackets are trimmed only when unmatched,
 * because a closing one can legitimately belong to the URL.
 */
function trimTrailingPunctuation(match) {
  let end = match.length;
  while (end > 0) {
    const char = match[end - 1];
    if (".,;:!?".includes(char)) {
      end -= 1;
      continue;
    }
    if (char === ")" || char === "]") {
      const open = char === ")" ? "(" : "[";
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

/** What the `<a href>` gets for a matched span. */
function hrefFor(text) {
  if (/^https?:\/\//i.test(text)) return text;
  if (/^www\./i.test(text)) return `https://${text}`;
  return `mailto:${text}`;
}

/**
 * The four delimiters, and what each one means.
 *
 * These are the characters people already type out of habit, and a message full
 * of stray asterisks is the visible symptom of an app that doesn't know them.
 * Deliberately the same four the category converged on — nothing invented here,
 * because the whole value is that nobody has to learn it.
 */
const DELIMITERS = {
  "*": "bold",
  _: "italic",
  "~": "strike",
  "`": "mono",
};

/** Letters and digits, for the boundary rules below. */
function isWordChar(char) {
  return char !== undefined && /[\p{L}\p{N}]/u.test(char);
}

/**
 * Whether the delimiter at `i` can *open* a run.
 *
 * The boundary rules are the whole reason this doesn't wreck ordinary writing:
 * `snake_case_name`, `2*3*4` and `a~b` all have a word character immediately
 * before the delimiter, so none of them opens anything. And a delimiter with
 * whitespace after it ("a * b") is arithmetic or a bullet, not emphasis.
 */
function canOpen(text, i) {
  const before = text[i - 1];
  const after = text[i + 1];
  if (isWordChar(before)) return false;
  if (after === undefined || /\s/.test(after)) return false;
  // `**` is someone leaning on the key, not an empty bold run.
  return after !== text[i];
}

/**
 * Where the run opened at `open` closes, or -1 if it never does.
 *
 * A closer is the same character with a non-space before it and a non-word
 * character (or nothing) after it — so `*bold*` closes and `*not*here` doesn't,
 * which is what keeps a stray asterisk mid-word from swallowing the rest of the
 * sentence.
 */
function findClose(text, open) {
  const delimiter = text[open];
  for (let i = open + 2; i < text.length; i += 1) {
    if (text[i] !== delimiter) continue;
    if (/\s/.test(text[i - 1])) continue;
    if (isWordChar(text[i + 1])) continue;
    return i;
  }
  return -1;
}

/**
 * Walk one run of text, emitting segments as it goes.
 *
 * **One walk for links and formatting together**, rather than linkifying and
 * then formatting the pieces (or the reverse). Two passes would fight: a URL
 * full of underscores is not italic, and a `` `code span` `` containing a URL is
 * not a link. Asking "link here? delimiter here?" at each index settles both
 * questions in the order the characters actually appear.
 *
 * `marks` accumulates down the recursion, so `*bold _and italic_*` renders as
 * both rather than as whichever won.
 */
function scan(text, marks, out, { links, mentions }) {
  let plainFrom = 0;
  let i = 0;

  /** Flush the plain characters between the last emission and `end`. */
  function flush(end) {
    if (end <= plainFrom) return;
    push(out, { kind: "text", text: text.slice(plainFrom, end) }, marks);
  }

  while (i < text.length) {
    // Mentions before links, because an `@` is where an email address would
    // otherwise start matching and "@Ada" is not one. Longest name first, so
    // "@Ada Lovelace" isn't cut down to "@Ada" by a second Ada in the room.
    if (text[i] === "@") {
      const name = mentions.find(
        (candidate) =>
          text.startsWith(candidate, i + 1) &&
          // Not mid-word: "@Ada" must not match inside "@Adam".
          !isWordChar(text[i + 1 + candidate.length])
      );
      if (name) {
        flush(i);
        push(out, { kind: "mention", text: `@${name}` }, marks);
        i += name.length + 1;
        plainFrom = i;
        continue;
      }
    }

    if (links) {
      LINK_AT.lastIndex = i;
      const match = LINK_AT.exec(text);
      if (match) {
        const trimmed = trimTrailingPunctuation(match[0]);
        // Wholly punctuation after trimming (an email match can't be), or the
        // remains of something like "https://" alone — not worth a link.
        if (/[a-z0-9]/i.test(trimmed) && !/^https?:\/\/$/i.test(trimmed)) {
          flush(i);
          push(out, { kind: "link", text: trimmed, url: hrefFor(trimmed) }, marks);
          i += trimmed.length;
          plainFrom = i;
          continue;
        }
      }
    }

    const mark = DELIMITERS[text[i]];
    if (mark && canOpen(text, i)) {
      const close = findClose(text, i);
      if (close > 0) {
        flush(i);
        const inner = text.slice(i + 1, close);
        // Monospace is literal by definition: no emphasis inside it, and no
        // linkifying either — a URL in a code span is being *quoted*, and
        // underlining it would make the one thing shown verbatim clickable.
        if (mark === "mono") {
          push(out, { kind: "text", text: inner }, [...marks, "mono"]);
        } else {
          scan(inner, [...marks, mark], out, { links, mentions });
        }
        i = close + 1;
        plainFrom = i;
        continue;
      }
    }

    i += 1;
  }

  flush(text.length);
}

/**
 * Emit one segment, carrying the current marks and merging with the run before
 * it where possible.
 *
 * The merge is what keeps the common case cheap: an unformatted message comes
 * out as a single `text` segment, so the bubble renders one paragraph rather
 * than a map over an array of one.
 */
function push(out, segment, marks) {
  const previous = out[out.length - 1];
  if (
    segment.kind === "text" &&
    marks.length === 0 &&
    previous?.kind === "text" &&
    !previous.marks
  ) {
    previous.text += segment.text;
    return;
  }
  out.push(marks.length > 0 ? { ...segment, marks } : segment);
}

/**
 * Split a message body into the runs a bubble draws: plain text, styled text,
 * and clickable links.
 *
 * Returns a single `text` segment when there's nothing to mark up, which is the
 * overwhelmingly common case and the one the bubble fast-paths on.
 */
export function parseMessageText(text, { mentions = [] } = {}) {
  const segments = [];
  // Longest first: two people in a group can be "Ada" and "Ada Lovelace", and
  // matching the shorter one first would leave half the second name as prose.
  const names = [...mentions].sort((a, b) => b.length - a.length);
  scan(text, [], segments, { links: true, mentions: names });
  return segments.length > 0 ? segments : [{ kind: "text", text }];
}

/**
 * The same words with the markup characters dropped and nothing styled.
 *
 * For the places a message appears as *one line of plain text* — a conversation
 * row's preview, a collapsed quote. Those can't carry emphasis, and showing the
 * raw `*asterisks*` there while the bubble two inches away renders them is
 * exactly the "half-finished" seam this milestone is closing.
 *
 * The editing bar is deliberately **not** one of them: it labels a message you
 * are about to rewrite, and the composer below it holds the raw string you'll
 * actually be editing. Showing a cleaned-up version above the source you're
 * typing into would be the one place where dropping the markup misleads.
 */
export function plainMessageText(text) {
  return parseMessageText(text)
    .map((segment) => segment.text)
    .join("");
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
 * `\p{...}` property escapes need RegExp Unicode property support. Every browser
 * we support has it, but a module-level `new RegExp` that throws takes down the
 * whole bundle at import — for a typographic nicety. `null` means "we couldn't
 * ask", which falls through to an ordinary bubble.
 */
let emojiOnlyPattern;

function emojiOnlyRegExp() {
  if (emojiOnlyPattern !== undefined) return emojiOnlyPattern;
  try {
    // One "emoji" = a pictographic base, optionally a skin-tone modifier or a
    // presentation selector, optionally joined to more of the same (a family is
    // several code points and one glyph). Between one and MAX_LARGE_EMOJI of
    // those, and nothing else at all.
    emojiOnlyPattern = new RegExp(
      "^(?:\\p{Extended_Pictographic}(?:\\p{Emoji_Modifier}|\\uFE0F)?" +
        "(?:\\u200D\\p{Extended_Pictographic}(?:\\p{Emoji_Modifier}|\\uFE0F)?)*)" +
        `{1,${MAX_LARGE_EMOJI}}$`,
      "u"
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
export function isEmojiOnly(text) {
  const pattern = emojiOnlyRegExp();
  if (!pattern) return false;
  const stripped = text.replace(/\s/g, "");
  if (!stripped) return false;
  return pattern.test(stripped);
}
