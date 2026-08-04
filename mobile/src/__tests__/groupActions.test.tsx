/**
 * The group ⋯ menu's destructive actions (`useGroupActions`): **leave** and
 * **delete**.
 *
 * What's pinned here is what each one *refreshes*, not just what it calls.
 * Membership gates the home feed and the personal calendar as well as the groups
 * list (`groupCache.ts`), so a leave that refreshes only `['groups']` leaves the
 * feed offering posts the server will now refuse (#277).
 *
 * The surfaces are **mounted alongside** the action rather than seeded into the
 * cache, because that's the situation the bug lives in: a tab stays mounted for
 * the life of the session, so its query has a live observer and never remounts.
 * A seeded but unobserved cache entry refetches on its next mount whatever we
 * do, and would pass against the broken build. Same reasoning as
 * `compose.test.tsx`.
 */

import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Pressable } from 'react-native';

import { useGroupActions } from '@/components/useGroupActions';

import { alertSpy, pressAlertButton, resetMenuSpies } from './helpers';

const mockReplace = jest.fn();
jest.mock('expo-router', () => ({
  router: { replace: (...args: unknown[]) => mockReplace(...args) },
}));

// Leaving is `removeGroupMember(groupId, me)`, so the hook needs to know who you
// are; the roster suite stands the session up the same way.
jest.mock('@/auth', () => ({
  ...jest.requireActual('@/auth'),
  useAuth: () => ({ user: { pk: 1, display_name: 'Me Myself' } }),
}));

const mockFetch = jest.fn();

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (body === null ? '' : JSON.stringify(body)),
    json: async () => body,
  };
}

/** The ⋯ menu, reduced to the two entries this hook owns. */
function GroupMenu() {
  const { leave, remove } = useGroupActions(7);
  return (
    <>
      <Pressable accessibilityRole="button" accessibilityLabel="Leave group" onPress={leave} />
      <Pressable accessibilityRole="button" accessibilityLabel="Delete group" onPress={remove} />
    </>
  );
}

/** A tab elsewhere in the app, observing its query the way the real screen does. */
function MountedTab({
  queryKey,
  queryFn,
}: {
  queryKey: unknown[];
  queryFn: () => Promise<unknown>;
}) {
  useQuery({ queryKey, queryFn });
  return null;
}

async function renderMenuOverTabs() {
  const queryClient = new QueryClient({
    defaultOptions: {
      // `gcTime: 0` on mutations as well as queries: the default five-minute
      // mutation timer keeps Node's event loop alive and hangs the run after
      // the suite has already passed.
      queries: { retry: false, gcTime: 0 },
      mutations: { gcTime: 0 },
    },
  });
  const tabs = {
    // `true` is the include-groups-in-feed preference turned on — the setting
    // that puts a group's posts on the home feed in the first place. The keys
    // carry the suffixes the real screens use, so a fix that invalidated the
    // bare keys as *exact* keys wouldn't pass here.
    feed: { key: ['feed', true], fn: jest.fn(async () => emptyList()) },
    calendar: { key: ['personalCalendar'], fn: jest.fn(async () => []) },
    groups: { key: ['groups'], fn: jest.fn(async () => emptyList()) },
  };
  await render(
    <QueryClientProvider client={queryClient}>
      {Object.entries(tabs).map(([name, tab]) => (
        <MountedTab key={name} queryKey={tab.key} queryFn={tab.fn} />
      ))}
      <GroupMenu />
    </QueryClientProvider>
  );
  // Their first load, so a later call is unambiguously a refetch.
  await waitFor(() =>
    expect(loadCounts(tabs)).toEqual({ feed: 1, calendar: 1, groups: 1 })
  );
  return tabs;
}

type Tabs = Awaited<ReturnType<typeof renderMenuOverTabs>>;

function emptyList() {
  return {
    pages: [{ count: 0, next: null, previous: null, results: [] }],
    pageParams: [undefined],
  };
}

/** How many times each surface has loaded, keyed by name for a readable diff. */
function loadCounts(tabs: Tabs) {
  return Object.fromEntries(
    Object.entries(tabs).map(([name, tab]) => [name, tab.fn.mock.calls.length])
  );
}

