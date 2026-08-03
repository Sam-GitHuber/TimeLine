/**
 * The shared photo picker (`photoSource.tsx`) — the "camera or library?" step
 * every screen that adds a photo goes through.
 *
 * The screens that use it have their own tests, but they only reach the happy
 * paths their own flow takes. Pinned here is what's easy to get wrong once and
 * then have wrong on four screens at once: that **every** way of backing out
 * resolves (an unresolved promise is an "Add photo" button that silently does
 * nothing forever), that the camera is never launched without permission, and
 * that a native failure is reported rather than swallowed.
 *
 * The suite runs under both platform projects, so each of these is asserted
 * against the sheet the platform actually presents — `helpers.ts` absorbs the
 * iOS/Android difference.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import * as ImagePicker from 'expo-image-picker';
import { Pressable, Text } from 'react-native';

import { usePhotoPicker, type PickPhotosOptions } from '@/photoSource';
import {
  alertSpy,
  cancelMenu,
  choosePhotoSource,
  menuOptions,
  resetMenuSpies,
} from './helpers';

jest.mock('expo-image-picker', () => ({
  launchImageLibraryAsync: jest.fn(),
  launchCameraAsync: jest.fn(),
  requestCameraPermissionsAsync: jest.fn(),
}));

const pick = ImagePicker.launchImageLibraryAsync as jest.Mock;
const takePhoto = ImagePicker.launchCameraAsync as jest.Mock;
const askCamera = ImagePicker.requestCameraPermissionsAsync as jest.Mock;

const PICKED = {
  canceled: false,
  assets: [{ uri: 'file:///tmp/a.jpg', width: 100, height: 100 }],
};

/** What the last finished `pickPhotos` resolved to. */
let result: unknown;

/**
 * A one-button harness, because `usePhotoPicker` is a hook: it needs a host to
 * run in and a place to render `photoMenu`, which on Android *is* the sheet.
 */
function Harness({ options }: { options?: PickPhotosOptions }) {
  const { pickPhotos, photoMenu } = usePhotoPicker();
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Add a photo"
        onPress={async () => {
          result = await pickPhotos('Add a photo', options);
        }}
      >
        <Text>Add</Text>
      </Pressable>
      {photoMenu}
    </>
  );
}

/** Open the menu. **Not** awaited: the press only settles once a choice lands. */
async function openPicker(options?: PickPhotosOptions) {
  // `render` is a promise in this RNTL version — without the await, `screen`
  // has nothing mounted yet.
  await render(<Harness options={options} />);
  fireEvent.press(screen.getByLabelText('Add a photo'));
}

beforeEach(() => {
  result = undefined;
  pick.mockReset().mockResolvedValue(PICKED);
  takePhoto.mockReset().mockResolvedValue(PICKED);
  askCamera.mockReset().mockResolvedValue({ granted: true, canAskAgain: true });
  resetMenuSpies();
});

describe('choosing a source', () => {
  it('offers the camera before the library', async () => {
    await openPicker();

    // Order is the point: on a phone the photo you want most often is the one
    // you haven't taken yet. Read off the sheet the platform really draws —
    // asserting the array we handed the menu is how Android assertions used to
    // certify buttons the OS had discarded (see `helpers.menuOptions`).
    await waitFor(() =>
      expect(menuOptions()).toEqual(['Take Photo', 'Choose from Library'])
    );
  });

  it('takes a photo when the camera is chosen', async () => {
    await openPicker();
    await choosePhotoSource('Take Photo');

    await waitFor(() => expect(result).toEqual(PICKED.assets));
    expect(pick).not.toHaveBeenCalled();
  });

  it('opens the library when that is chosen', async () => {
    await openPicker();
    await choosePhotoSource('Choose from Library');

    await waitFor(() => expect(result).toEqual(PICKED.assets));
    expect(takePhoto).not.toHaveBeenCalled();
  });

  it('resolves to nothing when the sheet is dismissed', async () => {
    // 🔒 The one that has to hold: dismissal is a *third* outcome next to the
    // two buttons, and if it doesn't settle the promise the caller waits
    // forever — leaving a button that does nothing for the rest of the
    // screen's life. Covers Cancel on iOS and Cancel / backdrop / Back on
    // Android, which all land on the same `onCancel`.
    await openPicker();
    await waitFor(() => expect(menuOptions().length).toBe(2));
    cancelMenu();

    await waitFor(() => expect(result).toBeNull());
    expect(pick).not.toHaveBeenCalled();
    expect(takePhoto).not.toHaveBeenCalled();
  });

  it('resolves to nothing when the picker itself is cancelled', async () => {
    pick.mockResolvedValue({ canceled: true });
    await openPicker();
    await choosePhotoSource('Choose from Library');

    await waitFor(() => expect(result).toBeNull());
  });

  it('resolves to nothing when a picker returns no assets', async () => {
    // Shouldn't happen, but reaching into `assets[0]` on the assumption is how
    // a picker turns into "cannot read property 'uri' of undefined".
    pick.mockResolvedValue({ canceled: false, assets: [] });
    await openPicker();
    await choosePhotoSource('Choose from Library');

    await waitFor(() => expect(result).toBeNull());
  });
});

