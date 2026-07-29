/**
 * Typing an `@mention` (Phase 9b M8) — the composer half.
 *
 * Four small string questions and one hook, kept out of the two composers that
 * need them (the transcript's and the focused strand's) so both behave
 * identically and the fiddly parts can be unit-tested as strings.
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

import { useCallback, useMemo, useState } from 'react';

/** Someone who can be named — the shape a `Participant` already has. */
export type Mentionable = { id: number; display_name: string };

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
export function mentionQuery(
  text: string,
  cursor: number
): { query: string; from: number } | null {
  const before = text.slice(0, cursor);
  const at = before.lastIndexOf('@');
  if (at < 0) return null;
  const preceding = before[at - 1];
  if (preceding !== undefined && !/\s/.test(preceding)) return null;
  const query = before.slice(at + 1);
  if (/\s/.test(query)) return null;
  return { query, from: at };
}

/** Whether `person` answers to `query` — matched on any part of their name, so
 * "@lov" finds Ada Lovelace and an empty query (a bare `@`) offers everyone. */
function matches(person: Mentionable, query: string): boolean {
  if (!query) return true;
  const needle = query.toLowerCase();
  return person.display_name
    .toLowerCase()
    .split(/\s+/)
    .some((part) => part.startsWith(needle));
}

/** Who to offer for a query, capped so the picker never covers the thread. */
export function matchMentionable(
  people: Mentionable[],
  query: string
): Mentionable[] {
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
export function applyMention(
  text: string,
  from: number,
  cursor: number,
  name: string
): { text: string; cursor: number } {
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
export function mentionIdsIn(text: string, picked: Mentionable[]): number[] {
  const ids = picked
    .filter((person) => text.includes(`@${person.display_name}`))
    .map((person) => person.id);
  return [...new Set(ids)];
}

/**
 * The composer's mention state: what to suggest, what to do when one is chosen,
 * and which ids to send.
 *
 * `text`/`setText` belong to the composer (it's an ordinary controlled input and
 * this only ever rewrites it on a pick), and the cursor is tracked from the
 * input's `onSelectionChange`.
 */
export function useMentions({
  people,
  text,
  setText,
}: {
  people: Mentionable[];
  text: string;
  setText: (value: string) => void;
}) {
  /**
   * Where the caret is.
   *
   * **Estimated from each edit and corrected by the platform**, rather than read
   * only from `onSelectionChange`. Typing happens at the caret, so an edit moves
   * it by the change in length — which means the picker works from the first
   * character typed, without waiting for a selection event that arrives a beat
   * later (and, in a test or on a platform that reports selection lazily, might
   * not arrive at all). Moving the caret by hand still reports itself, and that
   * report wins.
   */
  const [cursor, setCursor] = useState(() => text.length);
  /**
   * Everyone picked while writing this message. Kept in full rather than reduced
   * to ids straight away, because the *name* is what `mentionIdsIn` reconciles
   * against the final text — and kept even after a name is deleted, since it
   * costs nothing and re-typing the name by hand should still count.
   */
  const [picked, setPicked] = useState<Mentionable[]>([]);

  // Clamped, because the text can also change out from under the caret: edit
  // mode drops a whole message into the composer, and a stale offset past the
  // end would look for an `@` that isn't there.
  const caret = Math.min(cursor, text.length);
  const query = useMemo(() => mentionQuery(text, caret), [text, caret]);
  const suggestions = useMemo(
    () => (query && people.length > 0 ? matchMentionable(people, query.query) : []),
    [query, people]
  );

  const choose = useCallback(
    (person: Mentionable) => {
      if (!query) return;
      const next = applyMention(text, query.from, caret, person.display_name);
      setText(next.text);
      // Tracked optimistically so the picker closes on this render rather than
      // waiting for the input to report its new selection a frame later. The
      // input's own cursor is left alone: controlling `selection` on a
      // multiline RN TextInput fights the keyboard, and an inserted name is
      // almost always at the end anyway.
      setCursor(next.cursor);
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
     * What the composer's `onChangeText` should call: it sets the text *and*
     * moves the estimated caret by the size of the edit, which is what makes
     * the picker appear on the keystroke rather than a frame later.
     */
    onChangeText: useCallback(
      (value: string) => {
        setCursor((current) =>
          Math.max(
            0,
            Math.min(value.length, current + (value.length - text.length))
          )
        );
        setText(value);
      },
      [text, setText]
    ),
    /**
     * The platform's own report of where the caret is; it wins over the
     * estimate above, which is what keeps tapping into the middle of a sentence
     * from opening a picker over the word you left behind.
     */
    onSelectionChange: useCallback((start: number) => setCursor(start), []),
    /** The ids to send with `value` — see `mentionIdsIn`. */
    idsFor: useCallback(
      (value: string) => mentionIdsIn(value, picked),
      [picked]
    ),
    /** Start again after a send, or on leaving edit mode. */
    reset: useCallback(() => setPicked([]), []),
  };
}
