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
 * Phase 9b M7 adds photo messages: the composer grows an attach button that
 * offers the camera and the library, a picked photo is prepared *on the phone*
 * (resized and EXIF-stripped) before it's uploaded as multipart, a photo with no
 * caption is a valid message, and the bubble shows it and opens it full-screen.
 *
 * Phase 9b M3 adds reply threads: Reply in that menu opens a focused strand over
 * a blurred transcript with its own composer, a reply renders a quote resolved
 * from messages the client already holds (never anything the server attached to
 * it — not the text and not the author), and a root's "N replies" opens the same
 * strand. Reply has two ways in: the menu item, and a rightward **swipe** on the
 * bubble — the one that shipped with M3, was pulled for fighting the navigator's
 * back gesture, and came back once that gesture was turned off.
 *
 * What's worth pinning: sending fires the send endpoint and clears the input;
 * group threads attribute a *run* of messages to its sender only once (the first
 * bubble), never on 1:1 or your own; a soft-deleted message shows a tombstone in
 * place; a pending viewer gets the locked panel instead of the message list; and
 * a viewer who can't send gets the read-only footer, not a composer.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import * as Clipboard from 'expo-clipboard';
import * as Notifications from 'expo-notifications';
import * as ImagePicker from 'expo-image-picker';
import { Alert, FlatList, Linking, Platform, StyleSheet } from 'react-native';
import { State } from 'react-native-gesture-handler';

import { CONVERSATION_DETAIL_POLL_MS } from '@/api';
import ThreadScreen from '@/app/messages/[conversationId]';
import { AuthProvider } from '@/auth';
import { clearDrafts } from '@/drafts';
import { clearOutbox } from '@/outbox';
import { configureNotificationHandler, setOnScreenConversation } from '@/push';
import { saveTokens } from '@/tokens';
import type { Conversation, Message } from '@/types';

import {
  androidIt,
  backHandlerCount,
  captureBackHandler,
  choosePhotoSource,
  holdRequest,
  pressBack,
  resetMenuSpies,
  settle,
} from './helpers';

const mockNotifications = Notifications as jest.Mocked<typeof Notifications>;

const mockParams: { conversationId: string } = { conversationId: '5' };
const mockPush = jest.fn();
const mockBack = jest.fn();
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => mockParams,
  // The screen is always focused under test, so focus is a plain effect —
  // which still runs the cleanup on unmount, keeping `useAndroidBack`'s
  // subscribe/unsubscribe pairing honest.
  useFocusEffect: (callback: () => void | (() => void)) =>
    // `require`, not an import: jest.mock factories are hoisted above the
    // imports, so a module-scope binding isn't initialised yet when this runs.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('react').useEffect(callback, [callback]),
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

/**
 * The photo picker and the image pipeline are both native (Phase 9b M7).
 *
 * `expo-image-manipulator` is stood in with something that reports a plausible
 * output rather than a no-op, because the *dimensions* it returns are what the
 * bubble lays out from and what the multipart body carries. Its real behaviour —
 * that a re-encode drops the EXIF — is pinned in `chatPhotos.test.ts` and,
 * finally, on a device with a GPS-tagged photo.
 */
jest.mock('expo-image-picker', () => ({
  launchImageLibraryAsync: jest.fn(),
  launchCameraAsync: jest.fn(),
  requestCameraPermissionsAsync: jest.fn(async () => ({ granted: true })),
}));

jest.mock('expo-image-manipulator', () => ({
  SaveFormat: { JPEG: 'jpeg' },
  ImageManipulator: {
    manipulate: (uri: string) => {
      let size: { width?: number; height?: number } = {};
      return {
        resize: (requested: { width?: number; height?: number }) => {
          size = requested;
        },
        renderAsync: async () => ({
          saveAsync: async () => ({
            uri: `${uri}-prepared.jpg`,
            width: size.width ?? 1200,
            height: size.height ?? 900,
          }),
        }),
      };
    },
  },
}));

const pickFromLibrary = ImagePicker.launchImageLibraryAsync as jest.Mock;
const takePhoto = ImagePicker.launchCameraAsync as jest.Mock;

/** A picked camera-roll asset, as the picker reports one. */
const PICKED = {
  canceled: false,
  assets: [{ uri: 'file:///camera-roll/IMG_1.jpg', width: 4032, height: 3024 }],
};

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
const GRACE = { id: 3, display_name: 'Grace Hopper', avatar_thumb: null };
/** `ME` as a message sender — the author slice, not the account. */
const MINE = { id: ME.pk, display_name: ME.display_name, avatar_thumb: null };
/** The server's `PAGE_SIZE` (`config/settings.py`), so paging is served here as
 *  the real endpoint serves it. */
const PAGE_SIZE = 20;

/**
 * A local wall-clock time today, as the server would send it (Phase 9b M5).
 *
 * Local, not UTC: day separators and clock times are both derived in local time,
 * so a fixture pinned to a UTC instant would land on a different day — and read
 * a different hour — depending on where CI happens to be.
 */
function todayAt(hour: number, minute: number) {
  const when = new Date();
  when.setHours(hour, minute, 0, 0);
  return when.toISOString();
}

/** Midday yesterday, local — far enough from midnight to stay yesterday. */
function yesterday() {
  const when = new Date();
  when.setDate(when.getDate() - 1);
  when.setHours(12, 0, 0, 0);
  return when.toISOString();
}

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
    attachments: [],
    ...overrides,
  };
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

/**
 * Answer by URL + method. Order matters: the send/delete URLs contain
 * `/messages/`, so match those before the bare conversation-detail route — and
 * `/api/messages/<id>/react/` contains it too, so that goes first of all.
 */
function serve({
  conversation,
  messages = [],
  thread,
  quotable,
  reactionsAfterToggle = [{ emoji: '👍', count: 1, reacted: true }],
  reactors = [{ emoji: '👍', count: 1, users: [ADA] }],
  threadPageTwoFails = false,
  threadFails = false,
}: {
  conversation: Conversation;
  /** The transcript, **oldest-first** — the order the model has them in. */
  messages?: Message[];
  /**
   * What `?thread_root=` returns (Phase 9b M3). Its own list, not a filter over
   * `messages`, because the interesting cases are where the two *differ* — a
   * viewer clipped out of the root gets replies here and no head.
   */
  thread?: Message[];
  /**
   * What `?ids=` can resolve (Phase 9b M5), if it isn't just `messages`.
   *
   * Its own list for the same reason `thread` is: the case worth testing is
   * where a quoted message is **not** in the loaded transcript — the whole
   * point of the id fetch — and a fixture that filters `messages` couldn't
   * stage it. Anything absent from here is a message the viewer was clipped
   * out of, which is exactly how the server answers.
   */
  quotable?: Message[];
  reactionsAfterToggle?: { emoji: string; count: number; reacted: boolean }[];
  reactors?: { emoji: string; count: number; users: typeof ADA[] }[];
  /**
   * Stage #248: the strand's first page lands carrying a `next`, and the page it
   * points at 500s — without needing a 21-message fixture to get there. The
   * failure is a macrotask late on purpose, since a mock that rejects instantly
   * settles inside the same React batch as the render that fired it, which is
   * not how a real request behaves and would hide the loop (see `settle`).
   */
  threadPageTwoFails?: boolean;
  /** The strand's *first* page 500s, so nothing about it ever loads. */
  threadFails?: boolean;
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
        if (threadFails || (threadPageTwoFails && page > 1)) {
          await new Promise((resolve) => setTimeout(resolve, 0));
          return jsonResponse({ detail: 'Server error.' }, 500);
        }
        const results = all.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
        const base = url.replace(/[?&]page=\d+/, '');
        const hasMore = threadPageTwoFails || all.length > page * PAGE_SIZE;
        return jsonResponse({
          count: all.length,
          // Absolute, like DRF's — `getPage` re-bases it on BASE_URL.
          next: hasMore ? `${base}&page=${page + 1}` : null,
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

        // `?ids=` (Phase 9b M5) — how a collapsed quote gets its words and its
        // author now that the transcript pages lazily.
        //
        // **Paged like every other list**, because it is one: `?ids=` is a
        // filter on the transcript's own queryset, so a request for more ids
        // than fit in a page comes back short with a `next`. A mock that always
        // answered in full would hide the case where the client retires an id it
        // never actually got an answer about.
        const idsParam = url.match(/[?&]ids=([^&]*)/);
        if (idsParam) {
          const wanted = decodeURIComponent(idsParam[1])
            .split(',')
            .filter(Boolean)
            .map(Number);
          const pool = quotable ?? messages;
          const found = pool.filter((m) => wanted.includes(m.id));
          return jsonResponse({
            count: found.length,
            next: found.length > PAGE_SIZE ? `${url}&page=2` : null,
            previous: null,
            results: found.slice(0, PAGE_SIZE),
          });
        }

        // Paged like the real endpoint. **This matters more than it looks**:
        // the transcript's whole M5 change is that it stops loading every page,
        // so a fixture that always answers in full couldn't tell a lazy screen
        // from an eager one — and `?order=desc` returning the same oldest-first
        // array would make the run-grouping assertions pass upside down.
        const desc = url.includes('order=desc');
        const all = desc ? [...messages].reverse() : messages;
        const page = Number(url.match(/[?&]page=(\d+)/)?.[1] ?? 1);
        const results = all.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
        const base = url.replace(/[?&]page=\d+/, '');
        return jsonResponse({
          count: all.length,
          // Absolute, like DRF's — `getPage` re-bases it on BASE_URL.
          next:
            all.length > page * PAGE_SIZE
              ? `${base}${base.includes('?') ? '&' : '?'}page=${page + 1}`
              : null,
          previous: null,
          results,
        });
      }
      if (url.includes('/api/conversations/')) return jsonResponse(conversation);
      return jsonResponse(null, 404);
    }
  );
}

/**
 * The transcript endpoint fails from here on; everything else keeps working.
 *
 * Anchored on the **conversation's** messages route, not a bare `/messages/`:
 * the reactors endpoint is `/api/messages/<id>/reactions/`, which a looser
 * predicate breaks too — and a helper whose docblock and behaviour disagree is
 * how a later assertion fails for a reason nobody can find. The strand
 * (`thread_root=`), the quote resolver (`ids=`) and every send/edit/delete hang
 * off this same path and are deliberately left alone.
 */
function breakTheMessages(reason = 'Server error.') {
  const base = mockFetch.getMockImplementation()!;
  mockFetch.mockImplementation(
    async (url: string, init?: { method?: string; body?: string }) => {
      const transcriptGet =
        /\/api\/conversations\/\d+\/messages\//.test(String(url)) &&
        !String(url).includes('thread_root=') &&
        !String(url).includes('ids=') &&
        (init?.method ?? 'GET') === 'GET';
      if (!transcriptGet) return base(url, init);
      // A macrotask late, as a real request is — an instant rejection settles
      // inside the render's own batch and doesn't behave like one.
      await new Promise((resolve) => setTimeout(resolve, 0));
      return jsonResponse({ detail: reason }, 500);
    }
  );
}

/** How many `mark read` POSTs have gone out. */
const readPosts = () =>
  mockFetch.mock.calls.filter(
    ([url, init]) => String(url).includes('/read/') && init?.method === 'POST'
  ).length;

/**
 * A client whose cache survives an unmount, which one test needs — see
 * `renderScreen`. `gcTime` has to be non-zero for that: the default here drops a
 * query the moment its last observer goes.
 */
function warmClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { gcTime: 0 },
    },
  });
}

/**
 * Draw the screen again from the top, with a *fresh* element so React can't bail
 * out of the render. Set by `renderScreen`; only the swipe tests need it, and
 * why they need it is written up with them.
 */
let redrawScreen: (() => Promise<void>) | null = null;

async function renderScreen(client?: QueryClient) {
  await saveTokens({ access: 'a', refresh: 'r' });
  const queryClient =
    client ??
    new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: 0 },
        mutations: { gcTime: 0 },
      },
    });
  const tree = () => (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <ThreadScreen />
      </AuthProvider>
    </QueryClientProvider>
  );
  const result = await render(tree());
  redrawScreen = async () => {
    await result.rerender(tree());
  };
  return result;
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
  // The outbox is module state now (it has to outlive the screen, or tapping
  // back would throw away a failed message), so it also outlives a test unless
  // it's emptied here. Drafts (M5) are the same shape for the same reason.
  clearOutbox();
  clearDrafts();
  // Which thread the push handler thinks is on screen is module state too, and
  // the screen sets it on focus — so a test that renders one leaves it set for
  // the next unless it's cleared (#321's `readingMessages` guard is asserted
  // through this).
  setOnScreenConversation(null);
  // Dropped with the tree it closes over, so a swipe test that forgot to
  // render fails on the missing screen rather than redrawing a dead one.
  redrawScreen = null;
  // Delivered push notifications (#178). Empty tray by default, so only the
  // test that cares about dismissal has to say what's in it.
  mockNotifications.getPresentedNotificationsAsync.mockReset();
  mockNotifications.getPresentedNotificationsAsync.mockResolvedValue([] as never);
  mockNotifications.dismissNotificationAsync.mockReset();
  mockNotifications.dismissNotificationAsync.mockResolvedValue(undefined as never);
  // The camera/library sheet is a `useActionMenu`, so its spies need resetting
  // like any other menu test.
  resetMenuSpies();
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
  // The input is a controlled component keyed off state cleared on dispatch.
  await waitFor(() => expect(input.props.value).toBe(''));
});

// --- Phase 9b M4: optimistic send + read receipts ----------------------------

it('shows the message immediately, before the server has it', async () => {
  // The heart of the milestone. On a polling app the round trip is the entire
  // perceived latency of sending, and this is what removes it: the bubble is
  // there with a clock on it the instant you tap Send.
  let release: () => void = () => {};
  const inFlight = new Promise<void>((resolve) => {
    release = resolve;
  });
  serve({ conversation: detail({}), messages: [message({ id: 1 })] });
  const base = mockFetch.getMockImplementation()!;
  mockFetch.mockImplementation(async (url: string, init?: { method?: string }) => {
    if (url.includes('/messages/') && init?.method === 'POST') {
      await inFlight;
    }
    return base(url, init);
  });

  await renderScreen();
  await fireEvent.changeText(
    await screen.findByLabelText('Message'),
    'Hello there'
  );
  await fireEvent.press(screen.getByLabelText('Send'));

  // On screen while the POST is still open, wearing the clock.
  expect(await screen.findByText('Hello there')).toBeTruthy();
  expect(screen.getByLabelText('Sending')).toBeTruthy();
  // And no action menu on it: every action needs a server id it hasn't got.
  await fireEvent(
    screen.getByLabelText('Your message: Hello there'),
    'longPress'
  );
  expect(screen.queryByText('Delete')).toBeNull();

  release();
  await waitFor(() => expect(screen.queryByLabelText('Sending')).toBeNull());
});

