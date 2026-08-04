/**
 * The Groups tab (Phase 9 E3a) — the groups list and the invites segment.
 *
 * What's worth pinning: the Groups segment lists your groups and taps through to
 * one; the Invites segment accepts/declines a pending invite via the right
 * endpoint and refreshes the shared count so the tab badge can't go stale.
 */

import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import GroupsScreen from '@/app/(tabs)/groups';
import type { Group, GroupInvite } from '@/types';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  router: { push: (...args: unknown[]) => mockPush(...args) },
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

function page(results: unknown[]) {
  return { count: results.length, next: null, previous: null, results };
}

const FAMILY: Group = {
  id: 7,
  name: 'The Andersons',
  description: 'Family',
  avatar_url: null,
  avatar_thumb: null,
  member_count: 4,
  your_role: 'admin',
  created_at: '2026-07-01T10:00:00Z',
};

const INVITE: GroupInvite = {
  id: 99,
  group: { id: 8, name: 'Book Club', avatar_thumb: null },
  invited_by: { id: 3, display_name: 'Ada Lovelace', avatar_thumb: null },
  created_at: '2026-07-22T10:00:00Z',
};

function serve({
  groups = [FAMILY],
  invites = [INVITE],
}: { groups?: Group[]; invites?: GroupInvite[] } = {}) {
  mockFetch.mockImplementation(async (url: string) => {
    if (url.includes('/api/group-invites/')) return jsonResponse(page(invites));
    if (url.includes('/api/groups/')) return jsonResponse(page(groups));
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
  await render(
    <QueryClientProvider client={queryClient}>
      <GroupsScreen />
    </QueryClientProvider>
  );
  return { invalidate };
}

beforeEach(() => {
  mockFetch.mockReset();
  mockPush.mockReset();
  globalThis.fetch = mockFetch as unknown as typeof fetch;
});

it('lists your groups and taps through to one', async () => {
  serve();
  await renderScreen();

  expect(await screen.findByText('The Andersons')).toBeTruthy();
  expect(screen.getByText('4 members · Admin')).toBeTruthy();

  fireEvent.press(screen.getByText('The Andersons'));
  expect(mockPush).toHaveBeenCalledWith('/groups/7');
});

it('shows invites and accepts one, refreshing the shared count', async () => {
  serve();
  const { invalidate } = await renderScreen();
  await screen.findByText('The Andersons');

  fireEvent.press(screen.getByText('Invites'));
  expect(await screen.findByText('Book Club')).toBeTruthy();
  expect(screen.getByText('Ada Lovelace invited you')).toBeTruthy();

  fireEvent.press(screen.getByLabelText('Accept Book Club'));

  await waitFor(() =>
    expect(
      mockFetch.mock.calls.some(
        ([url, init]) =>
          String(url).includes('/api/group-invites/99/accept/') &&
          init?.method === 'POST'
      )
    ).toBe(true)
  );
  await waitFor(() =>
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['groupInvites'] })
  );
});

it('declines an invite via the reject endpoint', async () => {
  serve();
  await renderScreen();
  await screen.findByText('The Andersons');

  fireEvent.press(screen.getByText('Invites'));
  fireEvent.press(await screen.findByLabelText('Decline Book Club'));

  await waitFor(() =>
    expect(
      mockFetch.mock.calls.some(
        ([url, init]) =>
          String(url).includes('/api/group-invites/99/reject/') &&
          init?.method === 'POST'
      )
    ).toBe(true)
  );
});

describe('refreshing what a membership change gates', () => {
  /**
   * A tab elsewhere in the app, observing its query the way the real screen
   * does — mounted rather than seeded, because a tab navigator keeps every
   * visited tab mounted, so its query has a live observer and never remounts on
   * a tab switch. A seeded but unobserved entry refetches on its next mount
   * whatever we do, and would pass against the broken build (`compose.test.tsx`
   * has the same harness for the same reason).
   */
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

  async function renderScreenOverTabs() {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: 0 },
        mutations: { gcTime: 0 },
      },
    });
    const tabs = {
      // `true` is the include-groups-in-feed preference turned on — the setting
      // that puts a group's posts on the home feed at all. The suffix is the one
      // the real screen uses, so invalidating the bare key as an *exact* key
      // wouldn't pass here.
      feed: { key: ['feed', true], fn: jest.fn(async () => emptyList()) },
      calendar: { key: ['personalCalendar'], fn: jest.fn(async () => []) },
    };
    await render(
      <QueryClientProvider client={queryClient}>
        {Object.entries(tabs).map(([name, tab]) => (
          <MountedTab key={name} queryKey={tab.key} queryFn={tab.fn} />
        ))}
        <GroupsScreen />
      </QueryClientProvider>
    );
    // Their first load, so a later call is unambiguously a refetch.
    await waitFor(() => expect(loadCounts(tabs)).toEqual({ feed: 1, calendar: 1 }));
    return tabs;
  }

  type Tabs = Awaited<ReturnType<typeof renderScreenOverTabs>>;

  function emptyList() {
    return {
      pages: [{ count: 0, next: null, previous: null, results: [] }],
      pageParams: [undefined],
    };
  }

  function loadCounts(tabs: Tabs) {
    return Object.fromEntries(
      Object.entries(tabs).map(([name, tab]) => [name, tab.fn.mock.calls.length])
    );
  }

  function decided(inviteId: number, action: 'accept' | 'reject') {
    return mockFetch.mock.calls.some(
      ([url, init]) =>
        String(url).includes(`/api/group-invites/${inviteId}/${action}/`) &&
        init?.method === 'POST'
    );
  }

  it('refreshes the feed and the calendar when you accept an invite', async () => {
    serve();
    const tabs = await renderScreenOverTabs();

    fireEvent.press(await screen.findByText('Invites'));
    fireEvent.press(await screen.findByLabelText('Accept Book Club'));

    await waitFor(() => expect(decided(99, 'accept')).toBe(true));
    // Joining is the inverse of leaving (#277): the group's posts belong on the
    // home feed from now on and its events on the calendar, and the Groups tab
    // you accepted from is not the tab that has to show them.
    await waitFor(() => expect(loadCounts(tabs)).toEqual({ feed: 2, calendar: 2 }));
  });

  it('leaves them alone when you decline one', async () => {
    serve();
    const tabs = await renderScreenOverTabs();

    fireEvent.press(await screen.findByText('Invites'));
    const invitesLoads = invitesRequests();
    fireEvent.press(await screen.findByLabelText('Decline Book Club'));

    // Declining deletes the invite row and joins nothing, so neither gated
    // surface changed — refreshing them would be a needless round-trip on a
    // phone. The invites list reloading is the tell that the write has landed
    // and its invalidations have run, so the counts below aren't read early.
    await waitFor(() => expect(decided(99, 'reject')).toBe(true));
    await waitFor(() => expect(invitesRequests()).toBeGreaterThan(invitesLoads));
    expect(loadCounts(tabs)).toEqual({ feed: 1, calendar: 1 });
  });

  /** How many times the invites list has been fetched (its POSTs excluded). */
  function invitesRequests() {
    return mockFetch.mock.calls.filter(
      ([url, init]) =>
        String(url).includes('/api/group-invites/') && init?.method !== 'POST'
    ).length;
  }
});

it('offers a New group CTA when you have no groups', async () => {
  serve({ groups: [] });
  await renderScreen();

  expect(await screen.findByText('No groups yet')).toBeTruthy();
  fireEvent.press(screen.getByText('New group'));
  expect(mockPush).toHaveBeenCalledWith('/groups/new');
});
