/**
 * The People hub screen (E1) — its three segments and the request inbox.
 *
 * What's worth pinning: each segment hits the right endpoint (Connections and
 * Discover differ only by a query-string filter, easy to cross-wire), tapping a
 * row opens that person's profile, and approving a request fires the approve
 * endpoint and refreshes the shared count so the badge can't go stale.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import PeopleScreen from '@/app/(tabs)/people';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  // Read `mockPush` lazily through an arrow — the factory is hoisted above the
  // `const mockPush` line, so referencing it directly would capture undefined
  // (the trap the C4 notes describe).
  router: { push: (...args: unknown[]) => mockPush(...args) },
}));

const mockFetch = jest.fn();

function page(results: unknown[]) {
  return { count: results.length, next: null, previous: null, results };
}

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (body === null ? '' : JSON.stringify(body)),
    json: async () => body,
  };
}

const ADA = { id: 1, display_name: 'Ada Lovelace', avatar_thumb: null };
const GRACE = {
  id: 2,
  display_name: 'Grace Hopper',
  avatar_thumb: null,
  bio: '',
  connection_status: 'none',
  is_blocked: false,
};
const REQUEST = {
  id: 55,
  requester: { id: 3, display_name: 'Alan Turing', avatar_thumb: null },
  created_at: '2026-07-22T10:00:00Z',
};

/**
 * Route each request to a payload by URL, so segment switches (which fire
 * different endpoints) each get the right data without ordering assumptions.
 */
function routeFetch(url: string) {
  if (url.includes('filter=connected')) return jsonResponse(page([ADA]));
  if (url.includes('filter=discover')) return jsonResponse(page([GRACE]));
  if (url.includes('connection-requests')) return jsonResponse(page([REQUEST]));
  return jsonResponse(null, 204);
}

async function renderPeople() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { gcTime: 0 },
    },
  });
  const invalidate = jest.spyOn(queryClient, 'invalidateQueries');
  await render(
    <QueryClientProvider client={queryClient}>
      <PeopleScreen />
    </QueryClientProvider>
  );
  return { invalidate };
}

beforeEach(() => {
  mockFetch.mockReset();
  mockFetch.mockImplementation((url: string) => Promise.resolve(routeFetch(url)));
  globalThis.fetch = mockFetch as unknown as typeof fetch;
  mockPush.mockClear();
});

it('opens on Connections and lists people you are connected with', async () => {
  await renderPeople();
  expect(await screen.findByText('Ada Lovelace')).toBeTruthy();
  expect(
    mockFetch.mock.calls.some(([url]) => String(url).includes('filter=connected'))
  ).toBe(true);
});

it('taps a connection row through to their profile', async () => {
  await renderPeople();
  fireEvent.press(await screen.findByText('Ada Lovelace'));
  expect(mockPush).toHaveBeenCalledWith('/u/1');
});

it('switches to Discover and shows a Connect control per person', async () => {
  await renderPeople();
  await screen.findByText('Ada Lovelace');

  fireEvent.press(screen.getByText('Discover'));

  expect(await screen.findByText('Grace Hopper')).toBeTruthy();
  expect(screen.getByText('Connect')).toBeTruthy();
});

it('shows incoming requests and approves one, refreshing the shared count', async () => {
  const { invalidate } = await renderPeople();
  await screen.findByText('Ada Lovelace');

  fireEvent.press(screen.getByText('Requests'));
  expect(await screen.findByText('Alan Turing')).toBeTruthy();

  fireEvent.press(screen.getByLabelText('Approve Alan Turing'));

  await waitFor(() =>
    expect(
      mockFetch.mock.calls.some(
        ([url, init]) =>
          String(url).includes('/connection-requests/55/approve/') &&
          init.method === 'POST'
      )
    ).toBe(true)
  );
  // The badge/count query is invalidated so it can't linger stale.
  await waitFor(() =>
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['connectionRequests'] })
  );
});

it('offers a retry on a load error and recovers when tapped', async () => {
  // The first connections fetch fails; the retry succeeds. Keyed on the URL so
  // the badge request (which also fires on mount) isn't the one that fails.
  let connectedAttempts = 0;
  mockFetch.mockImplementation((url: string) => {
    if (url.includes('filter=connected')) {
      connectedAttempts += 1;
      if (connectedAttempts === 1) return Promise.reject(new Error('offline'));
    }
    return Promise.resolve(routeFetch(url));
  });

  await renderPeople();

  fireEvent.press(await screen.findByText('Try again'));

  // The retry re-fetches and the connection now renders.
  expect(await screen.findByText('Ada Lovelace')).toBeTruthy();
});

it('rejects a request via the reject endpoint', async () => {
  await renderPeople();
  await screen.findByText('Ada Lovelace');

  fireEvent.press(screen.getByText('Requests'));
  fireEvent.press(await screen.findByLabelText('Reject Alan Turing'));

  await waitFor(() =>
    expect(
      mockFetch.mock.calls.some(
        ([url, init]) =>
          String(url).includes('/connection-requests/55/reject/') &&
          init.method === 'POST'
      )
    ).toBe(true)
  );
});
