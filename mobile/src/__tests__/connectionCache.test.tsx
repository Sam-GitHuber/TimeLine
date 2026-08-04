/**
 * What a **connection write** refreshes — `connectionCache.ts` applied at the
 * four sites that make one: the Connect button, the Block button, the locked
 * pending-chat panel, and the requests inbox.
 *
 * A connection is the visibility boundary itself, so the set is much wider than
 * the screen any of these buttons sits on: `connected_user_ids` gates the feed,
 * profiles, group timelines, comment trees, the personal calendar and both
 * event lists. Each site used to hold its own list of what to refresh, and the
 * four had drifted apart (#278) with the whole calendar/events family missing
 * from all of them (#285).
 *
 * The gated surfaces are **mounted alongside** the write rather than seeded into
 * the cache, because that's the situation the bug lives in: the tabs stay
 * mounted for the life of the session, so their queries keep live observers and
 * never remount. A seeded but unobserved entry refetches on its next mount
 * whatever we do, and would pass against the broken build. Their keys carry the
 * suffixes the real screens use (`['groupEvents', 7, 'upcoming']`, not
 * `['groupEvents']`), so a fix that invalidated the bare keys as *exact* keys
 * wouldn't pass here either. Same reasoning as `groupActions.test.tsx`.
 */

import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { Alert } from 'react-native';

import PeopleScreen from '@/app/(tabs)/people';
import { BlockButton } from '@/components/BlockButton';
import { ConnectButton } from '@/components/ConnectButton';
import { PendingChatPanel } from '@/components/PendingChatPanel';

