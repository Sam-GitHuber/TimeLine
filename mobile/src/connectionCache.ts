/**
 * Refreshing everything a change to a **connection** invalidates.
 *
 * A connection isn't a row on the People tab — it's *the* visibility boundary.
 * `connected_user_ids(user)` (`backend/api/views.py`) is the single set the feed,
 * profiles, group timelines, comment trees, the personal calendar and the group
 * event lists all gate on (connections.md), so every write that adds or removes
 * an accepted connection changes what a dozen screens are allowed to show. But
 * each of the four writes was invalidating a list written from the point of view
 * of the screen it sits on — four call sites, four different sets, none of them
 * holding a single calendar or event key (#278, #285).
 *
 * On mobile that isn't a flash. The tabs are mounted for the life of the session
 * (`app/(tabs)/_layout.tsx` sets no `unmountOnBlur`/`freezeOnBlur`), so a query
 * there always has a live observer and never remounts on a tab switch; the
 * default `staleTime: 0` buys nothing without something marking it stale. Block
 * someone who organised a dated event and it sits on your Calendar tab for the
 * rest of the session — and tapping it gives *Event not available… you're not
 * connected to whoever organised it*, because the server dropped them from your
 * connected set the moment the block deleted the `Connection` row
 * (`BlockView.post`). Same property that made #275 / #277 worth fixing.
 *
 * One helper rather than the list copied into each write, because copied lists
 * drift — that drift *is* #215 / #273 / #275 / #277 / #278.
 *
 * ## Why this doesn't fork on which transition it was
 *
 * Strictly, only two of the button's four transitions move the *accepted* set:
 * approving an incoming request and disconnecting. Sending a request or
 * withdrawing one leaves a `pending` row, which `connected_user_ids` ignores.
 * We deliberately don't fork on that, unlike `groupCache.ts` — because the
 * client can't know which transition it made. `connectionStatus` is a snapshot
 * from a cached profile or list row, and the row underneath it can change while
 * the screen is open: they accept your request, and the DELETE you think is
 * withdrawing a pending request is in fact ending a live connection. Forking on
 * a stale prop would under-invalidate in exactly that race, which is the bug
 * this file exists to stop. The cost of the flat rule is a refetch of the
 * mounted screens after a request that changed nothing they show — cheap, and
 * `['feed']` was already being invalidated unconditionally by all four sites.
 *
 * Rejecting an incoming request *is* forked (`app/(tabs)/people.tsx`), because
 * there the server guarantees the narrow case rather than the client guessing
 * it: `ConnectionRequestActionView` 404s unless the row is still `PENDING`, so a
 * reject that reaches `onSuccess` cannot have deleted an accepted connection.
 *
 * ## Keys, and why each is here
 *
 * Bare first segments throughout (`['post']`, not `['post', id]`) — invalidation
 * prefix-matches, so one entry covers every id and every suffix the real screens
 * use (`postCache.ts` explains the same matching from the writer's side).
 * `userId` narrows the two keys that are genuinely about one person.
 *
 * - **`['users']` / `['connections']` / `['connectionRequests']` /
 *   `['user', userId]`** — the relationship itself: the Discover and Connections
 *   lists, the requests inbox and its badge, and the button's own state.
 * - **`['feed']` / `['userPosts', userId]` / `['groupPosts']` / `['post']` /
 *   `['comments']`** — content behind `visible_posts` and the comment prune. A
 *   group timeline shows only posts by members you're connected with, and a
 *   comment tree is pruned to the same boundary, so blocking someone from the
 *   post you're reading (the avatar on `PostCard` is the way there) leaves the
 *   screen underneath rendering a post and a thread the server would now refuse.
 * - **`['personalCalendar']` / `['groupEvents']` / `['groupCalendar']`** — #285.
 *   All three gate their organisers on `connected_user_ids` exactly as
 *   `feed_posts` does (`PersonalCalendarView`, `GroupEventsView`,
 *   `GroupCalendarView`), and none of the four writes had ever named one.
 * - **`['conversations']` / `['conversation']` / `['unreadMessages']`** —
 *   connecting and disconnecting flip your participation in shared group chats
 *   (`promote_shared_chats` / `sever_shared_chats`), so a chat can unlock or
 *   lock while you're looking at it. Connecting from the locked
 *   `PendingChatPanel` already refreshed the open thread and the list; doing it
 *   from a profile instead left the same chat locked (#278).
 *
 * **These three are the one place this helper departs from `groupCache.ts`**,
 * which leaves `['conversations']` / `['unreadMessages']` out precisely because
 * they're polled and heal within a cycle. The difference is what's on screen at
 * the moment of the write. A group leave only ever *removes* your access, and
 * you're on the Groups tab when you make it; connecting *grants* access, and the
 * `PendingChatPanel` is a locked screen you are staring at, waiting for it to
 * open — a poll cycle of "Connect with Dana to join this chat" after you already
 * have is the bug, not a slow heal. `['unreadMessages']` rides with
 * `['conversations']` rather than on its own merit: it's derived from that list,
 * and the two disagreeing for a cycle (a badge counting a chat the list has
 * already dropped, or not counting one it just gained) is the visible artefact.
 * The polled-key rule still holds everywhere it isn't beaten by something the
 * user is looking at.
 *
 * **Deliberately not in here:** `['notificationsUnread']` / `['notifications']`,
 * which approving does move (it addresses the request's notification and posts
 * an accepted one) and rejecting moves too (deleting the `Connection` cascades
 * its notification away). Both are **polled** by the activity bell, and neither
 * is the screen the write was made from, so they heal within a cycle — the call
 * `groupCache.ts` makes, for the reason it makes it.
 */

import type { QueryClient } from '@tanstack/react-query';

export function invalidateConnectionChange(
  queryClient: QueryClient,
  userId: number
): void {
  const keys: unknown[][] = [
    // The relationship
    ['users'],
    ['connections'],
    ['connectionRequests'],
    ['user', userId],
    // Content gated on connected_user_ids
    ['feed'],
    ['userPosts', userId],
    ['groupPosts'],
    ['post'],
    ['comments'],
    ['personalCalendar'],
    ['groupEvents'],
    ['groupCalendar'],
    // Shared group chats promote/sever with the connection
    ['conversations'],
    ['conversation'],
    ['unreadMessages'],
  ];
  for (const queryKey of keys) {
    queryClient.invalidateQueries({ queryKey });
  }
}
