/**
 * The group create/edit form's photo picking.
 *
 * A group avatar is picked exactly the way a profile photo is — the shared
 * "camera or library?" step in `photoSource.tsx`, then the same round cropper —
 * and this is the surface where that wiring was easiest to leave behind, since
 * the form had no test of its own. What's pinned is that both sources reach the
 * cropper and that the reframed square is what gets uploaded, never the original
 * (which is the wrong shape and carries the camera's EXIF).
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import * as ImagePicker from 'expo-image-picker';

import { router } from 'expo-router';

import { api, ApiError } from '@/api';
import NewGroupScreen from '@/app/groups/new';
import { GroupForm } from '@/components/GroupForm';

import {
  androidIt,
  captureBackHandler,
  choosePhotoSource,
  pressBack,
  resetMenuSpies,
} from './helpers';

jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn() },
  // The form holds both navigator-owned ways off the screen while its write is
  // out (#259), and both need a navigator: `useAndroidBack` scopes itself to
  // focus, and the swipe hold sets an option on the screen. Same stand-ins as
  // `jest.setup.js`, whose global stubs this factory overrides.
  useFocusEffect: (callback: () => void | (() => void)) =>
    // `require`, not an import: the factory is hoisted above the imports.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('react').useEffect(callback, [callback]),
  useNavigation: () => ({ setOptions: () => {} }),
}));

jest.mock('expo-image-picker', () => ({
  launchImageLibraryAsync: jest.fn(),
  launchCameraAsync: jest.fn(),
  requestCameraPermissionsAsync: jest.fn(),
}));

// Same stand-in as `profile.test.tsx`: the real cropper needs reanimated,
// gesture-handler and native image work, none of which run under Jest, and its
// geometry is covered by `avatarCrop.test.ts`. Here it's a button that hands
// back a cropped file, so the pick → reframe → attach wiring is what's tested.
jest.mock('@/components/AvatarCropModal', () => {
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
              uri: 'file:///tmp/group-cropped.jpg',
              name: 'group.jpg',
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

const PICKED = {
  canceled: false,
  assets: [{ uri: 'file:///tmp/original.jpg', width: 1200, height: 900 }],
};

let createGroup: jest.SpyInstance;

beforeEach(() => {
  pick.mockReset();
  takePhoto.mockReset();
  askCamera.mockReset().mockResolvedValue({ granted: true, canAskAgain: true });
  resetMenuSpies();
  (router.replace as jest.Mock).mockReset();
  createGroup = jest
    .spyOn(api, 'createGroup')
    .mockResolvedValue({ id: 7 } as Awaited<ReturnType<typeof api.createGroup>>);
});

afterEach(() => createGroup.mockRestore());

function renderForm() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { gcTime: 0 },
    },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <GroupForm mode="create" />
    </QueryClientProvider>
  );
}

it('picks a group photo from the library and uploads the reframed square', async () => {
  pick.mockResolvedValue(PICKED);
  await renderForm();

  await fireEvent.changeText(screen.getByLabelText('Group name'), 'Book Club');
  // Not awaited: the press doesn't settle until the source sheet is answered.
  fireEvent.press(screen.getByRole('button', { name: 'Add photo' }));
  await choosePhotoSource('Choose from Library');
  await fireEvent.press(await screen.findByText('Use photo (test)'));

  // Staged, not uploaded yet — the label flips and a Remove appears.
  expect(await screen.findByRole('button', { name: 'Change photo' })).toBeTruthy();

  await fireEvent.press(screen.getByRole('button', { name: 'Create group' }));

  // Waits on what the mutation's **success** produces, not on the call going
  // out: `onSuccess` (invalidate + navigate) runs a tick after the mutation
  // function is entered, so asserting on the call alone lets the test end with
  // React still updating — an intermittent "not wrapped in act(...)" that only
  // shows up when the whole suite runs.
  await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/groups/7'));
  expect(createGroup).toHaveBeenCalledWith(
    expect.objectContaining({
      name: 'Book Club',
      avatar: expect.objectContaining({ uri: 'file:///tmp/group-cropped.jpg' }),
    })
  );
});

it('lets you take the group photo with the camera', async () => {
  takePhoto.mockResolvedValue(PICKED);
  await renderForm();

  fireEvent.press(screen.getByRole('button', { name: 'Add photo' }));
  await choosePhotoSource('Take Photo');
  await fireEvent.press(await screen.findByText('Use photo (test)'));

  expect(await screen.findByRole('button', { name: 'Change photo' })).toBeTruthy();
  expect(pick).not.toHaveBeenCalled();
});

/**
 * Offline, the form says so in its own words (#243).
 *
 * `onSuccess` never navigates, so the screen is all anyone has to go on — and it
 * used to read React Native's `Network request failed`. Nothing in that says
 * whether the group exists, so the reasonable move is to press Create again,
 * which is how you end up with two.
 */