it('keeps a failed message in place with Retry and Discard', async () => {
  // Never drop text somebody typed. A failed send stays exactly where it was,
  // dimmed, and the two ways out are on the bubble itself.
  serve({ conversation: detail({}), messages: [message({ id: 1 })] });
  const base = mockFetch.getMockImplementation()!;
  mockFetch.mockImplementation(async (url: string, init?: { method?: string }) => {
    if (url.includes('/messages/') && init?.method === 'POST') {
      return jsonResponse({ detail: 'Nope.' }, 500);
    }
    return base(url, init);
  });

  await renderScreen();
  await fireEvent.changeText(await screen.findByLabelText('Message'), 'lost?');
  await fireEvent.press(screen.getByLabelText('Send'));

  expect(await screen.findByText('Not sent')).toBeTruthy();
  expect(screen.getByText('lost?')).toBeTruthy();
  expect(screen.getByLabelText('Try sending again')).toBeTruthy();

  // Discard is the *only* way it leaves, and it has to be the user's tap.
  await fireEvent.press(screen.getByLabelText('Discard this message'));
  await waitFor(() => expect(screen.queryByText('lost?')).toBeNull());
});

it('lets you send again while one is still in flight', async () => {
  // The composer no longer blocks on a send. Two quick messages in a row is the
  // ordinary case in a chat, and waiting for the first is exactly the lag this
  // milestone exists to remove.
  serve({ conversation: detail({}), messages: [message({ id: 1 })] });
  const base = mockFetch.getMockImplementation()!;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  mockFetch.mockImplementation(async (url: string, init?: { method?: string }) => {
    if (url.includes('/messages/') && init?.method === 'POST') {
      await gate;
    }
    return base(url, init);
  });

  await renderScreen();
  const input = await screen.findByLabelText('Message');
  await fireEvent.changeText(input, 'first');
  await fireEvent.press(screen.getByLabelText('Send'));
  await fireEvent.changeText(input, 'second');
  await fireEvent.press(screen.getByLabelText('Send'));

  expect(await screen.findByText('first')).toBeTruthy();
  expect(screen.getByText('second')).toBeTruthy();
  expect(screen.getAllByLabelText('Sending')).toHaveLength(2);

  // Let both settle, so the test doesn't leave two requests pending in the
  // shared mock for whatever runs next.
  release();
  await waitFor(() => expect(screen.queryByLabelText('Sending')).toBeNull());
});

it('still has the failed message when you leave and come back', async () => {
  // The promise the outbox makes is that text a person typed is never dropped
  // for them, and tapping back is not "discard". Held as screen state it was:
  // the failed message went with the component, silently, on the most ordinary
  // gesture in the app. The outbox is a store outside the screen for this.
  serve({ conversation: detail({}), messages: [message({ id: 1 })] });
  const base = mockFetch.getMockImplementation()!;
  mockFetch.mockImplementation(async (url: string, init?: { method?: string }) => {
    if (url.includes('/messages/') && init?.method === 'POST') {
      return jsonResponse({ detail: 'Nope.' }, 500);
    }
    return base(url, init);
  });

  const first = await renderScreen();
  await fireEvent.changeText(await screen.findByLabelText('Message'), 'keep me');
  await fireEvent.press(screen.getByLabelText('Send'));
  await screen.findByText('Not sent');

  first.unmount();
  await renderScreen();

  expect(await screen.findByText('keep me')).toBeTruthy();
  expect(screen.getByText('Not sent')).toBeTruthy();
  expect(screen.getByLabelText('Try sending again')).toBeTruthy();
});

it('settles a send that was still in flight when you left', async () => {
  // The other half of an outbox that outlives the screen. A `sending` entry
  // nobody ever clears would now *persist*, so you'd come back to the message
  // twice — once from the server and once wearing a clock that never stops.
  // It doesn't happen, because TanStack captures a mutation's options when it
  // starts and runs them whether or not the observer is still mounted. That's
  // load-bearing rather than incidental now, so it's pinned here.
  let release: () => void = () => {};
  const inFlight = new Promise<void>((resolve) => {
    release = resolve;
  });
  serve({ conversation: detail({}), messages: [message({ id: 1 })] });
  const base = mockFetch.getMockImplementation()!;
  mockFetch.mockImplementation(async (url: string, init?: { method?: string }) => {
    if (url.includes('/messages/') && init?.method === 'POST') {
      await inFlight;
    }
    return base(url, init);
  });

  const first = await renderScreen();
  await fireEvent.changeText(await screen.findByLabelText('Message'), 'in flight');
  await fireEvent.press(screen.getByLabelText('Send'));
  await screen.findByLabelText('Sending');

  // Leave while the POST is still open, then let it land.
  first.unmount();
  release();

  await renderScreen();
  await screen.findByText('Message 1');
  expect(screen.queryByLabelText('Sending')).toBeNull();
  expect(screen.queryByText('in flight')).toBeNull();
});

it('shows two ticks once everyone has read your message', async () => {
  const sent = '2026-07-22T10:00:00Z';
  serve({
    conversation: detail({
      participants: [
        {
          id: ME.pk,
          display_name: ME.display_name,
          avatar_thumb: null,
          status: 'active',
          active_since: '2026-07-01T00:00:00Z',
          last_read_at: '2026-07-22T11:00:00Z',
        },
        {
          ...ADA,
          status: 'active',
          active_since: '2026-07-01T00:00:00Z',
          last_read_at: '2026-07-22T11:00:00Z',
        },
      ],
    }),
    messages: [message({ id: 1, sender: MINE, text: 'read me', created_at: sent })],
  });

  await renderScreen();
  expect(await screen.findByLabelText('Read')).toBeTruthy();
});

it('shows one tick while they haven’t caught up', async () => {
  const sent = '2026-07-22T10:00:00Z';
  serve({
    conversation: detail({
      participants: [
        {
          ...ADA,
          status: 'active',
          active_since: '2026-07-01T00:00:00Z',
          // Before the message: they've been in the thread, just not since.
          last_read_at: '2026-07-22T09:00:00Z',
        },
      ],
    }),
    messages: [message({ id: 1, sender: MINE, text: 'unread', created_at: sent })],
  });

  await renderScreen();
  expect(await screen.findByLabelText('Sent')).toBeTruthy();
  expect(screen.queryByLabelText('Read')).toBeNull();
});

it('shows no ticks at all when you’ve turned receipts off', async () => {
  // The server withholds every marker when *you* opt out, so there's nothing to
  // draw. A column frozen on one tick would read as "nobody ever opens these",
  // which is a worse lie than showing nothing.
  serve({
    conversation: detail({
      participants: [{ ...ADA, status: 'active' }],
    }),
    messages: [message({ id: 1, sender: MINE, text: 'quiet' })],
  });

  await renderScreen();
  await screen.findByText('quiet');
  expect(screen.queryByLabelText('Sent')).toBeNull();
  expect(screen.queryByLabelText('Read')).toBeNull();
});

it('never puts a tick on someone else’s message', async () => {
  // A tick reports what *your* message did. On an incoming one it would be
  // telling you that you read it, which you plainly know.
  serve({
    conversation: detail({
      participants: [
        {
          ...ADA,
          status: 'active',
          active_since: '2026-07-01T00:00:00Z',
          last_read_at: '2026-07-22T11:00:00Z',
        },
      ],
    }),
    messages: [message({ id: 1, sender: ADA, text: 'theirs' })],
  });

  await renderScreen();
  await screen.findByText('theirs');
  expect(screen.queryByLabelText('Read')).toBeNull();
  expect(screen.queryByLabelText('Sent')).toBeNull();
});

it('turns one tick into two when they read it, without leaving the thread', async () => {
  // The bug this guards: the receipts ride on the conversation *detail*, which
  // used to be fetched once at mount. A marker read at mount is by construction
  // older than any message you send afterwards, so the second tick could only
  // ever appear after leaving the thread and coming back — the one moment
  // nobody is watching for it. The detail is polled now.
  jest.useFakeTimers();
  const sent = '2026-07-22T10:00:00Z';
  // Behind the message to begin with: they've been in the thread, just not since.
  let readAt = '2026-07-22T09:00:00Z';
  serve({
    conversation: detail({}),
    messages: [message({ id: 1, sender: MINE, text: 'read me', created_at: sent })],
  });
  const base = mockFetch.getMockImplementation()!;
  mockFetch.mockImplementation(async (url: string, init?: { method?: string }) => {
    if (url.match(/\/api\/conversations\/\d+\/$/)) {
      return jsonResponse(
        detail({
          participants: [
            {
              ...ADA,
              status: 'active',
              active_since: '2026-07-01T00:00:00Z',
              last_read_at: readAt,
            },
          ],
        })
      );
    }
    return base(url, init);
  });

  await renderScreen();
  expect(await screen.findByLabelText('Sent')).toBeTruthy();

  // They open the thread. Nothing on this screen changes, and nothing here
  // re-mounts it — only the next poll of the detail can carry the news.
  readAt = '2026-07-22T11:00:00Z';
  // Past one `CONVERSATION_DETAIL_POLL_MS` of *fake* time, so this waits on the
  // poll rather than on the wall clock.
  await waitFor(() => expect(screen.getByLabelText('Read')).toBeTruthy(), {
    timeout: CONVERSATION_DETAIL_POLL_MS * 2,
  });

  jest.useRealTimers();
});

it('carries a single ⋯ through to the info screen (M6)', async () => {
  // Mute, Add and Leave used to sit here as three text buttons crowding the
  // name of the person you're talking to. They live on the info screen now —
  // this header has one control, and it's a door rather than an action.
  serve({ conversation: detail({}), messages: [message({ id: 1 })] });

  await renderScreen();
  await fireEvent.press(await screen.findByLabelText('Conversation details'));

  expect(mockPush).toHaveBeenCalledWith('/messages/5/info');
  expect(screen.queryByLabelText('Mute notifications')).toBeNull();
  expect(screen.queryByLabelText('Leave chat')).toBeNull();
  expect(screen.queryByLabelText('Add people')).toBeNull();
});

