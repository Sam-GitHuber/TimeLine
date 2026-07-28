/**
 * A conversation thread (Phase 9 E2a).
 *
 * Phase 9b M1 adds the long-press action menu and editing: what the menu offers
 * depends on whose message it is and how old, Edit turns the composer into an
 * editor that PATCHes, and cancelling gives back the draft it borrowed.
 *
 * Phase 9b M2 adds reactions: a quick-emoji row across the top of that menu, and
 * pills under the bubble that toggle on tap and reveal who reacted on a hold.
 *
 * Phase 9b M3 adds reply threads: Reply in that menu opens a focused strand over
 * a blurred transcript with its own composer, a reply renders a quote resolved
 * from messages the client already holds (never anything the server attached to
 * it — not the text and not the author), and a root's "N replies" opens the same
 * strand. Reply is a menu item and nothing else: the swipe that shipped with M3
 * fought the navigator's back gesture and was removed.
 *
 * What's worth pinning: sending fires the send endpoint and clears the input;
 * group threads attribute a *run* of messages to its sender only once (the first
 * bubble), never on 1:1 or your own; a soft-deleted message shows a tombstone in
 * place; a pending viewer gets the locked panel instead of the message list; and
 * a viewer who can't send gets the read-only footer, not a composer.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import * as Clipboard from 'expo-clipboard';
import { Alert } from 'react-native';

import ThreadScreen from '@/app/messages/[conversationId]';
import { AuthProvider } from '@/auth';
import { saveTokens } from '@/tokens';
import type { Conversation, Message } from '@/types';

const mockParams: { conversationId: string } = { conversationId: '5' };
const mockPush = jest.fn();
const mockBack = jest.fn();
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => mockParams,
  router: {
    push: (...args: unknown[]) => mockPush(...args),
    back: (...args: unknown[]) => mockBack(...args),
    replace: jest.fn(),
    canGoBack: () => true,
  },
}));

/**
 * Stand in for the full emoji grid.
 *
 * The real `rn-emoji-keyboard` ships PNG icons that Jest can't parse, and none
 * of its internals are what's under test here. What *is* testable is the
 * handover: tapping `＋` opens the grid and leaves the action menu mounted but
 * hidden. (Whether iOS sequences the two modals correctly is a native
 * behaviour no Node test can reach — that one is a device check.)
 */
jest.mock('rn-emoji-keyboard', () => {
  // require, not import: a jest.mock factory is hoisted above the imports, so it
  // can't reference module-scope bindings and must pull its deps in itself.
  /* eslint-disable @typescript-eslint/no-require-imports */
  const React = require('react');
  const { Pressable, Text } = require('react-native');
  /* eslint-enable @typescript-eslint/no-require-imports */
  return {
    __esModule: true,
    default: ({
      open,
      onClose,
      onEmojiSelected,
    }: {
      open: boolean;
      onClose: () => void;
      onEmojiSelected: (picked: { emoji: string }) => void;
    }) =>
      open
        ? React.createElement(
            React.Fragment,
            null,
            React.createElement(Text, null, 'emoji grid'),
            React.createElement(
              Pressable,
              {
                accessibilityLabel: 'pick 🦖 from the grid',
                onPress: () => onEmojiSelected({ emoji: '🦖' }),
              },
              React.createElement(Text, null, '🦖')
            ),
            React.createElement(
              Pressable,
              { accessibilityLabel: 'dismiss the grid', onPress: onClose },
              React.createElement(Text, null, 'x')
            )
          )
        : null,
  };
});

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
};

const ADA = { id: 2, display_name: 'Ada Lovelace', avatar_thumb: null };
const GRACE = { id: 3, display_name: 'Grace Hopper', avatar_thumb: null };
/** `ME` as a message sender — the author slice, not the account. */
const MINE = { id: ME.pk, display_name: ME.display_name, avatar_thumb: null };
/** The server's `PAGE_SIZE` (`config/settings.py`), so paging is served here as
 *  the real endpoint serves it. */
const PAGE_SIZE = 20;

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

function message(overrides: Partial<Message> & { id: number }): Message {
  return {
    sender: ADA,
    text: `Message ${overrides.id}`,
    is_deleted: false,
    is_edited: false,
    // "Just now" by default, so a message is inside the 15-minute edit window
    // unless a test deliberately ages it.
    created_at: new Date().toISOString(),
    edited_at: null,
    reactions: [],
    ...overrides,
  };
}

/**
 * Answer by URL + method. Order matters: the send/delete URLs contain
 * `/messages/`, so match those before the bare conversation-detail route — and
 * `/api/messages/<id>/react/` contains it too, so that goes first of all.
 */
function serve({
  conversation,
  messages = [],
  thread,
  reactionsAfterToggle = [{ emoji: '👍', count: 1, reacted: true }],
  reactors = [{ emoji: '👍', count: 1, users: [ADA] }],
}: {
  conversation: Conversation;
  messages?: Message[];
  /**
   * What `?thread_root=` returns (Phase 9b M3). Its own list, not a filter over
   * `messages`, because the interesting cases are where the two *differ* — a
   * viewer clipped out of the root gets replies here and no head.
   */
  thread?: Message[];
  reactionsAfterToggle?: { emoji: string; count: number; reacted: boolean }[];
  reactors?: { emoji: string; count: number; users: typeof ADA[] }[];
}) {
  const meAuthor = { id: ME.pk, display_name: ME.display_name, avatar_thumb: null };
  mockFetch.mockImplementation(
    async (url: string, init?: { method?: string; body?: string }) => {
      if (url.includes('/api/auth/user/')) return jsonResponse(ME);
      if (url.includes('/react/')) {
        return jsonResponse({ reactions: reactionsAfterToggle });
      }
      if (url.match(/\/api\/messages\/\d+\/reactions\//)) {
        return jsonResponse(reactors);
      }
      if (url.includes('/read/')) return jsonResponse(null, 204);
      if (url.includes('/leave/')) return jsonResponse(null, 204);
      if (url.includes('/mute/')) {
        return jsonResponse({ muted: init?.method === 'POST' });
      }
      if (url.includes('/reports/')) return jsonResponse({ id: 1 }, 201);
      // Before the bare `/messages/` branch: the focused thread is the same
      // endpoint with a filter, so the order here mirrors the server's.
      if (url.includes('thread_root=')) {
        // Paged like the real endpoint, because it *is* the real endpoint with
        // a filter on it — a strand longer than one page is the case the view
        // used to get wrong, and a mock that always answers in full can't catch
        // it. Short threads still come back in one page with `next: null`, so
        // every other test here is unaffected.
        const all = thread ?? [];
        const page = Number(url.match(/[?&]page=(\d+)/)?.[1] ?? 1);
        const results = all.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
        const base = url.replace(/[?&]page=\d+/, '');
        return jsonResponse({
          count: all.length,
          // Absolute, like DRF's — `getPage` re-bases it on BASE_URL.
          next: all.length > page * PAGE_SIZE ? `${base}&page=${page + 1}` : null,
          previous: null,
          results,
        });
      }
      if (url.includes('/messages/')) {
        if (init?.method === 'POST') {
          return jsonResponse(message({ id: 999, sender: meAuthor, text: 'sent' }));
        }
        if (init?.method === 'PATCH') {
          return jsonResponse(
            message({
              id: 7,
              sender: meAuthor,
              text: JSON.parse(init.body ?? '{}').text,
              is_edited: true,
              edited_at: new Date().toISOString(),
            })
          );
        }
        if (init?.method === 'DELETE') return jsonResponse(null, 204);
        return jsonResponse({
          count: messages.length,
          next: null,
          previous: null,
          results: messages,
        });
      }
      if (url.includes('/api/conversations/')) return jsonResponse(conversation);
      return jsonResponse(null, 404);
    }
  );
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
        <ThreadScreen />
      </AuthProvider>
    </QueryClientProvider>
  );
}

