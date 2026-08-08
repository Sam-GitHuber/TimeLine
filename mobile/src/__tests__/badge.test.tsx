/**
 * The number on the app icon while the app is running (#179).
 *
 * The server puts a badge on every push, which is the only thing that reaches a
 * phone that isn't running the app. `useBadgeCount` is the other half: once the
 * app *is* running it knows better, and it takes the number over.
 *
 * What's pinned here is the arithmetic and, more importantly, the two ways this
 * could be actively wrong rather than merely stale:
 *
 *   - **a zero we haven't earned.** Every launch starts with both counts
 *     unknown, and a `?? 0` there would wipe a badge the server had correctly
 *     set, every single time;
 *   - **a number that outlives its owner.** Signing out has to clear it, or the
 *     count sits on the icon of a phone nobody is signed in on.
 *
 * `@/push` is mocked, so these assert the *number the hook decides on* rather
 * than the native call. Whether that number reaches the icon — and the
 * iOS-only rule that keeps `setBadgeCountAsync(0)` from wiping Android's
 * notification shade — is `setAppBadge`'s own contract, pinned in
 * `push.test.ts`.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render } from '@testing-library/react-native';

import { api } from '@/api';
import { useAuth } from '@/auth';
import { setAppBadge } from '@/push';
import { useBadgeCount } from '@/useBadgeCount';

jest.mock('@/auth', () => ({ useAuth: jest.fn() }));
jest.mock('@/push', () => ({ setAppBadge: jest.fn() }));

const mockUseAuth = useAuth as jest.MockedFunction<typeof useAuth>;
const mockSetAppBadge = setAppBadge as jest.MockedFunction<typeof setAppBadge>;

/** The counts the two endpoints are currently returning. */
function counts({ messages = 0, activity = 0 } = {}) {
  jest
    .spyOn(api, 'getUnreadMessageCount')
    .mockResolvedValue({ count: messages } as never);
  jest
    .spyOn(api, 'getUnreadNotificationCount')
    .mockResolvedValue({ count: activity } as never);
}

function Harness() {
  useBadgeCount();
  return null;
}

/**
 * One turn of the event loop, for effects and the fetches behind them.
 *
 * `tick(5)` where a *later millisecond* is needed: the re-assert rides
 * `dataUpdatedAt`, which React Query sets from `Date.now()` on every successful
 * fetch, so two fetches inside the same millisecond carry the same stamp and
 * the effect doesn't re-run. Irrelevant in the app, where the trigger is a
 * foreground or a mark-read seconds apart, but a real source of flake in a test
 * that refetches immediately. `setTimeout` fires no *earlier* than its delay,
 * which makes the gap a certainty rather than a likelihood.
 */
