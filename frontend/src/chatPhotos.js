/**
 * Preparing a photo for a chat message — **in the browser, not on the server**
 * (Phase 9b M9e).
 *
 * 🔒 **Why this file exists at all.** Everywhere else in TimeLine, an uploaded
 * image is processed server-side by `backend/api/imaging.py`: it's decoded to
 * prove it really is an image, rebuilt from raw pixels (which is what strips
 * EXIF, including the GPS coordinates a phone stamps on every shot), downscaled,
 * and re-encoded. Chat photos deliberately do **none** of that on the server,
 * and do all of it here instead.
 *
 * The reason is end-to-end encryption, which is a committed goal for messaging
 * (`docs/phases/phase-9c-e2e-encryption.md`). Under E2E the server is handed
 * bytes it cannot read, so it *cannot* strip EXIF or resize them — a server-side
 * pipeline for chat photos would be code we'd have to tear out, and worse, a
 * privacy guarantee that would quietly stop holding on the day it was needed
 * most. Doing it here means the pipeline is already in the only place that will
 * always be able to run it. See `reference/messaging.md` → *Photo messages*.
 *
 * The trade, stated plainly: the server can no longer verify that a chat
 * attachment is really an image. It enforces byte-size and count caps instead —
 * the two limits that still work on opaque bytes — and stores every attachment
 * under a forced `.jpg` filename so it can never be served as markup.
 *
 * **A rewrite of `mobile/src/chatPhotos.ts`, not a port**, because the phone's
 * `expo-image-manipulator` has no browser equivalent — `<canvas>` is what does
 * the decoding and re-encoding here. The *numbers* below are copied exactly, and
 * they have to stay that way: two clients producing visibly different photos
 * from the same source is precisely the divergence M9 exists to end. If you
 * change one, change both.
 *
 * **The stripping is a side effect of re-encoding, and that's not an accident.**
 * `drawImage` paints decoded pixels onto a canvas and `toBlob` writes a fresh
 * JPEG from them; metadata isn't carried across, so EXIF (including GPS) simply
 * doesn't exist in the output. Same technique as the server's, which is why the
 * two produce comparable results — see `imaging.py`'s `_strip_and_encode`.
 */

/**
 * Longest edge of the uploaded photo, in pixels.
 *
 * Sized for *looking at*, not for archiving: 1600px is sharper than the bubble
 * or the lightbox will ever draw it, and lands a photographic JPEG around
 * 200–500 KB. Bigger would cost every recipient the download — including the
 * ones on a phone, on cellular — for detail they can't see. (A chat is not the
 * photo library; the timeline's own posts keep the larger bound.)
 */
export const CHAT_PHOTO_MAX_EDGE = 1600;

/**
 * Longest edge of the thumbnail the bubble renders.
 *
 * A bubble is ~240px wide, so 480px covers it at 2×. Tens of KB, which is what
 * makes scrolling back through a photo-heavy thread cheap — the full image is
 * fetched only when someone actually opens one in the lightbox.
 */
export const CHAT_THUMBNAIL_MAX_EDGE = 480;

/** JPEG quality for the upload. 0.8 is the usual sweet spot: no visible loss on
 * screen, roughly half the bytes of 0.9. */
const PHOTO_QUALITY = 0.8;
/** The thumbnail is small and gets scaled down again on screen, so it can take
 * a harder squeeze than the photo. */
const THUMBNAIL_QUALITY = 0.6;

/** Fit `(width, height)` inside a square of `maxEdge`, keeping the aspect ratio.
 * Never scales *up* — a small photo is left alone rather than blown up into a
 * bigger file for no extra detail. */
export function fitWithin(width, height, maxEdge) {
  const longest = Math.max(width, height);
  if (longest <= maxEdge) return { width, height };
  const factor = maxEdge / longest;
  // Round, then floor at 1: a very thin panorama could otherwise compute a zero
  // for its short edge, and a zero-sized canvas exports nothing.
  return {
    width: Math.max(1, Math.round(width * factor)),
    height: Math.max(1, Math.round(height * factor)),
  };
}

/**
 * Decode a chosen file into an `<img>`.
 *
 * Through an object URL rather than a `FileReader` data URL: a 12 MP photo is
 * tens of megabytes as base64, and the browser would hold the whole string in
 * memory to no purpose. Revoked as soon as the image has decoded, whichever way
 * it went.
 */
function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      // Deliberately vague: the caller has something to say about a photo it
      // can't use, and there's nothing actionable in "the decoder said no".
      reject(new Error("Could not read that image."));
    };
    image.src = url;
  });
}

/** Draw `image` into a canvas of the given size and export it as a JPEG File. */
async function encode(image, size, quality, name) {
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not process that image.");
  // White underneath, because JPEG has no alpha: a transparent PNG dropped into
  // a chat would otherwise come out with black where it was see-through.
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, size.width, size.height);
  ctx.drawImage(image, 0, 0, size.width, size.height);

  const blob = await new Promise((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("Could not process that image."))),
      "image/jpeg",
      quality
    )
  );
  // Named here, not derived from the pick: the original filename is metadata too
  // ("IMG_4686.HEIC" says which phone and roughly when), and the server ignores
  // it anyway — every attachment is stored under a UUID with a forced `.jpg`.
  return new File([blob], name, { type: "image/jpeg" });
}

/**
 * Resize + re-encode a chosen photo and its thumbnail, ready to send.
 *
 * Both are drawn from the **decoded original**, not the thumbnail from the
 * already-compressed upload: one decode, two encodes, and no compression
 * artefacts fed into a second squeeze.
 *
 * Throws if the file can't be decoded — a corrupt pick, or something that isn't
 * an image at all. The caller decides what to say about it; this module has no
 * UI.
 *
 * ⚠️ **EXIF orientation is handled by the browser, not by us.** `image-orientation:
 * from-image` is the default for `<img>`, so a photo tagged "rotate 90°" decodes
 * already upright and `naturalWidth`/`naturalHeight` report the upright
 * dimensions. That's what makes drawing it straight onto a canvas correct — and
 * what would silently break if anything here ever set `image-orientation: none`
 * to "fix" something.
 */
export async function prepareChatPhoto(file) {
  const stamp = Date.now();
  const image = await loadImage(file);
  const width = image.naturalWidth;
  const height = image.naturalHeight;
  if (!width || !height) throw new Error("Could not read that image.");

  const full = fitWithin(width, height, CHAT_PHOTO_MAX_EDGE);
  const thumb = fitWithin(width, height, CHAT_THUMBNAIL_MAX_EDGE);
  const photo = await encode(image, full, PHOTO_QUALITY, `photo-${stamp}.jpg`);
  const thumbnail = await encode(
    image,
    thumb,
    THUMBNAIL_QUALITY,
    `thumb-${stamp}.jpg`
  );

  return {
    photo,
    thumbnail,
    // The dimensions of the bytes the server will store — which is exactly what
    // the bubble needs to reserve the right space, so a photo landing mid-scroll
    // doesn't shove what you were reading. The server takes these as given; it
    // never opens the file to check.
    width: full.width,
    height: full.height,
    /**
     * What the in-flight bubble draws, so a photo appears the instant you hit
     * send rather than after the upload.
     *
     * 🔒 **Whoever holds this owns revoking it.** An object URL is a document-
     * lifetime reference to the blob behind it, so one left dangling pins the
     * thumbnail's bytes in memory until the tab closes. `outbox.js` releases it
     * when the entry leaves the outbox — sent, discarded, or signed out.
     */
    previewUrl: URL.createObjectURL(thumbnail),
  };
}
