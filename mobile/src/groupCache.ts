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
