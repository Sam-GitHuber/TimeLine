/**
 * Tests for the compose box — the live end of the timeline.
 *
 * The multipart upload is the part most worth pinning: React Native's `FormData`
 * takes a `{uri, name, type}` object rather than a `Blob`, and getting that wrong
 * uploads nothing at all while still returning a cheerful 201.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import * as ImagePicker from 'expo-image-picker';
import { Alert } from 'react-native';

import { api } from '@/api';
import { ComposeBox } from '@/components/ComposeBox';
import type { User } from '@/types';
import { alertSpy, answerPhotoSource } from './helpers';

jest.mock('expo-image-picker', () => ({
  launchImageLibraryAsync: jest.fn(),
  launchCameraAsync: jest.fn(),
  requestCameraPermissionsAsync: jest.fn(),
}));

const mockFetch = jest.fn();
const pick = ImagePicker.launchImageLibraryAsync as jest.Mock;
const takePhoto = ImagePicker.launchCameraAsync as jest.Mock;
const askCamera = ImagePicker.requestCameraPermissionsAsync as jest.Mock;

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
  send_read_receipts: true,
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

/**
 * Watch what the composer hands to the API, while still calling through.
 *
 * `api.createPost` is the right seam for a component test: the multipart body it
 * builds is pinned in `api.test.ts`, so what's left to check here is that the
 * composer passes the *right arguments* — trimmed text, and every chosen photo
 * with a filename attached.
 */
let createPost: jest.SpiedFunction<typeof api.createPost>;

beforeEach(() => {
  mockFetch.mockReset();
  pick.mockReset();
  takePhoto.mockReset();
  askCamera.mockReset().mockResolvedValue({ granted: true });
  alertSpy.mockReset().mockImplementation(() => {});
  globalThis.fetch = mockFetch as unknown as typeof fetch;
  createPost = jest.spyOn(api, 'createPost');
});

afterEach(() => {
  createPost.mockRestore();
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

  // The surrounding whitespace is gone, and nothing else about the text is.
  // The third arg is the optional group id — undefined on the home feed (E3a).
  expect(createPost).toHaveBeenCalledWith('Hello from the phone', [], undefined);

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
  // Every path here goes through the "camera or library?" prompt first, so the
  // answer is armed by default and the camera tests below re-arm it.
  beforeEach(() => answerPhotoSource('Choose from Library'));

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

    await fireEvent.press(screen.getByRole('button', { name: 'Post' }));

    expect(createPost).toHaveBeenCalledWith(
      '',
      [{ uri: 'file:///tmp/a.jpg', name: 'a.jpg', type: 'image/jpeg' }],
      undefined
    );
  });

  it('synthesises a filename when the picker does not supply one', async () => {
    // A camera-roll asset often has no filename. The part must still carry one
    // or it's silently dropped from the multipart body — so this has to assert
    // on what gets *sent*, not just on the thumbnail appearing.
    pick.mockResolvedValue({
      canceled: false,
      assets: [{ uri: 'file:///tmp/b.jpg', fileName: null, mimeType: null }],
    });
    mockFetch.mockResolvedValue(jsonResponse({ id: 1 }, 201));
    await renderCompose();

    await fireEvent.press(screen.getByLabelText('Add photos'));
    expect(await screen.findByText('1 photo')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Post' }));

    const [, photos] = createPost.mock.calls[0];
    expect(photos).toHaveLength(1);
    expect(photos![0].name).toEqual(expect.stringMatching(/\.jpg$/));
    expect(photos![0].name).not.toBe('');
    // The server validates by decoding the bytes, so the fallback type only has
    // to be *a* raster type, but it must not be undefined.
    expect(photos![0].type).toBe('image/jpeg');
  });

  it('adds nothing when the picker is cancelled', async () => {
    pick.mockResolvedValue({ canceled: true });
    await renderCompose();

    await fireEvent.press(screen.getByLabelText('Add photos'));

    // The button keeps its "Add photos" label; what must NOT appear is a count.
    expect(screen.queryByText(/^\d+ photos?$/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Post' })).toBeDisabled();
  });

  it('lets you take a photo instead of picking one', async () => {
    // "Add photos" used to open the camera roll and nothing else, which meant
    // posting the thing in front of you was a trip out to the camera app and
    // back. Both paths end in the same attached photo.
    answerPhotoSource('Take Photo');
    takePhoto.mockResolvedValue({
      canceled: false,
      assets: [{ uri: 'file:///tmp/shot.jpg', fileName: null, mimeType: null }],
    });
    await renderCompose();

    await fireEvent.press(screen.getByLabelText('Add photos'));

    expect(await screen.findByText('1 photo')).toBeTruthy();
    expect(pick).not.toHaveBeenCalled();
  });

  it('says so and picks nothing when camera access is refused', async () => {
    // 🔒 The camera is the one path here that needs permission — the modern
    // library picker runs out of process. Silently doing nothing after someone
    // taps "Take Photo" reads as a broken button, so this asserts the telling.
    answerPhotoSource('Take Photo');
    askCamera.mockResolvedValue({ granted: false });
    await renderCompose();

    await fireEvent.press(screen.getByLabelText('Add photos'));

    await waitFor(() =>
      expect(alertSpy).toHaveBeenCalledWith(
        'Camera access needed',
        expect.stringContaining('Settings')
      )
    );
    expect(takePhoto).not.toHaveBeenCalled();
    expect(screen.queryByText(/^\d+ photos?$/)).toBeNull();
  });

  it('adds nothing when the source prompt is cancelled', async () => {
    alertSpy.mockImplementation(((
      _title: string,
      _message: string | undefined,
      buttons: { text?: string; onPress?: () => void }[] | undefined
    ) => {
      buttons?.find((button) => button.text === 'Cancel')?.onPress?.();
    }) as unknown as typeof Alert.alert);
    await renderCompose();

    await fireEvent.press(screen.getByLabelText('Add photos'));

    expect(pick).not.toHaveBeenCalled();
    expect(takePhoto).not.toHaveBeenCalled();
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