describe('camera permission', () => {
  it('asks before opening the camera', async () => {
    // 🔒 iOS terminates an app that reaches for a camera it was refused, so the
    // order matters: permission first, camera only if granted.
    await openPicker();
    await choosePhotoSource('Take Photo');

    await waitFor(() => expect(takePhoto).toHaveBeenCalled());
    expect(askCamera).toHaveBeenCalled();
  });

  it('opens nothing and says so when access is refused', async () => {
    askCamera.mockResolvedValue({ granted: false, canAskAgain: false });
    await openPicker();
    await choosePhotoSource('Take Photo');

    await waitFor(() => expect(result).toBeNull());
    expect(takePhoto).not.toHaveBeenCalled();
    expect(alertSpy).toHaveBeenCalledWith(
      'Camera access needed',
      expect.stringContaining('Settings')
    );
  });

  it('does not send you to Settings when the OS will ask again', async () => {
    // Android's first "Deny" leaves `canAskAgain` true — tapping again
    // re-prompts. Sending someone to a Settings toggle that doesn't exist yet
    // reads as the app being broken.
    askCamera.mockResolvedValue({ granted: false, canAskAgain: true });
    await openPicker();
    await choosePhotoSource('Take Photo');

    await waitFor(() => expect(result).toBeNull());
    const [, message] = alertSpy.mock.calls.at(-1) ?? [];
    expect(String(message)).not.toContain('Settings');
    expect(String(message)).toContain('again');
  });

  it('does not ask for permission to open the library', async () => {
    // The modern picker runs out of process and hands back only what was
    // chosen, so a library prompt would be a prompt for nothing.
    await openPicker();
    await choosePhotoSource('Choose from Library');

    await waitFor(() => expect(pick).toHaveBeenCalled());
    expect(askCamera).not.toHaveBeenCalled();
  });
});

describe('when the native picker fails', () => {
  it('reports a camera failure instead of dying quietly', async () => {
    // No camera on the device or simulator, no current view controller, a
    // failed write — all reject. Uncaught, that's a floating promise: the sheet
    // closes, nothing happens, nothing is said.
    takePhoto.mockRejectedValue(new Error('Camera not available on simulator'));
    await openPicker();
    await choosePhotoSource('Take Photo');

    await waitFor(() => expect(result).toBeNull());
    expect(alertSpy).toHaveBeenCalledWith(
      'Couldn’t open the camera',
      expect.any(String)
    );
  });

  it('reports a library failure too', async () => {
    pick.mockRejectedValue(new Error('nope'));
    await openPicker();
    await choosePhotoSource('Choose from Library');

    await waitFor(() => expect(result).toBeNull());
    expect(alertSpy).toHaveBeenCalledWith(
      'Couldn’t open your photos',
      expect.any(String)
    );
  });
});

describe('picker options', () => {
  it('passes multi-select and quality to the library', async () => {
    await openPicker({ allowsMultipleSelection: true, selectionLimit: 4, quality: 0.9 });
    await choosePhotoSource('Choose from Library');

    await waitFor(() =>
      expect(pick).toHaveBeenCalledWith(
        expect.objectContaining({
          mediaTypes: ['images'],
          allowsMultipleSelection: true,
          selectionLimit: 4,
          // Pinned, not just defaulted: the post composer deliberately picks at
          // 0.9 because its photos are uploaded as picked, and hard-coding the
          // default here would silently revert that.
          quality: 0.9,
        })
      )
    );
  });

  it('never sends multi-select to the camera, which returns one shot', async () => {
    await openPicker({ allowsMultipleSelection: true, selectionLimit: 4 });
    await choosePhotoSource('Take Photo');

    await waitFor(() => expect(takePhoto).toHaveBeenCalledWith({ quality: 1 }));
  });

  it('leaves the pick uncompressed by default', async () => {
    // Callers that re-encode afterwards (chat photos, avatar crops) want the
    // full-quality pick: compressing twice throws detail away before the step
    // that decides how much to keep.
    await openPicker();
    await choosePhotoSource('Choose from Library');

    await waitFor(() =>
      expect(pick).toHaveBeenCalledWith(expect.objectContaining({ quality: 1 }))
    );
  });
});

afterAll(() => alertSpy.mockRestore());
