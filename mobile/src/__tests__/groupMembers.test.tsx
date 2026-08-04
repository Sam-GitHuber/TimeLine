/**
 * The group members roster (Phase 9 E3a) — admin management.
 *
 * Pins the admin controls that have real branching: promoting a member hits the
 * role endpoint, and — the regression this file exists to guard — **cancelling
 * the remove confirmation is a true no-op** (no `removeGroupMember` call, no
 * cache invalidation), while confirming it actually removes. A non-admin sees
 * the roster read-only, with no action sheet.
 *
 * It also pins the **self-remove fork** (#282). Removing your own row is the same
 * server call as the ⋯ menu's Leave, so it has to refresh what leaving refreshes
 * — membership gates the home feed and the personal calendar (`groupCache.ts`) —
 * and removing *someone else* must not, since your own membership didn't change.
 * Those two gated surfaces are **mounted alongside** the roster rather than
 * seeded into the cache, because that's the situation the bug lives in: the tabs
 * stay mounted for the life of the session, so their queries keep a live observer
 * and never remount. A seeded but unobserved entry refetches on its next mount
 * whatever we do, and would pass against the broken build. Same reasoning as
 * `groupActions.test.tsx`.
 *
 * The menu and the confirm dialog are captured, not driven natively: the shared
 * `./helpers` seam hands us the menu to pick an option from — an action sheet on
 * iOS, an `Alert` chooser on Android — and the button list to press on the
 * confirm, so these tests read identically on both platforms.
 */

import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import GroupMembersScreen from '@/app/groups/[groupId]/members';
import type { Group, GroupMember } from '@/types';

import {
  alertSpy,
  menuOptions,
  menuWasShown,
  pickMenuAction,
  pressAlertButton,
  resetMenuSpies,
} from './helpers';

const mockReplace = jest.fn();
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ groupId: '7' }),
  router: { push: jest.fn(), back: jest.fn(), replace: (...args: unknown[]) => mockReplace(...args) },
}));

// `me` only drives the "(you)" label and the self-row. A fixed stub (over the
// real AuthProvider) keeps its async auth setState from bleeding across tests —
// that churn was starving later renders of their queries.
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

const GROUP: Group = {
  id: 7,
  name: 'The Andersons',
  description: 'Family group',
  avatar_url: null,
  avatar_thumb: null,
  member_count: 2,
  your_role: 'admin',
  created_at: '2026-07-01T10:00:00Z',
};

const MEMBERS: GroupMember[] = [
  { user: { id: 1, display_name: 'Me Myself', avatar_thumb: null }, role: 'admin' },
  { user: { id: 2, display_name: 'Ada Lovelace', avatar_thumb: null }, role: 'member' },
];

/**
 * Two admins — the shape the self-remove scenario needs, since the server's
 * last-admin guardrail refuses the sole admin's removal outright.
 */
const TWO_ADMINS: GroupMember[] = [
  MEMBERS[0],
  { user: { id: 2, display_name: 'Ada Lovelace', avatar_thumb: null }, role: 'admin' },
];

function serve({ role = 'admin' as 'admin' | 'member', members = MEMBERS } = {}) {
  mockFetch.mockImplementation(async (url: string, init?: { method?: string }) => {
    // A role change or a removal — both are member sub-resources; answer 204
    // before the members-list branch below can swallow them.
    if (/\/members\/\d+\/role\/$/.test(url)) return jsonResponse(null, 204);
    if (/\/members\/\d+\/$/.test(url) && init?.method === 'DELETE') {
      return jsonResponse(null, 204);
    }
    if (url.includes('/api/groups/7/members/')) return jsonResponse(members);
    if (url.includes('/api/groups/7/')) return jsonResponse({ ...GROUP, your_role: role });
    return jsonResponse(null, 204);
  });
}

async function renderScreen() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { gcTime: 0 },
    },
  });
  const invalidate = jest.spyOn(queryClient, 'invalidateQueries');
  render(
    <QueryClientProvider client={queryClient}>
      <GroupMembersScreen />
    </QueryClientProvider>
  );
  // Let the auth + group + members queries fire before the test touches
  // `screen`: RNTL's screen proxy isn't ready on the synchronous tick right
  // after render, and this settle step (which never touches `screen` itself)
  // is what lets the subsequent `findBy*` queries resolve.
  await waitFor(() => expect(mockFetch.mock.calls.length).toBeGreaterThan(0));
  return { invalidate };
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

/**
 * The roster, with the two membership-gated tabs mounted behind it.
 *
 * `['feed', true]` carries the include-groups-in-feed suffix the real Home tab
 * uses, so a fix that invalidated the bare key as an *exact* key wouldn't pass.
 */
