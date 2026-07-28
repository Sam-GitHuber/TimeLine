/**
 * The Messages tab — the conversation list (Phase 9 E2a).
 *
 * What's worth pinning: a 1:1 row shows the other person and a "You: …" preview
 * when the last message is yours; a group row falls back to its members' names
 * and shows an unread pill; a pending invite reads "Invited — connect to join"
 * (not a message preview it can't see); and tapping a row pushes that thread.
 *
 * Phase 9b M6 adds **search** and **swipe actions**. The swipe tests press the
 * action buttons directly rather than dragging: `Swipeable` renders its action
 * panel into the tree from the first frame (it's revealed by translation, not
 * by mounting), and how far a finger has to travel to uncover it is a device
 * concern no Node test can speak to — the same line `MessageActionMenu` draws
 * about where it lands on screen. What a test can prove is *what a row offers*
 * and *what pressing it sends*, which is where the bugs would be.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Alert } from 'react-native';

import MessagesScreen from '@/app/(tabs)/messages';
import { AuthProvider } from '@/auth';
import { saveTokens } from '@/tokens';
import type { Conversation } from '@/types';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  // Arrow so the read of `mockPush` is deferred to call time (the hoisted
  // factory runs before the `const` initialises — the trap the C4 notes describe).
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

const ME = {
  pk: 1,
  email: 'me@example.com',
  first_name: 'Me',
  last_name: 'Myself',
  display_name: 'Me Myself',
  bio: '',
  avatar_url: null,
  avatar_thumb: null,
  is_staff: false,
  send_read_receipts: true,
};

function convo(overrides: Partial<Conversation> & { id: number }): Conversation {
  return {
    kind: 'direct',
    title: '',
    group: null,
    other: { id: 2, display_name: 'Ada Lovelace', avatar_thumb: null },
    participants: [],
    my_status: 'active',
    must_connect_with: [],
    last_message: null,
    unread_count: 0,
    muted: false,
    can_send: null,
    updated_at: '2026-07-22T10:00:00Z',
    ...overrides,
  };
}

function serve(conversations: Conversation[]) {
  mockFetch.mockImplementation(async (url: string) => {
    if (url.includes('/api/auth/user/')) return jsonResponse(ME);
    if (url.includes('/api/conversations/')) {
      return jsonResponse({
        count: conversations.length,
        next: null,
        previous: null,
        results: conversations,
      });
    }
    return jsonResponse(null, 404);
  });
}

async function renderScreen() {
  await saveTokens({ access: 'a', refresh: 'r' });
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { gcTime: 0 },
    },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <MessagesScreen />
      </AuthProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  mockFetch.mockReset();
  mockPush.mockReset();
  globalThis.fetch = mockFetch as unknown as typeof fetch;
});

it('shows a 1:1 row with a “You:” preview for your own last message', async () => {
  serve([
    convo({
      id: 10,
      last_message: {
        text: 'See you Saturday',
        is_deleted: false,
        sender_id: ME.pk,
        created_at: '2026-07-22T10:00:00Z',
      },
    }),
  ]);

  await renderScreen();

  expect(await screen.findByText('Ada Lovelace')).toBeTruthy();
  // The "You:" prefix is a styled child node; the preview text sits beside it.
  // Regex matchers test each Text node's composed content, dodging the
  // nested-<Text> fragmentation getByText('exact') is brittle about.
  expect(screen.getByText(/^You:/)).toBeTruthy();
  expect(screen.getByText(/See you Saturday/)).toBeTruthy();
});

it('previews a deleted last message as “Message deleted”', async () => {
  serve([
    convo({
      id: 11,
      last_message: {
        text: '',
        is_deleted: true,
        sender_id: 2,
        created_at: '2026-07-22T10:00:00Z',
      },
    }),
  ]);

  await renderScreen();

  expect(await screen.findByText('Message deleted')).toBeTruthy();
});

it('names an untitled group by its other members and shows an unread pill', async () => {
  serve([
    convo({
      id: 12,
      kind: 'group',
      other: null,
      participants: [
        { id: 1, display_name: 'Me Myself', avatar_thumb: null, status: 'active' },
        { id: 2, display_name: 'Ada', avatar_thumb: null, status: 'active' },
        { id: 3, display_name: 'Grace', avatar_thumb: null, status: 'active' },
      ],
      unread_count: 3,
    }),
  ]);

  await renderScreen();

  // Excludes "Me Myself" from the fallback name.
  expect(await screen.findByText('Ada, Grace')).toBeTruthy();
  expect(screen.getByText('3')).toBeTruthy();
});

it('shows a pending invite as “Invited — connect to join”', async () => {
  serve([convo({ id: 13, kind: 'group', other: null, my_status: 'pending', title: 'Hikers' })]);

  await renderScreen();

  expect(await screen.findByText('Hikers')).toBeTruthy();
  expect(screen.getByText('Invited — connect to join')).toBeTruthy();
});

it('taps a row through to its thread', async () => {
  serve([convo({ id: 14 })]);

  await renderScreen();
  fireEvent.press(await screen.findByText('Ada Lovelace'));

  expect(mockPush).toHaveBeenCalledWith('/messages/14');
});

it('shows the empty state when you have no conversations', async () => {
  serve([]);

  await renderScreen();

  expect(await screen.findByText('No conversations yet')).toBeTruthy();
});

/* --- Search (Phase 9b M6) -------------------------------------------------- */

