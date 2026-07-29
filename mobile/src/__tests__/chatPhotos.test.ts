/**
 * Preparing a chat photo for upload (Phase 9b M7).
 *
 * 🔒 **This is the privacy-critical half of photo messages.** The server does
 * not decode a chat attachment — deliberately, so the same path still works when
 * it's handed ciphertext under E2E — which means the EXIF stripping and the
 * downscale that happen *here* are the only ones that happen at all. If this
 * module quietly stopped re-encoding, nothing would look broken: photos would
 * still send, still render, and still carry the GPS coordinates of the sender's
 * house to everyone in the chat.
 *
 * So what's pinned below is the *shape of the pipeline*, not pixels: that it
 * re-encodes to JPEG at all (which is what drops the metadata), that it bounds
 * the long edge, that the thumbnail is derived separately and smaller, and that
 * the dimensions handed to the bubble are the ones actually written.
 *
 * The manipulator itself is native, so it's mocked. That's the honest limit of a
 * Node test here — that a real photo comes out stripped is a device check, and
 * M7's *Done when* asks for it explicitly with a GPS-tagged photo.
 */

import {
  CHAT_PHOTO_MAX_EDGE,
  CHAT_THUMBNAIL_MAX_EDGE,
  prepareChatPhoto,
} from '@/chatPhotos';

/** Every `resize()` call made, in order — one per render (photo, then thumb). */
const resizes: { width?: number; height?: number }[] = [];
/** Every `saveAsync()` call's options, in the same order. */
const saves: { compress?: number; format?: string }[] = [];

jest.mock('expo-image-manipulator', () => ({
  SaveFormat: { JPEG: 'jpeg', PNG: 'png' },
  ImageManipulator: {
    manipulate: (uri: string) => {
      // The real API is a chained context; what matters to the caller is the
      // resize it was asked for and what came back, so the stand-in records the
      // first and synthesises the second at whatever size was requested.
      let requested: { width?: number; height?: number } = {};
      return {
        resize: (size: { width?: number; height?: number }) => {
          requested = size;
          resizes.push(size);
        },
        renderAsync: async () => ({
          saveAsync: async (options: { compress?: number; format?: string }) => {
            saves.push(options);
            return {
              uri: `${uri}-out-${saves.length}.jpg`,
              width: requested.width ?? 0,
              height: requested.height ?? 0,
            };
          },
        }),
      };
    },
  },
}));

beforeEach(() => {
  resizes.length = 0;
  saves.length = 0;
});

it('re-encodes to JPEG, which is what strips the EXIF', async () => {
  await prepareChatPhoto('file:///photo.heic', 4032, 3024);

  // Both outputs, not just the upload: a thumbnail that kept its metadata would
  // be a leak with a smaller picture attached.
  expect(saves).toHaveLength(2);
  expect(saves.every((options) => options.format === 'jpeg')).toBe(true);
});

it('bounds the long edge and keeps the aspect ratio', async () => {
  const prepared = await prepareChatPhoto('file:///photo.jpg', 4032, 3024);

  const [photo] = resizes;
  expect(Math.max(photo.width!, photo.height!)).toBe(CHAT_PHOTO_MAX_EDGE);
  // 4:3 in, 4:3 out — a stretched photo is worse than a big one.
  expect(photo.width! / photo.height!).toBeCloseTo(4032 / 3024, 2);
  // And the dimensions reported back are the ones actually written, since the
  // bubble reserves its space from them.
  expect(prepared.width).toBe(photo.width);
  expect(prepared.height).toBe(photo.height);
});

it('bounds a portrait photo by its height, not its width', async () => {
  // The case a width-only bound gets wrong: a tall photo would sail through at
  // 1600 *wide* and 2133 tall, which is bigger than the landscape ceiling.
  await prepareChatPhoto('file:///tall.jpg', 3024, 4032);

  const [photo] = resizes;
  expect(photo.height).toBe(CHAT_PHOTO_MAX_EDGE);
  expect(photo.width).toBeLessThan(CHAT_PHOTO_MAX_EDGE);
});

it('leaves a photo smaller than the bound alone', async () => {
  await prepareChatPhoto('file:///small.jpg', 800, 600);

  // Never upscaled: blowing a small image up costs bytes and adds no detail.
  expect(resizes[0]).toEqual({ width: 800, height: 600 });
});

it('makes a separate, smaller thumbnail from the original', async () => {
  const prepared = await prepareChatPhoto('file:///photo.jpg', 4032, 3024);

  const [, thumb] = resizes;
  expect(Math.max(thumb.width!, thumb.height!)).toBe(CHAT_THUMBNAIL_MAX_EDGE);
  // Two distinct files — sending the full image as its own thumbnail would
  // double every chat's storage and cost the recipient the big download in the
  // transcript. (The server caps the thumbnail separately for the same reason.)
  expect(prepared.thumbnail.uri).not.toBe(prepared.photo.uri);
  // The thumbnail takes the harder squeeze of the two.
  expect(saves[1].compress!).toBeLessThan(saves[0].compress!);
});

it('names the upload itself rather than reusing the picked filename', async () => {
  const prepared = await prepareChatPhoto('file:///IMG_4686.HEIC', 100, 100);

  // "IMG_4686.HEIC" is metadata too — it says which phone and roughly when.
  expect(prepared.photo.name).not.toContain('IMG_4686');
  expect(prepared.photo.name).toMatch(/\.jpg$/);
  expect(prepared.photo.type).toBe('image/jpeg');
});

it('falls back to a bounded long edge when the picker gives no dimensions', async () => {
  await prepareChatPhoto('file:///unknown.jpg');

  // Width only: the manipulator keeps the ratio itself when one side is omitted.
  expect(resizes[0]).toEqual({ width: CHAT_PHOTO_MAX_EDGE });
});