async function renderScreenOverTabs({ members = MEMBERS } = {}) {
  serve({ members });
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { gcTime: 0 },
    },
  });
  const invalidate = jest.spyOn(queryClient, 'invalidateQueries');
  const tabs = {
    feed: { key: ['feed', true], fn: jest.fn(async () => null) },
    calendar: { key: ['personalCalendar'], fn: jest.fn(async () => []) },
    groups: { key: ['groups'], fn: jest.fn(async () => null) },
  };
  render(
    <QueryClientProvider client={queryClient}>
      {Object.entries(tabs).map(([name, tab]) => (
        <MountedTab key={name} queryKey={tab.key} queryFn={tab.fn} />
      ))}
      <GroupMembersScreen />
    </QueryClientProvider>
  );
  // Their first load, so a later call is unambiguously a refetch.
  await waitFor(() => expect(loadCounts(tabs)).toEqual({ feed: 1, calendar: 1, groups: 1 }));
  return { invalidate, tabs };
}

type Tabs = Awaited<ReturnType<typeof renderScreenOverTabs>>['tabs'];

/** How many times each surface has loaded, keyed by name for a readable diff. */
function loadCounts(tabs: Tabs) {
  return Object.fromEntries(
    Object.entries(tabs).map(([name, tab]) => [name, tab.fn.mock.calls.length])
  );
}

function madeRequest(match: RegExp, method: string) {
  return mockFetch.mock.calls.some(
    ([url, init]) => match.test(String(url)) && (init?.method ?? 'GET') === method
  );
}