/** Enough rows to bring the search field out — see `SEARCH_FROM`. */
function manyConversations() {
  const names = ['Ada Lovelace', 'Grace Hopper', 'Alan Turing', 'Ida Rhodes'];
  const direct = names.map((display_name, index) =>
    convo({ id: 20 + index, other: { id: 30 + index, display_name, avatar_thumb: null } })
  );
  return [
    ...direct,
    convo({ id: 40, kind: 'group', other: null, title: 'Book club' }),
    convo({
      id: 41,
      kind: 'group',
      other: null,
      participants: [
        { id: 1, display_name: 'Me Myself', avatar_thumb: null, status: 'active' },
        { id: 50, display_name: 'Katherine Johnson', avatar_thumb: null, status: 'active' },
      ],
    }),
  ];
}

it('hides the search field until the list is long enough to need it', async () => {
  serve([convo({ id: 10 })]);

  await renderScreen();
  await screen.findByText('Ada Lovelace');

  expect(screen.queryByLabelText('Search conversations')).toBeNull();
});

it('filters the list by name, matching titles and members alike', async () => {
  serve(manyConversations());

  await renderScreen();
  const field = await screen.findByLabelText('Search conversations');

  // A person's name.
  await fireEvent.changeText(field, 'grace');
  expect(screen.getByText('Grace Hopper')).toBeTruthy();
  expect(screen.queryByText('Ada Lovelace')).toBeNull();

  // A group's title.
  await fireEvent.changeText(field, 'book');
  expect(screen.getByText('Book club')).toBeTruthy();
  expect(screen.queryByText('Grace Hopper')).toBeNull();

  // And a member of an *untitled* group, which is displayed as its members —
  // you should be able to find a chat by the name on the screen in front of you.
  await fireEvent.changeText(field, 'katherine');
  expect(screen.getByText('Katherine Johnson')).toBeTruthy();
});

it('says so when nothing matches, rather than looking empty', async () => {
  serve(manyConversations());

  await renderScreen();
  await fireEvent.changeText(
    await screen.findByLabelText('Search conversations'),
    'nobody'
  );

  expect(screen.getByText(/No conversations match/)).toBeTruthy();
  // Not the "you have no conversations yet" empty state — you have plenty.
  expect(screen.queryByText('No conversations yet')).toBeNull();
});

it('keeps the search field mounted when the filter empties the list', async () => {
  // Keyed off the unfiltered count: pulling the field out from under what
  // someone is typing would make it impossible to correct a typo.
  serve(manyConversations());

  await renderScreen();
  const field = await screen.findByLabelText('Search conversations');
  await fireEvent.changeText(field, 'nobody');

  expect(screen.getByLabelText('Search conversations')).toBeTruthy();
});

/* --- Swipe actions (Phase 9b M6) ------------------------------------------- */

