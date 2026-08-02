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
import { Alert } from 'react-native';

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

// Issue #236. A rejected write left the button un-disabled, still reading
// whatever it read before, and repainted nothing — no invalidation runs on the
// failure path — so the tap read as never having registered.
describe('a rejected write', () => {
  it('says which action failed, in the server’s words when it has any', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ detail: 'You can’t connect with this person.' }, 403)
    );
    await renderButton('none');

    fireEvent.press(screen.getByText('Connect'));

    await waitFor(() => expect(alert).toHaveBeenCalled());
    expect(alert.mock.calls[0][1]).toBe('You can’t connect with this person.');
    alert.mockRestore();
  });

  // Offline is the likeliest failure, and React Native rejects with a bare
  // `TypeError: Network request failed` — never fit to show. The fallback is
  // per-state so it names *which* of the four actions didn't happen.
  it('falls back to our own per-state words when the server never spoke', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    mockFetch.mockRejectedValueOnce(new TypeError('Network request failed'));
    await renderButton('requested');

    fireEvent.press(screen.getByText('Requested'));

    await waitFor(() => expect(alert).toHaveBeenCalled());
    expect(alert.mock.calls[0][1]).toBe(
      'Couldn’t withdraw that request — try again.'
    );
    alert.mockRestore();
  });

  // The other half of "the server never spoke": it answered, but with nothing a
  // person can read. `request` synthesizes "Request failed (500)" for that, and
  // that string carries a status and a message — so a bare `instanceof ApiError`
  // check would put it straight on screen. `fromServer` is what keeps it out.
  it('never shows the synthesized message from a body-less server error', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    // A 500 rendered as an HTML page: no DRF `detail` to pull out.
    mockFetch.mockResolvedValueOnce(jsonResponse('<html>Server Error</html>', 500));
    await renderButton('requested');

    fireEvent.press(screen.getByText('Requested'));

    await waitFor(() => expect(alert).toHaveBeenCalled());
    expect(alert.mock.calls[0][1]).toBe(
      'Couldn’t withdraw that request — try again.'
    );
    alert.mockRestore();
  });

  it('holds the disconnect warning open so its confirm is the retry', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    mockFetch.mockResolvedValueOnce(jsonResponse({ chats: [] }));
    await renderButton('connected');

    fireEvent.press(screen.getByText('Connected'));
    const confirm = await screen.findByText('Disconnect');

    mockFetch.mockRejectedValueOnce(new TypeError('Network request failed'));
    fireEvent.press(confirm);

    await waitFor(() => expect(alert).toHaveBeenCalled());
    expect(alert.mock.calls[0][1]).toBe('Couldn’t disconnect — try again.');
    // Dismissing on confirm is what left the failure nowhere to go.
    expect(screen.queryByText('Disconnect')).toBeTruthy();
    alert.mockRestore();
  });
});
