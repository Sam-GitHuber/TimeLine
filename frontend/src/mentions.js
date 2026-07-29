/**
 * Typing an `@mention` (Phase 9b M8 on the phone, M9f here) — the composer half.
 *
 * A port of `mobile/src/mentions.ts`, comments included. The four string
 * questions below are character-for-character the app's, because the whole point
 * of M9 is that the two clients stop disagreeing about what a message *is*: if
 * one of these changes, change the other. Only the hook differs, and it differs
 * for one reason spelled out on `useMentions`.
 *
 * **What the server is told, and what it isn't.** A mention is sent as a list of
 * **user ids**, worked out here from what you picked — never left for the server
 * to find by matching names in the text. Names change, two people in a family
 * can share one, and once the words are ciphertext there is nothing on the
 * server to match against. This module is where the id and the typed name are
 * held together, and `mentionIdsIn` is the moment they're reconciled: only the
 * people whose names still appear in what you actually sent are named.
 *
 * 🔒 A mention is the one thing that beats a muted thread, so the server checks
 * every id is an active participant. This module offers only people the screen
 * hands it, which is that same set — but it's the server's check that's
 * load-bearing, not this one.
 */

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";

/** How many suggestions the picker shows at once. */
const MAX_SUGGESTIONS = 6;

/**
 * The half-typed `@…` immediately before the cursor, if there is one.
 *
 * Anchored on the cursor rather than searched for anywhere in the text, because
 * "am I mentioning someone *right now*" is a question about where you're
 * typing — going back to fix a typo three words earlier must not reopen a picker
 * over the message.
 *
 * The `@` has to start a word (the beginning of the message, or after
 * whitespace), which is what keeps an email address from opening the picker
 * halfway through being typed. Everything from the `@` to the cursor is the
 * query, and it stops at the first space: display names contain spaces, but a
 * query that could span them would keep matching after you'd moved on to the
 * rest of the sentence.
 */
export function mentionQuery(text, cursor) {
  const before = text.slice(0, cursor);
  const at = before.lastIndexOf("@");
  if (at < 0) return null;
  const preceding = before[at - 1];
  if (preceding !== undefined && !/\s/.test(preceding)) return null;
  const query = before.slice(at + 1);
  if (/\s/.test(query)) return null;
  return { query, from: at };
}

/** Whether `person` answers to `query` — matched on any part of their name, so
 * "@lov" finds Ada Lovelace and an empty query (a bare `@`) offers everyone. */
function matches(person, query) {
  if (!query) return true;
  const needle = query.toLowerCase();
  return person.display_name
    .toLowerCase()
    .split(/\s+/)
    .some((part) => part.startsWith(needle));
}

/** Who to offer for a query, capped so the picker never covers the thread. */
export function matchMentionable(people, query) {
  return people.filter((person) => matches(person, query)).slice(0, MAX_SUGGESTIONS);
}

/**
 * Replace the half-typed query with the whole name, and say where the cursor
 * should land.
 *
 * A trailing space is part of the insertion: you have just finished naming
 * someone and the next thing you type is a word, not more of their name — and
 * without it the parser's "not mid-word" rule would refuse to highlight a
 * mention you immediately typed punctuation onto.
 */
export function applyMention(text, from, cursor, name) {
  const inserted = `@${name} `;
  return {
    text: text.slice(0, from) + inserted + text.slice(cursor),
    cursor: from + inserted.length,
  };
}

/**
 * Which of the people you picked are still named in `text`.
 *
 * Checked against the words rather than trusted from the picker, because a
 * mention can be *un*-typed: pick Ada, change your mind, delete her name, send.
 * Sending her id anyway would buzz her muted thread about a message that doesn't
 * mention her — a small thing that would feel like the app talking behind your
 * back.
 */
export function mentionIdsIn(text, picked) {
  const ids = picked
    .filter((person) => text.includes(`@${person.display_name}`))
    .map((person) => person.id);
  return [...new Set(ids)];
}