it('still says a thread is muted, without carrying the toggle', async () => {
  // The one piece of state that stays in the header: the whole risk of muting
  // a chat is forgetting you did, so it has to be visible where you'd notice.
  serve({ conversation: detail({ muted: true }), messages: [message({ id: 1 })] });

  await renderScreen();

  expect(await screen.findByText('Muted')).toBeTruthy();
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

it('takes back that thread’s notifications on open, and no others (#178)', async () => {
  // Reading a thread in the app is the commonest way a push goes stale, and
  // until this landed nothing ever removed a delivered one: you could read
  // everything and still find it on the lock screen. Matched on the push's own
  // `/messages/<id>` url, so a notification for a *different* thread has to
  // survive — dismissing the lot would be worse than dismissing none.
  serve({ conversation: detail({}), messages: [message({ id: 1 })] });
  mockNotifications.getPresentedNotificationsAsync.mockResolvedValue([
    { request: { identifier: 'this-thread', content: { data: { url: '/messages/5' } } } },
    { request: { identifier: 'another-thread', content: { data: { url: '/messages/9' } } } },
  ] as never);

  await renderScreen();
  await screen.findByText('Message 1');

  await waitFor(() =>
    expect(mockNotifications.dismissNotificationAsync).toHaveBeenCalledWith(
      'this-thread'
    )
  );
  expect(mockNotifications.dismissNotificationAsync).not.toHaveBeenCalledWith(
    'another-thread'
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

/**
 * Issue #220 §2 — the one mutation on this screen without the `onError` its
 * siblings all have.
 *
 * You confirm "Delete message?", the request fails on a dropped connection, and
 * the bubble stays. That is indistinguishable from the tap not registering, so
 * the natural response is to delete it again — against a server that may well
 * have succeeded the first time.
 *
 * The confirm and the refusal are both `Alert`s, so the spy sees two calls: the
 * assertion names the *second*, because a spy that only proved "an alert
 * happened" would pass against the build with no `onError` at all.
 */
it('says so when a single-message delete is refused', async () => {
  serve({
    conversation: detail({}),
    messages: [message({ id: 7, sender: MINE, text: 'oops typo' })],
  });
  const alertSpy = jest
    .spyOn(Alert, 'alert')
    .mockImplementation((_title, _msg, buttons) => {
      buttons?.find((b) => b.style === 'destructive')?.onPress?.();
    });

  await renderScreen();
  await openMenu('Your message: oops typo');
  mockFetch.mockImplementation(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    return jsonResponse({ detail: 'You can only delete your own messages.' }, 403);
  });
  await fireEvent.press(screen.getByLabelText('Delete'));

  await waitFor(() =>
    expect(alertSpy).toHaveBeenCalledWith(
      'Couldn’t delete that message',
      'You can only delete your own messages.'
    )
  );
  // Still there, which is right — and was the whole of the feedback before.
  expect(screen.getByText('oops typo')).toBeTruthy();
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

/**
 * Leaving edit mode may not throw away a rejection that hasn't arrived (#257).
 *
 * `stopEditing()` ends with `editMutation.reset()`, written to clear a
 * **settled** failure — an error from a finished edit shouldn't hang over a
 * composer that isn't editing anything. But `reset()` doesn't distinguish that
 * from an edit still in flight: it detaches the observer from the running
 * mutation, so the PATCH's answer arrives with nothing left to paint the error
 * line, which is its only renderer.
 *
 * So both hand routes out of edit mode hold while the write is out, which is
 * what makes that `reset()` safe rather than conditional. A blanket
 * `if (!isPending)` guard on the call itself couldn't work: React Query runs
 * `onSuccess` before the mutation leaves its pending state, so it would refuse
 * the one call that has to work — the last test here is what pins that.
 */
describe('holding edit mode until the server answers', () => {
  const REFUSAL = 'Editing is only allowed for 15 minutes.';

  async function startSaving() {
    serve({
      conversation: detail({}),
      messages: [message({ id: 7, sender: MINE, text: 'teh quick fox' })],
    });

    await renderScreen();
    await openMenu('Your message: teh quick fox');
    await fireEvent.press(screen.getByLabelText('Edit'));
    await fireEvent.changeText(screen.getByLabelText('Message'), 'the quick fox');

    const server = holdRequest(mockFetch, { detail: REFUSAL }, 403);
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Save'));
    });
    await server.inFlight('Saving…');
    return server;
  }

  it('refuses the ✕, then shows the refusal', async () => {
    const server = await startSaving();

    await fireEvent.press(screen.getByLabelText('Cancel editing'));
    expect(screen.getByText('Editing message')).toBeTruthy();

    await server.refuse();
    expect(await screen.findByText(REFUSAL)).toBeTruthy();
  });

  it('refuses the header’s Back, which would unmount the whole screen', async () => {
    const server = await startSaving();

    await fireEvent.press(screen.getByLabelText('Back'));
    expect(mockBack).not.toHaveBeenCalled();

    await server.refuse();
    expect(await screen.findByText(REFUSAL)).toBeTruthy();
  });

  androidIt('refuses hardware back, then shows the refusal', async () => {
    captureBackHandler();
    const server = await startSaving();

    await act(async () => {
      // Claimed, not passed on: an unclaimed press leaves the conversation.
      expect(pressBack()).toBe(true);
    });
    expect(screen.getByText('Editing message')).toBeTruthy();

    await server.refuse();
    expect(await screen.findByText(REFUSAL)).toBeTruthy();
  });

  /**
   * Issue #261 — the *other* spelling of an unreported write, and why the alert
   * exists alongside the line rather than instead of it.
   *
   * The line lives inside the composer's `KeyboardAvoider`, and three
   * screen-level `Modal`s are siblings of it — the strand, the photo lightbox
   * and the reactors sheet. Each is opaque, and each stays reachable while the
   * PATCH is out (`busy` greys the Save button and nothing else), so a 403
   * landing while one is open paints underneath it. The strand also sets
   * `accessibilityViewIsModal`, so the announcement is dropped outright and
   * never replayed.
   *
   * An `Alert` isn't part of this screen's tree, so being covered can't happen
   * to it. Both are asserted here: the line is still the better answer when
   * nothing is covering it, because it persists beside the text you're editing.
   */
  it('reports a refused edit through an Alert as well as the line', async () => {
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const server = await startSaving();

    await server.refuse();

    expect(await screen.findByText(REFUSAL)).toBeTruthy();
    expect(alertSpy).toHaveBeenCalledWith('Couldn’t save the edit', REFUSAL);
    alertSpy.mockRestore();
  });

  it('still leaves edit mode when the save succeeds', async () => {
    // `onSuccess` calls `stopEditing` while the mutation is *still* pending, so
    // a hold written as a guard inside `stopEditing` would strand the composer
    // in edit mode on every successful save.
    serve({
      conversation: detail({}),
      messages: [message({ id: 7, sender: MINE, text: 'teh quick fox' })],
    });

    await renderScreen();
    await openMenu('Your message: teh quick fox');
    await fireEvent.press(screen.getByLabelText('Edit'));
    await fireEvent.changeText(screen.getByLabelText('Message'), 'the quick fox');
    await fireEvent.press(screen.getByLabelText('Save'));

    await waitFor(() => expect(screen.queryByText('Editing message')).toBeNull());
  });
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

/* ---- Swipe to reply -------------------------------------------------------
 *
 * The gesture M3 shipped, pulled, and has now brought back with the clash
 * settled the other way round: the thread screen gives up its own back gesture
 * (`app/_layout.tsx`) so a rightward drag on a bubble belongs to the reply and
 * nothing else. What these pin is the arming threshold — a drag that stops short
 * must do *nothing*, the property that makes an accidental pull free to abandon
 * — and the gate on which messages offer the gesture at all.
 *
 * Firing one needs no drag simulator. `react-native-gesture-handler` puts the
 * raw `onGestureHandlerEvent` / `onGestureHandlerStateChange` props on the view
 * under the handler, so a test can post the events the native side would, and
 * `SwipeToReply` puts a per-message `testID` on that view so a suite can aim at
 * one bubble — a drag has no accessible name to query by.
 */

/**
 * Drag a message right by `distance` points past the point the pan took over,
 * and let go.
 *
 * The `ACTIVE` event first is the real sequence, not ceremony: a pan reports
 * `translationX` from *touch-down*, so it has already travelled the activation
 * slop by the time the gesture is a swipe at all, and `SwipeToReply` subtracts
 * where it was when it activated. Sending the transition is what exercises
 * that; `START` is arbitrary precisely because the component reads it off the
 * event rather than assuming a constant.
 *
 * **The redraw first is a Jest artefact, not a user step.** The handler stamps
 * its `handlerTag` onto the view at *render* time but is only assigned one when
 * it *mounts*, and it drops every event whose tag doesn't match — so on a tree
 * that has rendered exactly once, the view advertises `-1` and swallows
 * everything sent to it. Any later render publishes the real tag. On a device
 * this can't bite (a screen that has never re-rendered has also never been
 * touched); here it would quietly turn every assertion below into a test of
 * nothing, which is why the pair of pulls in one test matters — a short pull
 * and a long one through the same helper can't both be swallowed and still
 * disagree.
 */
const START = 30;

async function swipeMessage(messageId: number, distance: number) {
  await redrawScreen?.();
  const row = screen.getByTestId(`swipe-to-reply-${messageId}`);
  const { handlerTag } = row.props;
  await fireEvent(row, 'gestureHandlerStateChange', {
    nativeEvent: {
      handlerTag,
      oldState: State.BEGAN,
      state: State.ACTIVE,
      translationX: START,
    },
  });
  await fireEvent(row, 'gestureHandlerEvent', {
    nativeEvent: {
      handlerTag,
      state: State.ACTIVE,
      translationX: START + distance,
    },
  });
  await fireEvent(row, 'gestureHandlerStateChange', {
    nativeEvent: {
      handlerTag,
      oldState: State.ACTIVE,
      state: State.END,
      translationX: START + distance,
    },
  });
}

it('swiping a message right opens its strand, ready to reply', async () => {
  const only = message({ id: 8, sender: ADA, text: 'dinner at 7?' });
  serve({ conversation: detail({}), messages: [only], thread: [only] });

  await renderScreen();
  await screen.findByLabelText('Message from Ada Lovelace: dinner at 7?');

  // Half a pull first: far enough to move the bubble and show the arrow, not
  // far enough to arm. Nothing happens *during* a drag, which is the whole
  // reason a gesture this easy to start by accident is safe to have.
  //
  // 40 is picked against `START`: under the trigger on its own, over it if the
  // travel *before* activation were counted too — so this fails as well if the
  // bubble ever goes back to measuring from touch-down.
  await swipeMessage(8, 40);
  expect(screen.queryByLabelText('Reply to thread')).toBeNull();

  await swipeMessage(8, 90);

  // Past the line it lands where the menu's Reply lands — keyboard up, aimed at
  // message 8. One destination, two ways in.
  const input = await screen.findByLabelText('Reply to thread');
  expect(input.props.autoFocus).toBe(true);

  await fireEvent.changeText(input, 'yes, see you');
  await fireEvent.press(screen.getByLabelText('Send reply'));

  await waitFor(() => expect(sendCalls()).toEqual([['yes, see you', 8]]));
});

it('refuses the swipe on a message there is no replying to', async () => {
  // A read-only thread would refuse the send and a tombstone has nothing to
  // answer, so neither gets a gesture that could only end in an error or an
  // empty strand — the same gate Reply has in the menu. The handler stays in
  // the tree but is switched off, which is what stops select mode remounting
  // every bubble on screen; `enabled` is the half a device obeys, and the
  // swipe below is the half a test can prove.
  serve({
    conversation: detail({ can_send: false }),
    messages: [
      message({ id: 8, sender: ADA, text: 'dinner at 7?' }),
      message({ id: 9, sender: ADA, text: '', is_deleted: true }),
    ],
  });

  await renderScreen();
  await screen.findByLabelText('Message from Ada Lovelace: dinner at 7?');

  expect(screen.getByTestId('swipe-to-reply-8').props.enabled).toBe(false);
  expect(screen.getByTestId('swipe-to-reply-9').props.enabled).toBe(false);

  await swipeMessage(8, 90);
  expect(screen.queryByLabelText('Reply to thread')).toBeNull();
});

it('drops the swipe while a selection is on', async () => {
  // A drag across the list while selecting is how you get to the next message
  // you want, and a swipe that yanked you into a strand would take the ticks
  // you had gathered with it. Select mode suspends the gesture, exactly as it
  // suspends the strand-edge tap.
  const only = message({ id: 8, sender: ADA, text: 'dinner at 7?' });
  serve({ conversation: detail({}), messages: [only], thread: [only] });

  await renderScreen();
  expect((await screen.findByTestId('swipe-to-reply-8')).props.enabled).toBe(true);

  await openMenu('Message from Ada Lovelace: dinner at 7?');
  await fireEvent.press(screen.getByLabelText('Select'));

  expect(screen.getByTestId('swipe-to-reply-8').props.enabled).toBe(false);
  await swipeMessage(8, 90);
  expect(screen.queryByLabelText('Reply to thread')).toBeNull();
});

/**
 * The strand hides the transcript on Android too (Phase 10).
 *
 * `expo-blur` is iOS-first: on Android it paints a flat translucent tint, and
 * real blur needs a `<BlurTargetView>` in the same window — which a `Modal`
 * isn't. So the strand sat over a fully legible transcript and the two
 * conversations' text overlapped. The wash is what covers for the missing blur,
 * and this is the assertion that keeps the two platforms' values from being
 * "tidied" back into one.
 *
 * Runs on both platforms because the iOS half is the other side of the same
 * decision: a blurred transcript should still show through.
 *
 * Asserted as a *threshold* rather than the exact rgba, so that tuning the wash
 * against a real screen doesn't fail a test with nothing to say — only losing
 * the platform split does, which is the thing worth defending.
 */
it(`washes the transcript out enough to read the strand on ${Platform.OS}`, async () => {
  const only = message({ id: 8, sender: ADA, text: 'dinner at 7?' });
  serve({
    conversation: detail({}),
    messages: [only],
    thread: [only],
  });

  await renderScreen();
  await openMenu('Message from Ada Lovelace: dinner at 7?');
  await fireEvent.press(screen.getByLabelText('Reply'));
  await screen.findByText('Thread');

  const wash = StyleSheet.flatten(screen.getByTestId('thread-wash').props.style);
  const alpha = Number(
    /rgba\([^)]*,\s*([\d.]+)\)/.exec(String(wash.backgroundColor))?.[1]
  );
  if (Platform.OS === 'android') {
    // Near-solid: the blur that would have destroyed the detail behind it
    // doesn't exist here, so the wash has to. Anything much below this and the
    // transcript is legible through it again.
    expect(alpha).toBeGreaterThanOrEqual(0.9);
  } else {
    // Light, because the blur underneath is doing the rest — a wash this heavy
    // on iOS would hide the blurred conversation the design is keeping.
    expect(alpha).toBeLessThanOrEqual(0.6);
  }
});

/**
 * The strand opens at its newest reply, a frame late if that's what it takes
 * (Phase 10).
 *
 * `scrollToEnd` is a command to the *native* list. On Android it arrives before
 * the new content height has been committed, so it scrolls to a bottom that is
 * still the old one — 0, on a strand that has just opened — and the next event
 * is a `layout` rather than a content size, so nothing corrects it. The strand
 * sat at the root with its newest replies under the composer.
 *
 * The fix is the deferred second call, so that's what this pins: a `scrollToEnd`
 * that happens *after* a frame. Asserting merely that it was called would pass
 * against the broken version, which called it too — just too early.
 */
it('scrolls the strand to its end again a frame after the content lands', async () => {
  const scrollToEnd = jest
    .spyOn(FlatList.prototype, 'scrollToEnd')
    .mockImplementation(() => {});
  const frames: FrameRequestCallback[] = [];
  const raf = jest
    .spyOn(global, 'requestAnimationFrame')
    .mockImplementation((cb) => {
      frames.push(cb);
      return 0;
    });
  try {
    const only = message({ id: 8, sender: ADA, text: 'dinner at 7?' });
    serve({
      conversation: detail({}),
      messages: [only],
      thread: [only],
    });

    await renderScreen();
    await openMenu('Message from Ada Lovelace: dinner at 7?');
    await fireEvent.press(screen.getByLabelText('Reply'));
    await screen.findByText('Thread');
    // The list, not the spinner it replaces once the strand's first page lands.
    const strand = await screen.findByTestId('strand');

    // Cleared here, not at the top: both spies are global — one is on
    // `FlatList.prototype`, which the transcript's list shares — so anything
    // either of them caught while the screen mounted belongs to something else.
    // From this line on, every call is one this handler made.
    scrollToEnd.mockClear();
    frames.length = 0;

    // Driven by hand: there's no native layout under the test renderer, so the
    // list never measures itself and the event this all hangs off never fires
    // on its own.
    await act(async () => {
      strand.props.onContentSizeChange(400, 800);
    });

    // Nothing has run the frame yet, so this is the scroll the strand asked for
    // synchronously — the one Android drops on the floor.
    expect(scrollToEnd).toHaveBeenCalledTimes(1);
    expect(frames).toHaveLength(1);

    await act(async () => {
      frames.forEach((frame) => frame(0));
    });

    // …and the frame brought the second one, which is the fix.
    expect(scrollToEnd).toHaveBeenCalledTimes(2);
    expect(scrollToEnd).toHaveBeenLastCalledWith({ animated: false });
  } finally {
    raf.mockRestore();
    scrollToEnd.mockRestore();
  }
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

it('keeps a failed reply on screen, with a way to send it again', async () => {
  // The words a person typed are never dropped on their behalf — but since M4
  // they're kept as a *failed bubble in the strand* rather than as text sitting
  // in the composer. That's the better home for two reasons: the bubble is
  // where the failure actually happened, and it still works when two replies
  // are in flight and only one of them fell over. The composer clears, so the
  // same message can't be sent twice by accident.
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

  // The reply is still on screen, in the strand, marked as not sent.
  expect(await screen.findByText('Not sent')).toBeTruthy();
  expect(screen.getAllByText('yes, see you').length).toBeGreaterThan(0);
  expect(screen.getByLabelText('Try sending again')).toBeTruthy();
  // And the composer is empty, so tapping Send again can't duplicate it.
  expect(screen.getByLabelText('Reply to thread').props.value).toBe('');
});

it('sends a failed reply again when you retry it', async () => {
  // Retry is the whole point of keeping the failed bubble — without it the
  // message is preserved but stuck, and the only way out is retyping it.
  const only = message({ id: 8, sender: ADA, text: 'dinner at 7?' });
  serve({ conversation: detail({}), messages: [only], thread: [only] });
  const ok = mockFetch.getMockImplementation()!;
  let failNext = true;
  mockFetch.mockImplementation(async (url: string, init?: { method?: string }) => {
    if (url.includes('/messages/') && init?.method === 'POST' && failNext) {
      failNext = false;
      return jsonResponse({ detail: 'Something went wrong.' }, 500);
    }
    return ok(url, init);
  });

  await renderScreen();
  await openMenu('Message from Ada Lovelace: dinner at 7?');
  await fireEvent.press(screen.getByLabelText('Reply'));
  await fireEvent.changeText(
    await screen.findByLabelText('Reply to thread'),
    'yes, see you'
  );
  await fireEvent.press(screen.getByLabelText('Send reply'));
  await screen.findByText('Not sent');

  await fireEvent.press(screen.getByLabelText('Try sending again'));

  // Two POSTs for one message: the failure and the retry. The second lands, so
  // the failed state clears rather than the bubble sticking around beside a
  // duplicate.
  await waitFor(() => expect(sendCalls()).toHaveLength(2));
  expect(sendCalls()[1]).toEqual(['yes, see you', 8]);
  await waitFor(() => expect(screen.queryByText('Not sent')).toBeNull());
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

it('marks a reply as part of a thread instead of quoting it', async () => {
  serve({
    conversation: detail({}),
    messages: [
      message({ id: 8, sender: ADA, text: 'dinner at 7?', reply_count: 1 }),
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

  // The root said it once and the reply doesn't say it again (M9g). The strand
  // edge is drawn on the bubble, so what a screen reader gets is the hint —
  // the audible half of the same mark.
  expect(screen.getAllByText('dinner at 7?')).toHaveLength(1);
  expect(screen.getByLabelText('Your message: yes').props.accessibilityHint).toBe(
    'Part of a thread. Opens it. Press and hold for message actions'
  );
  // A plain message keeps its inert tap, and says so.
  expect(
    screen.getByLabelText('Message from Ada Lovelace: dinner at 7?').props
      .accessibilityHint
  ).toBe('Press and hold for message actions');
});

it('draws a reply without asking the server what it answers', async () => {
  // 🔒 The transcript used to resolve every quote by id through the clipped
  // endpoint (`?ids=`, M5). A bar is drawn from the bare `{ id }` the reply
  // already carries, so the one request that could ever have surfaced a clipped
  // body is no longer made — the leak is now structurally impossible here
  // rather than merely gated. `quotes.ts` still guards the strand's own quotes.
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
    quotable: [message({ id: 8, sender: ADA, text: 'dinner at 7?' })],
  });

  await renderScreen();
  await screen.findByText('still on for that');

  // Given plenty of time to have asked, if it were going to.
  await waitFor(() => expect(transcriptCalls().length).toBeGreaterThan(1), {
    timeout: 15000,
  });
  expect(
    mockFetch.mock.calls.some(([url]) => String(url).includes('?ids='))
  ).toBe(false);
  // And nothing about a message it can't see is on screen, honest or otherwise.
  expect(screen.queryByText('Original message unavailable')).toBeNull();
});

it('draws plain bubbles inside the strand — no quotes, no edges', async () => {
  // Everything in a strand belongs to that strand, so a mark saying so on each
  // bubble would say nothing, and a quote would repeat words that are already
  // on screen a few rows up. What you're answering is named above the composer
  // instead, and only when it isn't the root.
  const root = message({
    id: 8,
    sender: ADA,
    text: 'dinner at 7?',
    reply_count: 2,
  });
  const answered = message({
    id: 9,
    sender: GRACE,
    text: 'or 8 if easier',
    reply_to: { id: 8 },
    thread_root_id: 8,
  });
  // Answers a message that isn't in the strand and never will be.
  const orphan = message({
    id: 10,
    sender: GRACE,
    text: 'still on for that',
    reply_to: { id: 7 },
    thread_root_id: 8,
  });
  serve({
    conversation: detail({}),
    messages: [root, answered, orphan],
    thread: [root, answered, orphan],
  });

  await renderScreen();
  await fireEvent.press(
    await screen.findByLabelText('Message from Grace Hopper: or 8 if easier')
  );

  // Exactly one "dinner at 7?" on screen — the root's own bubble in the
  // transcript behind the blur. The strand opens at its newest reply, so its
  // head is scrolled above the fold, and **no reply repeats it**: before M9g
  // every visible reply in here carried it again as a quote.
  await screen.findByText('Thread');
  await waitFor(() =>
    expect(screen.getAllByText('dinner at 7?')).toHaveLength(1)
  );
  // Nothing announces a message the viewer can't see, either: the reply to a
  // clipped message is just a bubble.
  expect(screen.queryByText('Original message unavailable')).toBeNull();
  expect(screen.getByText('still on for that')).toBeTruthy();
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

it('stops a strand’s page walk when a page fails, instead of looping on it', async () => {
  const root = message({
    id: 8,
    sender: ADA,
    text: 'dinner at 7?',
    reply_count: 21,
  });
  serve({
    conversation: detail({}),
    messages: [root],
    thread: [
      root,
      message({ id: 9, sender: MINE, text: 'yes', reply_to: { id: 8 }, thread_root_id: 8 }),
    ],
    threadPageTwoFails: true,
  });

  await renderScreen();
  await fireEvent.press(await screen.findByLabelText('21 replies — open thread'));

  // What did load stays readable, and the gap is named at the end it's at:
  // pages run oldest-first, so a failed page two is the *newest* replies
  // missing — while the root's count goes on claiming 21.
  expect(await screen.findByText('yes')).toBeTruthy();
  expect(await screen.findByText('Couldn’t load the newest replies.')).toBeTruthy();

  // #248, the worst of the three: this query polls and the strand is a Modal
  // that stays mounted, so a loop here ran for the whole time the strand was
  // open, against a server that had just failed.
  await settle();
  expect(
    mockFetch.mock.calls.filter(
      ([url]) =>
        String(url).includes('thread_root=8') && String(url).includes('page=2')
    )
  ).toHaveLength(1);
});

it('doesn’t blame permissions for a strand the network failed to fetch', async () => {
  // The two failure lines have to stay distinguishable, and an unsent reply is
  // what makes them collide: the strand's list counts outbox entries, so one
  // queued against a strand that never loaded stops the list being *empty* —
  // and both the "no root" header and the empty state key off that. A missing
  // root is a claim about permission, and the flag is sticky since #248, so
  // without the guard the phone would go on telling you you're not entitled to
  // a message it merely failed to fetch.
  const only = message({ id: 8, sender: ADA, text: 'dinner at 7?' });
  serve({ conversation: detail({}), messages: [only], threadFails: true });
  const base = mockFetch.getMockImplementation()!;
  mockFetch.mockImplementation(async (url: string, init?: { method?: string }) => {
    // The reply fails too, so it stays an outbox entry rather than being
    // written into the strand's cache (which would clear the error with it).
    if (url.includes('/messages/') && init?.method === 'POST') {
      return jsonResponse({ detail: 'Nope.' }, 500);
    }
    return base(url, init);
  });

  await renderScreen();
  await openMenu('Message from Ada Lovelace: dinner at 7?');
  await fireEvent.press(screen.getByLabelText('Reply'));

  // Nothing loaded, nothing queued: the empty state carries the line.
  expect(
    await screen.findByText('Couldn’t load this thread. Close and try again.')
  ).toBeTruthy();

  await fireEvent.changeText(
    await screen.findByLabelText('Reply to thread'),
    'yes, see you'
  );
  await fireEvent.press(screen.getByLabelText('Send reply'));
  await screen.findByText('Not sent');

  // Still the load failure, and still only that.
  expect(
    screen.getByText('Couldn’t load this thread. Close and try again.')
  ).toBeTruthy();
  expect(screen.queryByText('Couldn’t load the newest replies.')).toBeNull();
  expect(
    screen.queryByText('The start of this thread isn’t available to you')
  ).toBeNull();
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

it('keeps a sent reply in the strand while its refetch is still coming', async () => {
  // The transcript writes an accepted message straight into its cache so the
  // bubble doesn't blink out between the response landing and the refetch
  // returning. The strand reads a *different* query, so it needs the same write
  // or it gets exactly the flicker the transcript was careful to avoid — the
  // reply vanishing from the view you sent it from.
  const root = message({ id: 8, sender: ADA, text: 'dinner at 7?', reply_count: 1 });
  serve({ conversation: detail({}), messages: [root], thread: [root] });
  const base = mockFetch.getMockImplementation()!;
  let posted = false;
  let release: () => void = () => {};
  const refetch = new Promise<void>((resolve) => {
    release = resolve;
  });
  mockFetch.mockImplementation(
    async (url: string, init?: { method?: string; body?: string }) => {
      // Hold the strand's refetch open once the send has landed, so the window
      // this test is about is observable rather than a single frame.
      if (url.includes('thread_root=') && posted) await refetch;
      if (url.includes('/messages/') && init?.method === 'POST') {
        posted = true;
        // Echoing the text and the strand it was flattened into, as the real
        // endpoint does — the default mock answers with neither, and
        // `thread_root_id` is what tells the screen which strand to write to.
        return jsonResponse(
          message({
            id: 99,
            sender: MINE,
            text: JSON.parse(init.body ?? '{}').text,
            reply_to: { id: 8 },
            thread_root_id: 8,
          })
        );
      }
      return base(url, init);
    }
  );

  await renderScreen();
  await fireEvent.press(await screen.findByLabelText('1 reply — open thread'));
  await screen.findByText('Thread');
  await fireEvent.changeText(screen.getByLabelText('Reply to thread'), 'perfect');
  await fireEvent.press(screen.getByLabelText('Send reply'));

  // The outbox entry is gone by now (the send succeeded) and the strand's own
  // data hasn't come back, so what's on screen is the cache write under test.
  await waitFor(() => expect(sendCalls()).toEqual([['perfect', 8]]));
  expect(await screen.findByText('perfect')).toBeTruthy();

  release();
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
    // Zero, because a reply is not a root — which is exactly why the reply
    // itself has to be the way in here. With the root clipped away there's no
    // bubble left in the transcript to carry a reply count.
    reply_count: 0,
  });
  serve({
    conversation: detail({}),
    // The transcript shows the reply but never the root.
    messages: [reply],
    thread: [reply],
  });

  await renderScreen();
  // 🔒 The reply itself is the way in, and it names nothing on the way: the
  // bar says "part of a thread" and stops there. Otherwise a group member who
  // joined, posted and left inside your gap would reach you here — through the
  // one affordance that used to carry a name for a message you can't see.
  await fireEvent.press(
    await screen.findByLabelText('Message from Ada Lovelace: still on for that')
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
  // Page one is still on screen — this pages the strand, it doesn't replace one
  // window with another.
  //
  // Asserted on the oldest reply rather than on the root's text: until M9g every
  // reply quoted the root, so counting "dinner at 7?" counted quote blocks, not
  // the strand's own head. With the quotes gone the root's words appear once,
  // which proves nothing about paging.
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

/**
 * Nothing takes the locked panel off screen while its Connect is out (#259).
 *
 * The panel's error line is the only renderer of a refused connect, and both
 * ways out unmount it: the screen's "← Back" (and Android's hardware back,
 * which reads the same declaration) and the panel's own Decline / Leave. Walk
 * away first and you believe you're waiting on them to accept — you're not in
 * anyone's inbox, and the chat stays locked with no explanation.
 */
describe('holding the locked chat panel while a connect is out', () => {
  const REFUSAL = 'You can’t connect with this person.';

  async function startConnecting() {
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
    const server = holdRequest(mockFetch, { detail: REFUSAL }, 400);
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Connect with Ada Lovelace'));
    });
    await settle(1);
    return server;
  }

  it('refuses the header’s Back, then shows the refusal', async () => {
    const server = await startConnecting();

    await fireEvent.press(screen.getByLabelText('Back'));
    expect(mockBack).not.toHaveBeenCalled();

    await server.refuse();
    expect(await screen.findByText(REFUSAL)).toBeTruthy();
  });

  it('refuses Decline / Leave, whose answer would outlive this chat', async () => {
    // Held where the web deliberately leaves its Leave controls open, and the
    // difference is what the pending write is *about*: a connection request
    // changes a relationship that outlives the conversation.
    const server = await startConnecting();

    await fireEvent.press(screen.getByText('Decline / Leave'));
    expect(
      mockFetch.mock.calls.some(([url]) => String(url).includes('/leave/'))
    ).toBe(false);

    await server.refuse();
    expect(await screen.findByText(REFUSAL)).toBeTruthy();
  });

  /**
   * Issue #238 — Decline had no error path of its own. `onLeave()` runs only on
   * success, so a refused decline put the button back from "Leaving…" to
   * "Decline / Leave" and left the invite in your list the next time you opened
   * Messages, with nothing to say it hadn't worked.
   *
   * Reported through an `Alert`, not the inline line the Connect uses: the line
   * is what the Connect needs a *hold* for, and a native dialog needs neither
   * because it outlives the panel.
   */
  it('says so when Decline / Leave is itself refused', async () => {
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    serve({
      conversation: detail({
        kind: 'group',
        my_status: 'pending',
        can_send: false,
        must_connect_with: [ADA],
      }),
    });

    await renderScreen();
    await screen.findByText('Decline / Leave');
    mockFetch.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      return jsonResponse({ detail: 'You’re no longer in this chat.' }, 403);
    });
    await fireEvent.press(screen.getByText('Decline / Leave'));

    await waitFor(() =>
      expect(alertSpy).toHaveBeenCalledWith(
        'Couldn’t leave this chat',
        'You’re no longer in this chat.'
      )
    );
    alertSpy.mockRestore();
  });

  androidIt('refuses hardware back, then shows the refusal', async () => {
    captureBackHandler();
    const server = await startConnecting();

    await act(async () => {
      // Claimed, not passed on: falling through would pop the screen.
      expect(pressBack()).toBe(true);
    });

    await server.refuse();
    expect(await screen.findByText(REFUSAL)).toBeTruthy();
  });
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

/* ---- Thread mechanics (Phase 9b M5) -------------------------------------- */

/** Every GET of the transcript, as the URLs they were fetched with. */
function transcriptCalls() {
  return mockFetch.mock.calls
    .filter(
      ([url, init]) =>
        String(url).includes('/api/conversations/5/messages/') &&
        String(url).includes('order=desc') &&
        (init?.method ?? 'GET') === 'GET'
    )
    .map(([url]) => String(url));
}

/** A long thread, oldest-first, so paging is more than one page deep. */
function longThread(count: number) {
  return Array.from({ length: count }, (_, index) =>
    message({
      id: index + 1,
      sender: index % 2 === 0 ? ADA : MINE,
      text: `Message ${index + 1}`,
    })
  );
}

/**
 * Scroll the transcript. `y` is distance from the newest — the list is inverted.
 *
 * The layout and content-size events come first because `VirtualizedList` learns
 * its metrics only from events, and under Node nothing measures itself: a bare
 * scroll arrives at a list that believes it is zero pixels tall, and the
 * `onEndReached` guard bails before it looks at anything.
 */
async function scrollTranscript(y: number) {
  const list = screen.getByTestId('transcript');
  await fireEvent(list, 'layout', {
    nativeEvent: { layout: { height: 800, width: 400, x: 0, y: 0 } },
  });
  await fireEvent(list, 'contentSizeChange', 400, 2000);
  await fireEvent.scroll(list, {
    nativeEvent: {
      contentOffset: { y, x: 0 },
      contentSize: { height: 2000, width: 400 },
      layoutMeasurement: { height: 800, width: 400 },
    },
  });
}

it('opens on one page instead of loading the whole history', async () => {
  // The defect M5 exists for. The screen used to walk `fetchNextPage` in an
  // effect until every page was in memory, so opening a chat pulled all of it —
  // invisible at today's volumes and worse every month.
  serve({ conversation: detail({}), messages: longThread(45) });

  await renderScreen();
  // The newest is on screen (`?order=desc` puts it on page one)…
  expect(await screen.findByText('Message 45')).toBeTruthy();

  // …and nothing has asked for a second page.
  expect(transcriptCalls().some((url) => url.includes('page='))).toBe(false);
  expect(screen.queryByText('Message 1')).toBeNull();
});

it('pages older messages in when you reach the top', async () => {
  /**
   * Served in pages of **four**, not the real endpoint's twenty, and that isn't
   * laziness about the fixture. `VirtualizedList` only fires `onEndReached` once
   * the last cell has actually been laid out
   * (`cellsAroundViewport.last === count - 1`) — and under Node nothing lays
   * anything out, so that stays wherever `initialNumToRender` (10) left it. A
   * first page of twenty bubbles is therefore permanently "not at the end" and
   * no sequence of synthetic scrolls can reach it.
   *
   * A short page keeps the row count inside that window, which lets the *real*
   * trigger be exercised — a scroll, through the list's own edge detection —
   * rather than the handler being called by hand. What's under test is that
   * reaching the top follows `next` and puts older messages on screen; the
   * server's page size is not part of that.
   */
  const all = longThread(9);
  serve({ conversation: detail({}), messages: all });
  const base = mockFetch.getMockImplementation()!;
  mockFetch.mockImplementation(async (url: string, init?: { method?: string }) => {
    if (url.includes('order=desc') && (init?.method ?? 'GET') === 'GET') {
      const newestFirst = [...all].reverse();
      const page = Number(url.match(/[?&]page=(\d+)/)?.[1] ?? 1);
      const results = newestFirst.slice((page - 1) * 4, page * 4);
      const stripped = url.replace(/[?&]page=\d+/, '');
      return jsonResponse({
        count: all.length,
        next:
          all.length > page * 4 ? `${stripped}&page=${page + 1}` : null,
        previous: null,
        results,
      });
    }
    return base(url, init);
  });

  /**
   * Rendered **twice against one query client**, which is the other half of
   * making this reachable. `VirtualizedList` decides how many cells exist at
   * construction and `_constrainToItemCount` only ever shrinks that afterwards,
   * so a list that mounts empty — as it does on a cold thread, while the query
   * is still in flight — sits at "no cells" forever under Node and can never
   * report having reached its end. Warming the cache first means the second
   * mount has its rows from the first frame, exactly as a real list does once
   * it has laid itself out.
   */
  const client = warmClient();
  const cold = await renderScreen(client);
  await screen.findByText('Message 9');
  cold.unmount();
  await renderScreen(client);
  await screen.findByText('Message 9');
  // Page one only: the four newest, and nothing older.
  expect(screen.queryByText('Message 5')).toBeNull();

  // The "end" of an inverted list is the top of the history.
  await scrollTranscript(1900);

  await waitFor(() =>
    expect(transcriptCalls().some((url) => url.includes('page=2'))).toBe(true)
  );
  expect(await screen.findByText('Message 5')).toBeTruthy();
});

it('separates the days and shows a clock time, not "5m ago"', async () => {
  // A chat's bubbles answer *when in the day*; the separator above them answers
  // which day. Relative time stays on the conversation list, where the question
  // really is how recent something is.
  serve({
    conversation: detail({}),
    messages: [
      message({ id: 1, sender: ADA, text: 'yesterday', created_at: yesterday() }),
      message({ id: 2, sender: ADA, text: 'today', created_at: todayAt(14, 32) }),
    ],
  });

  await renderScreen();
  await screen.findByText('today');

  // The label is uppercased with `textTransform`, which is a style — the text
  // node itself still reads "Today".
  expect(screen.getByText('Today')).toBeTruthy();
  expect(screen.getByText('Yesterday')).toBeTruthy();
  // 24-hour or 12-hour depending on the runner's locale — both are a clock, and
  // neither is "just now", which is what this replaced.
  expect(screen.getByText(/^(14:32|2:32 pm)$/)).toBeTruthy();
});

it('times a run once, on its last bubble', async () => {
  // The whole point of grouping. A timestamp repeated down five bubbles sent in
  // one minute is noise standing where the next message should be.
  serve({
    conversation: detail({}),
    messages: [
      message({ id: 1, sender: ADA, text: 'one', created_at: todayAt(9, 0) }),
      message({ id: 2, sender: ADA, text: 'two', created_at: todayAt(9, 1) }),
      message({ id: 3, sender: ADA, text: 'three', created_at: todayAt(9, 2) }),
    ],
  });

  await renderScreen();
  await screen.findByText('three');

  expect(screen.queryByText(/^(09:00|9:00 am)$/)).toBeNull();
  expect(screen.queryByText(/^(09:01|9:01 am)$/)).toBeNull();
  expect(screen.getByText(/^(09:02|9:02 am)$/)).toBeTruthy();
});

it('keeps the "Edited" marker on a bubble in the middle of a run', async () => {
  // 🔒 Not a tidy-up. `messaging.md` calls the marker the thing that makes
  // editing safe at all — a thread is a shared record, and an edit that showed
  // no trace would let either side change what the other already read. It
  // cannot be suppressed by where a bubble happens to sit in a run.
  serve({
    conversation: detail({}),
    messages: [
      message({
        id: 1,
        sender: ADA,
        text: 'corrected',
        created_at: todayAt(9, 0),
        is_edited: true,
        edited_at: todayAt(9, 1),
      }),
      message({ id: 2, sender: ADA, text: 'and then', created_at: todayAt(9, 2) }),
    ],
  });

  await renderScreen();
  await screen.findByText('and then');

  expect(screen.getByText(/· Edited$/)).toBeTruthy();
});

it('marks where you stopped reading', async () => {
  serve({
    conversation: detail({ unread_count: 2 }),
    messages: [
      message({ id: 1, sender: ADA, text: 'read this one' }),
      message({ id: 2, sender: ADA, text: 'missed this one' }),
      message({ id: 3, sender: ADA, text: 'and this one' }),
    ],
  });

  await renderScreen();

  expect(await screen.findByText('2 unread messages')).toBeTruthy();
});

it('keeps the unread divider after the thread is marked read', async () => {
  // The divider is captured once, before the mark-read write lands — otherwise
  // it would appear and then vanish a moment later, which is worse than never
  // showing it. The two race on open, which is why the read POST waits for the
  // detail.
  serve({
    conversation: detail({ unread_count: 1 }),
    messages: [message({ id: 1, sender: ADA, text: 'missed this one' })],
  });

  await renderScreen();
  await screen.findByText('1 unread message');

  // The mark-read has gone out by now; the divider stays for as long as you're
  // on the screen.
  await waitFor(() =>
    expect(
      mockFetch.mock.calls.some(([url]) => String(url).includes('/read/'))
    ).toBe(true)
  );
  expect(screen.getByText('1 unread message')).toBeTruthy();
});

it('keeps the divider where you stopped, not where the newest message is', async () => {
  // The divider is placed by counting back from the newest message, and the
  // newest message keeps changing — so the *count* being captured on open isn't
  // enough on its own. Left live, every message that arrives while you're
  // reading pushes a fixed count one further down and slides the marker past the
  // very messages it was put there to mark.
  const messages = [
    message({ id: 1, sender: ADA, text: 'read this one' }),
    message({ id: 2, sender: ADA, text: 'missed this one' }),
    message({ id: 3, sender: ADA, text: 'and this one' }),
  ];
  serve({ conversation: detail({ unread_count: 2 }), messages });

  await renderScreen();
  await screen.findByText('2 unread messages');

  // Someone sends another one while you're reading. The mock serves from the
  // array, so pushing to it is what the next poll finds.
  messages.push(message({ id: 4, sender: ADA, text: 'newly arrived' }));
  await waitFor(() => expect(screen.getByText('newly arrived')).toBeTruthy(), {
    timeout: 15000,
  });

  // Rendered order is the list's own — newest first, since it's inverted — so
  // this is where the divider *sits*, which is the whole assertion. It belongs
  // above "missed this one", the oldest message you hadn't read on open.
  const order = screen
    .getAllByText(
      /^(newly arrived|and this one|missed this one|read this one|2 unread messages)$/
    )
    .map((node) => node.props.children);
  expect(order).toEqual([
    'newly arrived',
    'and this one',
    'missed this one',
    '2 unread messages',
    'read this one',
  ]);
});

it('opens the thread at the unread divider rather than at the bottom', async () => {
  // What the divider is for: a marker you have to go and find is decoration.
  const scrollToIndex = jest
    .spyOn(FlatList.prototype, 'scrollToIndex')
    .mockImplementation(() => {});
  try {
    serve({
      conversation: detail({ unread_count: 2 }),
      messages: [
        message({ id: 1, sender: ADA, text: 'read this one' }),
        message({ id: 2, sender: ADA, text: 'missed this one' }),
        message({ id: 3, sender: ADA, text: 'and this one' }),
      ],
    });

    await renderScreen();
    await screen.findByText('2 unread messages');

    // Rows newest-first: [3, 2, divider, 1, day separator]. `viewPosition: 1` is
    // the top of the screen on an inverted list, so the divider goes up there
    // and the unread messages fill in beneath it.
    await waitFor(() =>
      expect(scrollToIndex).toHaveBeenCalledWith({
        index: 2,
        viewPosition: 1,
        animated: false,
      })
    );
  } finally {
    scrollToIndex.mockRestore();
  }
});

it('leaves a thread with nothing unread at the bottom, where it opened', async () => {
  const scrollToIndex = jest
    .spyOn(FlatList.prototype, 'scrollToIndex')
    .mockImplementation(() => {});
  try {
    serve({ conversation: detail({ unread_count: 0 }), messages: longThread(6) });

    await renderScreen();
    await screen.findByText('Message 6');

    expect(scrollToIndex).not.toHaveBeenCalled();
  } finally {
    scrollToIndex.mockRestore();
  }
});

it('offers a jump back to the latest once you’ve scrolled away', async () => {
  serve({ conversation: detail({}), messages: longThread(10) });

  await renderScreen();
  await screen.findByText('Message 10');
  expect(screen.queryByLabelText(/^Jump to latest/)).toBeNull();

  await scrollTranscript(600);
  expect(await screen.findByLabelText(/^Jump to latest/)).toBeTruthy();

  // And it goes again once you're back at the bottom, rather than sitting there
  // permanently — a control that's always there is one nobody reads.
  await scrollTranscript(0);
  await waitFor(() =>
    expect(screen.queryByLabelText(/^Jump to latest/)).toBeNull()
  );
});

it('opens a link in the message instead of leaving it as dead text', async () => {
  // The cheapest "this feels broken" fix in the phase: a link someone sent used
  // to be text you had to retype by hand.
  const openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
  serve({
    conversation: detail({}),
    messages: [
      message({ id: 1, sender: ADA, text: 'recipe here https://example.com/x' }),
    ],
  });

  await renderScreen();
  await fireEvent.press(await screen.findByText('https://example.com/x'));

  expect(openURL).toHaveBeenCalledWith('https://example.com/x');
  openURL.mockRestore();
});

it('keeps a half-written message when you leave the thread and come back', async () => {
  // The composer's text used to die with the screen, so the most ordinary
  // navigation in the app silently ate a draft.
  serve({ conversation: detail({}), messages: [message({ id: 1 })] });

  const first = await renderScreen();
  await fireEvent.changeText(
    await screen.findByLabelText('Message'),
    'half-written thought'
  );
  first.unmount();

  await renderScreen();
  expect((await screen.findByLabelText('Message')).props.value).toBe(
    'half-written thought'
  );
});

it('does not leave a message you were editing sitting in the composer', async () => {
  // The one case the draft store must *not* remember: in edit mode the composer
  // holds someone's sent words, not a draft of yours. Persisting them would mean
  // coming back to a message you never wrote.
  serve({
    conversation: detail({}),
    messages: [message({ id: 7, sender: MINE, text: 'teh quick fox' })],
  });

  const first = await renderScreen();
  await fireEvent.changeText(
    await screen.findByLabelText('Message'),
    'half-written thought'
  );
  await openMenu('Your message: teh quick fox');
  await fireEvent.press(screen.getByLabelText('Edit'));
  expect(screen.getByLabelText('Message').props.value).toBe('teh quick fox');
  first.unmount();

  await renderScreen();
  expect((await screen.findByLabelText('Message')).props.value).toBe(
    'half-written thought'
  );
});

/* --- Photo messages (Phase 9b M7) ----------------------------------------- */

it('sends a photo picked from the library, prepared on the phone', async () => {
  serve({ conversation: detail({}), messages: [message({ id: 1 })] });
  pickFromLibrary.mockResolvedValue(PICKED);

  await renderScreen();
  // Not awaited: the press doesn't settle until the sheet is answered.
  fireEvent.press(await screen.findByLabelText('Add a photo'));
  await choosePhotoSource('Choose from Library');
  // The prepared thumbnail sits on the composer until you send it, so you can
  // see what you're about to send and back out of it.
  await screen.findByLabelText('Remove photo');
  await fireEvent.press(screen.getByLabelText('Send'));

  await waitFor(() => {
    const send = mockFetch.mock.calls.find(
      ([url, init]) =>
        String(url).includes('/api/conversations/5/messages/') &&
        init?.method === 'POST'
    );
    expect(send).toBeDefined();
    // 🔒 Multipart rather than JSON, which is the observable sign the photo went
    // with it. **The file is the prepared one, never the camera-roll URI** — the
    // server doesn't open a chat attachment (it can't, once these are
    // ciphertext), so uploading the original would ship its GPS coordinates to
    // everyone in the chat. The exact part names and the prepared filename are
    // pinned in `api.test.ts`, which has the harness to read a FormData's parts.
    expect(send![1].body).toBeInstanceOf(FormData);
    expect(send![1].headers['Content-Type']).toBeUndefined();
  });
});

it('offers the camera as well as the library', async () => {
  // Sending a picture of what's in front of you is half of what a photo in a
  // chat is for; routing people out to the camera app is the friction that makes
  // an app feel like a website.
  serve({ conversation: detail({}), messages: [message({ id: 1 })] });
  takePhoto.mockResolvedValue(PICKED);

  await renderScreen();
  // Not awaited: the press doesn't settle until the sheet is answered.
  fireEvent.press(await screen.findByLabelText('Add a photo'));
  await choosePhotoSource('Take Photo');

  await waitFor(() => expect(takePhoto).toHaveBeenCalled());
  expect(pickFromLibrary).not.toHaveBeenCalled();
});

it('declares the camera permission the camera path needs', () => {
  // 🔒 **The test above cannot catch this and shipped a crash once already.** It
  // mocks `requestCameraPermissionsAsync`, so it passes against a binary that
  // has no camera permission at all — which is exactly what M7 first built.
  //
  // `expo-image-picker`'s config plugin treats `cameraPermission: false` as an
  // instruction to *remove* `NSCameraUsageDescription` from Info.plist and to
  // add `android.permission.CAMERA` to `blockedPermissions`. iOS terminates an
  // app that reaches for the camera with no usage description, so "Take Photo"
  // was a hard crash on a real phone while every Node test stayed green.
  //
  // This asserts the config instead, which is the only thing about it a Node
  // test *can* see. It's a string rather than a boolean because Apple shows it
  // to the person in the permission prompt.
  const config = require('../../app.json');
  const picker = config.expo.plugins.find(
    (plugin: unknown) => Array.isArray(plugin) && plugin[0] === 'expo-image-picker'
  );
  expect(typeof picker[1].cameraPermission).toBe('string');
  expect(picker[1].cameraPermission.length).toBeGreaterThan(0);
});

it('sends a photo with no caption at all', async () => {
  // The rule the server enforces is text *or* a photo, never neither — so Send
  // has to come alive for a photo alone, and an empty composer still must not
  // send anything.
  serve({ conversation: detail({}), messages: [message({ id: 1 })] });
  pickFromLibrary.mockResolvedValue(PICKED);

  await renderScreen();
  const send = await screen.findByLabelText('Send');
  expect(send.props.accessibilityState?.disabled).toBe(true);

  // Not awaited: the press doesn't settle until the sheet is answered.
  fireEvent.press(screen.getByLabelText('Add a photo'));
  await choosePhotoSource('Choose from Library');
  await screen.findByLabelText('Remove photo');

  expect(screen.getByLabelText('Send').props.accessibilityState?.disabled).toBe(
    false
  );
});

it('lets you back out of a photo before sending it', async () => {
  serve({ conversation: detail({}), messages: [message({ id: 1 })] });
  pickFromLibrary.mockResolvedValue(PICKED);

  await renderScreen();
  // Not awaited: the press doesn't settle until the sheet is answered.
  fireEvent.press(await screen.findByLabelText('Add a photo'));
  await choosePhotoSource('Choose from Library');
  await fireEvent.press(await screen.findByLabelText('Remove photo'));

  expect(screen.queryByLabelText('Remove photo')).toBeNull();
  // And Send goes back to inert, because there's nothing left to send.
  expect(screen.getByLabelText('Send').props.accessibilityState?.disabled).toBe(
    true
  );
});

it('won’t let a queued photo turn an emptied edit into a PATCH', async () => {
  // ⚠️ The composer's photo made `!value` false, so the one guard standing in
  // front of *both* modes let an empty edit through — a `PATCH` the server
  // answers "A message can't be empty". A `PATCH` carries text only, so what's
  // queued in the composer has nothing to say about whether an edit does.
  serve({
    conversation: detail({}),
    messages: [message({ id: 7, sender: MINE, text: 'teh plan' })],
  });
  pickFromLibrary.mockResolvedValue(PICKED);

  await renderScreen();
  // Not awaited: the press doesn't settle until the sheet is answered.
  fireEvent.press(await screen.findByLabelText('Add a photo'));
  await choosePhotoSource('Choose from Library');
  await screen.findByLabelText('Remove photo');

  await openMenu('Your message: teh plan');
  await fireEvent.press(screen.getByLabelText('Edit'));
  await fireEvent.changeText(screen.getByLabelText('Message'), '');

  const save = screen.getByLabelText('Save');
  expect(save.props.accessibilityState?.disabled).toBe(true);
  // And pressing it anyway does nothing — `disabled` alone would leave the
  // hardware/keyboard route in.
  await fireEvent.press(save);
  expect(
    mockFetch.mock.calls.some(([, init]) => init?.method === 'PATCH')
  ).toBe(false);
});

it('keeps a queued photo out of sight while you edit, and gives it back after', async () => {
  // The attach *button* was hidden during an edit but the preview wasn't, so the
  // picture sat over the composer looking as though it would go with the edit.
  // Hidden, not dropped: stopping to fix a typo mustn't cost you the photo.
  serve({
    conversation: detail({}),
    messages: [message({ id: 7, sender: MINE, text: 'teh plan' })],
  });
  pickFromLibrary.mockResolvedValue(PICKED);

  await renderScreen();
  // Not awaited: the press doesn't settle until the sheet is answered.
  fireEvent.press(await screen.findByLabelText('Add a photo'));
  await choosePhotoSource('Choose from Library');
  await screen.findByLabelText('Remove photo');

  await openMenu('Your message: teh plan');
  await fireEvent.press(screen.getByLabelText('Edit'));
  expect(screen.queryByLabelText('Remove photo')).toBeNull();

  await fireEvent.press(screen.getByLabelText('Cancel editing'));
  expect(screen.getByLabelText('Remove photo')).toBeTruthy();
});

it('lets a photo message’s caption be edited away, as the server does', async () => {
  // The mirror case on the same line: with nothing queued, `!value` returned
  // early — so the one message you *should* be able to empty was the one you
  // couldn't. A photo with no caption is an ordinary message, and
  // `MessageSerializer.validate` allows exactly this via `has_attachments`; the
  // composer mustn't be stricter than the server.
  serve({
    conversation: detail({}),
    messages: [
      message({ id: 7, sender: MINE, text: 'look', attachments: [photo(9)] }),
    ],
  });

  await renderScreen();
  await openMenu('Your message: look');
  await fireEvent.press(screen.getByLabelText('Edit'));
  await fireEvent.changeText(screen.getByLabelText('Message'), '');

  expect(screen.getByLabelText('Save').props.accessibilityState?.disabled).toBe(
    false
  );
  await fireEvent.press(screen.getByLabelText('Save'));

  await waitFor(() =>
    expect(
      mockFetch.mock.calls.some(
        ([url, init]) =>
          String(url).includes('/api/conversations/5/messages/7/') &&
          init?.method === 'PATCH' &&
          JSON.parse(init.body).text === ''
      )
    ).toBe(true)
  );
});

it('still refuses to empty a text-only message, as the server does', async () => {
  // The other half of the same rule: no photo on the message means an edit needs
  // words. Deleting a message is a different, deliberate action.
  serve({
    conversation: detail({}),
    messages: [message({ id: 7, sender: MINE, text: 'teh plan' })],
  });

  await renderScreen();
  await openMenu('Your message: teh plan');
  await fireEvent.press(screen.getByLabelText('Edit'));
  await fireEvent.changeText(screen.getByLabelText('Message'), '   ');

  const save = screen.getByLabelText('Save');
  expect(save.props.accessibilityState?.disabled).toBe(true);
  await fireEvent.press(save);
  expect(
    mockFetch.mock.calls.some(([, init]) => init?.method === 'PATCH')
  ).toBe(false);
});

it('shows a received photo in the bubble and opens it full-screen', async () => {
  serve({
    conversation: detail({}),
    messages: [message({ id: 1, sender: ADA, text: '', attachments: [photo(9)] })],
  });

  await renderScreen();
  await fireEvent.press(await screen.findByLabelText('Photo, tap to open'));

  await screen.findByLabelText('Close photo viewer');
});

it('offers the action menu on a photo rather than swallowing the long-press', async () => {
  // A photo is its own `Pressable`, so it becomes the touch responder and the
  // bubble's `onLongPress` never sees the gesture. It has to re-offer the
  // gesture itself, or Reply/React/Report are unreachable from a photo message
  // and the hold falls through to `onPress` on release — which opened the
  // lightbox instead of the menu.
  //
  // **Asserted through the hint, not by firing a long-press**, and that's not
  // laziness: RNTL bubbles a `longPress` event up to the nearest ancestor
  // handler, so the menu opens under test whether or not the photo carries its
  // own — the bug reproduces on a device and cannot reproduce here. The hint is
  // rendered only when the handler is wired, so it stands in for the wiring
  // that the responder conflict actually turns on. If you're changing this,
  // verify the gesture on a simulator too; no Node test can cover it.
  serve({
    conversation: detail({}),
    messages: [message({ id: 1, sender: ADA, text: '', attachments: [photo(9)] })],
  });

  await renderScreen();

  const image = await screen.findByLabelText('Photo, tap to open');
  expect(image.props.accessibilityHint).toBe('Press and hold for message actions');
});

it('announces a captionless photo as a photo, not as an empty message', async () => {
  // A bubble with no text would otherwise read out as nothing at all, which is
  // how a screen reader reports "there's nothing here".
  serve({
    conversation: detail({}),
    messages: [message({ id: 1, sender: ADA, text: '', attachments: [photo(9)] })],
  });

  await renderScreen();
  await screen.findByLabelText('Message from Ada Lovelace: Photo');
});

it('offers no attach button while editing a message', async () => {
  // An edit changes the words of something already read; swapping the picture
  // under it isn't something the "Edited" marker can honestly disclose, and the
  // server refuses it.
  serve({
    conversation: detail({}),
    messages: [message({ id: 7, sender: MINE, text: 'mine' })],
  });

  await renderScreen();
  expect(await screen.findByLabelText('Add a photo')).toBeTruthy();

  await openMenu('Your message: mine');
  await fireEvent.press(screen.getByLabelText('Edit'));

  expect(screen.queryByLabelText('Add a photo')).toBeNull();
});

/**
 * @mentions (Phase 9b M8). Three things worth pinning at screen level: the
 * picker appears while you're typing an `@`, choosing someone puts their whole
 * name in and sends their **id**, and a name that got deleted before you hit
 * send isn't sent at all. Everything about *matching* is a string question and
 * lives in `mentions.test.ts`.
 */
function groupWithMentions(messages: Message[] = []) {
  serve({
    conversation: detail({
      kind: 'group',
      other: null,
      title: 'Hikers',
      participants: [
        { ...ADA, status: 'active' },
        { ...GRACE, status: 'active' },
        { id: ME.pk, display_name: ME.display_name, avatar_thumb: null, status: 'active' },
      ],
    }),
    messages,
  });
}

it('offers people to mention and sends the chosen one as an id', async () => {
  groupWithMentions();
  await renderScreen();

  const input = await screen.findByLabelText('Message');
  await fireEvent.changeText(input, 'can @ad');

  // The picker is a strip above the composer, not a modal: you're still writing.
  await fireEvent.press(await screen.findByLabelText('Mention Ada Lovelace'));
  // The half-typed query is replaced by the whole name, so the text says who
  // you meant even for a client that can't resolve the id.
  expect(screen.getByLabelText('Message').props.value).toBe('can @Ada Lovelace ');

  await fireEvent.changeText(
    screen.getByLabelText('Message'),
    'can @Ada Lovelace bring the map?'
  );
  await fireEvent.press(screen.getByLabelText('Send'));

  await waitFor(() => {
    const send = mockFetch.mock.calls.find(
      ([url, init]: [string, { method?: string; body?: string }]) =>
        url.includes('/messages/') && init?.method === 'POST'
    );
    expect(JSON.parse(send[1].body).mention_ids).toEqual([ADA.id]);
  });
});

it('does not name someone whose name was deleted before sending', async () => {
  // Picked, then thought better of it. Sending the id anyway would buzz a muted
  // thread about a message that doesn't mention her — the app talking behind
  // your back.
  groupWithMentions();
  await renderScreen();

  const input = await screen.findByLabelText('Message');
  await fireEvent.changeText(input, '@ad');
  await fireEvent.press(await screen.findByLabelText('Mention Ada Lovelace'));
  await fireEvent.changeText(screen.getByLabelText('Message'), 'never mind');
  await fireEvent.press(screen.getByLabelText('Send'));

  await waitFor(() => {
    const send = mockFetch.mock.calls.find(
      ([url, init]: [string, { method?: string; body?: string }]) =>
        url.includes('/messages/') && init?.method === 'POST'
    );
    expect(JSON.parse(send[1].body).mention_ids).toBeUndefined();
  });
});

it('offers no mention picker in a 1:1', async () => {
  // One person it could mean, so the picker would be ceremony around a word.
  serve({ conversation: detail({}), messages: [] });
  await renderScreen();

  await fireEvent.changeText(await screen.findByLabelText('Message'), '@');

  expect(screen.queryByLabelText('Mention Ada Lovelace')).toBeNull();
});

it('offers no mention picker while editing a message', async () => {
  // An edit carries no `mention_ids`, so a name picked here would notify nobody
  // and wouldn't even highlight — the highlight is driven by the ids, not the
  // words. A picker that silently does nothing is worse than no picker; adding
  // a mention means sending a message.
  groupWithMentions([message({ id: 7, sender: MINE, text: 'mine' })]);
  await renderScreen();

  await openMenu('Your message: mine');
  await fireEvent.press(screen.getByLabelText('Edit'));

  const input = screen.getByLabelText('Message');
  await fireEvent.changeText(input, 'mine @ad');
  // The caret is reported explicitly. Edit mode drops a whole message into the
  // composer without going through `onChangeText`, so the hook's estimate is
  // behind — and a test that skipped this would pass because of *that* rather
  // than because the picker is suppressed, which is no test at all.
  await fireEvent(input, 'selectionChange', {
    nativeEvent: { selection: { start: 8, end: 8 } },
  });

  expect(screen.queryByLabelText('Mention Ada Lovelace')).toBeNull();
});

it('highlights a mention by resolving its id against the participants', async () => {
  // The server sends bare ids — no names, no faces — so the highlight exists
  // only because the client can match an id to someone it already knows about.
  groupWithMentions([
    message({
      id: 1,
      sender: GRACE,
      text: '@Ada Lovelace can you bring the map?',
      mentions: [ADA.id],
    }),
  ]);

  await renderScreen();

  // The name is its own run inside the bubble, split out of the sentence — which
  // is what being styled differently means here.
  expect(await screen.findByText('@Ada Lovelace')).toBeTruthy();
});

/**
 * Multi-select (Phase 9b M8). Deleting a burst one long-press at a time is the
 * irritation this removes, so what's worth pinning is that the mode is
 * reachable, that a tap ticks rather than doing nothing, that Delete acts on
 * everything ticked — and that it isn't offered for someone else's messages,
 * where a bulk action could only ever half-work.
 */
it('ticks a reply rather than opening its strand while selecting', async () => {
  // Select mode has to win the tap on *every* bubble, and a reply is the one
  // that would otherwise have somewhere else to go — its strand edge makes the
  // whole bubble a way into the thread.
  serve({
    conversation: detail({}),
    messages: [
      message({ id: 7, sender: MINE, text: 'one', reply_count: 1 }),
      message({
        id: 8,
        sender: MINE,
        text: 'two',
        reply_to: { id: 7 },
        thread_root_id: 7,
      }),
    ],
  });

  await renderScreen();
  await openMenu('Your message: one');
  await fireEvent.press(screen.getByLabelText('Select'));
  await screen.findByText('1 selected');

  await fireEvent.press(screen.getByLabelText('Your message: two'));

  await screen.findByText('2 selected');
  // Not "Thread": the strand never opened, and nothing was asked for.
  expect(screen.queryByText('Thread')).toBeNull();
  expect(
    mockFetch.mock.calls.some(([url]) => String(url).includes('thread_root='))
  ).toBe(false);
  // The branch into the strand stands down with the tap, the way the long-press
  // menu does — two modes racing for one gesture is what the mode prevents.
  expect(screen.queryByLabelText('1 reply — open thread')).toBeNull();
});

it('ticks an unsent reply too, rather than opening its strand', async () => {
  // The case the first version of this got wrong. A bubble decides it opens a
  // strand from "no tap handler, but a strand handler" — and an unsent message
  // has no tap handler even mid-selection, because it has no server id to tick
  // by. It would have been the one bubble in a selection that opened a Modal.
  serve({
    conversation: detail({}),
    messages: [message({ id: 7, sender: ADA, text: 'dinner at 7?' })],
    thread: [message({ id: 7, sender: ADA, text: 'dinner at 7?' })],
  });
  const base = mockFetch.getMockImplementation()!;
  mockFetch.mockImplementation(async (url: string, init?: { method?: string }) => {
    if (url.includes('/messages/') && init?.method === 'POST') {
      return jsonResponse({ detail: 'Nope.' }, 500);
    }
    return base(url, init);
  });

  await renderScreen();
  await openMenu('Message from Ada Lovelace: dinner at 7?');
  await fireEvent.press(screen.getByLabelText('Reply'));
  await fireEvent.changeText(
    screen.getByLabelText('Reply to thread'),
    'yes please'
  );
  await fireEvent.press(screen.getByLabelText('Send reply'));
  await screen.findByText('Not sent');
  // Two of these are on screen (the scrim and the header button); either closes.
  await fireEvent.press(screen.getAllByLabelText('Close thread')[0]);

  await openMenu('Message from Ada Lovelace: dinner at 7?');
  await fireEvent.press(screen.getByLabelText('Select'));
  await screen.findByText('1 selected');

  // The unsent reply is still on screen, still untickable — and tapping it must
  // do *nothing at all* rather than reopening the strand over the selection.
  await fireEvent.press(screen.getByLabelText('Your message: yes please'));

  expect(screen.getByText('1 selected')).toBeTruthy();
  expect(screen.queryByText('Thread')).toBeNull();
});

it('selects several messages and deletes them in one action', async () => {
  serve({
    conversation: detail({}),
    messages: [
      message({ id: 7, sender: MINE, text: 'one' }),
      message({ id: 8, sender: MINE, text: 'two' }),
    ],
  });

  await renderScreen();
  await openMenu('Your message: one');
  await fireEvent.press(screen.getByLabelText('Select'));

  // The pressed message comes with you — the common case is "this one and the
  // next few", so entering the mode with nothing ticked would waste a tap.
  await screen.findByText('1 selected');
  await fireEvent.press(screen.getByLabelText('Your message: two'));
  await screen.findByText('2 selected');

  const alert = jest.spyOn(Alert, 'alert').mockImplementation(((
    _title: string,
    _message: string | undefined,
    buttons: { text: string; onPress?: () => void }[]
  ) => {
    buttons.find((button) => button.text === 'Delete')?.onPress?.();
  }) as unknown as typeof Alert.alert);

  await fireEvent.press(screen.getByLabelText('Delete selected messages'));

  await waitFor(() => {
    const deletes = mockFetch.mock.calls.filter(
      ([url, init]: [string, { method?: string }]) =>
        url.includes('/messages/') && init?.method === 'DELETE'
    );
    expect(deletes).toHaveLength(2);
  });
  alert.mockRestore();
});

/**
 * Android's back button leaves multi-select rather than the thread (Phase 10).
 *
 * Without a handler the press falls through to the navigator and you land two
 * screens away with the selection still armed — quiet, and reads as a bug in
 * the app rather than a missing handler. The hook itself is unit-tested in
 * `androidBack.test.tsx`; this pins that the *screen* actually uses it, which
 * is the part a refactor can silently drop.
 *
 * Android-only: iOS has no hardware back, and `useAndroidBack` registers
 * nothing there.
 */
(Platform.OS === 'android' ? it : it.skip)(
  'clears the selection on Android back, without leaving the thread',
  async () => {
    const back = captureBackHandler();
    serve({
      conversation: detail({}),
      messages: [message({ id: 7, sender: MINE, text: 'one' })],
    });

    await renderScreen();
    await openMenu('Your message: one');
    await fireEvent.press(screen.getByLabelText('Select'));
    await screen.findByText('1 selected');

    let handled = false;
    await act(async () => {
      handled = pressBack();
    });

    // The selection is gone, the press was swallowed, and we're still here.
    expect(handled).toBe(true);
    expect(screen.queryByText('1 selected')).toBeNull();
    expect(mockBack).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Your message: one')).toBeTruthy();

    // …and the handler is unregistered once the mode closes, so a second back
    // press leaves the thread as it normally would.
    expect(back.removed()).toBe(1);
  }
);

/**
 * Android back cancels an edit instead of destroying the draft (#168).
 *
 * The worst of the unguarded states, because it loses work rather than just
 * misplacing you: `stashedDraft` is put back by the Cancel path and by nothing
 * else, so a back press that fell through to the navigator took the
 * half-written message with it *and* left the thread. Both halves are asserted
 * here — the draft is the point, but a test that only checked the draft would
 * still pass if we'd fixed it by cancelling the edit on the way out.
 */
(Platform.OS === 'android' ? it : it.skip)(
  'cancels an edit on Android back, keeping the draft and the thread',
  async () => {
    captureBackHandler();
    serve({
      conversation: detail({}),
      messages: [message({ id: 7, sender: MINE, text: 'teh quick fox' })],
    });

    await renderScreen();
    await fireEvent.changeText(
      await screen.findByLabelText('Message'),
      'half-written thought'
    );
    await openMenu('Your message: teh quick fox');
    await fireEvent.press(screen.getByLabelText('Edit'));
    expect(screen.getByLabelText('Message').props.value).toBe('teh quick fox');

    let handled = false;
    await act(async () => {
      handled = pressBack();
    });

    expect(handled).toBe(true);
    expect(screen.queryByText('Editing message')).toBeNull();
    expect(screen.getByLabelText('Message').props.value).toBe(
      'half-written thought'
    );
    expect(mockBack).not.toHaveBeenCalled();
    // Abandoning an edit is not an edit: nothing reached the server.
    expect(
      mockFetch.mock.calls.some(([, init]) => String(init?.method) === 'PATCH')
    ).toBe(false);
  }
);

/**
 * With two things open, back closes the innermost first (#168).
 *
 * The one behaviour a per-state `useAndroidBack` couldn't give us: React Native
 * runs back handlers most-recently-registered-first, so three separate
 * subscriptions would rank themselves by the order you *opened* things, and a
 * photo staged before you hit Edit would swallow the press meant for the edit.
 * The screen decides the order instead, and this is what pins it — staging the
 * photo first is the arrangement that fails under registration order.
 */
(Platform.OS === 'android' ? it : it.skip)(
  'unwinds a staged photo and an edit one at a time, innermost first',
  async () => {
    captureBackHandler();
    serve({
      conversation: detail({}),
      messages: [message({ id: 7, sender: MINE, text: 'teh quick fox' })],
    });

    await renderScreen();
    // Not awaited: the press doesn't settle until the sheet is answered.
    fireEvent.press(await screen.findByLabelText('Add a photo'));
    await choosePhotoSource('Choose from Library');
    await screen.findByLabelText('Remove photo');

    await openMenu('Your message: teh quick fox');
    await fireEvent.press(screen.getByLabelText('Edit'));
    await screen.findByText('Editing message');

    // First press: the edit, opened last.
    await act(async () => {
      expect(pressBack()).toBe(true);
    });
    expect(screen.queryByText('Editing message')).toBeNull();
    expect(screen.getByLabelText('Remove photo')).toBeTruthy();

    // Second: the photo still waiting underneath it.
    await act(async () => {
      expect(pressBack()).toBe(true);
    });
    expect(screen.queryByLabelText('Remove photo')).toBeNull();

    // Only now is there nothing left to close, so back means back.
    expect(mockBack).not.toHaveBeenCalled();
    expect(backHandlerCount()).toBe(0);
  }
);

/**
 * Selection outranks the composer states it covers up (#168).
 *
 * Select mode takes over the composer's slot with the bulk bar, so a staged
 * photo is still staged but no longer *visible*. Dismissing the photo first
 * would be a press that changes nothing on screen and quietly bins the photo —
 * the priority has to follow what you can see, not the order things opened in.
 */
(Platform.OS === 'android' ? it : it.skip)(
  'clears the selection before a staged photo it is covering',
  async () => {
    captureBackHandler();
    serve({
      conversation: detail({}),
      messages: [message({ id: 7, sender: MINE, text: 'one' })],
    });

    await renderScreen();
    // Not awaited: the press doesn't settle until the sheet is answered.
    fireEvent.press(await screen.findByLabelText('Add a photo'));
    await choosePhotoSource('Choose from Library');
    await screen.findByLabelText('Remove photo');

    // Select mode replaces the composer — the photo is staged but off screen.
    await openMenu('Your message: one');
    await fireEvent.press(screen.getByLabelText('Select'));
    await screen.findByText('1 selected');
    expect(screen.queryByLabelText('Remove photo')).toBeNull();

    // First press: the selection, because it's what's on top.
    await act(async () => {
      expect(pressBack()).toBe(true);
    });
    expect(screen.queryByText('1 selected')).toBeNull();
    // The composer is back, and the photo survived the press.
    expect(await screen.findByLabelText('Remove photo')).toBeTruthy();

    // Second: now the photo, which you can see again.
    await act(async () => {
      expect(pressBack()).toBe(true);
    });
    expect(screen.queryByLabelText('Remove photo')).toBeNull();

    expect(mockBack).not.toHaveBeenCalled();
    expect(backHandlerCount()).toBe(0);
  }
);

it('offers no bulk delete once someone else’s message is selected', async () => {
  // A bulk action that silently did only *part* of what it says would be worse
  // than one that isn't there.
  serve({
    conversation: detail({}),
    messages: [
      message({ id: 7, sender: MINE, text: 'mine' }),
      message({ id: 8, sender: ADA, text: 'theirs' }),
    ],
  });

  await renderScreen();
  await openMenu('Your message: mine');
  await fireEvent.press(screen.getByLabelText('Select'));
  expect(screen.getByLabelText('Delete selected messages')).toBeTruthy();

  await fireEvent.press(
    screen.getByLabelText('Message from Ada Lovelace: theirs')
  );

  expect(screen.queryByLabelText('Delete selected messages')).toBeNull();
  // Copy still stands: quoting a conversation is exactly what you'd select
  // someone else's messages for.
  expect(screen.getByLabelText('Copy selected messages')).toBeTruthy();
});

it('copies a selection in the order it was said', async () => {
  serve({
    conversation: detail({}),
    messages: [
      message({ id: 7, sender: ADA, text: 'first' }),
      message({ id: 8, sender: MINE, text: 'second' }),
    ],
  });
  const copy = jest.spyOn(Clipboard, 'setStringAsync').mockResolvedValue(true);

  await renderScreen();
  await openMenu('Message from Ada Lovelace: first');
  await fireEvent.press(screen.getByLabelText('Select'));
  await fireEvent.press(screen.getByLabelText('Your message: second'));
  await fireEvent.press(screen.getByLabelText('Copy selected messages'));

  // Oldest-first, whatever order they were ticked in — a copied exchange only
  // reads correctly in the order it happened.
  expect(copy).toHaveBeenCalledWith('first\nsecond');
  // And the mode ends with the action, rather than leaving the header in a
  // state you have to dismiss.
  expect(screen.queryByText('2 selected')).toBeNull();
});

it('leaves the action menu alone while selecting', async () => {
  // Two modes at once is where a long-press does something you didn't mean.
  serve({
    conversation: detail({}),
    messages: [message({ id: 7, sender: MINE, text: 'one' })],
  });

  await renderScreen();
  await openMenu('Your message: one');
  await fireEvent.press(screen.getByLabelText('Select'));

  fireEvent(screen.getByLabelText('Your message: one'), 'longPress');

  expect(screen.queryByLabelText('Close message actions')).toBeNull();
});

// --- A refresh that fails (#309) --------------------------------------------

/**
 * A failed *refresh* of the conversation must not take the thread off the
 * screen.
 *
 * `query-core`'s error action keeps the data it has and only flips `status` to
 * 'error', and a refetch of `['conversation', id]` is constant here: `staleTime`
 * is 0, `focusManager` is wired to `AppState`, and the detail is re-polled every
 * `CONVERSATION_DETAIL_POLL_MS`. With the error branch ahead of the data,
 * backgrounding the app and coming back on patchy signal replaced the header,
 * the transcript and the composer — with whatever was half-typed in it — with an
 * error card and a *Back to messages* button.
 */
describe('a refresh of the conversation that fails', () => {
  /** The conversation detail fails from here on; the transcript keeps working. */
  function breakTheDetail(status: number, reason: string) {
    const base = mockFetch.getMockImplementation()!;
    mockFetch.mockImplementation(
      async (url: string, init?: { method?: string; body?: string }) => {
        // The detail route only: `/messages/` and `/read/` hang off the same
        // prefix, and breaking those would be testing something else.
        if (/\/api\/conversations\/5\/(\?|$)/.test(url)) {
          return jsonResponse({ detail: reason }, status);
        }
        return base(url, init);
      }
    );
  }

  it('keeps the transcript, the header and the composer', async () => {
    serve({
      conversation: detail({}),
      messages: [message({ id: 1, text: 'See you at six' })],
    });
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: 0 },
        mutations: { gcTime: 0 },
      },
    });
    await renderScreen(client);
    await screen.findByText('See you at six');

    // A half-typed reply — the costly half of what used to be thrown away.
    await fireEvent.changeText(
      await screen.findByLabelText('Message'),
      'On my way'
    );
    breakTheDetail(503, 'Service unavailable.');

    await act(async () => {
      await client.invalidateQueries({ queryKey: ['conversation', 5] });
    });

    await waitFor(() =>
      expect(client.getQueryState(['conversation', 5])?.status).toBe('error')
    );
    // The cache flips to 'error' a render before the screen does — React Query
    // notifies on a macrotask. Without this flush the assertions below run
    // against the pre-error tree and pass with the bug still in place.
    await settle(2);
    expect(screen.queryByText('Couldn’t load this conversation.')).toBeNull();
    expect(screen.getByText('See you at six')).toBeTruthy();
    // Who you're talking to, rather than the anonymous "Conversation" the error
    // header fell back to.
    expect(screen.getByText('Ada Lovelace')).toBeTruthy();
    expect(screen.getByLabelText('Message').props.value).toBe('On my way');
  });

  it('still says the conversation has gone on a 404, holding a copy of it', async () => {
    // The one error that outranks the cached copy: a 404 is an answer about
    // *now* — deleted, or put out of reach — not a failure to ask.
    serve({
      conversation: detail({}),
      messages: [message({ id: 1, text: 'See you at six' })],
    });
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: 0 },
        mutations: { gcTime: 0 },
      },
    });
    await renderScreen(client);
    await screen.findByText('See you at six');
    breakTheDetail(404, 'Not found.');

    await act(async () => {
      await client.invalidateQueries({ queryKey: ['conversation', 5] });
    });

    expect(
      await screen.findByText('This conversation isn’t available.')
    ).toBeTruthy();
    expect(screen.queryByText('See you at six')).toBeNull();
  });

  it('still shows the error card when the first load fails', async () => {
    // Nothing cached to fall back on — this is the case the card is for, and
    // the branch that keeps a loaded thread up must not swallow it.
    serve({ conversation: detail({}), messages: [] });
    breakTheDetail(503, 'Service unavailable.');
    await renderScreen();

    expect(
      await screen.findByText('Couldn’t load this conversation.')
    ).toBeTruthy();
    expect(screen.queryByLabelText('Message')).toBeNull();
  });
});

/**
 * Reading a thread whose *refresh* failed still marks it read (#309).
 *
 * The guard used to include `convoQuery.isError`, which meant the same thing as
 * "nothing is on screen" only for as long as a failed refetch took the thread
 * off the screen. Now that it doesn't, the reader is looking at the messages —
 * and skipping the write left the lock-screen notification and the tab badge
 * claiming unread mail they had just read.
 */
it('marks the thread read even when the detail refresh has failed', async () => {
  // The array is read by the mock at call time, so pushing to it is how a new
  // message "arrives" — and `messageCount` changing is what re-runs the effect.
  const transcript = [message({ id: 1, text: 'See you at six' })];
  serve({ conversation: detail({ unread_count: 1 }), messages: transcript });
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { gcTime: 0 },
    },
  });
  await renderScreen(client);
  await screen.findByText('See you at six');

  const before = readPosts();

  // The detail fails from here on; the transcript keeps working, which is the
  // state this whole PR creates — thread on screen, `convoQuery` in error.
  const base = mockFetch.getMockImplementation()!;
  mockFetch.mockImplementation(
    async (url: string, init?: { method?: string; body?: string }) => {
      if (/\/api\/conversations\/5\/(\?|$)/.test(url)) {
        return jsonResponse({ detail: 'Service unavailable.' }, 503);
      }
      return base(url, init);
    }
  );
  await act(async () => {
    await client.invalidateQueries({ queryKey: ['conversation', 5] });
  });
  await settle(2);
  expect(screen.getByText('See you at six')).toBeTruthy();

  // Someone says something else while we're in that state.
  transcript.push(message({ id: 2, text: 'Running late' }));
  await act(async () => {
    await client.invalidateQueries({ queryKey: ['messages', 5] });
  });
  await screen.findByText('Running late');

  await waitFor(() => expect(readPosts()).toBeGreaterThan(before));
});

/**
 * The other half of that guard (#315): a **404** takes the thread off the
 * screen, and the mark-read effect has to notice.
 *
 * `!!detail` was what shipped in #311, and it is wrong here in the opposite
 * direction — nothing clears a query's `data`, a 404 least of all, so the cached
 * detail stays truthy while every render branch has switched to *This
 * conversation isn't available*. The effect went on POSTing `mark_read` for a
 * conversation showing nothing, on the detail poll's schedule, for as long as
 * the screen stayed open. The effect reads `showingThread` now, derived in the
 * same block as the `loadError` the render branches read, so neither half
 * re-derives the answer for itself.
 */
it('stops marking read once a 404 has taken the thread off the screen', async () => {
  const transcript = [message({ id: 1, text: 'See you at six' })];
  serve({ conversation: detail({ unread_count: 1 }), messages: transcript });
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { gcTime: 0 },
    },
  });
  await renderScreen(client);
  await screen.findByText('See you at six');

  // Removed from the chat, or it was deleted: the detail 404s from here on. The
  // transcript endpoint keeps answering, which is what keeps `messageCount`
  // moving and re-runs the effect.
  const base = mockFetch.getMockImplementation()!;
  mockFetch.mockImplementation(
    async (url: string, init?: { method?: string; body?: string }) => {
      if (/\/api\/conversations\/5\/(\?|$)/.test(url)) {
        return jsonResponse({ detail: 'Not found.' }, 404);
      }
      return base(url, init);
    }
  );
  await act(async () => {
    await client.invalidateQueries({ queryKey: ['conversation', 5] });
  });
  expect(
    await screen.findByText('This conversation isn’t available.')
  ).toBeTruthy();
  const afterGone = readPosts();

  // A message lands underneath the card. Nothing is on screen to have read.
  transcript.push(message({ id: 2, text: 'Running late' }));
  await act(async () => {
    await client.invalidateQueries({ queryKey: ['messages', 5] });
  });
  await settle(2);

  expect(readPosts()).toBe(afterGone);
});

