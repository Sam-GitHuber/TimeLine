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
 *
 * **The download itself is not allowed to become a second copy.** A full-size
 * friend's photo left in the cache would outlive the post it came from, which
 * is the same leak without anyone having chosen Save. So downloads go into one
 * folder of their own that is **emptied before every download** — at most one
 * photo is ever in it — and a save deletes its file as soon as it's done.
 * Share can't do the same: on Android the receiving app may still be reading
 * the file after the share sheet has returned, so that one file waits for the
 * next download (or the OS's own cache eviction) instead.
 */

import { Directory, File, Paths } from 'expo-file-system';
// `/legacy`, not the package root: from SDK 55 the root exports the new
// object API, where `saveToLibraryAsync` is a stub that throws. The legacy call
// is the one that works on **add-only** access — `Asset.create` returns the new
// asset, which needs read access to the library, and asking for that just to
// save a photo is a permission this app has no use for.
import {
  getPermissionsAsync,
  requestPermissionsAsync,
  saveToLibraryAsync,
} from 'expo-media-library/legacy';
import * as Sharing from 'expo-sharing';

import { mediaHeaders } from '@/components/AuthedImage';

/**
 * Download the photo at `uri` into the viewer's own cache folder, emptying it
 * first (see the privacy note above). Returns the file, or `null` for a URI
 * that's already local — a photo still in the outbox — which is used as it is
 * and is not ours to delete.
 *
 * Named after the server's own filename (a random hex plus the real extension,
 * see `imaging.py`'s `_uuid_name`), because the library and the share sheet
 * both read the type off the extension — a file with none is refused by the
 * library on Android.
 */
async function downloadPhoto(uri: string): Promise<File | null> {
  if (uri.startsWith('file:')) return null;
  const folder = new Directory(Paths.cache, 'photo-viewer');
  folder.create({ overwrite: true });
  const name = uri.split('?')[0].split('/').pop() || `photo-${Date.now()}.jpg`;
  return await File.downloadFileAsync(uri, new File(folder, name), {
    headers: mediaHeaders(uri),
  });
}

/**
 * What became of a Save: done; refused at the prompt just now (the person has
 * answered — nothing more to say); or refused *before*, when the OS won't ask
 * again and Settings is the only way back.
 */
export type SaveOutcome = 'saved' | 'declined' | 'blocked';

/**
 * Save the photo to the camera roll. Throws when the download or the save
 * itself fails.
 *
 * `writeOnly` is the whole permission story: on iOS it asks for "add photos
 * only" (`NSPhotoLibraryAddUsageDescription`), never to read the library; on
 * Android 13+ saving needs no permission at all, and before that the
 * `WRITE_EXTERNAL_STORAGE` the photo picker already declares.
 *
 * The permission is *read* before it's requested because the answer to "can we
 * ask?" has to come from before the prompt: afterwards, a fresh "Don't Allow"
 * and an old one look the same, and only the old one deserves a nudge toward
 * Settings — the person who just tapped it doesn't need telling twice.
 */
export async function savePhoto(uri: string): Promise<SaveOutcome> {
  const current = await getPermissionsAsync(true);
  if (!current.granted) {
    if (!current.canAskAgain) return 'blocked';
    const asked = await requestPermissionsAsync(true);
    if (!asked.granted) return 'declined';
  }
  const file = await downloadPhoto(uri);
  try {
    await saveToLibraryAsync(file?.uri ?? uri);
  } finally {
    // The library has its own copy now; ours is just the leak described above.
    file?.delete();
  }
  return 'saved';
}

/** Open the system share sheet on the photo. */
export async function sharePhoto(uri: string): Promise<void> {
  const file = await downloadPhoto(uri);
  await Sharing.shareAsync(file?.uri ?? uri, {
    // Without a type Android offers every app that takes *a file*; with one,
    // the apps that take an image.
    mimeType: 'image/*',
    dialogTitle: 'Share photo',
  });
}
