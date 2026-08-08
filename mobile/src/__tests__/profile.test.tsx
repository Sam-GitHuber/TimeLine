/**
 * The profile screen and its inline editor (Milestone C4).
 *
 * Two things are worth pinning here. First, the private-by-default wall: a
 * profile you aren't connected with must show the locked state, not their posts.
 * Second, the editor's save path — that it sends the edited name as multipart
 * and then refreshes "who am I" so the new name repaints from auth, which is the
 * one genuinely new bit of plumbing this milestone adds.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import * as ImagePicker from 'expo-image-picker';

import ProfileScreen from '@/app/u/[userId]';
import { AuthProvider } from '@/auth';
import { PostCard } from '@/components/PostCard';
import { saveTokens } from '@/tokens';
import type { Post, ProfileUser, User } from '@/types';

import {
  androidIt,
  captureBackHandler,
  choosePhotoSource,
  holdRequest,
  pressBack,
  resetMenuSpies,
  settle,
} from './helpers';

// A mutable route param so each test can view a different person. Both this and
// the router spy are `mock`-prefixed so Jest lets the factory below close over
// them (its one exception to the out-of-scope-variable rule).
const mockParams: { userId: string } = { userId: '1' };
const mockPush = jest.fn();
const mockBack = jest.fn();

jest.mock('expo-router', () => ({
  // The screen is always focused under test, so focus is a plain effect — see
  // `jest.setup.js`, whose global stub this local factory overrides.
  useFocusEffect: (callback: () => void | (() => void)) =>
    // `require`, not an import: the factory is hoisted above the imports.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('react').useEffect(callback, [callback]),
  useLocalSearchParams: () => mockParams,
  // The screen's swipe-back hold (`useHoldSwipeBack`) reaches for the navigator;
  // there isn't one under test and the option it sets governs an iOS gesture
  // Node can't perform. Same stand-in as the global stub this overrides.
  useNavigation: () => ({ setOptions: () => {} }),
  // `push` reads `mockPush` lazily: the factory runs while the hoisted imports
  // load expo-router, which is *before* the `const mockPush` line executes, so
  // referencing it directly would capture `undefined`. An arrow defers the read
  // to call time, by when it's initialised.
  router: {
    push: (...args: unknown[]) => mockPush(...args),
    back: (...args: unknown[]) => mockBack(...args),
    replace: jest.fn(),
    canGoBack: () => true,
  },
}));

jest.mock('expo-image-picker', () => ({
  launchImageLibraryAsync: jest.fn(),
  launchCameraAsync: jest.fn(),
  requestCameraPermissionsAsync: jest.fn(),
}));

// The real crop modal pulls in reanimated + gesture-handler + native image
// work, none of which run under Jest — and its gestures/geometry are covered by
// `avatarCrop.test.ts`. Here it stands in for a sheet that immediately hands
// back a cropped file, so the pick → reframe → attach *wiring* is what's tested.
jest.mock('@/components/AvatarCropModal', () => {
  // require, not import: a jest.mock factory is hoisted above the imports, so it
  // can't reference module-scope bindings and must pull its deps in itself.
  /* eslint-disable @typescript-eslint/no-require-imports */
  const React = require('react');
  const { Text } = require('react-native');
  /* eslint-enable @typescript-eslint/no-require-imports */
  return {
    AvatarCropModal: ({
      onCropped,
    }: {
      onCropped: (u: { uri: string; name: string; type: string }) => void;
    }) =>
      React.createElement(
        Text,
        {
          accessibilityRole: 'button',
          onPress: () =>
            onCropped({
              uri: 'file:///tmp/cropped.jpg',
              name: 'avatar.jpg',
              type: 'image/jpeg',
            }),
        },
        'Use photo (test)'
      ),
  };
});

const pick = ImagePicker.launchImageLibraryAsync as jest.Mock;
const takePhoto = ImagePicker.launchCameraAsync as jest.Mock;
const askCamera = ImagePicker.requestCameraPermissionsAsync as jest.Mock;
const mockFetch = jest.fn();

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (body === null ? '' : JSON.stringify(body)),
    json: async () => body,
  };
}

