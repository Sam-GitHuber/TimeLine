/**
 * Preparing a photo for a chat message — **on the phone, not on the server**
 * (Phase 9b M7).
 *
 * 🔒 **Why this file exists at all.** Everywhere else in TimeLine, an uploaded
 * image is processed server-side by `backend/api/imaging.py`: it's decoded to
 * prove it really is an image, rebuilt from raw pixels to strip EXIF (phone
 * photos carry the GPS coordinates they were taken at — a real leak on a family
 * photo), downscaled, and re-encoded. Chat photos deliberately do **none** of
 * that on the server, and do all of it here instead.
 *
 * The reason is end-to-end encryption, which is a committed goal for messaging
 * (`docs/phases/phase-9c-e2e-encryption.md`). Under E2E the server is handed
 * bytes it cannot read, so it *cannot* strip EXIF or resize them — a server-side
 * pipeline for chat photos would be code we'd have to tear out, and worse, a
 * privacy guarantee that would quietly stop holding on the day it was needed
 * most. Doing it here means the pipeline is already in the only place that will
 * always be able to run it.
 *
 * The trade, stated plainly: the server can no longer verify that a chat
 * attachment is really an image. It enforces byte-size and count caps instead —
 * the two limits that still work on opaque bytes — and stores every attachment
 * under a forced `.jpg` filename so it can never be served as markup. See
 * `MessageAttachment` in `backend/api/models.py`.
 *
 * **The stripping is a side effect of re-encoding, and that's not an accident.**
 * `expo-image-manipulator` decodes the image and writes a fresh JPEG from the
 * pixels; metadata isn't copied across, so EXIF (including GPS) simply doesn't
 * exist in the output. Same technique as the server's, which is why the two
 * produce comparable results — see `imaging.py`'s `_strip_and_encode`.
 */

import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';

import type { PhotoUpload } from '@/api';

/**
 * Longest edge of the uploaded photo, in pixels.
 *
 * Sized for *looking at on a phone*, not for archiving: 1600px is sharper than
 * any screen this is viewed on even when zoomed, and lands a photographic JPEG
 * around 200–500 KB. Bigger would cost every recipient the download on cellular
 * for detail they can't see. (A chat is not the photo library — the timeline's
 * own posts keep the larger bound.)
 */
export const CHAT_PHOTO_MAX_EDGE = 1600;

/**
 * Longest edge of the thumbnail the bubble renders.
 *
 * A bubble is ~240pt wide, so 480px covers it at 2×. Tens of KB, which is what
 * makes scrolling back through a photo-heavy thread cheap — the full image is
 * fetched only when someone actually opens one in the lightbox.
 */
export const CHAT_THUMBNAIL_MAX_EDGE = 480;

/** JPEG quality for the upload. 0.8 is the usual sweet spot: no visible loss on
 * a phone screen, roughly half the bytes of 0.9. */
const PHOTO_QUALITY = 0.8;
/** The thumbnail is small and gets scaled down again on screen, so it can take
 * a harder squeeze than the photo. */
const THUMBNAIL_QUALITY = 0.6;

/** A processed photo: what to upload, plus the dimensions the bubble lays out
 * from. The server stores these as given — it never opens the file to check. */
export type PreparedPhoto = {
  photo: PhotoUpload;
  thumbnail: PhotoUpload;
  /** The *uploaded* image's dimensions, not the original's. */
  width: number;
  height: number;
  /** Local URI to draw immediately, before the upload finishes. */
  previewUri: string;
};

/** Fit `(width, height)` inside a square of `maxEdge`, keeping the aspect ratio.
 * Never scales *up* — a small photo is left alone rather than blown up into a
 * bigger file for no extra detail. */