jest.mock('expo-router', () => ({
  router: { push: jest.fn(), replace: jest.fn() },
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

const REQUEST = {
  id: 55,
  requester: { id: 42, display_name: 'Ada Lovelace', avatar_thumb: null },
  created_at: '2026-08-04T10:00:00Z',
};

/** A screen elsewhere in the app, observing its query the way the real one does. */
function MountedScreen({
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
 * The surfaces `connected_user_ids` gates, under the keys their real screens
 * use. `['feed', true]` is the include-groups-in-feed preference turned on.
 */
function gatedSurfaces() {
  return {
    feed: { key: ['feed', true], fn: jest.fn(async () => null) },
    calendar: { key: ['personalCalendar'], fn: jest.fn(async () => []) },
    groupEvents: { key: ['groupEvents', 7, 'upcoming'], fn: jest.fn(async () => []) },
    groupCalendar: { key: ['groupCalendar', 7], fn: jest.fn(async () => []) },
    groupPosts: { key: ['groupPosts', 7], fn: jest.fn(async () => null) },
    comments: { key: ['comments', 9], fn: jest.fn(async () => []) },
    conversations: { key: ['conversations'], fn: jest.fn(async () => null) },
  };
}
// `['connections']` is deliberately not one of these: the People screen holds
// that exact key itself, and two observers on one key share a single query, so
// mounting a stand-in alongside it would count nothing. It's asserted through
// the invalidation spy in the block test instead — the one place it regressed.

type Surfaces = ReturnType<typeof gatedSurfaces>;

/** How many times each surface has loaded, keyed by name for a readable diff. */
function loadCounts(surfaces: Surfaces) {
  return Object.fromEntries(
    Object.entries(surfaces).map(([name, s]) => [name, s.fn.mock.calls.length])
  );
}

/** Every surface at `n` — the shape both the "all refreshed" and "none" assertions want. */
function allAt(n: number) {
  return Object.fromEntries(Object.keys(gatedSurfaces()).map((name) => [name, n]));
}

async function renderOverSurfaces(subject: ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: {
      // `gcTime: 0` on mutations as well as queries: the default five-minute
      // mutation timer keeps Node's event loop alive and hangs the run after the
      // suite has already passed.
      queries: { retry: false, gcTime: 0 },
      mutations: { gcTime: 0 },
    },
  });
  const invalidate = jest.spyOn(queryClient, 'invalidateQueries');
  const surfaces = gatedSurfaces();
  await render(
    <QueryClientProvider client={queryClient}>
      {Object.entries(surfaces).map(([name, s]) => (
        <MountedScreen key={name} queryKey={s.key} queryFn={s.fn} />
      ))}
      {subject}
    </QueryClientProvider>
  );
  // Their first load, so a later call is unambiguously a refetch.
  await waitFor(() => expect(loadCounts(surfaces)).toEqual(allAt(1)));
  return { surfaces, invalidate };
}

/**
 * Turn the event loop a few times, so a write that *did* refresh something has
 * had room to do it — the only honest way to read a negative here. Deliberately
 * not `settle()` from `./helpers`; see `groupActions.test.tsx` for what its
 * `act()` does to the *next* test in the file.
 */
async function turnEventLoop(turns = 5): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

beforeEach(() => {
  // The refused write alerts (#236); nothing here is about the wording.
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  mockFetch.mockReset();
  mockFetch.mockImplementation(async (url: string) => {
    if (String(url).includes('/disconnect-impact/')) return jsonResponse({ chats: [] });
    if (String(url).includes('connection-requests')) return jsonResponse(page([REQUEST]));
    if (String(url).includes('filter=')) return jsonResponse(page([]));
    return jsonResponse(null, 204);
  });
  globalThis.fetch = mockFetch as unknown as typeof fetch;
});

/**
 * The #285 scenario, and the one that's permanent on the phone: Ada organised a
 * dated event you can see because you're connected. Disconnecting drops her out
 * of `connected_user_ids`, so the server will refuse that event from here on —
 * but nothing marked the Calendar tab stale, and it kept offering it.
 */
it('refreshes the calendars and the event lists when you disconnect', async () => {
  const { surfaces } = await renderOverSurfaces(
    <ConnectButton userId={42} displayName="Ada Lovelace" connectionStatus="connected" />
  );

  fireEvent.press(screen.getByText('Connected'));
  fireEvent.press(await screen.findByText('Disconnect'));

  await waitFor(() =>
    expect(
      mockFetch.mock.calls.some(
        ([url, init]) => String(url).endsWith('/users/42/connect/') && init.method === 'DELETE'
      )
    ).toBe(true)
  );
  await waitFor(() => expect(loadCounts(surfaces)).toEqual(allAt(2)));
});

/**
 * The other half of #278's mobile side: connecting from a profile rather than
 * from the locked panel. `api.connect` promotes you into every group chat you
 * now share (`promote_shared_chats`), but this button never named
 * `['conversations']` — so the Messages tab, mounted for the session, kept
 * showing the chat locked.
 */
it('refreshes the conversation list when you connect from a profile', async () => {
  const { surfaces } = await renderOverSurfaces(
    <ConnectButton userId={42} displayName="Ada Lovelace" connectionStatus="incoming" />
  );

  fireEvent.press(screen.getByText('Approve'));

  await waitFor(() => expect(loadCounts(surfaces)).toEqual(allAt(2)));
});

/**
 * Blocking deletes the same `Connection` row a disconnect does, so it has to
 * refresh the same set. Its own list omitted `['connections']` — leaving someone
 * you'd just blocked listed as a connection — and every calendar and event key.
 */
it('refreshes the same set when you block someone', async () => {
  const { surfaces, invalidate } = await renderOverSurfaces(
    <BlockButton userId={42} displayName="Ada Lovelace" isBlocked={false} />
  );

  await fireEvent.press(screen.getByLabelText('Block'));
  // The modal's confirm also reads "Block"; the trigger is the first.
  const confirms = await screen.findAllByText('Block');
  await fireEvent.press(confirms.at(-1)!);

  await waitFor(() =>
    expect(
      mockFetch.mock.calls.some(
        ([url, init]) => String(url).endsWith('/users/42/block/') && init.method === 'POST'
      )
    ).toBe(true)
  );
  await waitFor(() => expect(loadCounts(surfaces)).toEqual(allAt(2)));
  // The key the block path never had: without it the person you just blocked
  // stayed listed as a connection (#278).
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ['connections'] });
});

/** The locked panel's Connect is the same write, so it refreshes the same set. */
it('refreshes the same set when you connect from the locked chat panel', async () => {
  const { surfaces } = await renderOverSurfaces(
    <PendingChatPanel
      conversationId={3}
      mustConnectWith={[{ id: 42, display_name: 'Ada Lovelace', avatar_thumb: null }]}
      onLeave={jest.fn()}
    />
  );

  fireEvent.press(screen.getByLabelText('Connect with Ada Lovelace'));

  await waitFor(() => expect(loadCounts(surfaces)).toEqual(allAt(2)));
});

describe('the requests inbox', () => {
  async function openRequests() {
    const { surfaces } = await renderOverSurfaces(<PeopleScreen />);
    fireEvent.press(screen.getByText('Requests'));
    await screen.findByLabelText('Approve Ada Lovelace');
    return surfaces;
  }

  it('refreshes everything a connection gates when you approve', async () => {
    const surfaces = await openRequests();
    const before = loadCounts(surfaces);

    fireEvent.press(screen.getByLabelText('Approve Ada Lovelace'));

    await waitFor(() =>
      expect(
        mockFetch.mock.calls.some(([url]) =>
          String(url).includes('/connection-requests/55/approve/')
        )
      ).toBe(true)
    );
    await waitFor(() =>
      expect(loadCounts(surfaces)).toEqual(
        Object.fromEntries(Object.entries(before).map(([name, n]) => [name, n + 1]))
      )
    );
  });

  /**
   * Rejecting deletes a still-pending row and connects nobody, so none of the
   * gated surfaces changed — and unlike the button's four states, this narrow
   * case is safe to assume, because the server enforces it (the view 404s unless
   * the row is still pending).
   */
  it('leaves the gated surfaces alone when you reject', async () => {
    const surfaces = await openRequests();
    const before = loadCounts(surfaces);

    fireEvent.press(screen.getByLabelText('Reject Ada Lovelace'));

    await waitFor(() =>
      expect(
        mockFetch.mock.calls.some(([url]) =>
          String(url).includes('/connection-requests/55/reject/')
        )
      ).toBe(true)
    );
    await turnEventLoop();
    expect(loadCounts(surfaces)).toEqual(before);
  });
});

/** Nothing changed on the server, so nothing is refreshed. */
it('refreshes nothing when the server refuses the write', async () => {
  const { surfaces } = await renderOverSurfaces(
    <ConnectButton userId={42} displayName="Ada Lovelace" connectionStatus="incoming" />
  );
  mockFetch.mockImplementation(async () =>
    jsonResponse({ detail: 'You can’t connect with this person.' }, 403)
  );

  fireEvent.press(screen.getByText('Approve'));

  await turnEventLoop();
  expect(loadCounts(surfaces)).toEqual(allAt(1));
});