// The logged-in user, mutated in place by a successful PATCH so the follow-up
// `refreshUser` GET reads back the edited name — exactly what the server does.
let me: User;

function resetMe() {
  me = {
    pk: 1,
    email: 'alice@example.com',
    first_name: 'Alice',
    last_name: 'Anderson',
    display_name: 'Alice Anderson',
    bio: 'Walks and sourdough.',
    avatar_url: null,
    avatar_thumb: null,
    is_staff: false,
    send_read_receipts: true,
  };
}

function profile(overrides: Partial<ProfileUser> & { id: number }): ProfileUser {
  return {
    display_name: 'Alice Anderson',
    bio: 'Walks and sourdough.',
    avatar_thumb: null,
    connection_status: 'connected',
    is_blocked: false,
    ...overrides,
  };
}

function makePost(overrides: Partial<Post> & { id: number }): Post {
  return {
    author: { id: 1, display_name: 'Alice Anderson', avatar_thumb: null },
    text: `Post ${overrides.id}`,
    images: [],
    group: null,
    reactions: [],
    comment_count: 0,
    new_comment_count: 0,
    created_at: '2026-07-18T10:00:00Z',
    edited_at: null,
    ...overrides,
  };
}

/**
 * Answer by URL + method. The cold-start `AuthProvider` asks "who am I", then the
 * screen asks for the profile header and the person's posts.
 */
function serve({
  user,
  posts = [],
}: {
  user: ProfileUser;
  posts?: Post[];
}) {
  mockFetch.mockImplementation(async (url: string, init?: { method?: string }) => {
    if (url.includes('/api/auth/user/')) {
      if (init?.method === 'PATCH') {
        // A save: apply the change and hand back the updated user, as DRF would.
        me = { ...me, first_name: 'Alicia', display_name: 'Alicia Anderson' };
        return jsonResponse(me);
      }
      return jsonResponse(me);
    }
    // Order matters: the posts URL (`/api/users/<id>/posts/`) contains *both*
    // substrings, so it must be matched before the bare `/api/users/` header
    // route or every posts request would be answered with the profile header.
    if (url.includes('/posts/')) return jsonResponse({ count: posts.length, next: null, previous: null, results: posts });
    if (url.includes('/api/users/')) return jsonResponse(user);
    return jsonResponse(null, 404);
  });
}

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { gcTime: 0 },
    },
  });
}

// Hands the client back so a test can drive a refetch (and read the query's
// state afterwards); every caller that doesn't care can keep ignoring it.
async function renderScreen(client = makeQueryClient()) {
  // Prime a session so the real AuthProvider resolves to `me` rather than the
  // signed-out state — the screen's self/other branch turns on `me.pk`.
  await saveTokens({ access: 'access-token', refresh: 'refresh-token' });
  const view = await render(
    <QueryClientProvider client={client}>
      <AuthProvider>
        <ProfileScreen />
      </AuthProvider>
    </QueryClientProvider>
  );
  return { client, ...view };
}

beforeEach(() => {
  mockFetch.mockReset();
  pick.mockReset();
  takePhoto.mockReset();
  askCamera.mockReset().mockResolvedValue({ granted: true, canAskAgain: true });
  resetMenuSpies();
  resetMe();
  mockParams.userId = '1';
  mockPush.mockReset();
  mockBack.mockReset();
  globalThis.fetch = mockFetch as unknown as typeof fetch;
});

