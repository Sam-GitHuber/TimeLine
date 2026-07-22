/**
 * The connection control's state machine (E1).
 *
 * The thing worth pinning is that the four `connection_status` values map to the
 * right label *and* the right action — a mis-wire here would, say, disconnect
 * someone when you meant to approve them. Also pinned: only the `connected`
 * state routes through the disconnect warning; the others mutate straight away.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import { ConnectButton } from '@/components/ConnectButton';
import type { ProfileUser } from '@/types';

const mockFetch = jest.fn();

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (body === null ? '' : JSON.stringify(body)),
    json: async () => body,
  };
}

// `render` is async in RNTL v14; awaiting it inside the helper is what keeps
// `screen` populated (a bare `render(...)` returns a promise that spreads to
// nothing, and every later query then throws "render has not been called").
async function renderButton(status: ProfileUser['connection_status']) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { gcTime: 0 },
    },
  });
  const invalidate = jest.spyOn(queryClient, 'invalidateQueries');
  const utils = await render(
    <QueryClientProvider client={queryClient}>
      <ConnectButton userId={42} displayName="Ada Lovelace" connectionStatus={status} />
    </QueryClientProvider>
  );
  return { ...utils, invalidate };
}

beforeEach(() => {
  mockFetch.mockReset();
  globalThis.fetch = mockFetch as unknown as typeof fetch;
});

it.each([
  ['none', 'Connect'],
  ['requested', 'Requested'],
  ['incoming', 'Approve'],
  ['connected', 'Connected'],
] as const)('shows "%s" as "%s"', async (status, label) => {
  await renderButton(status);
  expect(screen.getByText(label)).toBeTruthy();
});

it('sends a POST to connect from the "none" state', async () => {
  mockFetch.mockResolvedValueOnce(jsonResponse(null, 204));
  const { invalidate } = await renderButton('none');

  fireEvent.press(screen.getByText('Connect'));

  await waitFor(() => expect(mockFetch).toHaveBeenCalled());
  const [url, init] = mockFetch.mock.calls[0];
  expect(url).toBe('https://your-timeline.net/api/users/42/connect/');
  expect(init.method).toBe('POST');
  // Every view the change touches is refreshed.
  await waitFor(() =>
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['feed'] })
  );
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ['user', 42] });
});

it('accepts an incoming request with a POST (not a second request)', async () => {
  mockFetch.mockResolvedValueOnce(jsonResponse(null, 204));
  await renderButton('incoming');

  fireEvent.press(screen.getByText('Approve'));

  await waitFor(() => expect(mockFetch).toHaveBeenCalled());
  expect(mockFetch.mock.calls[0][1].method).toBe('POST');
});

it('withdraws a pending request with a DELETE, no warning', async () => {
  mockFetch.mockResolvedValueOnce(jsonResponse(null, 204));
  await renderButton('requested');

  fireEvent.press(screen.getByText('Requested'));

  await waitFor(() => expect(mockFetch).toHaveBeenCalled());
  expect(mockFetch.mock.calls[0][1].method).toBe('DELETE');
  // Withdrawing never had a live connection to break, so no confirmation.
  expect(screen.queryByText('Disconnect')).toBeNull();
});

it('routes a disconnect through the warning modal before mutating', async () => {
  // First fetch is the impact check the modal fires on open; the disconnect
  // itself must not have gone out yet.
  mockFetch.mockResolvedValueOnce(jsonResponse({ chats: [] }));
  await renderButton('connected');

  fireEvent.press(screen.getByText('Connected'));

  // The modal is up (its confirm button reads "Disconnect")…
  const confirm = await screen.findByText('Disconnect');
  // …and only the impact GET has fired — no DELETE yet.
  await waitFor(() => expect(mockFetch).toHaveBeenCalled());
  expect(mockFetch.mock.calls[0][0]).toContain('/disconnect-impact/');
  expect(mockFetch.mock.calls.every(([, init]) => init.method !== 'DELETE')).toBe(
    true
  );

  // Confirming fires the disconnect.
  mockFetch.mockResolvedValueOnce(jsonResponse(null, 204));
  fireEvent.press(confirm);

  await waitFor(() =>
    expect(
      mockFetch.mock.calls.some(
        ([url, init]) =>
          url === 'https://your-timeline.net/api/users/42/connect/' &&
          init.method === 'DELETE'
      )
    ).toBe(true)
  );
});

it('lists the impacted chats in the warning when a disconnect would sever one', async () => {
  mockFetch.mockResolvedValueOnce(
    jsonResponse({ chats: [{ id: 1, title: 'Hiking crew', kind: 'group' }] })
  );
  await renderButton('connected');

  fireEvent.press(screen.getByText('Connected'));

  expect(await screen.findByText('Hiking crew')).toBeTruthy();
});