/**
 * Turn the event loop a few times, so an invalidation that *did* fire has had
 * room to reach its query — the only honest way to read the negative in the
 * "leaves the feed alone" tests, since a key that is correctly left alone
 * produces no signal of its own to wait for.
 *
 * Deliberately **not** `settle()` from `./helpers`, which is this idea wrapped in
 * `act()`; under this harness that `act` leaves the renderer in a state where the
 * next test's `render` mounts nothing at all. Nothing here needs React to
 * re-render, only the loop to turn (`groupActions.test.tsx` says the same).
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
  globalThis.fetch = mockFetch as unknown as typeof fetch;
});

// Unmount and flush between tests: a mutation's onSuccess invalidates queries,
// which schedules a background refetch, and a leaked one starves the following
// render of its own queries. Explicit cleanup + a macrotask tick clears it.
afterEach(async () => {
  cleanup();
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});

it('promotes a member via the role endpoint', async () => {
  serve();
  const { invalidate } = await renderScreen();

  await fireEvent.press(await screen.findByLabelText('Manage Ada Lovelace'));
  pickMenuAction(0); // "Make admin"

  await waitFor(() =>
    expect(madeRequest(/\/api\/groups\/7\/members\/2\/role\/$/, 'POST')).toBe(true)
  );
  await waitFor(() =>
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['groupMembers', 7] })
  );
});

it('does nothing when the remove confirmation is cancelled', async () => {
  serve();
  const { invalidate } = await renderScreen();

  await fireEvent.press(await screen.findByLabelText('Manage Ada Lovelace'));
  pickMenuAction(1); // "Remove from group" → confirm dialog
  pressAlertButton('Remove member?', 'Cancel');

  // The whole point of the fix: cancelling never touches the API or the cache.
  expect(madeRequest(/\/api\/groups\/7\/members\/2\/$/, 'DELETE')).toBe(false);
  expect(invalidate).not.toHaveBeenCalled();
});

it('removes a member when the confirmation is accepted', async () => {
  serve();
  await renderScreen();

  await fireEvent.press(await screen.findByLabelText('Manage Ada Lovelace'));
  pickMenuAction(1); // "Remove from group"
  pressAlertButton('Remove member?', 'Remove');

  await waitFor(() =>
    expect(madeRequest(/\/api\/groups\/7\/members\/2\/$/, 'DELETE')).toBe(true)
  );
});

it('refreshes the feed and the calendar when an admin removes their own row', async () => {
  const { tabs } = await renderScreenOverTabs({ members: TWO_ADMINS });

  await fireEvent.press(await screen.findByLabelText('Manage Me Myself'));
  pickMenuAction(1); // "Leave group"
  pressAlertButton('Leave group?', 'Leave');

  // The same endpoint the ⋯ menu's Leave calls, with your own id — the server
  // treats it as leaving (groups.md).
  await waitFor(() => expect(madeRequest(/\/api\/groups\/7\/members\/1\/$/, 'DELETE')).toBe(true));
  // #282: membership gates both of these, and on the app the lie is permanent —
  // the tabs never unmount, so nothing else marks the feed stale and it keeps
  // offering posts `can_view_post` will now refuse.
  await waitFor(() => expect(loadCounts(tabs)).toEqual({ feed: 2, calendar: 2, groups: 2 }));
  // And you don't stay on the roster of a group you've just left, whose own
  // queries would 404 from here on.
  expect(mockReplace).toHaveBeenCalledWith('/groups');
});

it('leaves the feed and the calendar alone when removing someone else', async () => {
  const { invalidate, tabs } = await renderScreenOverTabs();

  await fireEvent.press(await screen.findByLabelText('Manage Ada Lovelace'));
  pickMenuAction(1); // "Remove from group"
  pressAlertButton('Remove member?', 'Remove');

  await waitFor(() => expect(madeRequest(/\/api\/groups\/7\/members\/2\/$/, 'DELETE')).toBe(true));
  await waitFor(() =>
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['groupMembers', 7] })
  );
  // Your own membership didn't change, so the two gated surfaces are still
  // right — only the roster's own keys move. `['groups']` counts a member.
  await turnEventLoop();
  expect(loadCounts(tabs)).toEqual({ feed: 1, calendar: 1, groups: 2 });
  expect(mockReplace).not.toHaveBeenCalled();
});

it('leaves the feed and the calendar alone when you demote yourself', async () => {
  const { tabs } = await renderScreenOverTabs({ members: TWO_ADMINS });

  await fireEvent.press(await screen.findByLabelText('Manage Me Myself'));
  pickMenuAction(0); // "Make member" — your own row, but a role change

  // The fork is on the *action*, not just on whose row it is: giving up admin
  // keeps your membership, so it must not be treated as a leave.
  await waitFor(() =>
    expect(madeRequest(/\/api\/groups\/7\/members\/1\/role\/$/, 'POST')).toBe(true)
  );
  await turnEventLoop();
  expect(loadCounts(tabs)).toEqual({ feed: 1, calendar: 1, groups: 2 });
  expect(mockReplace).not.toHaveBeenCalled();
});

it('refreshes nothing when the server refuses the self-removal', async () => {
  const { tabs } = await renderScreenOverTabs({ members: MEMBERS });
  const listing = mockFetch.getMockImplementation()!;
  // The last-admin guardrail, which is exactly the state MEMBERS is in.
  mockFetch.mockImplementation(async (url: string, init?: { method?: string }) =>
    /\/members\/\d+\/$/.test(url) && init?.method === 'DELETE'
      ? jsonResponse({ detail: 'Promote another member to admin first.' }, 400)
      : listing(url, init)
  );

  await fireEvent.press(await screen.findByLabelText('Manage Me Myself'));
  pickMenuAction(1); // "Leave group"
  pressAlertButton('Leave group?', 'Leave');

  // The surfaced guardrail message is also the tell that the failure has settled,
  // so the counts below are read after the mutation finished rather than before
  // it started. Nothing changed on the server, so nothing is refreshed — and you
  // stay on the roster rather than being bounced out of a group you're still in.
  await waitFor(() =>
    expect(alertSpy.mock.calls.some(([title]) => title === 'Couldn’t do that')).toBe(true)
  );
  expect(loadCounts(tabs)).toEqual({ feed: 1, calendar: 1, groups: 1 });
  expect(mockReplace).not.toHaveBeenCalled();
});

it('calls the self row’s removal a leave, on the menu and the confirm', async () => {
  await renderScreenOverTabs({ members: TWO_ADMINS });

  await fireEvent.press(await screen.findByLabelText('Manage Me Myself'));
  expect(menuOptions()).toContain('Leave group');
  pickMenuAction(1);

  // Same wording as the ⋯ menu's Leave, which makes the identical call — a
  // dialog offering to "remove" you from a group by your own name reads as
  // something being done *to* you, and hides that you're about to navigate out.
  expect(alertSpy.mock.calls.some(([title]) => title === 'Leave group?')).toBe(true);
  pressAlertButton('Leave group?', 'Cancel');
  expect(madeRequest(/\/api\/groups\/7\/members\/1\/$/, 'DELETE')).toBe(false);
});

it('still calls someone else’s removal a removal', async () => {
  await renderScreenOverTabs();

  await fireEvent.press(await screen.findByLabelText('Manage Ada Lovelace'));
  expect(menuOptions()).toContain('Remove from group');
});

it('is read-only for a non-admin (no action sheet)', async () => {
  serve({ role: 'member' });
  await renderScreen();

  const row = await screen.findByLabelText('Ada Lovelace');
  fireEvent.press(row);

  expect(menuWasShown()).toBe(false);
});
