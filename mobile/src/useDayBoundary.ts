/**
 * A value that changes when the calendar day does.
 *
 * The feed's day dividers say "Today" and "Yesterday", which are computed from
 * the clock at the moment the rows are built. Nothing re-derives them on its
 * own, so an app left open across midnight goes on labelling yesterday's posts
 * "Today" — and the posts from the new day get folded under that same stale
 * divider instead of starting one of their own.
 *
 * Depending on a refetch to fix it isn't enough: a phone left on the feed
 * overnight may not fetch anything at all, and a refetch that returns identical
 * data is exactly the case where you'd least expect the labels to be wrong.
 *
 * So this schedules a single timer for the next local midnight, and returns the
 * current day key for callers to use as a memo dependency. One timer, rearmed
 * once a day.
 *
 * iOS suspends timers in a backgrounded app, so a phone left closed overnight
 * fires this late rather than on the stroke of midnight — which is harmless:
 * the timer runs as soon as JS resumes, before there's anything on screen to
 * read, and reschedules from the real current time rather than accumulating
 * drift.
 */

import { useEffect, useState } from 'react';

import { dayKey } from './utils';

/** Milliseconds from `now` until the next local midnight. */
function msUntilMidnight(now: Date): number {
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);
  // +1s of slack: firing a hair early would recompute the same day and leave
  // the label stale until the *next* midnight.
  return midnight.getTime() - now.getTime() + 1000;
}

export function useDayBoundary(): string {
  const [today, setToday] = useState(() => dayKey(new Date().toISOString()));

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;

    // Re-arm rather than using an interval: a 24h interval drifts, and the
    // device sleeping through one is precisely the case that matters.
    const schedule = () => {
      timer = setTimeout(() => {
        setToday(dayKey(new Date().toISOString()));
        schedule();
      }, msUntilMidnight(new Date()));
    };
    schedule();

    return () => clearTimeout(timer);
  }, []);

  return today;
}
