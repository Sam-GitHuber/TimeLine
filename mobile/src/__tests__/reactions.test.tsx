/**
 * Reacting, from the feed or a comment.
 *
 * The toggle semantics are the thing worth pinning: the endpoint *toggles*, so
 * sending an emoji you've already used removes it, and the response — not a
 * guess made on the client — is what the row then shows.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import { ReactionBar } from '@/components/ReactionBar';
import type { Reaction } from '@/types';

const mockFetch = jest.fn();

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (body === null ? '' : JSON.stringify(body)),
    json: async () => body,
  };
}

function renderBar(reactions: Reaction[], target: { postId?: number; commentId?: number } = { postId: 5 }) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { gcTime: 0 },
    },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ReactionBar {...target} reactions={reactions} />
    </QueryClientProvider>
  );
}

beforeEach(() => {
  mockFetch.mockReset();
  globalThis.fetch = mockFetch as unknown as typeof fetch;
});

it('renders the pruned counts exactly as the server sent them', async () => {
  // Two viewers legitimately see different counts on the same post; the client
  // never recomputes them.
  await renderBar([
    { emoji: '👍', count: 3, reacted: true },
    { emoji: '🎉', count: 1, reacted: false },
  ]);

  expect(screen.getByText('3')).toBeTruthy();
  expect(screen.getByText('1')).toBeTruthy();
});

it('toggles a chip and shows what came back, not a guess', async () => {
  // The server returns the freshly aggregated summary; if the client guessed
  // instead, its count would drift from everyone else's.
  mockFetch.mockResolvedValue(
    jsonResponse({ reactions: [{ emoji: '👍', count: 2, reacted: false }] })
  );

  await renderBar([{ emoji: '👍', count: 3, reacted: true }]);

  await fireEvent.press(screen.getByText('👍'));

  expect(await screen.findByText('2')).toBeTruthy();
  const [url, init] = mockFetch.mock.calls[0];
  expect(url).toContain('/api/posts/5/react/');
  expect(JSON.parse(init.body)).toEqual({ emoji: '👍' });
});

it('reacts to a comment on the comment endpoint', async () => {
  mockFetch.mockResolvedValue(
    jsonResponse({ reactions: [{ emoji: '❤️', count: 1, reacted: true }] })
  );

  await renderBar([], { commentId: 12 });

  await fireEvent.press(screen.getByLabelText('Add a reaction'));
  await fireEvent.press(await screen.findByLabelText('React with ❤️'));

  await waitFor(() => expect(mockFetch).toHaveBeenCalled());
  expect(mockFetch.mock.calls[0][0]).toContain('/api/comments/12/react/');
});

it('sends a typed emoji, so the full set stays reachable', async () => {
  // The web's picker is a DOM component with no RN equivalent; the system
  // keyboard is what keeps "any emoji from your keyboard" true on the phone.
  mockFetch.mockResolvedValue(
    jsonResponse({ reactions: [{ emoji: '🦔', count: 1, reacted: true }] })
  );

  await renderBar([]);

  await fireEvent.press(screen.getByLabelText('Add a reaction'));
  await fireEvent.changeText(await screen.findByLabelText('Any emoji'), '🦔');
  await fireEvent.press(screen.getByLabelText('Add reaction'));

  await waitFor(() => expect(mockFetch).toHaveBeenCalled());
  expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toEqual({ emoji: '🦔' });
});

it('surfaces the server’s rejection when the input is not an emoji', async () => {
  // Validation lives in `api/emoji.py` and is not duplicated here, so the
  // message has to reach the person who typed.
  mockFetch.mockResolvedValue(
    jsonResponse({ emoji: ["That's not a valid emoji."] }, 400)
  );

  await renderBar([]);

  await fireEvent.press(screen.getByLabelText('Add a reaction'));
  await fireEvent.changeText(await screen.findByLabelText('Any emoji'), 'nope');
  await fireEvent.press(screen.getByLabelText('Add reaction'));

  expect(await screen.findByText("That's not a valid emoji.")).toBeTruthy();
});

it('offers "who reacted" only once there is someone to show', async () => {
  const { rerender } = await renderBar([]);
  expect(screen.queryByText('Who reacted?')).toBeNull();

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  await rerender(
    <QueryClientProvider client={queryClient}>
      <ReactionBar postId={5} reactions={[{ emoji: '👍', count: 1, reacted: false }]} />
    </QueryClientProvider>
  );

  expect(screen.getByText('Who reacted?')).toBeTruthy();
});

it('re-syncs when the server summary changes underneath it', async () => {
  // A feed refetch brings new counts; the row must follow them rather than
  // clinging to what it rendered first.
  const { rerender } = await renderBar([{ emoji: '👍', count: 1, reacted: false }]);
  expect(screen.getByText('1')).toBeTruthy();

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  await rerender(
    <QueryClientProvider client={queryClient}>
      <ReactionBar postId={5} reactions={[{ emoji: '👍', count: 4, reacted: false }]} />
    </QueryClientProvider>
  );

  expect(screen.getByText('4')).toBeTruthy();
});