/**
 * The composer's mention state: what to suggest, what to do when one is chosen,
 * and which ids to send.
 *
 * `text`/`setText` belong to the composer (it's an ordinary controlled textarea
 * and this only ever rewrites it on a pick).
 *
 * **The one place this diverges from the app, and why.** The app *estimates* the
 * caret from the size of each edit, because a React Native `TextInput` reports
 * its selection a beat later and sometimes not at all — so waiting for the
 * report would mean a picker that opens a keystroke behind what you typed. A DOM
 * `<textarea>` has no such problem: `selectionStart` is readable synchronously
 * on the very event that changed the text, so the caret is simply *read* here.
 * The estimate would be strictly worse — it can't tell typing from a paste, an
 * undo, or a drag-and-drop, all of which a browser has and a phone keyboard
 * doesn't.
 *
 * The other half of the same difference is that a pick *sets* the caret here,
 * where the app deliberately leaves it alone (controlling `selection` on a
 * multiline RN input fights the keyboard). On the web, choosing a name is a
 * click on a button, which takes focus off the textarea — so putting focus back,
 * after the inserted name, is what keeps naming someone mid-sentence from
 * dumping you at the end of the message with the keyboard gone.
 */
export function useMentions({ people, text, setText, inputRef }) {
  /** Where the caret is, as last reported by the textarea. */
  const [cursor, setCursor] = useState(() => text.length);
  /**
   * Everyone picked while writing this message. Kept in full rather than reduced
   * to ids straight away, because the *name* is what `mentionIdsIn` reconciles
   * against the final text — and kept even after a name is deleted, since it
   * costs nothing and re-typing the name by hand should still count.
   */
  const [picked, setPicked] = useState([]);
  /**
   * Where to put the caret once the inserted name has actually been painted.
   * A `<textarea>`'s value is controlled, so its DOM value is still the old
   * string during the click handler — setting the selection there would clamp to
   * the wrong length.
   */
  const pendingCaret = useRef(null);

  // Clamped, because the text can also change out from under the caret: edit
  // mode drops a whole message into the composer, and a stale offset past the
  // end would look for an `@` that isn't there.
  const caret = Math.min(cursor, text.length);
  const query = useMemo(() => mentionQuery(text, caret), [text, caret]);
  const suggestions = useMemo(
    () => (query && people.length > 0 ? matchMentionable(people, query.query) : []),
    [query, people]
  );

  useLayoutEffect(() => {
    const at = pendingCaret.current;
    if (at === null) return;
    pendingCaret.current = null;
    const el = inputRef?.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(at, at);
  }, [text, inputRef]);

  const choose = useCallback(
    (person) => {
      if (!query) return;
      const next = applyMention(text, query.from, caret, person.display_name);
      setText(next.text);
      // Tracked here as well as in the layout effect, so the picker closes on
      // this render rather than waiting for the textarea to report its new
      // selection a frame later.
      setCursor(next.cursor);
      pendingCaret.current = next.cursor;
      setPicked((current) =>
        current.some((p) => p.id === person.id) ? current : [...current, person]
      );
    },
    [query, text, caret, setText]
  );

  return {
    suggestions,
    choose,
    /**
     * What the composer's `onChange` should call — the new value and the caret
     * that came with it, both read off the same event.
     */
    onChange: useCallback(
      (value, at) => {
        setCursor(at ?? value.length);
        setText(value);
      },
      [setText]
    ),
    /**
     * The textarea's own report of where the caret is (its `onSelect`), which is
     * what keeps clicking into the middle of a sentence from opening a picker
     * over the word you left behind.
     */
    onCaretMove: useCallback((at) => setCursor(at), []),
    /** The ids to send with `value` — see `mentionIdsIn`. */
    idsFor: useCallback((value) => mentionIdsIn(value, picked), [picked]),
    /** Start again after a send, or on leaving edit mode. */
    reset: useCallback(() => setPicked([]), []),
  };
}
