/**
 * The new-chat picker (Phase 9 E2b) — the 1:1-vs-group branch and add-people
 * mode.
 *
 * What's worth pinning: one selection with no title is a 1:1 (`openConversation`,
 * `{ user_id }`), while two selections — or a title on one — is a group
 * (`createGroupChat`, `{ participant_ids }`); creating replaces the picker with
 * the new thread. In add-people mode (`?addTo=`) Create instead adds the selected
 * people to that chat and returns to it, with no title field.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import NewChatScreen from '@/app/messages/new';
import type { PersonSummary } from '@/types';

const mockParams: { addTo?: string } = {};
const mockPush = jest.fn();
const mockReplace = jest.fn();
const mockBack = jest.fn();
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => mockParams,
  router: {
    push: (...args: unknown[]) => mockPush(...args),
    replace: (...args: unknown[]) => mockReplace(...args),
    back: (...args: unknown[]) => mockBack(...args),
    canGoBack: () => true,
  },
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

function person(id: number, name: string): PersonSummary {
  return {
    id,
    display_name: name,
    bio: '',
    avatar_thumb: null,
    connection_status: 'connected',
    is_blocked: false,
  };
}

const ADA = person(2, 'Ada Lovelace');
const GRACE = person(3, 'Grace Hopper');

function serve(connections: PersonSummary[] = [ADA, GRACE]) {
  mockFetch.mockImplementation(async (url: string, init?: { method?: string }) => {
    if (url.includes('filter=connected')) {
      return jsonResponse({
        count: connections.length,
        next: null,
        previous: null,
        results: connections,
      });
    }
    if (url.includes('/participants/')) return jsonResponse(null, 204);
    // Both openConversation and createGroupChat POST here; the returned id is
    // what the picker navigates to.
    if (url.includes('/api/conversations/') && init?.method === 'POST') {
      return jsonResponse({ id: 42 });
    }
    return jsonResponse(null, 404);
  });
}

async function renderScreen() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { gcTime: 0 },
    },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <NewChatScreen />
    </QueryClientProvider>
  );
}

function bodyOf(call: [string, { body?: string }]) {
  return JSON.parse(call[1].body ?? '{}');
}

beforeEach(() => {
  mockFetch.mockReset();
  mockPush.mockReset();
  mockReplace.mockReset();
  mockBack.mockReset();
  mockParams.addTo = undefined;
  globalThis.fetch = mockFetch as unknown as typeof fetch;
});

it('one selection and no title creates a 1:1 and opens its thread', async () => {
  serve();
  await renderScreen();

  await fireEvent.press(await screen.findByLabelText('Ada Lovelace'));
  await fireEvent.press(screen.getByLabelText('Create'));

  await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/messages/42'));
  const post = mockFetch.mock.calls.find(
    ([url, init]) =>
      String(url).endsWith('/api/conversations/') && init?.method === 'POST'
  );
  // A 1:1 is get-or-create by user_id, not a participant list.
  expect(bodyOf(post as [string, { body?: string }])).toEqual({ user_id: 2 });
});

it('two selections creates a group', async () => {
  serve();
  await renderScreen();

  await fireEvent.press(await screen.findByLabelText('Ada Lovelace'));
  await fireEvent.press(screen.getByLabelText('Grace Hopper'));
  await fireEvent.press(screen.getByLabelText('Create'));

  await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/messages/42'));
  const post = mockFetch.mock.calls.find(
    ([url, init]) =>
      String(url).endsWith('/api/conversations/') && init?.method === 'POST'
  );
  const body = bodyOf(post as [string, { body?: string }]);
  expect(body.participant_ids).toEqual([2, 3]);
  expect(body.title).toBe('');
});

it('a title on a single selection still makes a group, not a 1:1', async () => {
  serve();
  await renderScreen();

  await fireEvent.press(await screen.findByLabelText('Ada Lovelace'));
  await fireEvent.changeText(screen.getByLabelText('Chat name'), 'Book club');
  await fireEvent.press(screen.getByLabelText('Create'));

  await waitFor(() => expect(mockReplace).toHaveBeenCalled());
  const post = mockFetch.mock.calls.find(
    ([url, init]) =>
      String(url).endsWith('/api/conversations/') && init?.method === 'POST'
  );
  const body = bodyOf(post as [string, { body?: string }]);
  expect(body.participant_ids).toEqual([2]);
  expect(body.title).toBe('Book club');
});

it('add-people mode adds to the existing chat and returns to it', async () => {
  mockParams.addTo = '5';
  serve();
  await renderScreen();

  // No title field in add mode — the chat already exists.
  expect(screen.queryByLabelText('Chat name')).toBeNull();

  await fireEvent.press(await screen.findByLabelText('Ada Lovelace'));
  await fireEvent.press(screen.getByLabelText('Add'));

  await waitFor(() =>
    expect(
      mockFetch.mock.calls.some(
        ([url, init]) =>
          String(url).includes('/api/conversations/5/participants/') &&
          init?.method === 'POST' &&
          JSON.parse(init.body).user_ids[0] === 2
      )
    ).toBe(true)
  );
  // Returns to the thread it came from rather than opening a new one.
  expect(mockBack).toHaveBeenCalled();
  expect(mockReplace).not.toHaveBeenCalled();
});

it('filters the connection list by the search term', async () => {
  serve();
  await renderScreen();
  await screen.findByLabelText('Ada Lovelace');

  await fireEvent.changeText(
    screen.getByLabelText('Search your connections'),
    'grace'
  );

  expect(screen.getByLabelText('Grace Hopper')).toBeTruthy();
  expect(screen.queryByLabelText('Ada Lovelace')).toBeNull();
});
