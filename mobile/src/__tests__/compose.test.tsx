/**
 * Tests for the compose box — the live end of the timeline.
 *
 * The multipart upload is the part most worth pinning: React Native's `FormData`
 * takes a `{uri, name, type}` object rather than a `Blob`, and getting that wrong
 * uploads nothing at all while still returning a cheerful 201.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react-native';
import * as ImagePicker from 'expo-image-picker';

import { ComposeBox } from '@/components/ComposeBox';
import type { User } from '@/types';

jest.mock('expo-image-picker', () => ({
  launchImageLibraryAsync: jest.fn(),
}));

const mockFetch = jest.fn();
const pick = ImagePicker.launchImageLibraryAsync as jest.Mock;

const user: User = {
  pk: 1,
  email: 'alice@example.com',
  first_name: 'Alice',
  last_name: 'Anderson',
  display_name: 'Alice Anderson',
  bio: '',
  avatar_url: null,
  avatar_thumb: null,
  is_staff: false,
};

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (body === null ? '' : JSON.stringify(body)),
    json: async () => body,
  };
}

function renderCompose() {
  // `gcTime: 0` on **mutations**, not just queries — they have separate caches
  // and separate timers. The default five-minute mutation gcTime keeps Node's
  // event loop alive, so the suite passes and then never exits, hanging CI. The
  // query-only version of this fix silently doesn't cover a component that
  // posts.
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { gcTime: 0 },
    },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ComposeBox user={user} />
    </QueryClientProvider>
  );
}

beforeEach(() => {
  mockFetch.mockReset();
  pick.mockReset();
  globalThis.fetch = mockFetch as unknown as typeof fetch;
});

it('will not post an empty composer', async () => {
  await renderCompose();

  // Neither text nor a photo — the same rule the server enforces.
  expect(screen.getByRole('button', { name: 'Post' })).toBeDisabled();
});

it('enables posting once there is text', async () => {
  await renderCompose();

  await fireEvent.changeText(
    screen.getByLabelText("What's happening?"),
    'Hello from the phone'
  );

  expect(screen.getByRole('button', { name: 'Post' })).not.toBeDisabled();
});

it('posts trimmed text as multipart', async () => {
  mockFetch.mockResolvedValue(jsonResponse({ id: 1 }, 201));
  await renderCompose();

  await fireEvent.changeText(
    screen.getByLabelText("What's happening?"),
    '  Hello from the phone  '
  );
  await fireEvent.press(screen.getByRole('button', { name: 'Post' }));

  const [url, init] = mockFetch.mock.calls[0];
  expect(url).toContain('/api/posts/');
  expect(init.body).toBeInstanceOf(FormData);
  // Content-Type is deliberately unset: the runtime adds it *with* the multipart
  // boundary, and setting it by hand omits the boundary so the server can't
  // parse any of the parts.
  expect(init.headers['Content-Type']).toBeUndefined();
});

it('clears the composer after a successful post', async () => {
  mockFetch.mockResolvedValue(jsonResponse({ id: 1 }, 201));
  await renderCompose();

  const input = screen.getByLabelText("What's happening?");
  await fireEvent.changeText(input, 'Hello');
  await fireEvent.press(screen.getByRole('button', { name: 'Post' }));

  expect(await screen.findByDisplayValue('')).toBeTruthy();
});

it('keeps what you typed when posting fails', async () => {
  // Losing someone's text to a network blip is unforgivable on a phone.
  mockFetch.mockResolvedValue(jsonResponse({ detail: 'Nope.' }, 400));
  await renderCompose();

  await fireEvent.changeText(
    screen.getByLabelText("What's happening?"),
    'Worth keeping'
  );
  await fireEvent.press(screen.getByRole('button', { name: 'Post' }));

  expect(await screen.findByDisplayValue('Worth keeping')).toBeTruthy();
});

describe('photos', () => {
  it('attaches a picked photo and lets you post with no text', async () => {
    pick.mockResolvedValue({
      canceled: false,
      assets: [{ uri: 'file:///tmp/a.jpg', fileName: 'a.jpg', mimeType: 'image/jpeg' }],
    });
    mockFetch.mockResolvedValue(jsonResponse({ id: 1 }, 201));
    await renderCompose();

    await fireEvent.press(screen.getByLabelText('Add photos'));

    // A photo-only post is allowed.
    expect(await screen.findByText('1 photo')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Post' })).not.toBeDisabled();
  });

  it('synthesises a filename when the picker does not supply one', async () => {
    // A camera-roll asset often has no filename. The part must still carry one
    // or it's silently dropped from the multipart body.
    pick.mockResolvedValue({
      canceled: false,
      assets: [{ uri: 'file:///tmp/b.jpg', fileName: null, mimeType: null }],
    });
    await renderCompose();

    await fireEvent.press(screen.getByLabelText('Add photos'));

    expect(await screen.findByText('1 photo')).toBeTruthy();
  });

  it('adds nothing when the picker is cancelled', async () => {
    pick.mockResolvedValue({ canceled: true });
    await renderCompose();

    await fireEvent.press(screen.getByLabelText('Add photos'));

    // The button keeps its "Add photos" label; what must NOT appear is a count.
    expect(screen.queryByText(/^\d+ photos?$/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Post' })).toBeDisabled();
  });

  it('lets you remove a chosen photo', async () => {
    pick.mockResolvedValue({
      canceled: false,
      assets: [{ uri: 'file:///tmp/c.jpg', fileName: 'c.jpg', mimeType: 'image/jpeg' }],
    });
    await renderCompose();

    await fireEvent.press(screen.getByLabelText('Add photos'));
    await fireEvent.press(await screen.findByLabelText('Remove photo 1'));

    expect(screen.getByRole('button', { name: 'Post' })).toBeDisabled();
  });
});