// --- A transcript that fails to load (#321) ---------------------------------

/**
 * The mirror image of the block above: this file read `convoQuery.isError` and
 * never `messagesQuery`'s.
 *
 * The header, the participants and the mute state all come from the *other*
 * query, so they render perfectly while the transcript's fetch is errored — and
 * what filled the space where the messages should be was "No messages yet — say
 * hello.", in a thread with years of history, under the name of the person whose
 * messages had just gone missing. The natural response to that sentence is to
 * start the conversation again.
 */
describe('a transcript that fails to load', () => {
  it('doesn’t say a thread is empty when we couldn’t ask', async () => {
    serve({ conversation: detail({}), messages: [] });
    breakTheMessages();
    await renderScreen();

    expect(await screen.findByText('Couldn’t load these messages')).toBeTruthy();
    expect(screen.queryByText('No messages yet — say hello.')).toBeNull();
    // The header still loaded, which is exactly why the empty state was
    // convincing: nothing else on screen looked wrong.
    expect(screen.getByText('Ada Lovelace')).toBeTruthy();
  });

  it('offers a retry that reloads the transcript', async () => {
    serve({
      conversation: detail({}),
      messages: [message({ id: 1, text: 'See you at six' })],
    });
    breakTheMessages();
    await renderScreen();
    await screen.findByText('Couldn’t load these messages');

    // The server comes back.
    serve({
      conversation: detail({}),
      messages: [message({ id: 1, text: 'See you at six' })],
    });
    await fireEvent.press(
      screen.getByLabelText('Try loading the messages again')
    );

    expect(await screen.findByText('See you at six')).toBeTruthy();
    expect(screen.queryByText('Couldn’t load these messages')).toBeNull();
  });

  it('keeps the messages on screen when a poll of them fails', async () => {
    // `isError && !pages`, never a bare `isError` (#309/#311). This query polls
    // on `MESSAGE_POLL_MS` and pages backwards into history, so a failure of
    // either must not take the transcript away.
    serve({
      conversation: detail({}),
      messages: [message({ id: 1, text: 'See you at six' })],
    });
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: 0 },
        mutations: { gcTime: 0 },
      },
    });
    await renderScreen(client);
    await screen.findByText('See you at six');
    breakTheMessages();

    await act(async () => {
      await client.invalidateQueries({ queryKey: ['messages', 5] });
    });
    await settle(2);

    expect(screen.getByText('See you at six')).toBeTruthy();
    expect(screen.queryByText('Couldn’t load these messages')).toBeNull();
  });

  it('doesn’t claim the thread is empty while the detail is still in flight', async () => {
    // The transcript query is `enabled: !!detail`, and a *disabled* query is
    // neither loading nor errored — `isLoading` is false with nothing behind
    // it. Gated on `isLoading`, the empty state painted "No messages yet" in
    // the gap before the messages had even been asked for. `!pages` is the
    // branch that state is owed.
    mockFetch.mockImplementation(async (url: string) => {
      if (String(url).includes('/api/auth/user/')) return jsonResponse(ME);
      // The detail never answers, so `messagesQuery` never becomes enabled.
      if (/\/api\/conversations\/5\/(\?|$)/.test(String(url))) {
        return new Promise(() => {});
      }
      return jsonResponse(null, 404);
    });
    await renderScreen();
    await settle(2);

    expect(screen.queryByText('No messages yet — say hello.')).toBeNull();
    expect(screen.queryByText('Couldn’t load these messages')).toBeNull();
  });
});

