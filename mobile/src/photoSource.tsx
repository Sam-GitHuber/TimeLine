/**
 * Adding a photo, from the camera or the library — the whole flow, once.
 *
 * Every place in the app that takes a photo (a post, a chat message, a profile
 * or group avatar) asks **"Take Photo / Choose from Library"** first. On a phone
 * "add a photo" very often means "take one right now", and bouncing someone out
 * to the camera app and back is the kind of friction that makes an app feel like
 * a website with a wrapper.
 *
 * **What the caller gets is assets or nothing.** The prompt, the permission, the
 * launch, the three separate ways to back out and the errors all collapse to a
 * single `await`, because the fragile part was never the wording — it was the
 * five-step dance around it, which drifted between screens the first time it was
 * copied (one guarded an empty `assets`, two didn't). One `if (!assets) return;`
 * per screen is the whole contract.
 *
 * **Why a menu and not `Alert`.** This is a menu — pick one of two actions — and
 * `ActionMenu`'s docblock records what Android's `Alert` does to one: it maps
 * buttons to neutral/negative/positive in *reverse* array order, so "Cancel"
 * would land in the emphasised primary slot and "Take Photo" in the throwaway
 * neutral one, and it ignores per-button `style` entirely. It also defaults to
 * `cancelable: false`, so Back wouldn't dismiss it. Going through the same sheet
 * as every other menu in the app gets all of that right, and gets a real
 * dismissal signal (`onCancel`) so an awaited prompt can't hang.
 */

import * as ImagePicker from 'expo-image-picker';
import { useCallback } from 'react';
import { Alert } from 'react-native';

import { useActionMenu } from '@/components/ActionMenu';

export type PickPhotosOptions = {
  /** Library only — the camera returns exactly one shot. */
  allowsMultipleSelection?: boolean;
  selectionLimit?: number;
  /**
   * Compression at the *pick*, defaulting to full quality. Leave it alone where
   * the image is re-encoded again afterwards (chat photos, avatar crops):
   * compressing twice only throws away detail before the step that decides how
   * much to keep.
   */
  quality?: number;
};

/**
 * Returns `pickPhotos`, plus the menu element to render.
 *
 * `photoMenu` is `null` on iOS (`ActionSheetIOS` draws nothing in the tree), so
 * callers render `{photoMenu}` unconditionally and it costs nothing there.
 *
 * ```tsx
 * const { pickPhotos, photoMenu } = usePhotoPicker();
 * // …
 * const assets = await pickPhotos('Add a photo');
 * if (!assets) return;          // backed out, refused, or failed — already told
 * ```
 */
export function usePhotoPicker(): {
  pickPhotos: (
    title: string,
    options?: PickPhotosOptions
  ) => Promise<ImagePicker.ImagePickerAsset[] | null>;
  photoMenu: React.ReactElement | null;
} {
  const { openMenu, menu } = useActionMenu();

  const pickPhotos = useCallback(
    async (title: string, options: PickPhotosOptions = {}) => {
      const source = await new Promise<'camera' | 'library' | null>(
        (resolve) => {
          openMenu({
            title,
            items: [
              { label: 'Take Photo', onPress: () => resolve('camera') },
              { label: 'Choose from Library', onPress: () => resolve('library') },
            ],
            // Without this the promise never settles when the sheet is
            // dismissed, and the button is dead for the rest of the screen's
            // life.
            onCancel: () => resolve(null),
          });
        }
      );
      if (!source) return null;

      const result = await launch(source, options);
      // `null` = refused or failed, and the person has already been told why.
      // `canceled` = they changed their mind, which needs no telling.
      if (!result || result.canceled) return null;
      // A `canceled: false` result with nothing in it shouldn't happen, but
      // reaching into `assets[0]` on the assumption is how a picker turns into
      // a "cannot read property 'uri' of undefined" and a dead button.
      if (!result.assets?.length) return null;
      return result.assets;
    },
    [openMenu]
  );

  return { pickPhotos, photoMenu: menu };
}

async function launch(
  source: 'camera' | 'library',
  options: PickPhotosOptions
): Promise<ImagePicker.ImagePickerResult | null> {
  try {
    if (source === 'camera') {
      // The camera *does* need permission — unlike the modern library picker,
      // which runs out of process and hands back only what was chosen, so
      // asking for library access would be a prompt for nothing.
      const permission = await ImagePicker.requestCameraPermissionsAsync();
      if (!permission.granted) {
        // 🔒 Silently doing nothing after someone taps "Take Photo" reads as a
        // broken button. Which sentence they get matters too: on Android a
        // first "Deny" leaves `canAskAgain` true and tapping again re-prompts,
        // so sending them to Settings for a toggle that isn't there yet would
        // be the app misleading them about its own state.
        Alert.alert(
          'Camera access needed',
          permission.canAskAgain
            ? 'TimeLine needs your permission to use the camera. Tap “Take Photo” again to allow it.'
            : 'Allow camera access in Settings to take a photo here.'
        );
        return null;
      }
      return await ImagePicker.launchCameraAsync({
        quality: options.quality ?? 1,
      });
    }

    return await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: options.quality ?? 1,
      ...(options.allowsMultipleSelection
        ? {
            allowsMultipleSelection: true,
            selectionLimit: options.selectionLimit,
          }
        : {}),
    });
  } catch {
    // The native side rejects for a handful of real reasons — no camera on the
    // device or simulator, no current view controller, a failed write — and an
    // uncaught rejection here is a floating promise: the sheet closes, nothing
    // happens, nothing is said. Say something instead.
    Alert.alert(
      source === 'camera' ? 'Couldn’t open the camera' : 'Couldn’t open your photos',
      'Something went wrong. Please try again.'
    );
    return null;
  }
}