function fitWithin(width: number, height: number, maxEdge: number) {
  const longest = Math.max(width, height);
  if (longest <= maxEdge) return { width, height };
  const factor = maxEdge / longest;
  // Round, then floor at 1: a very thin panorama could otherwise compute a zero
  // for its short edge, which the manipulator rejects.
  return {
    width: Math.max(1, Math.round(width * factor)),
    height: Math.max(1, Math.round(height * factor)),
  };
}

/**
 * The source image's dimensions, measured if the picker didn't report them.
 *
 * The picker almost always does, so the extra decode almost never happens. It
 * matters because the alternative — bounding one side and letting the
 * manipulator infer the other — quietly breaks both halves of `fitWithin`'s
 * contract on the path that can't check it: `{ width: MAX_EDGE }` *upscales* a
 * small photo into a bigger file for no extra detail, and on a portrait source
 * it produces a 1600×2133 image, overshooting the very long-edge bound it was
 * meant to enforce. Measuring first means one rule for every pick.
 *
 * Throws rather than guessing if the size still can't be established: the caller
 * already has something to say about a photo it can't use, and a guess here
 * would be a silently oversized upload the server then rejects.
 */
async function measureSource(
  uri: string,
  declaredWidth?: number,
  declaredHeight?: number
) {
  if (declaredWidth && declaredHeight) {
    return { width: declaredWidth, height: declaredHeight };
  }
  const rendered = await ImageManipulator.manipulate(uri).renderAsync();
  if (!rendered.width || !rendered.height) {
    throw new Error('Could not measure the picked image.');
  }
  return { width: rendered.width, height: rendered.height };
}

/**
 * Resize + re-encode a picked photo and its thumbnail, ready to send.
 *
 * Two renders rather than one resized twice, because the manipulator's context
 * is consumed by `renderAsync` — and it keeps the thumbnail derived from the
 * *original* pixels rather than from an already-compressed intermediate.
 *
 * Throws if the file can't be decoded (a corrupt pick, a native hiccup). The
 * caller decides what to say about it — this module has no UI.
 */
export async function prepareChatPhoto(
  uri: string,
  /** The picker's reported dimensions, when it has them. Saves a decode; the
   * manipulator is still the source of truth for the output's own size. */
  sourceWidth?: number,
  sourceHeight?: number
): Promise<PreparedPhoto> {
  const stamp = Date.now();
  const source = await measureSource(uri, sourceWidth, sourceHeight);

  const context = ImageManipulator.manipulate(uri);
  context.resize(fitWithin(source.width, source.height, CHAT_PHOTO_MAX_EDGE));
  const rendered = await context.renderAsync();
  const photo = await rendered.saveAsync({
    compress: PHOTO_QUALITY,
    format: SaveFormat.JPEG,
  });

  const thumbContext = ImageManipulator.manipulate(uri);
  thumbContext.resize(
    fitWithin(source.width, source.height, CHAT_THUMBNAIL_MAX_EDGE)
  );
  const thumbRendered = await thumbContext.renderAsync();
  const thumbnail = await thumbRendered.saveAsync({
    compress: THUMBNAIL_QUALITY,
    format: SaveFormat.JPEG,
  });

  // `saveAsync` reports what it actually wrote, so these are the dimensions of
  // the bytes the server will store — which is exactly what the bubble needs to
  // reserve the right space. Falling back to the measured source keeps a layout
  // hint present rather than sending a zero the server would reject.
  const width = photo.width || source.width;
  const height = photo.height || source.height;

  return {
    photo: {
      uri: photo.uri,
      // Named, not derived from the pick: the original filename is metadata too
      // ("IMG_4686.HEIC" says which phone and roughly when), and the server
      // ignores it anyway — every attachment is stored under a UUID.
      name: `photo-${stamp}.jpg`,
      type: 'image/jpeg',
    },
    thumbnail: {
      uri: thumbnail.uri,
      name: `thumb-${stamp}.jpg`,
      type: 'image/jpeg',
    },
    width,
    height,
    previewUri: thumbnail.uri,
  };
}