/**
 * The write beside that screen has to agree with it (#315's rule, #321's cause).
 *
 * `showingThread` answers for the *conversation* — header, participants,
 * composer — and all of those render from `convoQuery` while the transcript is
 * errored. So the mark-read effect went on firing: it dismissed this thread's
 * delivered pushes from the tray and POSTed `read`, for messages the reader was
 * being told we couldn't load. They are informed there is nothing there **and**
 * the only signal that would have brought them back is gone — #318's outcome,
 * reached from here.
 */
describe('marking read when the transcript failed', () => {
  it('doesn’t mark read, and leaves the notification in the tray', async () => {
    serve({ conversation: detail({ unread_count: 3 }), messages: [] });
    mockNotifications.getPresentedNotificationsAsync.mockResolvedValue([
      { request: { identifier: 'this-thread', content: { data: { url: '/messages/5' } } } },
    ] as never);
    breakTheMessages();
    await renderScreen();
    await screen.findByText('Couldn’t load these messages');
    await settle(2);

    expect(readPosts()).toBe(0);
    expect(mockNotifications.dismissNotificationAsync).not.toHaveBeenCalled();
  });

  it('marks read as soon as the retry lands', async () => {
    // Recovery must not need a fresh mount: nothing else would ever clear the
    // badge for a thread whose first fetch happened to fail. The effect re-runs
    // when the transcript arrives, which is what `!!pages` in its guard buys.
    serve({ conversation: detail({ unread_count: 3 }), messages: [] });
    breakTheMessages();
    await renderScreen();
    await screen.findByText('Couldn’t load these messages');
    expect(readPosts()).toBe(0);

    serve({
      conversation: detail({ unread_count: 3 }),
      messages: [message({ id: 1, text: 'See you at six' })],
    });
    await fireEvent.press(
      screen.getByLabelText('Try loading the messages again')
    );
    await screen.findByText('See you at six');

    await waitFor(() => expect(readPosts()).toBeGreaterThan(0));
  });
});