describe('viewing a profile', () => {
  it('shows your own name, bio, posts, and the edit/logout actions', async () => {
    serve({ user: profile({ id: 1 }), posts: [makePost({ id: 5, text: 'A day on the hills' })] });

    await renderScreen();

    expect(await screen.findByText('A day on the hills')).toBeTruthy();
    expect(screen.getByText('Walks and sourdough.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Edit profile' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Log out' })).toBeTruthy();
  });

  it('locks a not-connected person’s posts instead of showing them', async () => {
    mockParams.userId = '2';
    serve({ user: profile({ id: 2, display_name: 'Bob Brown', connection_status: 'none' }) });

    await renderScreen();

    expect(await screen.findByText('Bob Brown’s posts are private.')).toBeTruthy();
    // No edit/logout on someone else's profile.
    expect(screen.queryByRole('button', { name: 'Edit profile' })).toBeNull();
    // And their posts were never requested — you're not allowed to see them, so
    // the query stays disabled rather than firing a call the backend empties.
    expect(mockFetch.mock.calls.some(([url]) => url.includes('/posts/'))).toBe(false);
  });
});

describe('editing your profile', () => {
  it('saves the edited name as multipart and refreshes who-am-I', async () => {
    serve({ user: profile({ id: 1 }), posts: [] });

    await renderScreen();

    await fireEvent.press(await screen.findByRole('button', { name: 'Edit profile' }));

    const firstName = await screen.findByLabelText('First name');
    await fireEvent.changeText(firstName, 'Alicia');
    await fireEvent.press(screen.getByRole('button', { name: 'Save' }));

    // The save went out as a multipart PATCH to the dj-rest-auth user endpoint.
    await waitFor(() => {
      const patch = mockFetch.mock.calls.find(
        ([url, init]) => url.includes('/api/auth/user/') && init?.method === 'PATCH'
      );
      expect(patch).toBeTruthy();
      expect(patch![1].body).toBeInstanceOf(FormData);
      // Never hand-set for multipart — the boundary must come from the runtime.
      expect(patch![1].headers['Content-Type']).toBeUndefined();
    });

    // refreshUser re-read the user, so the header now shows the edited name and
    // the editor has closed.
    expect(await screen.findByText('Alicia Anderson')).toBeTruthy();
    expect(screen.queryByLabelText('First name')).toBeNull();
  });

  it('reframes a picked photo through the crop modal, then attaches it', async () => {
    pick.mockResolvedValue({
      canceled: false,
      assets: [{ uri: 'file:///tmp/orig.jpg', width: 1000, height: 800 }],
    });
    serve({ user: profile({ id: 1 }), posts: [] });

    await renderScreen();

    await fireEvent.press(await screen.findByRole('button', { name: 'Edit profile' }));
    // No avatar yet, so the button offers to add one. The press isn't awaited:
    // it doesn't settle until the camera-or-library sheet is answered.
    fireEvent.press(await screen.findByRole('button', { name: 'Add photo' }));
    await choosePhotoSource('Choose from Library');
    // The picked photo goes to the crop modal, which returns the reframed square.
    await fireEvent.press(await screen.findByText('Use photo (test)'));

    // A cropped avatar is now staged: the editor lets you change or remove it.
    expect(await screen.findByRole('button', { name: 'Remove' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Change photo' })).toBeTruthy();
  });

  it('lets you take a new profile photo with the camera', async () => {
    // A profile photo is the picture people most often want to take on the
    // spot; the camera shot goes through the same cropper as a picked one.
    takePhoto.mockResolvedValue({
      canceled: false,
      assets: [{ uri: 'file:///tmp/selfie.jpg', width: 1000, height: 1000 }],
    });
    serve({ user: profile({ id: 1 }), posts: [] });

    await renderScreen();

    await fireEvent.press(await screen.findByRole('button', { name: 'Edit profile' }));
    fireEvent.press(await screen.findByRole('button', { name: 'Add photo' }));
    await choosePhotoSource('Take Photo');
    await fireEvent.press(await screen.findByText('Use photo (test)'));

    expect(await screen.findByRole('button', { name: 'Change photo' })).toBeTruthy();
    expect(pick).not.toHaveBeenCalled();
  });

  it('will not save with an empty first name', async () => {
    serve({ user: profile({ id: 1 }), posts: [] });

    await renderScreen();

    await fireEvent.press(await screen.findByRole('button', { name: 'Edit profile' }));
    await fireEvent.changeText(await screen.findByLabelText('First name'), '');

    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('will not save with an empty last name', async () => {
    // The display name is first + last, so *both* are required — a guard that's
    // easy to write for only one field. Clearing the surname must disable Save
    // just as clearing the given name does.
    serve({ user: profile({ id: 1 }), posts: [] });

    await renderScreen();

    await fireEvent.press(await screen.findByRole('button', { name: 'Edit profile' }));
    await fireEvent.changeText(await screen.findByLabelText('Last name'), '');

    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  /**
   * Android back closes the editor, not the profile (#168).
   *
   * The editor is inline rather than a Modal, so nothing claimed the press and
   * it fell through to the navigator — taking a rewritten bio with it, since
   * the form holds its fields in local state and unmounts with the screen.
   */
  androidIt('closes the editor on Android back, staying on the profile', async () => {
    captureBackHandler();
    serve({ user: profile({ id: 1 }), posts: [] });

    await renderScreen();
    await fireEvent.press(await screen.findByRole('button', { name: 'Edit profile' }));
    await fireEvent.changeText(await screen.findByLabelText('Bio'), 'a rewritten bio');

    await act(async () => {
      expect(pressBack()).toBe(true);
    });

    // Back to the read view — and still on it, rather than wherever the
    // navigator would have taken us.
    expect(screen.queryByLabelText('Bio')).toBeNull();
    expect(screen.getByRole('button', { name: 'Edit profile' })).toBeTruthy();
  });

  /**
   * …but nothing closes it while the PATCH is out (#256/#259).
   *
   * The form is the only renderer of a refused save, and all four ways out of it
   * unmount it: its own Cancel, Android's hardware back, the screen's "← Back"
   * and iOS's swipe. Pick a new avatar on mobile data, hit Save, leave — and an
   * upload the server then rejects for its image allow-list leaves the old
   * avatar showing and nothing said, which reads as the save being ignored.
   *
   * The registration for that back press is on the *screen*, one component above
   * the mutation, which is the structural cause #256 names.
   */
  describe('holding the editor open until the server answers', () => {
    async function startSaving() {
      serve({ user: profile({ id: 1 }), posts: [] });
      await renderScreen();
      await fireEvent.press(
        await screen.findByRole('button', { name: 'Edit profile' })
      );
      await fireEvent.changeText(
        await screen.findByLabelText('First name'),
        'Alicia'
      );

      const server = holdRequest(
        mockFetch,
        { detail: 'That name isn’t allowed.' },
        400
      );
      await fireEvent.press(screen.getByRole('button', { name: 'Save' }));
      await server.inFlight('Saving…');
      return server;
    }

    it('refuses Cancel, then shows the refusal', async () => {
      const server = await startSaving();

      await fireEvent.press(screen.getByRole('button', { name: 'Cancel' }));
      expect(screen.getByLabelText('First name')).toBeTruthy();

      await server.refuse();
      expect(await screen.findByText('That name isn’t allowed.')).toBeTruthy();
    });

    it('refuses the screen’s Back, then shows the refusal', async () => {
      const server = await startSaving();

      await fireEvent.press(screen.getByLabelText('Back'));
      expect(mockBack).not.toHaveBeenCalled();
      expect(screen.getByLabelText('First name')).toBeTruthy();

      await server.refuse();
      expect(await screen.findByText('That name isn’t allowed.')).toBeTruthy();
    });

    androidIt('refuses hardware back, then shows the refusal', async () => {
      captureBackHandler();
      const server = await startSaving();

      await act(async () => {
        // Claimed, not passed on — falling through would leave the profile.
        expect(pressBack()).toBe(true);
      });
      expect(screen.getByLabelText('First name')).toBeTruthy();

      await server.refuse();
      expect(await screen.findByText('That name isn’t allowed.')).toBeTruthy();
    });

    it('lets go the moment the PATCH lands, not when refreshUser finishes', async () => {
      // React Query holds a mutation pending for the whole of `onSuccess`, and
      // this one awaits a *second* request (`refreshUser`). A hold left on
      // `isPending` alone would stay shut across a round trip with nothing to
      // report — moving the trap rather than removing it (#255, #259).
      serve({ user: profile({ id: 1 }), posts: [] });
      await renderScreen();
      await fireEvent.press(
        await screen.findByRole('button', { name: 'Edit profile' })
      );
      await fireEvent.changeText(
        await screen.findByLabelText('First name'),
        'Alicia'
      );
      await fireEvent.press(screen.getByRole('button', { name: 'Save' }));

      // The editor closes on its own here, which is the point: nothing was left
      // holding it shut behind the follow-up read.
      expect(await screen.findByText('Alicia Anderson')).toBeTruthy();
      expect(screen.queryByLabelText('First name')).toBeNull();
    });
  });
});

describe('reaching a profile', () => {
  it('opens the author’s profile when their name is tapped on a post', async () => {
    await render(
      <QueryClientProvider client={makeQueryClient()}>
        {/* PostCard's ⋯ menu reads auth; with no session primed the user is null
            and the menu renders nothing, which is all this tap test needs. */}
        <AuthProvider>
          <PostCard post={makePost({ id: 9, author: { id: 42, display_name: 'Carol Clark', avatar_thumb: null } })} />
        </AuthProvider>
      </QueryClientProvider>
    );

    await fireEvent.press(screen.getByText('Carol Clark'));

    // Exactly one navigation, to the profile — not also the post. (The name's
    // onPress sits inside the body's open-post Pressable; RN's responder system
    // gives the deeper Text the tap, but a device pass confirms it for real.)
    expect(mockPush).toHaveBeenCalledTimes(1);
    expect(mockPush).toHaveBeenCalledWith('/u/42');
  });
});

// --- A refresh that fails (#309) --------------------------------------------

/**
 * A failed *refresh* of the profile must not take the profile off the screen.
 *
 * `query-core`'s error action keeps the data it has and only flips `status` to
 * 'error', and `staleTime` is 0 with `focusManager` wired to `AppState` — so
 * every foreground refetches `['user', id]`, and one that fails on patchy signal
 * used to replace the header, the connection state and the whole timeline with
 * "Couldn't load this profile".
 */
describe('a refresh that fails', () => {
  /** Someone else's profile, so the fetch is live (your own is disabled). */
  function viewingAda() {
    mockParams.userId = '2';
    serve({
      user: profile({ id: 2, display_name: 'Ada Lovelace' }),
      posts: [makePost({ id: 5, text: 'A day on the hills' })],
    });
  }

  /** The profile request fails from here on; their posts keep working. */
  function breakTheProfile(status: number, reason: string) {
    const base = mockFetch.getMockImplementation()!;
    mockFetch.mockImplementation(
      async (url: string, init?: { method?: string }) =>
        url.includes('/api/users/') && !url.includes('/posts/')
          ? jsonResponse({ detail: reason }, status)
          : base(url, init)
    );
  }

  it('keeps the profile and its timeline', async () => {
    viewingAda();
    const { client } = await renderScreen();
    await screen.findByText('A day on the hills');
    breakTheProfile(503, 'Service unavailable.');

    await act(async () => {
      await client.invalidateQueries({ queryKey: ['user', 2] });
    });

    await waitFor(() =>
      expect(client.getQueryState(['user', 2])?.status).toBe('error')
    );
    // `getQueryState` reads the cache, which goes 'error' a render *before* the
    // screen does — React Query notifies through `notifyManager`, which batches
    // on a macrotask. Without this flush the assertions below run against the
    // pre-error tree and pass against a screen with the bug still in it.
    await settle(2);
    expect(screen.queryByText('Couldn’t load this profile')).toBeNull();
    expect(screen.getByText('A day on the hills')).toBeTruthy();
    expect(screen.getAllByText('Ada Lovelace').length).toBeGreaterThan(0);
  });

  it('still says the user is gone on a 404, even holding a copy', async () => {
    // A 404 is an answer about *now* — no such user — not a failure to ask, so
    // it outranks the cached copy.
    viewingAda();
    const { client } = await renderScreen();
    await screen.findByText('A day on the hills');
    breakTheProfile(404, 'Not found.');

    await act(async () => {
      await client.invalidateQueries({ queryKey: ['user', 2] });
    });

    expect(await screen.findByText('User not found')).toBeTruthy();
    expect(screen.queryByText('A day on the hills')).toBeNull();
  });

  it('still shows the error card when the first load fails', async () => {
    // Nothing cached to fall back on — the case the card is for.
    viewingAda();
    breakTheProfile(503, 'Service unavailable.');
    await renderScreen();

    expect(await screen.findByText('Couldn’t load this profile')).toBeTruthy();
  });
});

// --- A posts fetch that fails (#317) ----------------------------------------

/**
 * The mirror image of the block above: this screen read `userQuery.isError` and
 * never `postsQuery`'s, so a failed *timeline* fetch fell through to an empty
 * state that names the person while it says it — under a header that had loaded
 * perfectly, because it is a different query.
 */
describe('a posts fetch that fails', () => {
  /** Their posts fail from here on; the profile header keeps working. */
  function breakThePosts(reason = 'Server error.') {
    const base = mockFetch.getMockImplementation()!;
    mockFetch.mockImplementation(
      async (url: string, init?: { method?: string }) => {
        if (!url.includes('/posts/')) return base(url, init);
        // A macrotask late, as a real request is — an instant rejection settles
        // inside the render's own batch and doesn't behave like one.
        await new Promise((resolve) => setTimeout(resolve, 0));
        return jsonResponse({ detail: reason }, 500);
      }
    );
  }

  it('doesn’t say someone hasn’t posted when we couldn’t ask', async () => {
    mockParams.userId = '2';
    serve({ user: profile({ id: 2, display_name: 'Ada Lovelace' }) });
    breakThePosts();
    await renderScreen();

    expect(await screen.findByText('Couldn’t load these posts')).toBeTruthy();
    expect(screen.queryByText('Ada Lovelace hasn’t posted yet.')).toBeNull();
  });

  it('doesn’t say *you* haven’t posted when we couldn’t ask', async () => {
    // Worse on your own profile: `userQuery` is disabled entirely there, so the
    // posts query is the only thing that can fail — and the sentence it fell
    // through to was said to you about your own timeline.
    serve({ user: profile({ id: 1 }) });
    breakThePosts();
    await renderScreen();

    expect(await screen.findByText('Couldn’t load these posts')).toBeTruthy();
    expect(screen.queryByText('You haven’t posted yet.')).toBeNull();
  });

  it('keeps the posts already on screen when a refresh fails', async () => {
    // `isError && !data`, never a bare `isError` (#309/#311).
    mockParams.userId = '2';
    serve({
      user: profile({ id: 2, display_name: 'Ada Lovelace' }),
      posts: [makePost({ id: 5, text: 'A day on the hills' })],
    });
    const { client } = await renderScreen();
    await screen.findByText('A day on the hills');
    breakThePosts();

    await act(async () => {
      await client.invalidateQueries({ queryKey: ['userPosts', 2] });
    });
    await settle(2);

    expect(screen.getByText('A day on the hills')).toBeTruthy();
    expect(screen.queryByText('Couldn’t load these posts')).toBeNull();
  });
});

it('doesn’t contradict the empty state when a refresh of it fails', async () => {
  // Ada really has posted nothing: page one comes back `{count: 0, results: []}`,
  // so `postsQuery.data` is defined and `rows` is empty. A foreground refetch
  // then fails — routine, since `staleTime` is 0. Keyed off `data`, the partial
  // note would print "Couldn't load any older posts." directly under "Ada hasn't
  // posted yet": two claims at once, the second wrong twice over since no posts
  // loaded to be older than.
  mockParams.userId = '2';
  serve({ user: profile({ id: 2, display_name: 'Ada Lovelace' }), posts: [] });
  const { client } = await renderScreen();
  await screen.findByText('Ada Lovelace hasn’t posted yet.');

  const base = mockFetch.getMockImplementation()!;
  mockFetch.mockImplementation(
    async (url: string, init?: { method?: string }) => {
      if (!url.includes('/posts/')) return base(url, init);
      await new Promise((resolve) => setTimeout(resolve, 0));
      return jsonResponse({ detail: 'Server error.' }, 500);
    }
  );
  await act(async () => {
    await client.invalidateQueries({ queryKey: ['userPosts', 2] });
  });
  await settle(2);

  expect(screen.getByText('Ada Lovelace hasn’t posted yet.')).toBeTruthy();
  expect(screen.queryByText('Couldn’t load any older posts.')).toBeNull();
});
