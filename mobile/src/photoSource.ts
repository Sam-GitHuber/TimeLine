/**
 * Where a photo comes from: the camera, or the library.
 *
 * Every place in the app that takes a photo — a post, a chat message, a profile
 * or group avatar — should offer both. On a phone, "add a photo" very often
 * means "take one right now", and bouncing someone out to the camera app and
 * back is the kind of friction that makes an app feel like a website with a
 * wrapper. This module is the one place that asks, so the wording, the button
 * order and the permission handling can't drift between screens.
 *
 * A plain `Alert` rather than a native action sheet: three choices, one of them
 * Cancel, and it's the pattern these screens already use — an extra dependency
 * for a rounder sheet isn't worth it.
 */

import * as ImagePicker from 'expo-image-picker';
import { Alert } from 'react-native';

export type PhotoSource = 'camera' | 'library';

/**
 * Ask where the photo should come from. Resolves `null` if the person backs out.
 *
 * `Alert`'s API is callbacks, and every caller wants to `await` the answer
 * before launching a picker, so it's wrapped in a promise here rather than in
 * four different screens.
 */
export function askPhotoSource(title: string): Promise<PhotoSource | null> {
  return new Promise((resolve) => {
    Alert.alert(
      title,
      undefined,
      [
        { text: 'Take Photo', onPress: () => resolve('camera') },
        { text: 'Choose from Library', onPress: () => resolve('library') },
        { text: 'Cancel', style: 'cancel', onPress: () => resolve(null) },
      ],
      // Android dismisses an alert on Back without firing any button, which
      // would otherwise leave the caller awaiting a promise that never settles.
      { onDismiss: () => resolve(null) }
    );
  });
}

/**
 * Launch the picker for `source`, or `null` if the camera was refused.
 *
 * `null` rather than an exception because a refused permission isn't an error —
 * the person has been told what to do about it and the caller should simply do
 * nothing. A cancelled picker comes back as the picker's own `canceled` result,
 * which callers already handle.
 *
 * The options apply to the library only; the camera returns exactly one shot.
 */
export async function launchPhotoPicker(
  source: PhotoSource,
  options: {
    allowsMultipleSelection?: boolean;
    selectionLimit?: number;
    /**
     * Compression at the *pick*. Pass 1 where the image is re-encoded again
     * afterwards (chat photos, avatar crops) — compressing twice only throws
     * away detail before the step that decides how much to keep.
     */
    quality?: number;
  } = {}
): Promise<ImagePicker.ImagePickerResult | null> {
  if (source === 'camera') {
    // The camera *does* need permission — unlike the modern library picker,
    // which runs out of process and hands back only what was chosen.
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      Alert.alert(
        'Camera access needed',
        'Allow camera access in Settings to take a photo here.'
      );
      return null;
    }
    return ImagePicker.launchCameraAsync({ quality: options.quality ?? 1 });
  }

  return ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    quality: options.quality ?? 1,
    ...(options.allowsMultipleSelection
      ? {
          allowsMultipleSelection: true,
          selectionLimit: options.selectionLimit,
        }
      : {}),
  });
}