/**
 * Long-press a bubble by its accessibility label and wait for the menu.
 *
 * The gesture is the only way in, and the bubble measures itself first — under
 * Node there's nothing to measure, so `MessageBubble` falls back to a degenerate
 * rect and the menu still opens (which is the behaviour we want on a device too:
 * a long-press must never silently do nothing).
 */
async function openMenu(bubbleLabel: string) {
  fireEvent(await screen.findByLabelText(bubbleLabel), 'longPress');
  await screen.findByLabelText('Close message actions');
}

beforeEach(() => {
  mockFetch.mockReset();
  mockPush.mockReset();
  mockBack.mockReset();
  mockParams.conversationId = '5';
  globalThis.fetch = mockFetch as unknown as typeof fetch;
});

it('sends a message and clears the input', async () => {
  serve({ conversation: detail({}), messages: [message({ id: 1 })] });

  await renderScreen();
  const input = await screen.findByLabelText('Message');
  await fireEvent.changeText(input, 'Hello there');
  await fireEvent.press(screen.getByLabelText('Send'));

  await waitFor(() =>
    expect(
      mockFetch.mock.calls.some(
        ([url, init]) =>
          String(url).includes('/api/conversations/5/messages/') &&
          init?.method === 'POST' &&
          JSON.parse(init.body).text === 'Hello there'
      )
    ).toBe(true)
  );
  // The input is a controlled component keyed off state cleared on success.
  await waitFor(() => expect(input.props.value).toBe(''));
});