/**
 * Review findings on the above: the notice has to survive an outbox entry, and
 * the *other* write beside the screen needed the same guard as mark-read.
 */
describe('a failed transcript with something already on screen', () => {
  it('still says the history is missing when the outbox holds a bubble', async () => {
    // `ListEmptyComponent` can't answer for this: an unsent message survives the
    // screen (`outbox.ts`), so `rows` is non-empty and the empty slot — where
    // the card and its only retry live — never gets its turn. What was left was
    // a chat holding one bubble, years of history absent, nothing saying why.
    serve({ conversation: detail({}), messages: [] });
    const base = mockFetch.getMockImplementation()!;
    mockFetch.mockImplementation(async (url: string, init?: { method?: string }) => {
      if (String(url).includes('/messages/') && init?.method === 'POST') {
        return jsonResponse({ detail: 'Nope.' }, 500);
      }
      return base(url, init);
    });
    breakTheMessages();
    await renderScreen();
    await screen.findByText('Couldn’t load these messages');

    await fireEvent.changeText(await screen.findByLabelText('Message'), 'lost?');
    await fireEvent.press(screen.getByLabelText('Send'));
    expect(await screen.findByText('Not sent')).toBeTruthy();

    // The bubble is kept — replacing an unsent message with an apology reads as
    // it having been thrown away — and the failure gets a line beside it.
    expect(screen.getByText('lost?')).toBeTruthy();
    expect(
      screen.getByText('Couldn’t load the rest of this conversation.')
    ).toBeTruthy();
    expect(screen.getByLabelText('Try loading the messages again')).toBeTruthy();
  });

  it('doesn’t claim the thread’s pushes while it can’t show them', async () => {
    // The quieter twin of the mark-read guard. Claiming the thread makes the
    // foreground handler return `shouldShowList: false` for its pushes — so a
    // message arriving while the error card is up banners once and is never
    // filed in the notification centre. Told there is nothing there, and the
    // one signal that would bring them back is dropped.
    serve({ conversation: detail({}), messages: [] });
    breakTheMessages();
    await renderScreen();
    await screen.findByText('Couldn’t load these messages');

    configureNotificationHandler();
    const [handler] = mockNotifications.setNotificationHandler.mock.calls.at(-1)!;
    const behaviour = await handler!.handleNotification!({
      request: { content: { data: { url: '/messages/5' } } },
    } as never);

    expect(behaviour).toMatchObject({ shouldShowList: true });
  });

  it('claims them again once the transcript is up', async () => {
    serve({
      conversation: detail({}),
      messages: [message({ id: 1, text: 'See you at six' })],
    });
    await renderScreen();
    await screen.findByText('See you at six');

    configureNotificationHandler();
    const [handler] = mockNotifications.setNotificationHandler.mock.calls.at(-1)!;
    const behaviour = await handler!.handleNotification!({
      request: { content: { data: { url: '/messages/5' } } },
    } as never);

    expect(behaviour).toMatchObject({ shouldShowList: false });
  });
});

