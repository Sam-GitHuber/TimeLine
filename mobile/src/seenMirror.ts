/**
 * Mirroring the server's **"viewing is seeing"** stamp, locally.
 *
 * Fetching a post or an event — or the comment tree hanging off either — marks
 * every unread notification aimed at it seen server-side
 * (`see_post_notifications` / `see_event_notifications`; see
 * `docs/reference/notifications.md`). Two things on the phone have to follow
 * that, and neither happens by itself:
 *
 * - the count the **icon badge** watches, so it drops now rather than on the
 *   bell's next twelve-second poll;
 * - the **delivered pushes** in the tray, because an OS notification is a badge
 *   signal too (#178) — leaving them behind is the exact split that rule exists
 *   to prevent: the app says you've read it, the lock screen says you haven't.
 *
 * **Call these from a `queryFn`, after the `await` — never from an effect.**
 * `useQuery` hands back cached data synchronously, so an effect gated on
 * `!!data` fires on a warm reopen before the refetch has been anywhere near the
 * server; if that refetch then 404s, the screen says the thing is gone while
 * the notification that would have explained it has already been destroyed
 * (#318, and #307/#308 before it). A dismissal is not undoable, so the trigger
 * has to be the server's answer and nothing else.
 *
 * **Neither call may throw.** By the time these run the server has already
 * stamped, so a throw would reject a GET that succeeded — leaving a badge that
 * nothing can clear. `dismissDelivered` swallows its own errors, and an
 * invalidation reports a failed refetch through query state rather than by
 * rejecting.
 *
 * **Three GETs stamp, so three call sites mirror.** The post detail, the event
 * detail, and the comment tree for either — that last one is easy to miss
 * (`PostCommentsView.get` calls `_see_notifications` beside its own
 * `PostCommentRead` upsert), and missing it meant a warm reopen whose *detail*
 * fetch failed while its *comments* fetch succeeded left a notification nothing
 * would ever clear.
 *
 * The comment tree's other mirror — the `· N new` count — is **not** in here on
 * purpose: only the comments GET stamps `PostCommentRead`, so clearing that
 * count from a detail fetch would hide comments nobody has been shown. See
 * `markPostCommentsSeen` / `markEventCommentsSeen` in `postCache.ts`.
 */

import type { QueryClient } from '@tanstack/react-query';

import { dismissEventNotifications, dismissPostNotifications } from '@/push';

/** The badge count both mirrors refresh. */
function refreshBadgeCount(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: ['notificationsUnread'] });
}

/** Everything one post's seen-stamp implies for the tray and the badge. */
export function mirrorPostSeen(queryClient: QueryClient, postId: number): void {
  void dismissPostNotifications(postId);
  refreshBadgeCount(queryClient);
}

/** The event twin. Its pushes carry the nested `/g/<gid>/events/<eid>` url. */
export function mirrorEventSeen(
  queryClient: QueryClient,
  eventId: number
): void {
  void dismissEventNotifications(eventId);
  refreshBadgeCount(queryClient);
}
