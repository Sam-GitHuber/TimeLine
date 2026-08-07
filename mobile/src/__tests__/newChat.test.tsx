/**
 * The new-chat picker (Phase 9 E2b) — the 1:1-vs-group branch and add-people
 * mode.
 *
 * What's worth pinning: one selection is a 1:1 (`openConversation`,
 * `{ user_id }`) and two is a group (`createGroupChat`, `{ participant_ids }`);
 * creating replaces the picker with the new thread. The name field is only
 * offered at two-plus, and a name left behind by an untick is ignored, so a
 * title can never turn a 1:1 into a two-person group behind your back (#156).
 * In add-people mode
 * (`?addTo=`) Create instead adds the selected people to that chat and returns
 * to it, with no title field.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import NewChatScreen from '@/app/messages/new';
import type { PersonSummary } from '@/types';

import { androidIt, captureBackHandler, holdRequest, pressBack, settle } from './helpers';

const mockParams: { addTo?: string } = {};
const mockPush = jest.fn();
const mockReplace = jest.fn();
const mockBack = jest.fn();
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => mockParams,
  // The screen holds Android's back and iOS's swipe while Create is out (#259).
  // Both want a navigator there isn't one of under test — same stand-ins as
  // `jest.setup.js`, whose global stubs this factory overrides.
  useFocusEffect: (callback: () => void | (() => void)) =>
    // `require`, not an import: the factory is hoisted above the imports.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('react').useEffect(callback, [callback]),
  useNavigation: () => ({ setOptions: () => {} }),
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

/**
 * `pageTwoFails` stages #248: page one lands carrying a `next`, and the page it
 * points at 500s. The failure is deliberately a macrotask late — a mock that
 * rejects instantly settles inside the same React batch as the render that
 * fired it, which is not how a real request behaves and would hide the loop
 * (see `settle`).
 */
