/**
 * The conversation info screen (Phase 9b M6).
 *
 * It exists because the thread header had grown three text buttons competing
 * with the name of the person you're talking to. So the things worth pinning
 * are the ones that *moved* — mute and leave still work, from here — plus the
 * one thing that's new: renaming a group chat, which until M6 was fixed at
 * creation.
 *
 * The rename rules are enforced server-side (group chats only, active members
 * only); what these tests hold is that the client doesn't *offer* what the
 * server would refuse, since an action that always errors is worse than one
 * that isn't there.
 *
 * Phase 9b M7 finishes the one piece M6 shipped without: the **media gallery**.
 * It was left out on purpose until there were photo messages to put in it, so
 * what's pinned here is that it appears when there are photos, stays away
 * entirely when there aren't, and reads the chat's photos through the same
 * interval-clipped messages endpoint as the transcript.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Alert } from 'react-native';

import ConversationInfoScreen from '@/app/messages/[conversationId]/info';
import { AuthProvider } from '@/auth';
import { saveTokens } from '@/tokens';
import type { Conversation } from '@/types';

const mockPush = jest.fn();
const mockDismissTo = jest.fn();
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ conversationId: '5' }),
  router: {
    push: (...args: unknown[]) => mockPush(...args),
    back: jest.fn(),
    replace: jest.fn(),
    canGoBack: () => true,
    canDismiss: () => true,
    dismissTo: (...args: unknown[]) => mockDismissTo(...args),
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

const ADA = { id: 2, display_name: 'Ada Lovelace', avatar_thumb: null };

function detail(overrides: Partial<Conversation>): Conversation {
  return {
    id: 5,
    kind: 'direct',
    title: '',
    group: null,
    other: ADA,
    participants: [],
    my_status: 'active',
    must_connect_with: [],
    last_message: null,
    unread_count: 0,
    muted: false,
    can_send: true,
    updated_at: '2026-07-22T10:00:00Z',
    ...overrides,
  };
}

function group(overrides: Partial<Conversation> = {}): Conversation {
  return detail({
    kind: 'group',
    other: null,
    title: 'Weekend plans',
    participants: [
      { id: ME.pk, display_name: 'Me Myself', avatar_thumb: null, status: 'active' },
      { id: 2, display_name: 'Ada Lovelace', avatar_thumb: null, status: 'active' },
      { id: 3, display_name: 'Grace Hopper', avatar_thumb: null, status: 'pending' },
    ],
    ...overrides,
  });
}

/** A photo on a message, as `MessageAttachmentSerializer` sends one. */
function photo(id: number) {
  return {
    id,
    kind: 'image' as const,
    url: `https://example.test/media/messages/${id}.jpg`,
    thumbnail: `https://example.test/media/messages/thumbs/${id}.jpg`,
    width: 1200,
    height: 900,
  };
}

