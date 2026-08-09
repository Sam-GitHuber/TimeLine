/**
 * Refreshing everything a change to **your own** group membership invalidates.
 *
 * Membership isn't just a row on the Groups tab — it's a **gate on two other
 * queries**. The home feed filters group posts down to the groups you're an
 * active member of, and the personal calendar gates on the identical set
 * (`feed_posts` and `PersonalCalendarView` in `backend/api/views.py`; see
 * groups.md and events.md). So joining or leaving a group changes what those
 * two screens are allowed to show, and a write that invalidates only
 * `['groups']` leaves both of them lying (#277).
 *
 * On mobile the lie is permanent rather than a flash, which is why this is
 * worth a helper: the tabs are mounted for the life of the session
 * (`app/(tabs)/_layout.tsx` sets no `unmountOnBlur`/`freezeOnBlur`), so the feed
 * query always has a live observer and never remounts on a tab switch. Nothing
 * marks it stale, so the default `staleTime: 0` buys nothing, and the stale
 * feed can offer posts the server will refuse — leave a group and its posts are
 * still listed, but tapping one gives *Post not available*, because
 * `can_view_post` requires the membership you just gave up. Only a
 * pull-to-refresh or an app foreground heals it. Same property that made #275
 * worth fixing.
 *
 * One helper rather than the list copied into each of the three writes (leave,
 * delete, accept an invite), because copied lists drift — that drift *is*
 * #215 / #273 / #275 / #277.
 *
 * `['feed']` is invalidated **bare**, not `['feed', includeGroups]`:
 * invalidation prefix-matches on the key, so one entry covers both settings of
 * the include-groups-in-feed preference, including a cached entry for the value
 * this device isn't currently on (`postCache.ts` explains the same
 * first-segment matching from the writer's side).
 *
 * **Deliberately not in here:** `['conversations']` / `['unreadMessages']` —
 * leaving a group deactivates you in its chats (`GroupMemberDetailView.delete`)
 * and deleting one takes them with it through the FK cascade
 * (`GroupDetailView.delete`) — and `['notificationsUnread']`, which
 * accepting or declining an invite moves by addressing its notification. Those
 * are all real, but every one of those keys is **polled**: the Messages tab
 * polls the conversation list, the tab bar polls the unread-message count, and
 * the activity bell polls the unread-activity count. They heal on their own
 * cadence, within a cycle. The feed and the personal calendar are the two that
 * never do.
 */

import type { QueryClient } from '@tanstack/react-query';

export function invalidateGroupMembership(queryClient: QueryClient): void {
  queryClient.invalidateQueries({ queryKey: ['groups'] });
  queryClient.invalidateQueries({ queryKey: ['feed'] });
  queryClient.invalidateQueries({ queryKey: ['personalCalendar'] });
}

/**
 * Refreshing what a change to **someone else's** row on the roster invalidates.
 *
 * The narrow half, shared by both roster writes: the list itself, the group
 * payload (whose `member_count` and `your_role` both move) and the groups list,
 * which counts members too.
 *
 * Deliberately **not** the wider `invalidateGroupMembership` set: promoting,
 * demoting or removing *someone else* changes no membership of yours, so the
 * home feed and the personal calendar are still right. The self-remove branch
 * is a leave and calls that one instead (see `members.tsx`).
 */
export function invalidateGroupRoster(queryClient: QueryClient, groupId: number): void {
  queryClient.invalidateQueries({ queryKey: ['groupMembers', groupId] });
  queryClient.invalidateQueries({ queryKey: ['group', groupId] });
  queryClient.invalidateQueries({ queryKey: ['groups'] });
}

/**
 * Refreshing what **removing someone else from a group** invalidates (#290).
 *
 * The roster's own keys, plus the three an event cancellation moves — because
 * that's what a removal is, server-side. `GroupMemberDetailView.delete` ends
 * with `cancel_events_on_departure` (`backend/api/views.py`): an event's
 * visibility gate hangs off a *present* organiser, so every event the departing
 * member organises in this group is soft-cancelled in the same transaction.
 * That's the same set `events/[eventId].tsx` invalidates after a cancel, for the
 * identical reason, and neither client's roster named one of them.
 *
 * On the app it's the sticky version of the web's flash: `/calendar` is a tab,
 * mounted for the life of the session, so a plan the server cancelled the moment
 * you removed its organiser sits there as a live one until a pull-to-refresh —
 * the same property that made #275 / #277 / #282 worth fixing. The group screen
 * behind the roster keeps its own upcoming/past strips just as stale.
 *
 * **`['groupPosts']` is not in here, and that's the point.** #290 was filed
 * saying a removal drops the member's posts from the group timeline. It doesn't:
 * `visible_posts(user, group=pk)` gates on the *author* being you or a
 * connection and still active — it never asks whether they're still a member —
 * and `can_view_post` only requires that **the viewer** is one. A removed
 * member's posts stay visible to the co-members who could already see them, and
 * tapping one still opens it. Invalidating that key would be a refetch we can't
 * justify, on the strength of a rule the server doesn't have.
 */
export function invalidateMemberRemoved(queryClient: QueryClient, groupId: number): void {
  invalidateGroupRoster(queryClient, groupId);
  queryClient.invalidateQueries({ queryKey: ['groupEvents', groupId] });
  queryClient.invalidateQueries({ queryKey: ['groupCalendar', groupId] });
  queryClient.invalidateQueries({ queryKey: ['personalCalendar'] });
}