function serve(
  connections: PersonSummary[] = [ADA, GRACE],
  { pageTwoFails = false } = {}
) {
  mockFetch.mockImplementation(async (url: string, init?: { method?: string }) => {
    if (url.includes('filter=connected')) {
      if (pageTwoFails && url.includes('page=2')) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        return jsonResponse({ detail: 'Server error.' }, 500);
      }
      return jsonResponse({
        count: connections.length,
        next: pageTwoFails
          ? 'http://localhost:8000/api/users/?filter=connected&page=2'
          : null,
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

/** Every request for the second page of connections — one is a walk that
 *  stopped, many is the loop. */
function pageTwoRequests() {
  return mockFetch.mock.calls.filter(([url]) => String(url).includes('page=2'));
}

beforeEach(() => {
  mockFetch.mockReset();
  mockPush.mockReset();
  mockReplace.mockReset();
  mockBack.mockReset();
  captureBackHandler();
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

it('offers no name field until a second person is ticked (#156)', async () => {
  serve();
  await renderScreen();

  // Nothing selected, and one selected, are both potential 1:1s — a title is
  // what would turn them into a two-person group, so it isn't on offer.
  await screen.findByLabelText('Ada Lovelace');
  expect(screen.queryByLabelText('Chat name')).toBeNull();

  await fireEvent.press(screen.getByLabelText('Ada Lovelace'));
  expect(screen.queryByLabelText('Chat name')).toBeNull();

  await fireEvent.press(screen.getByLabelText('Grace Hopper'));
  expect(screen.getByLabelText('Chat name')).toBeTruthy();
});

it('ignores a name typed at two selections once one is unticked (#156)', async () => {
  serve();
  await renderScreen();

  await fireEvent.press(await screen.findByLabelText('Ada Lovelace'));
  await fireEvent.press(screen.getByLabelText('Grace Hopper'));
  await fireEvent.changeText(screen.getByLabelText('Chat name'), 'Book club');

  // Untick back to one: the name goes off screen with the field, and off the
  // request with it — a plain 1:1, not a titled two-person group.
  await fireEvent.press(screen.getByLabelText('Grace Hopper'));
  expect(screen.queryByLabelText('Chat name')).toBeNull();

  await fireEvent.press(screen.getByLabelText('Create'));

  await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/messages/42'));
  const post = mockFetch.mock.calls.find(
    ([url, init]) =>
      String(url).endsWith('/api/conversations/') && init?.method === 'POST'
  );
  expect(bodyOf(post as [string, { body?: string }])).toEqual({ user_id: 2 });
});

it('gives the name back if a second person is re-ticked (#156)', async () => {
  // The title is read at send time rather than cleared on untick, so a mis-tap
  // doesn't silently bin what you typed. It's visible again the moment it can
  // be used, which is what keeps "on screen" and "sent" the same thing.
  serve();
  await renderScreen();

  await fireEvent.press(await screen.findByLabelText('Ada Lovelace'));
  await fireEvent.press(screen.getByLabelText('Grace Hopper'));
  await fireEvent.changeText(screen.getByLabelText('Chat name'), 'Book club');

  await fireEvent.press(screen.getByLabelText('Grace Hopper'));
  await fireEvent.press(screen.getByLabelText('Grace Hopper'));

  expect(screen.getByLabelText('Chat name').props.value).toBe('Book club');
});

it('a name on two selections still names the group (#156)', async () => {
  serve();
  await renderScreen();

  await fireEvent.press(await screen.findByLabelText('Ada Lovelace'));
  await fireEvent.press(screen.getByLabelText('Grace Hopper'));
  await fireEvent.changeText(screen.getByLabelText('Chat name'), 'Book club');
  await fireEvent.press(screen.getByLabelText('Create'));

  await waitFor(() => expect(mockReplace).toHaveBeenCalled());
  const post = mockFetch.mock.calls.find(
    ([url, init]) =>
      String(url).endsWith('/api/conversations/') && init?.method === 'POST'
  );
  const body = bodyOf(post as [string, { body?: string }]);
  expect(body.participant_ids).toEqual([2, 3]);
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

it('stops paging your connections when a page fails, instead of looping on it', async () => {
  serve([ADA], { pageTwoFails: true });
  await renderScreen();

  // What did land is still pickable — a stopped walk keeps its pages.
  expect(await screen.findByLabelText('Ada Lovelace')).toBeTruthy();
  // And the list says why it might be short, rather than letting the names on
  // screen pass for all the names there are.
  expect(
    await screen.findByText('Couldn’t load your connections.')
  ).toBeTruthy();

  // #248: the failure re-armed the effect that asked for the page — the server
  // never said there was no page 2, so `hasNextPage` stayed true, and
  // `isFetchingNextPage` going false again *is* the condition it waits for.
  await settle();
  expect(pageTwoRequests()).toHaveLength(1);
});

it('keeps asking for nothing while you type into a truncated list', async () => {
  // Typing is what makes this screen's loop worse than a pure idle one: every
  // keystroke is another commit, so before the fix, searching for the person
  // missing from the truncated list was itself what hammered the server.
  serve([ADA], { pageTwoFails: true });
  await renderScreen();
  await screen.findByText('Couldn’t load your connections.');
  await settle();

  for (const term of ['g', 'gr', 'gra']) {
    await fireEvent.changeText(
      screen.getByLabelText('Search your connections'),
      term
    );
  }

  await settle();
  expect(pageTwoRequests()).toHaveLength(1);
});

/**
 * Nothing leaves this screen while Create is out (#259).
 *
 * The error line under the footer is the only renderer of a refusal, and all
 * three ways off the screen — the header's Back, Android's hardware back, iOS's
 * swipe — unmount it. Pick participants, tap Create, swipe back, and the chat is
 * never created while you go looking for the thread you think you started.
 */
describe('holding the picker open until the server answers', () => {
  async function startCreating() {
    serve();
    await renderScreen();
    await fireEvent.press(await screen.findByLabelText('Ada Lovelace'));
    await fireEvent.press(screen.getByLabelText('Grace Hopper'));

    const server = holdRequest(
      mockFetch,
      { detail: 'You can only message people you’re connected with.' },
      400
    );
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Create'));
    });
    await server.inFlight('Creating…');
    return server;
  }

  it('refuses the header’s Back, then shows the refusal', async () => {
    const server = await startCreating();

    await fireEvent.press(screen.getByLabelText('Back'));
    expect(mockBack).not.toHaveBeenCalled();

    await server.refuse();
    expect(
      await screen.findByText(
        'You can only message people you’re connected with.'
      )
    ).toBeTruthy();
  });

  androidIt('refuses hardware back, then shows the refusal', async () => {
    const server = await startCreating();

    await act(async () => {
      // Claimed, not passed on: falling through would pop the screen.
      expect(pressBack()).toBe(true);
    });

    await server.refuse();
    expect(
      await screen.findByText(
        'You can only message people you’re connected with.'
      )
    ).toBeTruthy();
  });
});