function serve(
  conversation: Conversation,
  renamed?: Conversation,
  /** Messages the gallery's `?media=1` request finds, newest first. */
  media: { id: number; attachments: ReturnType<typeof photo>[] }[] = [],
  /** The chat's *total*, when it's more than this one page holds. */
  mediaCount?: number
) {
  mockFetch.mockImplementation(async (url: string, init?: { method?: string }) => {
    if (String(url).includes('/api/auth/user/')) return jsonResponse(ME);
    if (String(url).includes('/api/users/')) {
      return jsonResponse({ ...ADA, is_blocked: false, connection_status: 'connected' });
    }
    // Before the conversation-detail branch: the gallery is the *messages*
    // endpoint with a filter, and its URL contains the conversation's too.
    if (String(url).includes('/messages/')) {
      return jsonResponse({
        count: mediaCount ?? media.length,
        next: null,
        previous: null,
        results: media,
      });
    }
    if (String(url).includes('/api/conversations/5/')) {
      if (init?.method === 'PATCH') return jsonResponse(renamed ?? conversation);
      return jsonResponse(conversation);
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
        <ConversationInfoScreen />
      </AuthProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  mockFetch.mockReset();
  mockPush.mockReset();
  mockDismissTo.mockReset();
  globalThis.fetch = mockFetch as unknown as typeof fetch;
});

it('lists the people in a group, marking who is still pending', async () => {
  serve(group());

  await renderScreen();

  expect(await screen.findByText('Weekend plans')).toBeTruthy();
  expect(screen.getByText('3 people')).toBeTruthy();
  expect(screen.getByText('Me Myself (you)')).toBeTruthy();
  // "Pending" is about the clique invariant — they're waiting on connections,
  // not ignoring an invitation.
  expect(screen.getByText('Pending')).toBeTruthy();
});

it('renames a group chat', async () => {
  serve(group(), group({ title: 'Sunday lunch' }));

  await renderScreen();
  await fireEvent.press(await screen.findByLabelText('Rename chat'));
  await fireEvent.changeText(screen.getByLabelText('Chat name'), 'Sunday lunch');
  await fireEvent.press(screen.getByLabelText('Save name'));

  await waitFor(() =>
    expect(
      mockFetch.mock.calls.some(
        ([url, init]) =>
          String(url).includes('/api/conversations/5/') &&
          init?.method === 'PATCH' &&
          JSON.parse(String(init.body)).title === 'Sunday lunch'
      )
    ).toBe(true)
  );
  // The response is the fresh conversation, written straight into the cache the
  // thread header reads — so the new name is up before any refetch lands.
  expect(await screen.findByText('Sunday lunch')).toBeTruthy();
});

it('gives up on a rename without sending anything', async () => {
  serve(group());

  await renderScreen();
  await fireEvent.press(await screen.findByLabelText('Rename chat'));
  await fireEvent.changeText(screen.getByLabelText('Chat name'), 'Nope');
  await fireEvent.press(screen.getByLabelText('Cancel rename'));

  expect(screen.getByText('Weekend plans')).toBeTruthy();
  expect(
    mockFetch.mock.calls.some(([, init]) => init?.method === 'PATCH')
  ).toBe(false);
});

it('offers no rename on a 1:1 — its name is the other person', async () => {
  serve(detail({}));

  await renderScreen();

  expect(await screen.findByText('Ada Lovelace')).toBeTruthy();
  expect(screen.queryByLabelText('Rename chat')).toBeNull();
  // The profile is one tap away instead, which is what a 1:1's "details" are.
  expect(screen.getByLabelText('View Ada Lovelace’s profile')).toBeTruthy();
});

it('offers no rename to a pending member', async () => {
  // The waiting room can't write to the thread, and a title is writing to it.
  serve(group({ my_status: 'pending' }));

  await renderScreen();
  await screen.findByText('Weekend plans');

  expect(screen.queryByLabelText('Rename chat')).toBeNull();
});

it('mutes and unmutes from here, now the header no longer does', async () => {
  serve(detail({}));

  await renderScreen();
  await fireEvent.press(await screen.findByLabelText('Mute notifications'));

  await waitFor(() =>
    expect(
      mockFetch.mock.calls.some(
        ([url, init]) =>
          String(url).includes('/api/conversations/5/mute/') &&
          init?.method === 'POST'
      )
    ).toBe(true)
  );
});

it('reads a muted thread as its state, and unmutes with a DELETE', async () => {
  serve(detail({ muted: true }));

  await renderScreen();
  const toggle = await screen.findByLabelText('Mute notifications');
  expect(screen.getByText('Muted')).toBeTruthy();
  await fireEvent.press(toggle);

  await waitFor(() =>
    expect(
      mockFetch.mock.calls.some(
        ([url, init]) =>
          String(url).includes('/api/conversations/5/mute/') &&
          init?.method === 'DELETE'
      )
    ).toBe(true)
  );
});

it('offers mute on a 1:1, not only on groups', async () => {
  // A chatty 1:1 is as worth silencing as a busy group — mute must not inherit
  // the group-only gating that Add and Leave have.
  serve(detail({}));

  await renderScreen();

  expect(await screen.findByLabelText('Mute notifications')).toBeTruthy();
  expect(screen.queryByLabelText('Leave chat')).toBeNull();
  expect(screen.queryByLabelText('Add people')).toBeNull();
});

it('confirms before leaving a group', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  serve(group());

  await renderScreen();
  await fireEvent.press(await screen.findByLabelText('Leave chat'));

  expect(
    mockFetch.mock.calls.some(([url]) => String(url).includes('/leave/'))
  ).toBe(false);

  const [, , buttons] = alert.mock.calls[0];
  await buttons?.find((b) => b.style === 'destructive')?.onPress?.();

  await waitFor(() =>
    expect(
      mockFetch.mock.calls.some(
        ([url, init]) =>
          String(url).includes('/api/conversations/5/leave/') &&
          init?.method === 'POST'
      )
    ).toBe(true)
  );
  // Past the thread, not back to it: going back one screen would land on the
  // transcript of a conversation you're no longer in.
  await waitFor(() => expect(mockDismissTo).toHaveBeenCalledWith('/messages'));
  alert.mockRestore();
});

/**
 * Issue #238 — **mute and leave said nothing at all when they failed**, in a
 * screen where the rename beside them already alerted.
 *
 * Mute is the one that lied hardest. The switch is driven by `detail.muted`, so
 * it deliberately doesn't move until the server says it has — correct, and
 * exactly why a refused mute was pixel-identical to one that worked. You
 * believe a noisy group chat is silenced and your phone buzzes all evening with
 * nothing to suggest the app is at fault.
 *
 * Through `Alert` rather than a line on the screen, which is the phone's answer
 * to the whole family: a native dialog is drawn above the RN tree, so it
 * survives the screen being covered or popped (messaging.md).
 */
it('says so when a mute is refused, since the switch cannot', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  serve(detail({}));

  await renderScreen();
  const toggle = await screen.findByLabelText('Mute notifications');
  mockFetch.mockImplementation(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    return jsonResponse({ detail: 'You’re no longer in this chat.' }, 403);
  });
  await fireEvent.press(toggle);

  await waitFor(() =>
    expect(alert).toHaveBeenCalledWith(
      'Couldn’t mute this chat',
      'You’re no longer in this chat.'
    )
  );
  alert.mockRestore();
});

