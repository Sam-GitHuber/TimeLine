/**
 * The midnight rollover.
 *
 * Without this the feed's day dividers freeze at whatever the clock said when
 * the rows were last built, so an app left open overnight goes on labelling
 * yesterday's posts "Today".
 *
 * **Fake timers need `await act(async () => …)` here, not a bare `act()`.**
 * Advancing the clock synchronously does run the timeout, but React schedules
 * the resulting re-render as a task of its own and only the async form gives it
 * a chance to flush. With the sync form the hook's value silently never
 * changes, and the test fails looking exactly like a broken hook. (Same family
 * as the RNTL v14 async-`render` trap in the phase doc.)
 */

import { act, renderHook } from '@testing-library/react-native';

import { useDayBoundary } from '@/useDayBoundary';

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

it('changes its value when the calendar day rolls over', async () => {
  jest.setSystemTime(new Date('2026-07-18T22:30:00'));

  const { result } = await renderHook(() => useDayBoundary());
  const before = result.current;

  // Cross midnight. Running the pending timer also advances Jest's fake clock
  // to that timer's due time, which is exactly the midnight the hook armed for
  // — so this is a phone left sitting on the feed overnight, no arithmetic.
  await act(async () => {
    jest.runOnlyPendingTimers();
  });

  expect(before).toBe('2026-6-18');
  expect(result.current).toBe('2026-6-19');
});

it('holds steady within a single day', async () => {
  jest.setSystemTime(new Date('2026-07-18T09:00:00'));

  const { result } = await renderHook(() => useDayBoundary());
  const before = result.current;

  // Eight hours later — still 18 July, and the midnight timer isn't due, so
  // nothing should have changed.
  await act(async () => {
    jest.advanceTimersByTime(8 * 60 * 60 * 1000);
  });

  expect(result.current).toBe(before);
});

it('rearms itself, so it still works on a second night', async () => {
  jest.setSystemTime(new Date('2026-07-18T23:00:00'));

  const { result } = await renderHook(() => useDayBoundary());

  await act(async () => {
    jest.runOnlyPendingTimers();
  });
  expect(result.current).toBe('2026-6-19');

  // A one-shot timer would leave the label stuck here for good.
  await act(async () => {
    jest.runOnlyPendingTimers();
  });
  expect(result.current).toBe('2026-6-20');
});

it('stops its timer on unmount', async () => {
  jest.setSystemTime(new Date('2026-07-18T23:00:00'));
  const clear = jest.spyOn(globalThis, 'clearTimeout');

  const { unmount } = await renderHook(() => useDayBoundary());
  // Act-wrapped, or React never runs the effect's cleanup at all.
  await act(async () => {
    unmount();
  });

  // A timer left armed keeps waking the app for a screen nobody is looking at.
  // Asserted via the spy rather than `getTimerCount`, because React schedules
  // timers of its own during teardown and the raw count actually goes *up*.
  expect(clear).toHaveBeenCalled();
  clear.mockRestore();
});