it('mutes a thread from the row, and unmutes an already-muted one', async () => {
  serve([convo({ id: 15 }), convo({ id: 16, muted: true })]);

  await renderScreen();
  await screen.findByLabelText('Mute');

  await fireEvent.press(screen.getByLabelText('Mute'));
  await waitFor(() =>
    expect(
      mockFetch.mock.calls.some(
        ([url, init]) =>
          String(url).includes('/api/conversations/15/mute/') &&
          init?.method === 'POST'
      )
    ).toBe(true)
  );

  // The label reads as the state, not as an imperative — otherwise a muted
  // thread looks identical to a live one until you open it.
  await fireEvent.press(screen.getByLabelText('Unmute'));
  await waitFor(() =>
    expect(
      mockFetch.mock.calls.some(
        ([url, init]) =>
          String(url).includes('/api/conversations/16/mute/') &&
          init?.method === 'DELETE'
      )
    ).toBe(true)
  );
});

it('marks a read thread unread with a DELETE on its read marker', async () => {
  serve([
    convo({
      id: 17,
      unread_count: 0,
      last_message: {
        text: 'can you do Tuesday?',
        is_deleted: false,
        sender_id: 2,
        created_at: '2026-07-22T10:00:00Z',
      },
    }),
  ]);

  await renderScreen();
  await fireEvent.press(await screen.findByLabelText('Mark unread'));

  await waitFor(() =>
    expect(
      mockFetch.mock.calls.some(
        ([url, init]) =>
          String(url).includes('/api/conversations/17/read/') &&
          init?.method === 'DELETE'
      )
    ).toBe(true)
  );
});

it('offers Mark read on a thread that has unread messages', async () => {
  serve([
    convo({
      id: 18,
      unread_count: 4,
      last_message: {
        text: 'still on for Tuesday?',
        is_deleted: false,
        sender_id: 2,
        created_at: '2026-07-22T10:00:00Z',
      },
    }),
  ]);

  await renderScreen();
  await fireEvent.press(await screen.findByLabelText('Mark read'));

  expect(screen.queryByLabelText('Mark unread')).toBeNull();
  await waitFor(() =>
    expect(
      mockFetch.mock.calls.some(
        ([url, init]) =>
          String(url).includes('/api/conversations/18/read/') &&
          init?.method === 'POST'
      )
    ).toBe(true)
  );
});

it.each([
  [
    'a thread whose last word was yours',
    convo({
      id: 19,
      last_message: {
        text: 'see you then',
        is_deleted: false,
        sender_id: ME.pk,
        created_at: '2026-07-22T10:00:00Z',
      },
    }),
  ],
  ['an empty thread', convo({ id: 21, last_message: null })],
  ['an invite you haven’t accepted', convo({ id: 22, my_status: 'pending' })],
  [
    'a thread whose last message has been deleted',
    convo({
      id: 25,
      last_message: {
        text: '',
        is_deleted: true,
        sender_id: 2,
        created_at: '2026-07-22T10:00:00Z',
      },
    }),
  ],
])('offers no unread toggle on %s', async (_label, row) => {
  // A tombstone is incoming but isn't a target — the marker can't be parked on
  // a deleted message, so a thread with nothing else incoming is a 400. The row
  // only knows its newest message, so it errs toward not offering an action
  // that would come back an error.
  serve([row]);

  await renderScreen();
  await screen.findByLabelText('Mute');

  expect(screen.queryByLabelText('Mark unread')).toBeNull();
  expect(screen.queryByLabelText('Mark read')).toBeNull();
});

it('confirms before leaving a chat from the row', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  serve([convo({ id: 23 })]);

  await renderScreen();
  await fireEvent.press(await screen.findByLabelText('Leave'));

  // Nothing has been sent yet — the confirm is the point.
  expect(
    mockFetch.mock.calls.some(([url]) =>
      String(url).includes('/api/conversations/23/leave/')
    )
  ).toBe(false);

  const [, , buttons] = alert.mock.calls[0];
  await buttons?.find((b) => b.style === 'destructive')?.onPress?.();

  await waitFor(() =>
    expect(
      mockFetch.mock.calls.some(
        ([url, init]) =>
          String(url).includes('/api/conversations/23/leave/') &&
          init?.method === 'POST'
      )
    ).toBe(true)
  );
  alert.mockRestore();
});

it('calls leaving an unaccepted invite “Decline”', async () => {
  // Same endpoint, very different sentence: you aren't leaving a conversation
  // you were never in.
  serve([convo({ id: 24, my_status: 'pending' })]);

  await renderScreen();

  expect(await screen.findByLabelText('Decline')).toBeTruthy();
  expect(screen.queryByLabelText('Leave')).toBeNull();
});