it('names the direction when an unmute is refused with nothing readable', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  serve(detail({ muted: true }));

  await renderScreen();
  const toggle = await screen.findByLabelText('Mute notifications');
  // A 500 with no DRF body: nothing of the server's to prefer, so our own
  // sentence shows and the *title* carries which direction failed
  // (connections.md — the fallback is per state, never generic).
  mockFetch.mockImplementation(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    return jsonResponse(null, 500);
  });
  await fireEvent.press(toggle);

  await waitFor(() =>
    expect(alert).toHaveBeenCalledWith(
      'Couldn’t unmute this chat',
      'Something went wrong — try again in a moment.'
    )
  );
  alert.mockRestore();
});

it('says so when leaving is refused, and keeps you on this screen', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  serve(group());

  await renderScreen();
  await fireEvent.press(await screen.findByLabelText('Leave chat'));
  mockFetch.mockImplementation(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    return jsonResponse({ detail: 'You’re no longer in this chat.' }, 403);
  });
  const [, , buttons] = alert.mock.calls[0];
  await buttons?.find((b) => b.style === 'destructive')?.onPress?.();

  await waitFor(() =>
    expect(alert).toHaveBeenCalledWith(
      'Couldn’t leave this chat',
      'You’re no longer in this chat.'
    )
  );
  // The `dismissTo` runs only on success, so you're still standing on the
  // Details screen of a chat you just confirmed leaving — which is precisely
  // why it has to say something.
  expect(mockDismissTo).not.toHaveBeenCalled();
  alert.mockRestore();
});

it('routes Add people to the picker, scoped to this chat', async () => {
  serve(group());

  await renderScreen();
  await fireEvent.press(await screen.findByLabelText('Add people'));

  expect(mockPush).toHaveBeenCalledWith('/messages/new?addTo=5');
});

it('offers Block on a 1:1', async () => {
  // 🔒 App Review requires a working block, and the moment you want one is
  // usually the moment you're looking at what someone sent.
  serve(detail({}));

  await renderScreen();

  expect(await screen.findByText('Block')).toBeTruthy();
});

/* --- The media gallery (Phase 9b M7) -------------------------------------- */

it('shows the chat’s photos, newest first, and opens one full-screen', async () => {
  serve(detail({}), undefined, [
    { id: 30, attachments: [photo(9)] },
    { id: 20, attachments: [photo(8)] },
  ]);

  await renderScreen();
  await screen.findByText('2 photos');

  // Numbered in the order they're drawn, so "photo 1" is the newest — which is
  // what someone scrolling for "the one from last week" is starting from.
  await fireEvent.press(screen.getByLabelText('Photo 1 of 2'));
  await screen.findByLabelText('Close photo viewer');
});

it('counts the chat’s photos in the heading, not just the page it drew', async () => {
  // The grid is deliberately one page, so `results.length` is a fact about the
  // page and not about the chat. Titling the section from it tells someone with
  // sixty photos that they have two, in a confident voice.
  serve(
    detail({}),
    undefined,
    [
      { id: 30, attachments: [photo(9)] },
      { id: 20, attachments: [photo(8)] },
    ],
    60
  );

  await renderScreen();
  await screen.findByText('60 photos');
  // The tiles still describe themselves by what's on screen — that numbering is
  // navigation, and "Photo 1 of 60" would be a lie about what you can tap.
  expect(screen.getByLabelText('Photo 1 of 2')).toBeTruthy();
});

it('renders no gallery at all in a chat with no photos', async () => {
  // An empty grid under a heading is a feature announcing it has nothing for
  // you — the same reason M6 shipped without this section rather than with an
  // empty one.
  serve(detail({}));

  await renderScreen();
  await screen.findByText('In this chat');

  expect(screen.queryByText(/photos?$/)).toBeNull();
});

it('reads the gallery through the messages endpoint, not one of its own', async () => {
  // 🔒 One clipped queryset serves both, so the gallery can never show a photo
  // the transcript wouldn't — including one sent during a gap in your
  // membership. A gallery endpoint of its own would be a second place for that
  // rule to live, and eventually to drift.
  serve(detail({}), undefined, [{ id: 30, attachments: [photo(9)] }]);

  await renderScreen();
  await screen.findByText('1 photo');

  expect(
    mockFetch.mock.calls.some(([url]) =>
      String(url).includes('/api/conversations/5/messages/?media=1&order=desc')
    )
  ).toBe(true);
});
