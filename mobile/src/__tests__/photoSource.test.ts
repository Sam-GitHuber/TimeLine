/**
 * The shared "camera or library?" step every photo picker in the app goes
 * through (`photoSource.ts`).
 *
 * The screens that use it have their own tests, but they can only see the happy
 * paths their own flow reaches. What's pinned here is the parts that are easy to
 * get wrong once and then have wrong everywhere: that backing out resolves
 * rather than hanging (an unresolved promise is an "Add photo" button that
 * silently does nothing forever), and that the camera is never launched without
 * permission — iOS terminates an app that tries.
 */

import * as ImagePicker from 'expo-image-picker';
import { Alert } from 'react-native';

import { askPhotoSource, launchPhotoPicker } from '@/photoSource';

jest.mock('expo-image-picker', () => ({
  launchImageLibraryAsync: jest.fn(),
  launchCameraAsync: jest.fn(),
  requestCameraPermissionsAsync: jest.fn(),
}));

const pick = ImagePicker.launchImageLibraryAsync as jest.Mock;
const takePhoto = ImagePicker.launchCameraAsync as jest.Mock;
const askCamera = ImagePicker.requestCameraPermissionsAsync as jest.Mock;
const alertSpy = jest.spyOn(Alert, 'alert');

type AlertButton = { text?: string; onPress?: () => void };
type AlertOptions = { onDismiss?: () => void };

/** The arguments of the most recent `Alert.alert`, typed for poking at. */
function lastAlert() {
  const call = alertSpy.mock.calls.at(-1);
  if (!call) throw new Error('no alert was shown');
  return {
    title: call[0],
    buttons: (call[2] ?? []) as AlertButton[],
    options: (call[3] ?? {}) as AlertOptions,
  };
}

beforeEach(() => {
  pick.mockReset().mockResolvedValue({ canceled: true });
  takePhoto.mockReset().mockResolvedValue({ canceled: true });
  askCamera.mockReset().mockResolvedValue({ granted: true });
  alertSpy.mockReset().mockImplementation(() => {});
});

afterAll(() => alertSpy.mockRestore());

describe('askPhotoSource', () => {
  it('offers the camera before the library', async () => {
    const answer = askPhotoSource('Add a photo');
    const { title, buttons } = lastAlert();

    expect(title).toBe('Add a photo');
    // Order is the point: on a phone the photo you want most often is the one
    // you haven't taken yet.
    expect(buttons.map((button) => button.text)).toEqual([
      'Take Photo',
      'Choose from Library',
      'Cancel',
    ]);

    buttons[0].onPress?.();
    expect(await answer).toBe('camera');
  });

  it('resolves to the library when that is chosen', async () => {
    const answer = askPhotoSource('Add a photo');
    lastAlert().buttons[1].onPress?.();

    expect(await answer).toBe('library');
  });

  it('resolves to nothing on Cancel', async () => {
    const answer = askPhotoSource('Add a photo');
    lastAlert().buttons[2].onPress?.();

    expect(await answer).toBeNull();
  });

  it('resolves to nothing when the dialog is dismissed', async () => {
    // Android's Back dismisses an alert without firing any button. Without an
    // `onDismiss`, the caller would await a promise that never settles and the
    // button would be dead for the rest of the screen's life.
    const answer = askPhotoSource('Add a photo');
    lastAlert().options.onDismiss?.();

    expect(await answer).toBeNull();
  });
});

describe('launchPhotoPicker', () => {
  it('asks for camera permission before opening the camera', async () => {
    // 🔒 iOS terminates an app that reaches for the camera it was refused, so
    // the order matters: permission first, camera only if granted.
    await launchPhotoPicker('camera');

    expect(askCamera).toHaveBeenCalled();
    expect(takePhoto).toHaveBeenCalled();
  });

  it('says so and opens nothing when camera access is refused', async () => {
    askCamera.mockResolvedValue({ granted: false });

    const result = await launchPhotoPicker('camera');

    expect(result).toBeNull();
    expect(takePhoto).not.toHaveBeenCalled();
    expect(alertSpy).toHaveBeenCalledWith(
      'Camera access needed',
      expect.stringContaining('Settings')
    );
  });

  it('opens the library without asking for permission', async () => {
    // The modern picker runs out of process and hands back only what was
    // chosen, so asking for library access would be a prompt for nothing.
    await launchPhotoPicker('library');

    expect(askCamera).not.toHaveBeenCalled();
    expect(pick).toHaveBeenCalledWith(
      expect.objectContaining({ mediaTypes: ['images'] })
    );
  });

  it('passes a multi-select limit to the library only', async () => {
    await launchPhotoPicker('library', {
      allowsMultipleSelection: true,
      selectionLimit: 4,
      quality: 0.9,
    });
    expect(pick).toHaveBeenCalledWith(
      expect.objectContaining({ allowsMultipleSelection: true, selectionLimit: 4 })
    );

    // The camera returns one shot; handing it a selection limit would be
    // meaningless, and `allowsMultipleSelection` is not a camera option at all.
    await launchPhotoPicker('camera', {
      allowsMultipleSelection: true,
      selectionLimit: 4,
    });
    expect(takePhoto).toHaveBeenCalledWith({ quality: 1 });
  });

  it('leaves the pick uncompressed unless asked', async () => {
    // Callers that re-encode afterwards (chat photos, avatar crops) want the
    // full-quality pick — compressing twice throws detail away before the step
    // that decides how much to keep.
    await launchPhotoPicker('library');
    expect(pick).toHaveBeenCalledWith(expect.objectContaining({ quality: 1 }));
  });
});