function requested(fragment: string, method: string) {
  return mockFetch.mock.calls.some(
    ([url, init]) => String(url).includes(fragment) && init?.method === method
  );
}

/**
 * Turn the event loop a few times, so a mutation that *did* fire has had room to
 * reach `fetch` — the only honest way to read a negative here, since a cancelled
 * confirmation produces no signal of its own to wait for.
 *
 * Deliberately **not** `settle()` from `./helpers`, which is this idea wrapped in
 * `act()`. Under this harness that `act` leaves the renderer in a state where the
 * *next* test's `render` mounts nothing at all and every query in it reads zero —
 * a green test turning the following one red, for a reason nowhere near the
 * failure. Nothing here needs React to re-render; it only needs the loop to turn,
 * so it turns it directly.
 */
async function turnEventLoop(turns = 5): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

beforeEach(() => {
  mockFetch.mockReset();
  mockReplace.mockReset();
  resetMenuSpies();
  mockFetch.mockImplementation(async () => jsonResponse(null, 204));
  globalThis.fetch = mockFetch as unknown as typeof fetch;
});

it('refreshes the feed and the calendar when you leave a group', async () => {
  const tabs = await renderMenuOverTabs();

  fireEvent.press(screen.getByLabelText('Leave group'));
  pressAlertButton('Leave group?', 'Leave');

  // Leaving is the member-remove endpoint with your own id (groups.md).
  await waitFor(() => expect(requested('/api/groups/7/members/1/', 'DELETE')).toBe(true));
  // The feed is the regression (#277): it filters group posts down to your
  // active memberships, so every post from this group is now one the server will
  // refuse — and the Home tab stays mounted, so nothing else refetches it until
  // a pull-to-refresh or an app foreground.
  await waitFor(() => expect(loadCounts(tabs)).toEqual({ feed: 2, calendar: 2, groups: 2 }));
  expect(mockReplace).toHaveBeenCalledWith('/groups');
});

it('refreshes the feed and the calendar when you delete a group', async () => {
  const tabs = await renderMenuOverTabs();

  fireEvent.press(screen.getByLabelText('Delete group'));
  pressAlertButton('Delete group?', 'Delete');

  // Deleting takes the group's posts and events with it for everyone, so the two
  // gated surfaces are just as wrong afterwards as they are after a leave.
  await waitFor(() => expect(requested('/api/groups/7/', 'DELETE')).toBe(true));
  await waitFor(() => expect(loadCounts(tabs)).toEqual({ feed: 2, calendar: 2, groups: 2 }));
});

it('refreshes nothing when you cancel the confirmation', async () => {
  const tabs = await renderMenuOverTabs();

  fireEvent.press(screen.getByLabelText('Leave group'));
  pressAlertButton('Leave group?', 'Cancel');

  await turnEventLoop();
  expect(requested('/api/groups/7/members/1/', 'DELETE')).toBe(false);
  expect(loadCounts(tabs)).toEqual({ feed: 1, calendar: 1, groups: 1 });
  expect(mockReplace).not.toHaveBeenCalled();
});

it('refreshes nothing when the server refuses the leave', async () => {
  const tabs = await renderMenuOverTabs();
  mockFetch.mockImplementation(async () =>
    jsonResponse({ detail: 'Promote another member to admin first.' }, 400)
  );

  fireEvent.press(screen.getByLabelText('Leave group'));
  pressAlertButton('Leave group?', 'Leave');

  // The last-admin guardrail is server-side and its message is surfaced rather
  // than swallowed; that alert is also the tell that the failure has settled, so
  // the counts below are read after the mutation finished rather than before it
  // started. Nothing changed on the server, so nothing is refreshed — and you
  // stay put rather than being bounced to a list you're still on.
  await waitFor(() =>
    expect(alertSpy.mock.calls.some(([title]) => title === 'Couldn’t do that')).toBe(true)
  );
  expect(loadCounts(tabs)).toEqual({ feed: 1, calendar: 1, groups: 1 });
  expect(mockReplace).not.toHaveBeenCalled();
});
