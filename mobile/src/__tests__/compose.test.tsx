/**
 * Tests for the compose box — the live end of the timeline.
 *
 * The multipart upload is the part most worth pinning: React Native's `FormData`
 * takes a `{uri, name, type}` object rather than a `Blob`, and getting that wrong
 * uploads nothing at all while still returning a cheerful 201.
 */

import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import * as ImagePicker from 'expo-image-picker';

import { api } from '@/api';
import { ComposeBox } from '@/components/ComposeBox';
import type { User } from '@/types';
import {
  alertSpy,
  cancelMenu,
  choosePhotoSource,
  menuWasShown,
  resetMenuSpies,
} from './helpers';

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
  askCamera.mockReset().mockResolvedValue({ granted: true, canAskAgain: true });
  resetMenuSpies();
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

describe('refreshing the timelines a new post lands on', () => {
  /**
   * A timeline screen sitting elsewhere in the app while you compose.
   *
   * It renders nothing — all that matters is that it *observes* its query, the
   * way the real screen does, because that's what decides whether an
   * invalidation refetches now or is merely noted for later. (Copied from
   * `comments.test.tsx`, for the same reason: a tab navigator keeps a visited
   * tab mounted, so the home feed has a live observer and never remounts on a
   * tab switch. A seeded, *unobserved* cache entry passes against the broken
   * build — at `staleTime` 0 it refetches on its next mount whatever we do.)
   */
  function TimelineScreen({
    queryKey,
    queryFn,
  }: {
    queryKey: unknown[];
    queryFn: () => Promise<unknown>;
  }) {
    useQuery({ queryKey, queryFn });
    return null;
  }

  /**
   * The composer, with every post-list surface mounted alongside it.
   *
   * The keys carry the suffixes the real screens use — `['feed', includeGroups]`
   * from the home tab, `['userPosts', id]` from a profile — so a fix that
   * invalidated the bare unsuffixed keys as *exact* keys wouldn't pass here.
   */
  async function renderComposeOverTimelines(props: { groupId?: number } = {}) {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: 0 },
        mutations: { gcTime: 0 },
      },
    });
    const screens = {
      // `true` is the "include groups in feed" preference turned on — the
      // setting that puts a group post on the home feed in the first place.
      feed: { key: ['feed', true], fn: jest.fn(async () => postList()) },
      userPosts: { key: ['userPosts', user.pk], fn: jest.fn(async () => postList()) },
      groupPosts: { key: ['groupPosts', 5], fn: jest.fn(async () => postList()) },
    };
    await render(
      <QueryClientProvider client={queryClient}>
        {Object.entries(screens).map(([name, s]) => (
          <TimelineScreen key={name} queryKey={s.key} queryFn={s.fn} />
        ))}
        <ComposeBox user={user} {...props} />
      </QueryClientProvider>
    );
    // Their first load, so a later call is unambiguously a refetch.
    await waitFor(() =>
      expect(loadCounts(screens)).toEqual({ feed: 1, userPosts: 1, groupPosts: 1 })
    );
    return screens;
  }

  type Screens = Awaited<ReturnType<typeof renderComposeOverTimelines>>;

  function postList() {
    return {
      pages: [{ count: 0, next: null, previous: null, results: [] }],
      pageParams: [undefined],
    };
  }

  /** How many times each surface has loaded, keyed by name for a readable diff. */
  function loadCounts(screens: Screens) {
    return Object.fromEntries(
      Object.entries(screens).map(([name, s]) => [name, s.fn.mock.calls.length])
    );
  }

  async function post(text: string) {
    await fireEvent.changeText(screen.getByLabelText("What's happening?"), text);
    await fireEvent.press(screen.getByRole('button', { name: 'Post' }));
  }

  it('refreshes the home feed and your profile after a personal post', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ id: 1 }, 201));
    const screens = await renderComposeOverTimelines();

    await post('From the home feed');

    // Your profile timeline is the other list a personal post lands on, and it
    // stays wrong when it isn't refreshed: open your profile from a screen
    // already in the stack and the post you just wrote isn't there.
    await waitFor(() =>
      expect(loadCounts(screens)).toEqual({ feed: 2, userPosts: 2, groupPosts: 1 })
    );
  });

  it('refreshes the home feed as well as the group after a group post', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ id: 1 }, 201));
    const screens = await renderComposeOverTimelines({ groupId: 5 });

    await post('Into the group');

    // The feed is the regression (#275): a group post surfaces there via the
    // "include groups" toggle, and the Home tab stays mounted while you're in
    // a group, so nothing else refetches it until a pull or an app foreground.
    // The profile must NOT refresh — the server files a group post under the
    // group, and `visible_posts` keeps group posts off a profile timeline.
    await waitFor(() =>
      expect(loadCounts(screens)).toEqual({ feed: 2, userPosts: 1, groupPosts: 2 })
    );
  });

  it('refreshes nothing when the post is refused', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ detail: 'Nope.' }, 400));
    const screens = await renderComposeOverTimelines();

    await post('Doomed');

    // The Alert is the tell that the failure has settled, so the counts below
    // are read after the mutation finished rather than before it started.
    await waitFor(() => expect(alertSpy).toHaveBeenCalled());
    expect(loadCounts(screens)).toEqual({ feed: 1, userPosts: 1, groupPosts: 1 });
  });
});

