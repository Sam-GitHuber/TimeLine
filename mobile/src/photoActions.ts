/**
 * Save a photo to the camera roll, or hand it to another app (#396).
 *
 * Both start the same way: **download the full-size file into the cache**.
 * Neither the photo library nor the share sheet can take a URL behind our
 * `forward_auth` — they'd fetch it bare and get a 401 — so the bytes have to be
 * on the device first, fetched with the same bearer header `AuthedImage` sends.
 *
 * **Privacy.** Saving or sharing takes a friend's photo outside the app's access
 * control: once it's in someone's camera roll, deleting the post or leaving the
 * group doesn't take it back. That was already true of a screenshot, so it isn't
 * a reason not to offer it, but it's written down in feed-and-posts.md so it's a
 * known property rather than a surprise.
 */

import { File, Paths } from 'expo-file-system';
// `/legacy`, not the package root: from SDK 55 the root exports the new
// object API, where `saveToLibraryAsync` is a stub that throws. The legacy call
// is the one that works on **add-only** access — `Asset.create` returns the new
// asset, which needs read access to the library, and asking for that just to
// save a photo is a permission this app has no use for.
import { requestPermissionsAsync, saveToLibraryAsync } from 'expo-media-library/legacy';
import * as Sharing from 'expo-sharing';

import { mediaHeaders } from '@/components/AuthedImage';

/**
 * Put the photo at `uri` in the cache and return a local `file://` URI for it.
 *
 * Named after the server's own filename (a random hex plus the real extension,
 * see `imaging.py`'s `_uuid_name`), because the library and the share sheet
 * both read the type off the extension — a file with none is refused by the
 * library on Android. `idempotent` overwrites a previous download of the same
 * photo rather than failing on it.
 *
 * A URI that's already local (a photo still in the outbox) is used as it is.
 */
async function downloadPhoto(uri: string): Promise<string> {
  if (uri.startsWith('file:')) return uri;
  const name = uri.split('?')[0].split('/').pop() || `photo-${Date.now()}.jpg`;
  const file = await File.downloadFileAsync(uri, new File(Paths.cache, name), {
    headers: mediaHeaders(uri),
    idempotent: true,
  });
  return file.uri;
}

/**
 * Save the photo to the camera roll. Resolves `'denied'` when the person said
 * no (or said no before), so the caller can point them at Settings; throws when
 * the download or the save itself fails.
 *
 * `writeOnly` is the whole permission story: on iOS it asks for "add photos
 * only" (`NSPhotoLibraryAddUsageDescription`), never to read the library; on
 * Android 13+ saving needs no permission at all, and before that the
 * `WRITE_EXTERNAL_STORAGE` the photo picker already declares.
 */
export async function savePhoto(uri: string): Promise<'saved' | 'denied'> {
  const permission = await requestPermissionsAsync(true);
  if (!permission.granted) return 'denied';
  await saveToLibraryAsync(await downloadPhoto(uri));
  return 'saved';
}

/** Open the system share sheet on the photo. */
export async function sharePhoto(uri: string): Promise<void> {
  await Sharing.shareAsync(await downloadPhoto(uri), {
    // Without a type Android offers every app that takes *a file*; with one,
    // the apps that take an image.
    mimeType: 'image/*',
    dialogTitle: 'Share photo',
  });
}
