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
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import * as ImagePicker from 'expo-image-picker';

import { router } from 'expo-router';

import { api } from '@/api';
import { GroupForm } from '@/components/GroupForm';
import { choosePhotoSource, resetMenuSpies } from './helpers';

jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn() },
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