it('says its own sentence when the create never reaches the server', async () => {
  // The shape `request` produces for a lost connection, not the bare `TypeError`
  // it started as: this suite spies on `api.createGroup`, so a raw `TypeError`
  // here would exercise a rejection production can no longer emit — and would
  // stay green with `api.ts`'s guard deleted. The guard itself is pinned in
  // `api.test.ts` and, end to end through `fetch`, in `settings.test.tsx`; what
  // this pins is the call site.
  createGroup.mockRejectedValue(
    new ApiError(
      'Couldn’t reach the server — check your connection and try again.',
      0,
      null,
      false
    )
  );
  await renderForm();

  await fireEvent.changeText(screen.getByLabelText('Group name'), 'Book Club');
  await fireEvent.press(screen.getByRole('button', { name: 'Create group' }));

  expect(await screen.findByText('Couldn’t save the group.')).toBeTruthy();
  expect(screen.queryByText('Network request failed')).toBeNull();
  expect(router.replace).not.toHaveBeenCalled();
});

/**
 * Nothing leaves the screen while the write is out (#259).
 *
 * This form has **no Cancel** — the ways out are the screen's "← Back",
 * Android's hardware back and iOS's swipe — so "gate the Cancel" has nothing to
 * gate here. All three unmount the screen, and the error above the button is the
 * only renderer of a refusal: press Create, leave, and a POST that 400s leaves
 * you on the Groups tab with no group and nothing said.
 */
describe('holding the group form open until the server answers', () => {
  /** Start a create that won't answer until the returned `refuse` is called. */
  function stall() {
    let refuse: (error: Error) => void = () => {};
    createGroup.mockReturnValue(
      new Promise((_resolve, reject) => {
        refuse = reject;
      }) as ReturnType<typeof api.createGroup>
    );
    return {
      refuse: async (message: string) => {
        await act(async () => {
          // An `ApiError` carrying DRF's `detail`, which is what `request()`
          // raises for a 400 — and what the form has to be handed for the
          // server's own sentence to reach the screen. A bare `Error` is the
          // shape of a *lost connection*, and since #243 that deliberately
          // shows our fallback instead.
          refuse(new ApiError(message, 400, { detail: message }));
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
      },
    };
  }

  androidIt('refuses hardware back, then shows the refusal', async () => {
    captureBackHandler();
    await renderForm();
    await fireEvent.changeText(screen.getByLabelText('Group name'), 'Book Club');

    const server = stall();
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Create group' }));
    });
    // `find`, not `get`: React Query dispatches the pending state through its
    // notify manager, so it lands a macrotask after the press — assert too
    // early and the rest of the test proves nothing.
    expect(await screen.findByText('Creating…')).toBeTruthy();

    await act(async () => {
      // Claimed, not passed on: falling through would pop the screen and take
      // the error with it.
      expect(pressBack()).toBe(true);
    });

    await server.refuse('A group with that name already exists.');
    expect(
      await screen.findByText('A group with that name already exists.')
    ).toBeTruthy();
  });

  it('refuses the screen’s Back, then shows the refusal', async () => {
    // The Back belongs to the screen and the mutation to the form, so this
    // passes only because the form declares its write to the screen's hold.
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: 0 },
        mutations: { gcTime: 0 },
      },
    });
    await render(
      <QueryClientProvider client={queryClient}>
        <NewGroupScreen />
      </QueryClientProvider>
    );
    await fireEvent.changeText(screen.getByLabelText('Group name'), 'Book Club');

    const server = stall();
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Create group' }));
    });
    expect(await screen.findByText('Creating…')).toBeTruthy();

    await fireEvent.press(screen.getByLabelText('Back'));
    expect(router.back).not.toHaveBeenCalled();

    await server.refuse('A group with that name already exists.');
    expect(
      await screen.findByText('A group with that name already exists.')
    ).toBeTruthy();
  });
});