function tick(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let client: QueryClient;

beforeEach(() => {
  mockUseAuth.mockReturnValue({ status: 'signedIn' } as never);
  counts();
  // `gcTime: 0` for the reason `pushDismiss.test.tsx` sets it: an idle
  // five-minute collection timer keeps Node alive long after the suite passes.
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
});

afterEach(() => {
  jest.clearAllMocks();
  jest.restoreAllMocks();
});

/**
 * Mount the hook and let both counts land.
 *
 * Returns a `rerender`, because `useAuth` is a mocked function rather than real
 * state: changing what it returns doesn't re-render anything on its own, so a
 * test about signing out has to drive the render itself.
 */
async function openApp() {
  // A fresh element each time: React bails out of re-rendering an element it is
  // handed back by identity, so reusing one would make `rerender` a no-op and
  // the sign-out test pass or fail for the wrong reason.
  const tree = () => (
    <QueryClientProvider client={client}>
      <Harness />
    </QueryClientProvider>
  );
  // `await`ed: RNTL 14's `render` is async, and the un-awaited Promise version
  // of this had no `rerender` on it at all.
  let mounted!: Awaited<ReturnType<typeof render>>;
  // Wrapped in `act` the way every other suite here renders: RNTL's own render
  // opens an async act scope, and a second one opened before it settles leaves
  // React with overlapping scopes.
  await act(async () => {
    mounted = await render(tree());
  });
  await act(async () => {
    await tick();
  });
  return async () => {
    await act(async () => {
      await mounted.rerender(tree());
      await tick();
    });
  };
}

/** The last number the hook decided on. */
function badge(): number | undefined {
  const calls = mockSetAppBadge.mock.calls;
  return calls.length ? calls[calls.length - 1][0] : undefined;
}

it('shows unread messages and unread activity added together', async () => {
  // One icon badge is one number, and the two counts can't double-count:
  // messaging deliberately sits outside the activity centre, so nothing is in
  // both. That's what makes the sum honest rather than merely convenient.
  counts({ messages: 2, activity: 3 });

  await openApp();

  expect(badge()).toBe(5);
});

it('clears the icon when nothing is waiting', async () => {
  counts({ messages: 0, activity: 0 });

  await openApp();

  expect(badge()).toBe(0);
});

it('does not touch the icon until both counts are known', async () => {
  // The launch case, and the one way this could be *actively* wrong rather than
  // stale: the server set a correct badge on the push that got the app opened,
  // and treating a not-yet-loaded count as zero would wipe it in the seconds
  // before the real numbers land.
  counts({ messages: 4 });
  jest
    .spyOn(api, 'getUnreadNotificationCount')
    .mockReturnValue(new Promise(() => {}) as never);

  await openApp();

  expect(mockSetAppBadge).not.toHaveBeenCalled();
});

it('follows the counts down as things are read', async () => {
  // Reading a thread doesn't call anything here — it invalidates
  // `['unreadMessages']`, like all six of the app's mark-read paths do. Riding
  // the cache rather than a call at each site is what makes the icon follow
  // every one of them, including the ones not written yet.
  counts({ messages: 2, activity: 1 });
  await openApp();
  expect(badge()).toBe(3);

  counts({ messages: 0, activity: 1 });
  await act(async () => {
    await client.invalidateQueries({ queryKey: ['unreadMessages'] });
    await tick();
  });

  expect(badge()).toBe(1);
});

/**
 * Refetch one count and let everything settle. Returns how many badge writes
 * that produced.
 *
 * **One key at a time, deliberately.** A blanket `invalidateQueries()` refetches
 * both, so either stamp alone re-running the effect would satisfy the assertion
 * — and the half of the level trigger that wasn't wired could regress in
 * silence. Read on the web, the two counts drop on different keys: a message
 * moves `unreadMessages`, a reaction or a reply moves `notificationsUnread`.
 */
async function refetch(...queryKeys: string[][]) {
  const before = mockSetAppBadge.mock.calls.length;
  // A later millisecond, so a fresh `dataUpdatedAt` is certain — see `tick`.
  await tick(5);
  await act(async () => {
    // One call per key: a single `queryKey` array is a *prefix*, so passing
    // both names together would match neither query.
    await Promise.all(
      queryKeys.map((queryKey) => client.invalidateQueries({ queryKey }))
    );
    await tick(20);
  });
  return mockSetAppBadge.mock.calls.length - before;
}

it('re-asserts the number when the message count confirms what we believed', async () => {
  // **#232, and the reason the badge is level-triggered rather than
  // edge-triggered.** The icon has two writers, and only one of them is us: a
  // push sets it while the app is backgrounded, and it can then stop being true
  // without the app observing anything — the messages get read on the web, or
  // the post behind a notification is deleted. On foreground our counts refetch
  // and land on the number already in the cache. Keyed on the count alone, the
  // effect never runs, and the server's stale number stands. That is how a
  // tester's icon sat on 2 with nothing at all waiting, unclearable by anything
  // she did in the app, because her counts were already right.
  counts({ messages: 0, activity: 0 });
  await openApp();
  expect(badge()).toBe(0);

  expect(await refetch(['unreadMessages'])).toBeGreaterThan(0);
  expect(badge()).toBe(0);
});

it('re-asserts the number when the activity count confirms what we believed', async () => {
  // The other half of the same trigger, pinned separately for the reason
  // `refetch` explains: one dep is enough to make a both-keys test pass.
  counts({ messages: 0, activity: 0 });
  await openApp();
  expect(badge()).toBe(0);

  expect(await refetch(['notificationsUnread'])).toBeGreaterThan(0);
  expect(badge()).toBe(0);
});

it('writes nothing when a count fails, even if the other one confirms', async () => {
  // **The trap in level-triggering, and the one way it could be worse than the
  // bug it fixes.** A failed fetch keeps its last good `data`, so one count
  // failing while the other succeeds still advances the survivor's stamp — and
  // an ungated effect would then write a sum half of which nobody has checked
  // in a while. Concretely: the server pushes 3, the phone comes back on bad
  // signal, the messages count fails, the activity count returns the same 0 as
  // before, and we clear an icon that was right. #179's rule is that we never
  // write a number we haven't earned, and half a confirmation isn't one.
  counts({ messages: 2, activity: 1 });
  await openApp();
  expect(badge()).toBe(3);

  jest
    .spyOn(api, 'getUnreadMessageCount')
    .mockRejectedValue(new Error('offline') as never);

  expect(await refetch(['unreadMessages'], ['notificationsUnread'])).toBe(0);
});

it('writes nothing when both counts fail', async () => {
  // The simple half of the same rule. Leaving the icon showing the last number
  // the server pushed is the decision here — it beats a stale one of ours.
  counts({ messages: 2, activity: 1 });
  await openApp();
  expect(badge()).toBe(3);

  jest
    .spyOn(api, 'getUnreadMessageCount')
    .mockRejectedValue(new Error('offline') as never);
  jest
    .spyOn(api, 'getUnreadNotificationCount')
    .mockRejectedValue(new Error('offline') as never);

  expect(await refetch(['unreadMessages'])).toBe(0);
  expect(await refetch(['notificationsUnread'])).toBe(0);
});

it('clears the icon on the way out', async () => {
  // Including a session that expired out from under us — the count belonged to
  // whoever was signed in, and it must not sit on the icon of a phone nobody is
  // signed in on.
  counts({ messages: 2, activity: 1 });
  const rerender = await openApp();
  expect(badge()).toBe(3);

  mockUseAuth.mockReturnValue({ status: 'signedOut' } as never);
  await rerender();

  expect(badge()).toBe(0);
});

it('leaves the icon alone while it is still working out who is signed in', async () => {
  // `'loading'` is not `'signedOut'`. Clearing here would flash the badge off
  // on every cold start, which is the exact moment the server's number is the
  // best one anybody has.
  mockUseAuth.mockReturnValue({ status: 'loading' } as never);

  await openApp();

  expect(mockSetAppBadge).not.toHaveBeenCalled();
});

it('asks for nothing while signed out', async () => {
  // The counts are authenticated; fetching them without a session would 401
  // into the refresh path for a badge nobody can see.
  mockUseAuth.mockReturnValue({ status: 'signedOut' } as never);

  await openApp();

  expect(api.getUnreadMessageCount).not.toHaveBeenCalled();
  expect(api.getUnreadNotificationCount).not.toHaveBeenCalled();
});
