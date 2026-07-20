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
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import * as ImagePicker from 'expo-image-picker';

import ProfileScreen from '@/app/u/[userId]';
import { AuthProvider } from '@/auth';
import { PostCard } from '@/components/PostCard';
import { saveTokens } from '@/tokens';
import type { Post, ProfileUser, User } from '@/types';

// A mutable route param so each test can view a different person. Both this and
// the router spy are `mock`-prefixed so Jest lets the factory below close over
// them (its one exception to the out-of-scope-variable rule).
const mockParams: { userId: string } = { userId: '1' };
const mockPush = jest.fn();

jest.mock('expo-router', () => ({
  useLocalSearchParams: () => mockParams,
  // `push` reads `mockPush` lazily: the factory runs while the hoisted imports
  // load expo-router, which is *before* the `const mockPush` line executes, so
  // referencing it directly would capture `undefined`. An arrow defers the read
  // to call time, by when it's initialised.
  router: {
    push: (...args: unknown[]) => mockPush(...args),
    back: jest.fn(),
    replace: jest.fn(),
    canGoBack: () => true,
  },
}));

jest.mock('expo-image-picker', () => ({
  launchImageLibraryAsync: jest.fn(),
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

async function renderScreen() {
  // Prime a session so the real AuthProvider resolves to `me` rather than the
  // signed-out state — the screen's self/other branch turns on `me.pk`.
  await saveTokens({ access: 'access-token', refresh: 'refresh-token' });
  return render(
    <QueryClientProvider client={makeQueryClient()}>
      <AuthProvider>
        <ProfileScreen />
      </AuthProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  mockFetch.mockReset();
  pick.mockReset();
  resetMe();
  mockParams.userId = '1';
  mockPush.mockReset();
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
    // No avatar yet, so the button offers to add one.
    await fireEvent.press(await screen.findByRole('button', { name: 'Add photo' }));
    // The picked photo goes to the crop modal, which returns the reframed square.
    await fireEvent.press(await screen.findByText('Use photo (test)'));

    // A cropped avatar is now staged: the editor lets you change or remove it.
    expect(await screen.findByRole('button', { name: 'Remove' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Change photo' })).toBeTruthy();
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
});

describe('reaching a profile', () => {
  it('opens the author’s profile when their name is tapped on a post', async () => {
    await render(
      <QueryClientProvider client={makeQueryClient()}>
        <PostCard post={makePost({ id: 9, author: { id: 42, display_name: 'Carol Clark', avatar_thumb: null } })} />
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