/**
 * A send that *succeeds* while the transcript is errored (#325).
 *
 * The failure above's mirror image, and the worse one. `insertMessage` writes
 * into a cached list, and on a cold transcript failure there is no list — so the
 * accepted message went nowhere, and `onSuccess` dropped the outbox entry
 * regardless. The bubble you had just watched send vanished, the "couldn't load"
 * card came back in its place, and the message was on the server the whole time:
 * it reads unmistakably as *your message was thrown away*, in a messenger, and
 * the obvious response is to type it again.
 */
describe('a send that succeeds while the transcript is errored', () => {
  /** Take the send, echoing back what was typed so the bubble is identifiable. */
  function acceptTheSend(id = 999) {
    const base = mockFetch.getMockImplementation()!;
    mockFetch.mockImplementation(
      async (url: string, init?: { method?: string; body?: string }) => {
        if (String(url).includes('/messages/') && init?.method === 'POST') {
          return jsonResponse(
            message({ id, sender: MINE, text: JSON.parse(init.body ?? '{}').text })
          );
        }
        return base(url, init);
      }
    );
  }

  /** The state the bug needs: transcript errored cold, composer live. */
  async function sendIntoABrokenTranscript(text: string) {
    serve({ conversation: detail({}), messages: [] });
    acceptTheSend();
    breakTheMessages();
    await renderScreen();
    await screen.findByText('Couldn’t load these messages');

    await fireEvent.changeText(await screen.findByLabelText('Message'), text);
    await fireEvent.press(screen.getByLabelText('Send'));
  }

  it('keeps the message on screen, as sent', async () => {
    await sendIntoABrokenTranscript('on my way');

    // The tick, not a clock and not "Not sent": the server took it.
    expect(await screen.findByLabelText('Sent')).toBeTruthy();
    expect(screen.getByText('on my way')).toBeTruthy();
    // And the note beside it still says why the history isn't there, so the one
    // bubble doesn't read as the whole conversation.
    expect(
      screen.getByText('Couldn’t load the rest of this conversation.')
    ).toBeTruthy();
  });

  it('offers no Retry on it, which would send the text twice', async () => {
    await sendIntoABrokenTranscript('on my way');
    await screen.findByLabelText('Sent');

    expect(screen.queryByText('Not sent')).toBeNull();
    expect(screen.queryByLabelText('Try sending again')).toBeNull();
    // Nor Discard: hiding it would hide a message the other person can read.
    expect(screen.queryByLabelText('Discard this message')).toBeNull();
  });

  it('hands over to the server’s own copy when the transcript loads', async () => {
    await sendIntoABrokenTranscript('on my way');
    await screen.findByLabelText('Sent');

    // The transcript comes back, carrying the message that was accepted.
    serve({
      conversation: detail({}),
      messages: [message({ id: 999, sender: MINE, text: 'on my way' })],
    });
    await fireEvent.press(
      screen.getByLabelText('Try loading the messages again')
    );

    await waitFor(() =>
      expect(
        screen.queryByText('Couldn’t load the rest of this conversation.')
      ).toBeNull()
    );
    // Once, never twice — the entry and the server's copy are the same message,
    // and both being on screen for even one frame reads as having sent it again.
    expect(screen.getAllByText('on my way')).toHaveLength(1);
  });

  it('lets go of it, rather than holding it for the next visit', async () => {
    await sendIntoABrokenTranscript('on my way');
    await screen.findByLabelText('Sent');

    serve({
      conversation: detail({}),
      messages: [message({ id: 999, sender: MINE, text: 'on my way' })],
    });
    await fireEvent.press(
      screen.getByLabelText('Try loading the messages again')
    );
    await screen.findByText('on my way');

    // Open the thread again with the transcript broken. The outbox outlives the
    // screen by design, so anything still in it would be drawn here — and a
    // message the server has confirmed is not the outbox's to keep.
    serve({ conversation: detail({}), messages: [] });
    breakTheMessages();
    await renderScreen();

    expect(await screen.findByText('Couldn’t load these messages')).toBeTruthy();
    expect(screen.queryByText('on my way')).toBeNull();
  });
});