it('mutes the thread from the header (#118)', async () => {
  serve({ conversation: detail({}), messages: [message({ id: 1 })] });

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

it('unmutes an already-muted thread with a DELETE', async () => {
  // The same control both ways — so the label has to reflect state, not just
  // offer an action, or a muted thread would look identical to a live one.
  serve({ conversation: detail({ muted: true }), messages: [message({ id: 1 })] });

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

it('offers mute on a 1:1 thread, not only on groups', async () => {
  // Mute lives beside Add/Leave, which are group-only — it must not inherit
  // that gating: a chatty 1:1 is as worth silencing as a busy group.
  serve({ conversation: detail({}), messages: [message({ id: 1 })] });

  await renderScreen();

  expect(await screen.findByLabelText('Mute notifications')).toBeTruthy();
  expect(screen.queryByLabelText('Leave chat')).toBeNull();
});

it('marks the thread read on open', async () => {
  serve({ conversation: detail({}), messages: [message({ id: 1 })] });

  await renderScreen();
  await screen.findByText('Message 1');

  await waitFor(() =>
    expect(
      mockFetch.mock.calls.some(
        ([url, init]) =>
          String(url).includes('/api/conversations/5/read/') &&
          init?.method === 'POST'
      )
    ).toBe(true)
  );
});

it('attributes only the first bubble of a run in a group thread', async () => {
  serve({
    conversation: detail({
      kind: 'group',
      other: null,
      title: 'Hikers',
      participants: [
        { ...ADA, status: 'active' },
        { ...GRACE, status: 'active' },
        { id: 1, display_name: 'Me Myself', avatar_thumb: null, status: 'active' },
      ],
    }),
    messages: [
      message({ id: 1, sender: ADA, text: 'first from Ada' }),
      message({ id: 2, sender: ADA, text: 'second from Ada' }),
      message({ id: 3, sender: GRACE, text: 'now Grace' }),
    ],
  });

  await renderScreen();
  await screen.findByText('first from Ada');

  // Ada's name labels her run once (the first bubble), not the second; Grace's
  // new run gets its own label. The header title "Hikers" isn't a sender label.
  expect(screen.getAllByText('Ada Lovelace')).toHaveLength(1);
  expect(screen.getByText('Grace Hopper')).toBeTruthy();
});

it('deletes your own message from the long-press menu → confirm', async () => {
  serve({
    conversation: detail({}),
    messages: [message({ id: 7, sender: MINE, text: 'oops typo' })],
  });
  // Stand in for the native confirm dialog by firing its destructive button.
  const alertSpy = jest
    .spyOn(Alert, 'alert')
    .mockImplementation((_title, _msg, buttons) => {
      buttons?.find((b) => b.style === 'destructive')?.onPress?.();
    });

  await renderScreen();
  await openMenu('Your message: oops typo');
  await fireEvent.press(screen.getByLabelText('Delete'));

  await waitFor(() =>
    expect(
      mockFetch.mock.calls.some(
        ([url, init]) =>
          String(url).includes('/api/conversations/5/messages/7/') &&
          init?.method === 'DELETE'
      )
    ).toBe(true)
  );
  alertSpy.mockRestore();
});

/* ---- The long-press action menu + edit (Phase 9b M1) --------------------- */

it('offers Copy/Edit/Delete on your own message', async () => {
  serve({
    conversation: detail({}),
    messages: [message({ id: 7, sender: MINE, text: 'teh quick fox' })],
  });

  await renderScreen();
  await openMenu('Your message: teh quick fox');

  expect(screen.getByLabelText('Copy')).toBeTruthy();
  expect(screen.getByLabelText('Edit')).toBeTruthy();
  expect(screen.getByLabelText('Delete')).toBeTruthy();
  // Reporting your own message is meaningless; it's the other menu.
  expect(screen.queryByLabelText('Report')).toBeNull();
});

it('offers Copy/Report — and no Edit — on someone else’s message', async () => {
  // You can never edit words someone else wrote. The server 403s it; the menu
  // shouldn't even suggest it.
  serve({
    conversation: detail({}),
    messages: [message({ id: 8, sender: ADA, text: 'from Ada' })],
  });

  await renderScreen();
  await openMenu('Message from Ada Lovelace: from Ada');

  expect(screen.getByLabelText('Copy')).toBeTruthy();
  expect(screen.getByLabelText('Report')).toBeTruthy();
  expect(screen.queryByLabelText('Edit')).toBeNull();
  expect(screen.queryByLabelText('Delete')).toBeNull();
});

it('hides Edit once the 15-minute window has passed', async () => {
  serve({
    conversation: detail({}),
    messages: [
      message({
        id: 7,
        sender: MINE,
        text: 'yesterday’s words',
        created_at: '2026-07-20T10:00:00Z',
      }),
    ],
  });

  await renderScreen();
  await openMenu('Your message: yesterday’s words');

  // Delete is forever, edit is not — the window is the whole point.
  expect(screen.queryByLabelText('Edit')).toBeNull();
  expect(screen.getByLabelText('Delete')).toBeTruthy();
});

it('Edit prefills the composer and PATCHes the correction', async () => {
  serve({
    conversation: detail({}),
    messages: [message({ id: 7, sender: MINE, text: 'teh quick fox' })],
  });

  await renderScreen();
  await openMenu('Your message: teh quick fox');
  await fireEvent.press(screen.getByLabelText('Edit'));

  const input = screen.getByLabelText('Message');
  expect(input.props.value).toBe('teh quick fox');
  expect(screen.getByText('Editing message')).toBeTruthy();

  await fireEvent.changeText(input, 'the quick fox');
  await fireEvent.press(screen.getByLabelText('Save'));

  await waitFor(() =>
    expect(
      mockFetch.mock.calls.some(
        ([url, init]) =>
          String(url).includes('/api/conversations/5/messages/7/') &&
          init?.method === 'PATCH' &&
          JSON.parse(init.body).text === 'the quick fox'
      )
    ).toBe(true)
  );
  // Edit mode closes itself once saved, so the composer is a composer again.
  await waitFor(() => expect(screen.queryByText('Editing message')).toBeNull());
});

it('cancelling an edit restores the draft you were typing', async () => {
  // The escape hatch has to be lossless — losing a half-written message to a
  // typo fix would be its own small betrayal.
  serve({
    conversation: detail({}),
    messages: [message({ id: 7, sender: MINE, text: 'teh quick fox' })],
  });

  await renderScreen();
  const input = await screen.findByLabelText('Message');
  await fireEvent.changeText(input, 'half-written thought');

  await openMenu('Your message: teh quick fox');
  await fireEvent.press(screen.getByLabelText('Edit'));
  expect(screen.getByLabelText('Message').props.value).toBe('teh quick fox');

  await fireEvent.press(screen.getByLabelText('Cancel editing'));

  expect(screen.getByLabelText('Message').props.value).toBe(
    'half-written thought'
  );
  expect(screen.queryByText('Editing message')).toBeNull();
  // Cancelling is not a delete: nothing was written to the server.
  expect(
    mockFetch.mock.calls.some(([, init]) =>
      ['PATCH', 'DELETE'].includes(String(init?.method))
    )
  ).toBe(false);
});

it('keeps the original draft when you switch from one edit to another', async () => {
  // The stash is a promise that a half-written message survives a typo fix. It
  // has to survive *two* typo fixes: overwriting it on the second Edit would
  // quietly swap your draft for the first message's text.
  serve({
    conversation: detail({}),
    messages: [
      message({ id: 7, sender: MINE, text: 'first of mine' }),
      message({ id: 8, sender: MINE, text: 'second of mine' }),
    ],
  });

  await renderScreen();
  await fireEvent.changeText(
    await screen.findByLabelText('Message'),
    'half-written thought'
  );

  await openMenu('Your message: first of mine');
  await fireEvent.press(screen.getByLabelText('Edit'));
  expect(screen.getByLabelText('Message').props.value).toBe('first of mine');

  await openMenu('Your message: second of mine');
  await fireEvent.press(screen.getByLabelText('Edit'));
  expect(screen.getByLabelText('Message').props.value).toBe('second of mine');

  await fireEvent.press(screen.getByLabelText('Cancel editing'));

  expect(screen.getByLabelText('Message').props.value).toBe(
    'half-written thought'
  );
});

it('saving unchanged text closes edit mode without a PATCH', async () => {
  // Opening Edit and thinking better of it shouldn't stamp the message
  // "Edited" — there's nothing to record.
  serve({
    conversation: detail({}),
    messages: [message({ id: 7, sender: MINE, text: 'nothing wrong with this' })],
  });

  await renderScreen();
  await openMenu('Your message: nothing wrong with this');
  await fireEvent.press(screen.getByLabelText('Edit'));
  await fireEvent.press(screen.getByLabelText('Save'));

  await waitFor(() => expect(screen.queryByText('Editing message')).toBeNull());
  expect(
    mockFetch.mock.calls.some(([, init]) => init?.method === 'PATCH')
  ).toBe(false);
});

it('marks an edited message "Edited"', async () => {
  serve({
    conversation: detail({}),
    messages: [
      message({
        id: 7,
        sender: MINE,
        text: 'the quick fox',
        is_edited: true,
        edited_at: new Date().toISOString(),
      }),
    ],
  });

  await renderScreen();
  await screen.findByText('the quick fox');

  // The timestamp and the marker share one Text node, so match on the suffix.
  expect(screen.getByText(/· Edited$/)).toBeTruthy();
});

it('copies a message to the clipboard', async () => {
  serve({
    conversation: detail({}),
    messages: [message({ id: 8, sender: ADA, text: 'the address is 12 Elm St' })],
  });

  await renderScreen();
  await openMenu('Message from Ada Lovelace: the address is 12 Elm St');
  await fireEvent.press(screen.getByLabelText('Copy'));

  expect(Clipboard.setStringAsync).toHaveBeenCalledWith(
    'the address is 12 Elm St'
  );
});

it('reports someone else’s message from the menu', async () => {
  // M0 shipped the endpoint and the modal but no way in; M1 is the entry point.
  serve({
    conversation: detail({}),
    messages: [message({ id: 8, sender: ADA, text: 'nasty' })],
  });

  await renderScreen();
  await openMenu('Message from Ada Lovelace: nasty');
  await fireEvent.press(screen.getByLabelText('Report'));

  expect(await screen.findByText('Report this message')).toBeTruthy();
});

it('shows no menu on a deleted message’s tombstone', async () => {
  serve({
    conversation: detail({}),
    messages: [message({ id: 7, sender: MINE, is_deleted: true, text: '' })],
  });

  await renderScreen();
  await screen.findByText('Message deleted');

  // Nothing to copy, edit, or delete twice — the tombstone isn't pressable.
  expect(screen.queryByLabelText(/^Your message:/)).toBeNull();
});

/* ---- Reactions on messages (Phase 9b M2) --------------------------------- */

/** Every call that toggled a reaction, as `[messageId, emoji]` pairs. */
function reactCalls() {
  return mockFetch.mock.calls
    .filter(([url]) => String(url).includes('/react/'))
    .map(([url, init]) => [
      String(url).match(/\/api\/messages\/(\d+)\/react\//)?.[1],
      JSON.parse(init.body).emoji,
    ]);
}

it('reacts to a message from the long-press menu', async () => {
  serve({
    conversation: detail({}),
    messages: [message({ id: 8, sender: ADA, text: 'dinner at 7?' })],
  });

  await renderScreen();
  await openMenu('Message from Ada Lovelace: dinner at 7?');
  await fireEvent.press(screen.getByLabelText('React with 👍'));

  await waitFor(() => expect(reactCalls()).toEqual([['8', '👍']]));
  // The toggle returns the fresh aggregate, so the pill appears without waiting
  // for the next poll.
  expect(await screen.findByLabelText(/^👍, 1/)).toBeTruthy();
});

it('offers the warm-and-sad set, not only the feed’s four positives', async () => {
  // A messenger needs 😮 and 😢: replying to someone's bad news with a 🎉 or
  // nothing at all is the gap this row exists to close.
  serve({
    conversation: detail({}),
    messages: [message({ id: 8, sender: ADA, text: 'bad news I’m afraid' })],
  });

  await renderScreen();
  await openMenu('Message from Ada Lovelace: bad news I’m afraid');

  for (const emoji of ['👍', '❤️', '😂', '😮', '😢', '🙏']) {
    expect(screen.getByLabelText(`React with ${emoji}`)).toBeTruthy();
  }
  expect(screen.getByLabelText('More emoji')).toBeTruthy();
});

it('shows an emoji you already used as active, to take it off again', async () => {
  serve({
    conversation: detail({}),
    messages: [
      message({
        id: 8,
        sender: ADA,
        text: 'dinner at 7?',
        reactions: [{ emoji: '👍', count: 1, reacted: true }],
      }),
    ],
    reactionsAfterToggle: [],
  });

  await renderScreen();
  await openMenu('Message from Ada Lovelace: dinner at 7?');
  // The label says what the tap will do, not just which emoji it is.
  await fireEvent.press(screen.getByLabelText('Remove 👍 reaction'));

  await waitFor(() => expect(reactCalls()).toEqual([['8', '👍']]));
});

it('taps a pill to see who reacted — it never toggles', async () => {
  // The pill displays what the thread said, so a tap goes to the detail of it
  // rather than silently changing it. Changing yours has two unambiguous homes:
  // the menu's emoji row, and this sheet.
  serve({
    conversation: detail({}),
    messages: [
      message({
        id: 8,
        sender: ADA,
        text: 'dinner at 7?',
        reactions: [{ emoji: '👍', count: 1, reacted: false }],
      }),
    ],
  });

  await renderScreen();
  await fireEvent.press(await screen.findByLabelText(/^👍, 1/));

  expect(await screen.findByText('Who reacted')).toBeTruthy();
  // The sheet's per-emoji heading, from the reactors endpoint. (Ada's *name*
  // isn't a safe assertion here — she's also the person in the thread header.)
  expect(await screen.findByText('👍 1')).toBeTruthy();
  expect(reactCalls()).toEqual([]);
});

it('removes your own reaction from the who-reacted sheet', async () => {
  serve({
    conversation: detail({}),
    messages: [
      message({
        id: 8,
        sender: ADA,
        text: 'dinner at 7?',
        reactions: [{ emoji: '👍', count: 1, reacted: true }],
      }),
    ],
    reactors: [{ emoji: '👍', count: 1, users: [MINE] }],
    reactionsAfterToggle: [],
  });

  await renderScreen();
  await fireEvent.press(await screen.findByLabelText(/^👍, 1/));
  await fireEvent.press(await screen.findByLabelText('Remove your 👍 reaction'));

  await waitFor(() => expect(reactCalls()).toEqual([['8', '👍']]));
  // The sheet closes on the way out; the pill goes with the reaction.
  await waitFor(() => expect(screen.queryByText('Who reacted')).toBeNull());
  await waitFor(() => expect(screen.queryByLabelText(/^👍/)).toBeNull());
});

it('hides the menu rather than unmounting it when the emoji grid opens', async () => {
  // The iOS trap ReactionTray documents: tearing down a presented modal in the
  // same commit that presents the next one can leave the new one never
  // appearing. The menu has to stay mounted and merely hidden — so its backdrop
  // is gone from the tree (Modal renders null when not visible) while the
  // *screen* still has the menu component alive to be closed afterwards.
  serve({
    conversation: detail({}),
    messages: [message({ id: 8, sender: ADA, text: 'dinner at 7?' })],
  });

  await renderScreen();
  await openMenu('Message from Ada Lovelace: dinner at 7?');
  await fireEvent.press(screen.getByLabelText('More emoji'));

  // The grid is up...
  expect(await screen.findByText('emoji grid')).toBeTruthy();
  // ...the menu's own chrome is hidden (a Modal renders null when not visible)...
  expect(screen.queryByLabelText('Close message actions')).toBeNull();
  // ...and nothing was toggled on the way — the grid decides that.
  expect(reactCalls()).toEqual([]);
});

it('closes the menu too when the emoji grid is dismissed', async () => {
  // The menu is only *hidden* while the grid is up, so something has to unmount
  // it afterwards — otherwise the thread stays dimmed behind an invisible modal
  // and every tap lands on a backdrop nobody can see.
  serve({
    conversation: detail({}),
    messages: [message({ id: 8, sender: ADA, text: 'dinner at 7?' })],
  });

  await renderScreen();
  await openMenu('Message from Ada Lovelace: dinner at 7?');
  await fireEvent.press(screen.getByLabelText('More emoji'));
  await screen.findByText('emoji grid');

  await fireEvent.press(screen.getByLabelText('dismiss the grid'));

  expect(screen.queryByText('emoji grid')).toBeNull();
  expect(screen.queryByLabelText('Close message actions')).toBeNull();
  // Back to the thread itself, not a menu waiting to be dismissed again.
  expect(screen.getByLabelText('Message')).toBeTruthy();
});

it('reacts with an emoji picked from the full grid', async () => {
  serve({
    conversation: detail({}),
    messages: [message({ id: 8, sender: ADA, text: 'dinner at 7?' })],
    reactionsAfterToggle: [{ emoji: '🦖', count: 1, reacted: true }],
  });

  await renderScreen();
  await openMenu('Message from Ada Lovelace: dinner at 7?');
  await fireEvent.press(screen.getByLabelText('More emoji'));
  await fireEvent.press(await screen.findByLabelText('pick 🦖 from the grid'));

  await waitFor(() => expect(reactCalls()).toEqual([['8', '🦖']]));
  // The grid and the menu both go; the pill lands on the bubble.
  expect(screen.queryByText('emoji grid')).toBeNull();
  expect(await screen.findByLabelText(/^🦖, 1/)).toBeTruthy();
});

it('never shows a stale reactor list after a reaction changes', async () => {
  // The reactor cache is separate from the thread's and outlives the sheet, so
  // a toggle has to drop it. Without that, reopening renders the pre-toggle
  // rows — and since those rows are actionable, a "Tap to remove" for a
  // reaction you already removed would toggle it straight back on.
  //
  // Dropping the entry (rather than just marking it stale) is what makes the
  // assertion below possible: with no cached data the sheet can only show a
  // spinner, so there is no window where the wrong row can be tapped.
  serve({
    conversation: detail({}),
    messages: [
      message({
        id: 8,
        sender: ADA,
        text: 'dinner at 7?',
        // You and Ada both — so removing yours leaves the pill (and the sheet)
        // reachable afterwards.
        reactions: [{ emoji: '👍', count: 2, reacted: true }],
      }),
    ],
    reactors: [{ emoji: '👍', count: 2, users: [MINE, ADA] }],
    reactionsAfterToggle: [{ emoji: '👍', count: 1, reacted: false }],
  });

  await renderScreen();
  // Open the sheet once so the reactor list is cached, then close it.
  await fireEvent.press(await screen.findByLabelText(/^👍, 2/));
  await screen.findByText('👍 2');
  expect(screen.getByText('Tap to remove')).toBeTruthy();
  await fireEvent.press(screen.getByLabelText('Close'));

  // Take the reaction off from the menu instead, so the sheet's own cache is
  // now describing a world that no longer exists. Ada's 👍 keeps the pill alive,
  // which is what lets the sheet be reopened at all.
  await openMenu('Message from Ada Lovelace: dinner at 7?');
  await fireEvent.press(screen.getByLabelText('Remove 👍 reaction'));
  await waitFor(() => expect(reactCalls()).toEqual([['8', '👍']]));

  // What the server would say now: Ada alone.
  serve({
    conversation: detail({}),
    messages: [
      message({
        id: 8,
        sender: ADA,
        text: 'dinner at 7?',
        reactions: [{ emoji: '👍', count: 1, reacted: false }],
      }),
    ],
    reactors: [{ emoji: '👍', count: 1, users: [ADA] }],
  });
  await fireEvent.press(await screen.findByLabelText(/^👍, 1/));

  // The reopened sheet shows Ada's row, never the cached one with yours in it.
  await screen.findByText('👍 1');
  expect(screen.queryByText('Tap to remove')).toBeNull();
  expect(screen.queryByText('👍 2')).toBeNull();
});

it('offers no remove on someone else’s row in the sheet', async () => {
  // "Tap to remove" on a row that isn't yours would be a button that lies.
  serve({
    conversation: detail({}),
    messages: [
      message({
        id: 8,
        sender: ADA,
        text: 'dinner at 7?',
        reactions: [{ emoji: '👍', count: 1, reacted: false }],
      }),
    ],
    reactors: [{ emoji: '👍', count: 1, users: [ADA] }],
  });

  await renderScreen();
  await fireEvent.press(await screen.findByLabelText(/^👍, 1/));

  await screen.findByText('Who reacted');
  expect(screen.queryByText('Tap to remove')).toBeNull();
});

it('drops the count from a lone reaction', async () => {
  // One emoji says everything on its own; "1" beside it is noise.
  serve({
    conversation: detail({}),
    messages: [
      message({
        id: 8,
        sender: ADA,
        text: 'dinner at 7?',
        reactions: [{ emoji: '👍', count: 1, reacted: false }],
      }),
    ],
  });

  await renderScreen();
  await screen.findByLabelText(/^👍, 1/);

  expect(screen.queryByText('1')).toBeNull();
});

it('offers no way to react in a thread you can’t send to', async () => {
  // A reaction is content everyone in the thread sees, so it's gated like a
  // message: the server 403s it, and the UI shouldn't offer it. The existing
  // pills stay readable — losing the ability to write isn't losing the history.
  serve({
    conversation: detail({ can_send: false }),
    messages: [
      message({
        id: 8,
        sender: ADA,
        text: 'dinner at 7?',
        // One you left earlier, back when you still could.
        reactions: [{ emoji: '👍', count: 1, reacted: true }],
      }),
    ],
    reactors: [{ emoji: '👍', count: 1, users: [MINE] }],
  });

  await renderScreen();
  // Asserted before the menu opens: a `Modal` makes everything behind it inert,
  // so the pill is genuinely there but unreachable to a query while it's up.
  const pill = await screen.findByLabelText(/^👍, 1/);

  await openMenu('Message from Ada Lovelace: dinner at 7?');
  expect(screen.queryByLabelText('React with 👍')).toBeNull();
  expect(screen.queryByLabelText('More emoji')).toBeNull();
  await fireEvent.press(screen.getByLabelText('Close message actions'));

  // The sheet still opens and still lists everyone — losing the ability to write
  // isn't losing the history — but your own row can't be tapped to remove.
  await fireEvent.press(pill);
  await screen.findByText('Who reacted');
  expect(screen.queryByText('Tap to remove')).toBeNull();
});

it('keeps a reaction visible on a deleted message’s tombstone', async () => {
  // A reaction someone left is a thing that happened; dropping it when the
  // message goes would make it look as though they never did.
  serve({
    conversation: detail({}),
    messages: [
      message({
        id: 8,
        sender: ADA,
        is_deleted: true,
        text: '',
        reactions: [{ emoji: '👍', count: 1, reacted: false }],
      }),
    ],
  });

  await renderScreen();
  await screen.findByText('Message deleted');

  expect(screen.getByLabelText(/^👍, 1/)).toBeTruthy();
});

/* ---- Reply threads (Phase 9b M3) ----------------------------------------- */

/** Every message POST, as `[text, reply_to_id]` pairs. */
function sendCalls() {
  return mockFetch.mock.calls
    .filter(
      ([url, init]) =>
        String(url).includes('/api/conversations/5/messages/') &&
        init?.method === 'POST'
    )
    .map(([, init]) => {
      const body = JSON.parse(init.body);
      return [body.text, body.reply_to_id];
    });
}

it('Reply opens the strand, even on a message with no replies yet', async () => {
  // The thing that makes replying feel like joining a conversation rather than
  // annotating a line: you get the exchange on screen while you write. A message
  // nobody has answered yet opens a strand one bubble long, deliberately.
  const only = message({ id: 8, sender: ADA, text: 'dinner at 7?' });
  serve({
    conversation: detail({}),
    messages: [only],
    thread: [only],
  });

  await renderScreen();
  await openMenu('Message from Ada Lovelace: dinner at 7?');
  await fireEvent.press(screen.getByLabelText('Reply'));

  // The strand, not the transcript's composer.
  expect(await screen.findByText('Thread')).toBeTruthy();
  const input = await screen.findByLabelText('Reply to thread');
  // Reply put you here, so the keyboard is already up.
  expect(input.props.autoFocus).toBe(true);

  await fireEvent.changeText(input, 'yes, see you');
  await fireEvent.press(screen.getByLabelText('Send reply'));

  await waitFor(() => expect(sendCalls()).toEqual([['yes, see you', 8]]));
});

it('replying to a reply answers *that* message, still in the one strand', async () => {
  // Depth stays 1 — the server flattens it into the same strand either way — but
  // the target is the message you tapped, so the quote names who you actually
  // answered rather than whoever started the thread.
  const root = message({ id: 8, sender: ADA, text: 'dinner at 7?' });
  const reply = message({
    id: 9,
    sender: GRACE,
    text: 'or 8 if easier',
    reply_to: { id: 8 },
    thread_root_id: 8,
  });
  serve({
    conversation: detail({}),
    messages: [{ ...root, reply_count: 1 }, reply],
    thread: [root, reply],
  });

  await renderScreen();
  await openMenu('Message from Grace Hopper: or 8 if easier');
  await fireEvent.press(screen.getByLabelText('Reply'));

  // Named, because it isn't the head of the strand — otherwise the label would
  // just restate the message at the top of the screen.
  expect(await screen.findByText('Replying to Grace Hopper')).toBeTruthy();

  await fireEvent.changeText(
    screen.getByLabelText('Reply to thread'),
    '8 works'
  );
  await fireEvent.press(screen.getByLabelText('Send reply'));

  await waitFor(() => expect(sendCalls()).toEqual([['8 works', 9]]));
});

it('browsing into a strand aims at the root and doesn’t grab the keyboard', async () => {
  const root = message({
    id: 8,
    sender: ADA,
    text: 'dinner at 7?',
    reply_count: 1,
  });
  serve({
    conversation: detail({}),
    messages: [root],
    thread: [
      root,
      message({
        id: 9,
        sender: GRACE,
        text: 'or 8 if easier',
        reply_to: { id: 8 },
        thread_root_id: 8,
      }),
    ],
  });

  await renderScreen();
  await fireEvent.press(await screen.findByLabelText('1 reply — open thread'));

  const input = await screen.findByLabelText('Reply to thread');
  // You came to read, so the keyboard stays down…
  expect(input.props.autoFocus).toBe(false);
  // …and there's no "Replying to" label, because the root is already the first
  // thing on screen.
  expect(screen.queryByText(/^Replying to/)).toBeNull();

  await fireEvent.changeText(input, 'either works');
  await fireEvent.press(screen.getByLabelText('Send reply'));

  await waitFor(() => expect(sendCalls()).toEqual([['either works', 8]]));
});

it('leaves the transcript’s composer alone while you reply', async () => {
  // The strand has its own composer, so a half-written message in the thread
  // screen is untouched by replying — and still there when you come back.
  const only = message({ id: 8, sender: ADA, text: 'dinner at 7?' });
  serve({
    conversation: detail({}),
    messages: [only],
    thread: [only],
  });

  await renderScreen();
  await fireEvent.changeText(
    await screen.findByLabelText('Message'),
    'half-written thought'
  );
  await openMenu('Message from Ada Lovelace: dinner at 7?');
  await fireEvent.press(screen.getByLabelText('Reply'));
  await screen.findByText('Thread');
  await fireEvent.press(screen.getAllByLabelText('Close thread')[0]);

  expect(screen.getByLabelText('Message').props.value).toBe(
    'half-written thought'
  );
});

it('an edit in progress survives a trip into a strand', async () => {
  // Two composers, two independent modes — replying no longer has to cancel an
  // edit, because it no longer competes for the same input.
  const mine = message({ id: 7, sender: MINE, text: 'teh quick fox' });
  const theirs = message({ id: 8, sender: ADA, text: 'dinner at 7?' });
  serve({
    conversation: detail({}),
    messages: [mine, theirs],
    thread: [theirs],
  });

  await renderScreen();
  await openMenu('Your message: teh quick fox');
  await fireEvent.press(screen.getByLabelText('Edit'));
  expect(screen.getByText('Editing message')).toBeTruthy();

  await openMenu('Message from Ada Lovelace: dinner at 7?');
  await fireEvent.press(screen.getByLabelText('Reply'));
  await screen.findByText('Thread');
  await fireEvent.press(screen.getAllByLabelText('Close thread')[0]);

  expect(screen.getByText('Editing message')).toBeTruthy();
  expect(screen.getByLabelText('Message').props.value).toBe('teh quick fox');
});

it('keeps the transcript’s draft when a reply is actually sent', async () => {
  // The stronger version of the test above, and the one that was missing: not
  // just opening and closing the strand, but *sending* from it. Both composers
  // run off one mutation, so a careless `setText('')` in its success handler
  // clears the transcript's box as well — you'd lose a half-written message to
  // someone else's thread.
  const only = message({ id: 8, sender: ADA, text: 'dinner at 7?' });
  serve({
    conversation: detail({}),
    messages: [only],
    thread: [only],
  });

  await renderScreen();
  await fireEvent.changeText(
    await screen.findByLabelText('Message'),
    'half-written thought'
  );
  await openMenu('Message from Ada Lovelace: dinner at 7?');
  await fireEvent.press(screen.getByLabelText('Reply'));
  await fireEvent.changeText(
    await screen.findByLabelText('Reply to thread'),
    'yes, see you'
  );
  await fireEvent.press(screen.getByLabelText('Send reply'));
  await waitFor(() => expect(sendCalls()).toEqual([['yes, see you', 8]]));

  // The strand's own composer empties, because that send *was* its send…
  await waitFor(() =>
    expect(screen.getByLabelText('Reply to thread').props.value).toBe('')
  );
  // …and the transcript's is untouched underneath.
  await fireEvent.press(screen.getAllByLabelText('Close thread')[0]);
  expect(screen.getByLabelText('Message').props.value).toBe(
    'half-written thought'
  );
});

it('keeps a failed reply in the box and says why', async () => {
  // Clearing on dispatch rather than on success loses the words outright when
  // the send fails, and the transcript's error line is behind the blur where
  // nobody can read it. The strand has to answer for its own send.
  const only = message({ id: 8, sender: ADA, text: 'dinner at 7?' });
  serve({
    conversation: detail({}),
    messages: [only],
    thread: [only],
  });
  const ok = mockFetch.getMockImplementation()!;
  mockFetch.mockImplementation(async (url: string, init?: { method?: string }) => {
    if (url.includes('/messages/') && init?.method === 'POST') {
      return jsonResponse({ detail: 'You can no longer message this person.' }, 403);
    }
    return ok(url, init);
  });

  await renderScreen();
  await openMenu('Message from Ada Lovelace: dinner at 7?');
  await fireEvent.press(screen.getByLabelText('Reply'));
  const input = await screen.findByLabelText('Reply to thread');
  await fireEvent.changeText(input, 'yes, see you');
  await fireEvent.press(screen.getByLabelText('Send reply'));

  expect(
    await screen.findByText('You can no longer message this person.')
  ).toBeTruthy();
  // Still there to retry or copy out of — the words are the user's, not ours.
  expect(screen.getByLabelText('Reply to thread').props.value).toBe(
    'yes, see you'
  );
});

it('offers no Reply in a thread you can’t send to', async () => {
  // Same line the server draws, and the same one the reaction row obeys: the
  // history stays readable, writing to it doesn't.
  serve({
    conversation: detail({ can_send: false }),
    messages: [message({ id: 8, sender: ADA, text: 'dinner at 7?' })],
  });

  await renderScreen();
  await openMenu('Message from Ada Lovelace: dinner at 7?');

  expect(screen.queryByLabelText('Reply')).toBeNull();
  expect(screen.getByLabelText('Copy')).toBeTruthy();
});

it('renders a reply’s quote from the message it already holds', async () => {
  serve({
    conversation: detail({}),
    messages: [
      message({ id: 8, sender: ADA, text: 'dinner at 7?' }),
      message({
        id: 9,
        sender: MINE,
        text: 'yes',
        reply_to: { id: 8 },
        thread_root_id: 8,
      }),
    ],
  });

  await renderScreen();
  await screen.findByText('yes');

  // The quoted body is resolved locally — the reply's payload carries only
  // a bare `{ id }`, which is what stops a quote leaking clipped history.
  expect(screen.getAllByText('dinner at 7?').length).toBeGreaterThan(1);
});

it('says so honestly when a quoted message isn’t available', async () => {
  // 🔒 The gap case, from the client's side: the server sends the reply but not
  // the message it answers, because the viewer was out of the chat when it was
  // sent. There is nothing to render, and pretending otherwise is the bug.
  serve({
    conversation: detail({}),
    messages: [
      message({
        id: 9,
        sender: ADA,
        text: 'still on for that',
        reply_to: { id: 8 },
        thread_root_id: 8,
      }),
    ],
  });

  await renderScreen();
  await screen.findByText('still on for that');

  expect(screen.getByText('Original message unavailable')).toBeTruthy();
});

it('opens the focused thread from a root’s reply count', async () => {
  const root = message({
    id: 8,
    sender: ADA,
    text: 'dinner at 7?',
    reply_count: 2,
  });
  serve({
    conversation: detail({}),
    messages: [root],
    thread: [
      root,
      message({
        id: 9,
        sender: MINE,
        text: 'yes',
        reply_to: { id: 8 },
        thread_root_id: 8,
      }),
      message({
        id: 10,
        sender: ADA,
        text: 'or 8 if easier',
        reply_to: { id: 8 },
        thread_root_id: 8,
      }),
    ],
  });

  await renderScreen();
  await fireEvent.press(await screen.findByLabelText('2 replies — open thread'));

  // The strand comes forward whole — root and both replies, in order.
  expect(await screen.findByText('Thread')).toBeTruthy();
  expect(await screen.findByText('or 8 if easier')).toBeTruthy();
  expect(screen.getByText('yes')).toBeTruthy();
  // It asked the same endpoint the transcript uses, filtered to this root.
  expect(
    mockFetch.mock.calls.some(([url]) =>
      String(url).includes('/api/conversations/5/messages/?thread_root=8')
    )
  ).toBe(true);
});

it('sends a reply into the thread from inside the focused view', async () => {
  const root = message({
    id: 8,
    sender: ADA,
    text: 'dinner at 7?',
    reply_count: 1,
  });
  serve({
    conversation: detail({}),
    messages: [root],
    thread: [
      root,
      message({
        id: 9,
        sender: ADA,
        text: 'or 8 if easier',
        reply_to: { id: 8 },
        thread_root_id: 8,
      }),
    ],
  });

  await renderScreen();
  await fireEvent.press(await screen.findByLabelText('1 reply — open thread'));
  await screen.findByText('Thread');

  await fireEvent.changeText(
    screen.getByLabelText('Reply to thread'),
    '8 works'
  );
  await fireEvent.press(screen.getByLabelText('Send reply'));

  // Aimed at the root, which is where the server's flattening would put it
  // anyway — so it's the honest target rather than a guess.
  await waitFor(() => expect(sendCalls()).toEqual([['8 works', 8]]));
});

it('opens a headless thread when the root is one you can’t see', async () => {
  // 🔒 The other half of the gap case. The replies below are ones this viewer
  // *is* entitled to, so the thread is genuinely headless rather than empty —
  // and that's a true statement, not an error.
  const reply = message({
    id: 9,
    sender: ADA,
    text: 'still on for that',
    reply_to: { id: 8 },
    thread_root_id: 8,
    // Zero, because a reply is not a root — which is exactly why the *quote* has
    // to be the way in here. With the root clipped away there's no bubble left
    // in the transcript to carry a reply count.
    reply_count: 0,
  });
  serve({
    conversation: detail({}),
    // The transcript shows the reply but never the root.
    messages: [reply],
    thread: [reply],
  });

  await renderScreen();
  // 🔒 Unnamed, and that's the fix: the quote reference is a bare id, so an
  // unresolved quote can't name its author either. Otherwise a group member who
  // joined, posted and left inside your gap would reach you here — through the
  // one payload that used to carry a name for a message you can't see.
  await fireEvent.press(
    await screen.findByLabelText(
      'In reply to a message you can’t see — open thread'
    )
  );
  // The reply now appears twice — once in the transcript behind the blur, once
  // in the strand — which is also how we know the thread's fetch has landed.
  // The strand opens and says plainly why its head is missing. Deliberately
  // different wording from the quote's "Original message unavailable": a thread
  // with no beginning is a different thing to tell someone than a quote that
  // won't resolve, and only one of them is about the message in front of you.
  expect(
    await screen.findByText('The start of this thread isn’t available to you')
  ).toBeTruthy();
  // Nothing errored, and the transcript still shows the reply behind the blur.
  expect(screen.getByText('still on for that')).toBeTruthy();
  // It asked for the thread by the *root's* id, taken from the reply's
  // `thread_root_id` — a message the viewer can't see and never had to know
  // anything else about.
  expect(
    mockFetch.mock.calls.some(([url]) =>
      String(url).includes('/api/conversations/5/messages/?thread_root=8')
    )
  ).toBe(true);
});

it('follows the strand past its first page to the newest reply', async () => {
  // The thread endpoint is the message list with a filter, so it paginates like
  // every list — and messages come oldest-first. Reading only page one would cut
  // a busy strand off at its oldest 20 and hide precisely the end of it: the
  // newest replies, and the one you just sent from the composer in this view.
  const root = message({ id: 8, sender: ADA, text: 'dinner at 7?' });
  const replies = Array.from({ length: PAGE_SIZE + 4 }, (_, i) =>
    message({
      id: 100 + i,
      sender: i % 2 ? MINE : GRACE,
      text: `reply ${i + 1}`,
      reply_to: { id: 8 },
      thread_root_id: 8,
    })
  );
  serve({
    conversation: detail({ kind: 'group' }),
    messages: [{ ...root, reply_count: replies.length }],
    thread: [root, ...replies],
  });

  await renderScreen();
  await fireEvent.press(
    await screen.findByLabelText(`${replies.length} replies — open thread`)
  );
  await screen.findByText('Thread');

  // Asserted on the requests rather than on a bubble: `FlatList` virtualises,
  // so under Jest — with no layout and no scrolling — only the first batch of
  // items is ever rendered, and the tail of a long strand can't be queried for
  // however well it loaded. What *is* provable here is the thing that was
  // broken: the view follows the paginator to the end of the strand.
  const threadPages = () =>
    mockFetch.mock.calls
      .map(([url]) => String(url))
      .filter((url) => url.includes('thread_root=8'));
  await waitFor(() =>
    expect(threadPages().some((url) => url.includes('page=2'))).toBe(true)
  );
  // …and stops there. Two pages hold 25 messages, so a request for a third
  // would mean the eager pull had lost its stopping condition.
  expect(threadPages().some((url) => url.includes('page=3'))).toBe(false);
  // Page one is on screen throughout — this pages the strand, it doesn't
  // replace one window with another. (The root twice: once in the transcript
  // behind the blur, once at the head of the strand.)
  expect(screen.getAllByText('dinner at 7?').length).toBeGreaterThan(1);
  expect(screen.getByText('reply 1')).toBeTruthy();
});

it('offers no long-press menu inside the focused thread', async () => {
  // Copy/Edit/Delete/Report all live in a Modal, and presenting one from inside
  // a presented modal is the iOS trap the emoji picker already documents. Close
  // the thread and act on the message in the transcript.
  const root = message({
    id: 8,
    sender: ADA,
    text: 'dinner at 7?',
    reply_count: 1,
  });
  serve({
    conversation: detail({}),
    messages: [root],
    thread: [
      root,
      message({
        id: 9,
        sender: MINE,
        text: 'yes',
        reply_to: { id: 8 },
        thread_root_id: 8,
      }),
    ],
  });

  await renderScreen();
  await fireEvent.press(await screen.findByLabelText('1 reply — open thread'));

  fireEvent(await screen.findByLabelText('Your message: yes'), 'longPress');
  expect(screen.queryByLabelText('Close message actions')).toBeNull();
});

it('shows a tombstone for a deleted message', async () => {
  serve({
    conversation: detail({}),
    messages: [message({ id: 1, is_deleted: true, text: '' })],
  });

  await renderScreen();

  expect(await screen.findByText('Message deleted')).toBeTruthy();
});

it('locks a pending thread behind the connect panel instead of messages', async () => {
  serve({
    conversation: detail({
      kind: 'group',
      other: null,
      title: 'Hikers',
      my_status: 'pending',
      can_send: false,
      must_connect_with: [ADA],
    }),
  });

  await renderScreen();

  // The locked panel offers a Connect action for whom you must connect with,
  // and no composer. (The prompt sentence is split across styled Text nodes, so
  // the button's stable accessibility label is what's asserted.)
  expect(
    await screen.findByLabelText('Connect with Ada Lovelace')
  ).toBeTruthy();
  expect(screen.getByText('Decline / Leave')).toBeTruthy();
  expect(screen.queryByLabelText('Send')).toBeNull();
  // It never asks for messages it can't see.
  expect(
    mockFetch.mock.calls.some(([url]) => String(url).includes('/messages/'))
  ).toBe(false);
});

it('replaces the composer with a read-only note when you can’t send', async () => {
  serve({
    conversation: detail({ can_send: false }),
    messages: [message({ id: 1 })],
  });

  await renderScreen();
  await screen.findByText('Message 1');

  expect(screen.queryByLabelText('Send')).toBeNull();
  expect(screen.getByText(/no longer connected/)).toBeTruthy();
});