describe('photos', () => {
  /**
   * Add a photo, answering the camera-or-library sheet.
   *
   * The press is deliberately **not** awaited: `pickPhotos` doesn't resolve
   * until a source is chosen, so awaiting it here would hang the test on a
   * sheet nobody has answered yet.
   */
  async function addPhoto(from: 'Take Photo' | 'Choose from Library') {
    fireEvent.press(screen.getByLabelText('Add photos'));
    await choosePhotoSource(from);
  }

  it('attaches a picked photo and lets you post with no text', async () => {
    pick.mockResolvedValue({
      canceled: false,
      assets: [{ uri: 'file:///tmp/a.jpg', fileName: 'a.jpg', mimeType: 'image/jpeg' }],
    });
    mockFetch.mockResolvedValue(jsonResponse({ id: 1 }, 201));
    await renderCompose();

    await addPhoto('Choose from Library');

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

    await addPhoto('Choose from Library');
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

  it('picks at a lower quality than the pickers that re-encode afterwards', async () => {
    // Post photos are uploaded as picked — this is the only compression they
    // ever get. Chat photos and avatars are re-encoded on the phone a moment
    // later, so they take the full-quality pick instead.
    pick.mockResolvedValue({ canceled: true });
    await renderCompose();

    await addPhoto('Choose from Library');

    await waitFor(() =>
      expect(pick).toHaveBeenCalledWith(expect.objectContaining({ quality: 0.9 }))
    );
  });

  it('adds nothing when the picker is cancelled', async () => {
    pick.mockResolvedValue({ canceled: true });
    await renderCompose();

    await addPhoto('Choose from Library');

    // The button keeps its "Add photos" label; what must NOT appear is a count.
    expect(screen.queryByText(/^\d+ photos?$/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Post' })).toBeDisabled();
  });

  it('lets you take a photo instead of picking one', async () => {
    // "Add photos" used to open the camera roll and nothing else, which meant
    // posting the thing in front of you was a trip out to the camera app and
    // back. Both paths end in the same attached photo.
    takePhoto.mockResolvedValue({
      canceled: false,
      assets: [{ uri: 'file:///tmp/shot.jpg', fileName: null, mimeType: null }],
    });
    await renderCompose();

    await addPhoto('Take Photo');

    expect(await screen.findByText('1 photo')).toBeTruthy();
    expect(pick).not.toHaveBeenCalled();
  });

  it('says so and picks nothing when camera access is refused', async () => {
    // 🔒 The camera is the one path here that needs permission — the modern
    // library picker runs out of process. Silently doing nothing after someone
    // taps "Take Photo" reads as a broken button, so this asserts the telling.
    askCamera.mockResolvedValue({ granted: false, canAskAgain: false });
    await renderCompose();

    await addPhoto('Take Photo');

    await waitFor(() =>
      expect(alertSpy).toHaveBeenCalledWith(
        'Camera access needed',
        expect.stringContaining('Settings')
      )
    );
    expect(takePhoto).not.toHaveBeenCalled();
    expect(screen.queryByText(/^\d+ photos?$/)).toBeNull();
  });

  it('adds nothing when the source sheet is dismissed', async () => {
    await renderCompose();

    fireEvent.press(screen.getByLabelText('Add photos'));
    await waitFor(() => expect(menuWasShown()).toBe(true));
    cancelMenu();

    // Nothing opened, and — the part that matters — the button still works
    // afterwards, which it wouldn't if the dismissal left a promise hanging.
    await waitFor(() => expect(screen.queryByTestId('action-menu')).toBeNull());
    expect(pick).not.toHaveBeenCalled();
    expect(takePhoto).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Post' })).toBeDisabled();

    pick.mockResolvedValue({
      canceled: false,
      assets: [{ uri: 'file:///tmp/d.jpg', fileName: 'd.jpg', mimeType: 'image/jpeg' }],
    });
    await addPhoto('Choose from Library');
    expect(await screen.findByText('1 photo')).toBeTruthy();
  });

  it('lets you remove a chosen photo', async () => {
    pick.mockResolvedValue({
      canceled: false,
      assets: [{ uri: 'file:///tmp/c.jpg', fileName: 'c.jpg', mimeType: 'image/jpeg' }],
    });
    await renderCompose();

    await addPhoto('Choose from Library');
    await fireEvent.press(await screen.findByLabelText('Remove photo 1'));

    expect(screen.getByRole('button', { name: 'Post' })).toBeDisabled();
  });
});
