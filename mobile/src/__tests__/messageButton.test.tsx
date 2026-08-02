/**
 * "Message" on a connected person's profile (E2) — it get-or-creates the 1:1
 * conversation, then pushes its thread.
 *
 * What's pinned is the failure path (issue #236). The button had no error path
 * at all, so a rejected `openConversation` flipped the label from "Opening…"
 * back to "Message" with no screen pushed: a tap that silently did nothing,
 * indistinguishable from having missed the button.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import { Alert } from 'react-native';

import { MessageButton } from '@/components/MessageButton';

jest.mock('expo-router', () => ({
  router: { push: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: () => true },
}));

const mockPush = (router as unknown as { push: jest.Mock }).push;
const mockFetch = jest.fn();

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (body === null ? '' : JSON.stringify(body)),
    json: async () => body,
  };
}

// `render` is async in RNTL v14; awaiting it is what keeps `screen` populated.
async function renderButton() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { gcTime: 0 },
    },
  });
  await render(
    <QueryClientProvider client={queryClient}>
      <MessageButton userId={42} />
    </QueryClientProvider>
  );
}

beforeEach(() => {
  mockFetch.mockReset();
  mockPush.mockReset();
  globalThis.fetch = mockFetch as unknown as typeof fetch;
});

it('opens the conversation and pushes its thread', async () => {
  mockFetch.mockResolvedValueOnce(jsonResponse({ id: 7 }, 200));
  await renderButton();

  fireEvent.press(screen.getByLabelText('Message'));

  await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/messages/7'));
});

it('says so when opening the chat is refused, in the server’s words', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  mockFetch.mockResolvedValueOnce(
    jsonResponse({ detail: 'You can’t message this person.' }, 403)
  );
  await renderButton();

  fireEvent.press(screen.getByLabelText('Message'));

  await waitFor(() => expect(alert).toHaveBeenCalled());
  expect(alert.mock.calls[0][1]).toBe('You can’t message this person.');
  expect(mockPush).not.toHaveBeenCalled();
  alert.mockRestore();
});

// Offline is the likeliest failure here, and React Native rejects with a bare
// `TypeError: Network request failed` — never fit to show a person.
it('shows our own words when the request never reached the server', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  mockFetch.mockRejectedValueOnce(new TypeError('Network request failed'));
  await renderButton();

  fireEvent.press(screen.getByLabelText('Message'));

  await waitFor(() => expect(alert).toHaveBeenCalled());
  expect(alert.mock.calls[0][1]).toBe('Try again.');
  alert.mockRestore();
});
