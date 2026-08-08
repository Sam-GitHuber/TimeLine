/**
 * The number on the app icon, while the app is running (#179).
 *
 * The icon badge has two halves. The server sets it on every push it sends
 * (`send_pushes.py`'s `badge`), which is the only lever that reaches a phone
 * that isn't running the app. This is the other half: once the app *is*
 * running, it knows better than any push does, so it owns the number.
 *
 * **It watches the two counts the app is already showing rather than setting
 * the badge at each place one changes.** Six screens invalidate
 * `['unreadMessages']` today (the thread, the list's swipe, the info screen,
 * the pending-chat panel, the block button…) and the activity centre
 * invalidates `['notificationsUnread']`; a `setAppBadge` call at each is six
 * chances to miss the seventh. Subscribing to the caches instead means every
 * existing path — and every future one — updates the icon by construction,
 * because they all already do the one thing that matters: invalidate the count.
 *
 * **The badge is therefore exactly as fresh as the in-app badges are**, which
 * is the right bar and worth stating plainly. These observers deliberately
 * don't poll: the tab bar polls `['unreadMessages']` and the activity bell
 * polls `['notificationsUnread']`, both on their own cadences, and adding a
 * third and fourth poller to the same two keys would double that traffic to
 * tell us something we're already being told. What they *do* add is a fetch on
 * mount and on foreground (`focusManager` is wired to `AppState` in
 * `_layout.tsx`), so the icon is right the moment the app is picked up.
 *
 * Its own module rather than an effect in `_layout.tsx` for the reason
 * `usePushDismissals` is: a hook can be rendered by a test harness and driven
 * directly.
 */

import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';

import { api } from '@/api';
import { useAuth } from '@/auth';
import { setAppBadge } from '@/push';

export function useBadgeCount(): void {
  const { status } = useAuth();
  const signedIn = status === 'signedIn';

  // Both share their key with the in-app badge that already reads it, so this
  // costs one cache subscription rather than a second source of truth.
  //
  // `dataUpdatedAt` is taken alongside the data because the badge has to be
  // **level-triggered, not edge-triggered** (#232). See the effect below.
  const { data: messages, dataUpdatedAt: messagesAt } = useQuery({
    queryKey: ['unreadMessages'],
    queryFn: api.getUnreadMessageCount,
    enabled: signedIn,
  });
  const { data: activity, dataUpdatedAt: activityAt } = useQuery({
    queryKey: ['notificationsUnread'],
    queryFn: api.getUnreadNotificationCount,
    enabled: signedIn,
  });

  // The sum, or `null` while either half is still unknown. **Not `?? 0`**: a
  // zero we haven't earned would wipe a badge the server correctly set, on
  // every single launch, in the seconds before the counts land.
  const total =
    messages && activity ? messages.count + activity.count : null;

  // **Re-assert on every landed count, not only on a changed one (#232).**
  //
  // The icon has two writers — the server, on every push, and this hook — and
  // an effect keyed on `total` alone only fires when *our* number moves. So
  // when the server moved the icon behind our back and our counts then land on
  // the value already in the cache, the deps don't change, the effect doesn't
  // run, and the server's number stands. That is exactly how a tester's icon
  // sat on 2 with nothing at all waiting: a push set it while the app was
  // backgrounded, the messages were read on the web, and the foreground
  // refetch returned the same 0 the cache already held. Nothing she could do
  // in the app would ever move it again, because the counts were already right.
  //
  // `dataUpdatedAt` changes on every *successful* fetch — mount, foreground
  // refetch, any invalidation — whether or not the number did, so putting it in
  // the deps turns "write when our count changes" into "re-assert whatever we
  // believe, whenever we've just confirmed it". `setBadgeCountAsync` with the
  // number already showing is a no-op, so the extra writes cost nothing.
  //
  // A *failed* fetch deliberately writes nothing: `dataUpdatedAt` doesn't move
  // on an error, and the last number the server pushed is a better guess than
  // a stale one of ours. That is now a decision rather than an accident.
  useEffect(() => {
    // Signed out — including a session that expired out from under us. The
    // count belonged to whoever was signed in, and it must not sit on the icon
    // of a phone nobody is signed in on. `'loading'` is not this case: it's the
    // cold-start moment before we know, and clearing there would flash the
    // badge off on every launch.
    if (status === 'signedOut') {
      void setAppBadge(0);
      return;
    }
    if (total === null) return;
    void setAppBadge(total);
    // `messagesAt`/`activityAt` are unused in the body on purpose: they are the
    // level trigger, not an input to the number.
  }, [status, total, messagesAt, activityAt]);
}
