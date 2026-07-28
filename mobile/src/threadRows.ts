/**
 * Shaping a conversation into list rows (Phase 9b M5).
 *
 * The transcript is no longer a flat run of bubbles: it carries day separators,
 * an unread divider, and grouped runs. All three are decisions about *sequence*,
 * so they're made once here rather than by each row asking questions about its
 * neighbours during render — the same reason the feed's `toRows` exists, and for
 * the same practical payoff of being directly testable without a screen.
 *
 * **Everything is newest-first**, in and out, because the thread is an inverted
 * `FlatList`: index 0 is the bubble at the bottom of the screen. That's what
 * lets the newest page load first and older messages page in *upward* as you
 * scroll, instead of the old shape where opening a chat walked every page to
 * reach the bottom of it. The walk inside is oldest-first anyway, because "did
 * the day change" and "is this the same person still talking" are questions
 * about what came *before*.
 */

import type { Message } from './types';
import { dayHeading, dayKey } from './utils';

export type ThreadRow =
  | { kind: 'day'; key: string; label: string }
  | { kind: 'unread'; key: string; count: number }
  | {
      kind: 'message';
      key: string;
      message: Message;
      /** First bubble of a run — the one that carries the sender's name. */
      startsRun: boolean;
      /** Last bubble of a run — the one that carries the time and the tail. */
      endsRun: boolean;
    };

/**
 * The oldest message you haven't read, or `null` for none.
 *
 * Derived from the **count** rather than from a timestamp, which is not a
 * shortcut: `unread_count` is on a payload the thread already loads, whereas
 * your own `last_read_at` isn't reliably there at all — the conversation detail
 * withholds every read marker, including yours, when you've turned read receipts
 * off. A divider that quietly stopped working for anyone who opted out of an
 * unrelated setting would be a bad trade for one fewer loop.
 *
 * Unread means visible, not yours, and not deleted — the server's definition
 * (see `unread_count_for`), counted from the newest backwards.
 *
 * Returns `null` when there are fewer candidates loaded than the count claims,
 * which happens when the unread run is longer than the first page. **No divider
 * is the right answer there**: the alternative is putting it at the top of what
 * happens to have loaded, which points at the wrong message and is worse than
 * pointing at nothing. It resolves itself as soon as another page pages in.
 */
export function firstUnreadId(
  messages: Message[],
  unreadCount: number,
  meId: number | undefined
): number | null {
  if (unreadCount <= 0) return null;
  let seen = 0;
  for (const message of messages) {
    if (message.sender.id === meId || message.is_deleted) continue;
    seen += 1;
    if (seen === unreadCount) return message.id;
  }
  return null;
}

/**
 * Rows for the transcript, newest-first.
 *
 * `now` is threaded in rather than read, so "Today" is a function of the
 * caller's clock — which is what lets the screen re-derive the labels on the
 * `useDayBoundary` tick instead of a chat left open overnight still calling
 * yesterday "Today".
 */
export function toThreadRows({
  messages,
  meId,
  unreadFrom,
  now,
}: {
  /** Newest-first: outbox entries, then loaded pages. */
  messages: Message[];
  meId: number | undefined;
  /** The id from `firstUnreadId`, or null for no divider. */
  unreadFrom?: number | null;
  now?: Date;
}): ThreadRow[] {
  // Oldest-first for the walk. De-duplicated on the way, because the endpoint
  // pages by page *number* over a newest-first list: a message arriving while
  // someone is scrolling shifts the window, so page 2 can re-send what page 1
  // already showed. Two rows sharing a key makes React warn and lets `FlatList`
  // recycle the wrong one — the same hazard, and the same fix, as the feed's.
  const seen = new Set<number>();
  const ordered: Message[] = [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (seen.has(message.id)) continue;
    seen.add(message.id);
    ordered.push(message);
  }

  const rows: ThreadRow[] = [];
  let lastDay: string | null = null;
  let unreadCount = 0;
  if (unreadFrom != null) {
    const from = ordered.findIndex((m) => m.id === unreadFrom);
    if (from >= 0) {
      unreadCount = ordered
        .slice(from)
        .filter((m) => m.sender.id !== meId && !m.is_deleted).length;
    }
  }

  ordered.forEach((message, index) => {
    // A divider between two bubbles breaks the run whatever the sender: a run
    // is a visual block, and one straddling "Yesterday" would read as a single
    // burst sent across midnight.
    let divided = false;

    const day = dayKey(message.created_at);
    if (day !== lastDay) {
      lastDay = day;
      divided = true;
      rows.push({
        kind: 'day',
        key: `day-${day}`,
        label: dayHeading(message.created_at, now).label,
      });
    }
    if (unreadCount > 0 && message.id === unreadFrom) {
      divided = true;
      rows.push({ kind: 'unread', key: 'unread', count: unreadCount });
    }

    const previous = ordered[index - 1];
    rows.push({
      kind: 'message',
      key: `m-${message.id}`,
      message,
      startsRun: divided || !previous || previous.sender.id !== message.sender.id,
      // Filled in below — it depends on the message after this one, which
      // hasn't been looked at yet.
      endsRun: true,
    });
  });

  // Second pass for `endsRun`: a bubble ends its run when the next one starts a
  // new one. Done backwards so "the next message row" is simply the last one
  // seen — and done as a second pass at all because mid-walk the day-divider
  // decision for the next message hasn't been made yet.
  let following: ThreadRow | null = null;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    if (row.kind !== 'message') continue;
    row.endsRun = following?.kind === 'message' ? following.startsRun : true;
    following = row;
  }

  return rows.reverse();
}
