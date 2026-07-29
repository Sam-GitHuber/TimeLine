import { describe, it, expect } from "vitest";
import {
  CHAT_PHOTO_MAX_EDGE,
  CHAT_THUMBNAIL_MAX_EDGE,
  fitWithin,
} from "./chatPhotos.js";

/**
 * The one part of the chat photo pipeline a test can reach (Phase 9b M9e).
 *
 * `prepareChatPhoto` itself needs an image decoder and `canvas.toBlob`, neither
 * of which jsdom has, so it's stubbed wherever it's used and the drawer's half
 * of the contract — *the picked file goes through it, and what comes out is what
 * gets sent* — is asserted in `messaging.test.jsx` instead. And the thing that
 * actually matters, that re-encoding strips EXIF, can only be checked with a
 * real browser and a real photo with GPS in it: it's a manual step in the
 * milestone, not something to pretend a unit test covers.
 *
 * What *is* pure is the sizing, and it's worth pinning because it's shared with
 * the phone (`mobile/src/chatPhotos.ts` has the same function and the same
 * numbers). Two clients producing visibly different photos from one source is
 * the divergence M9 exists to end.
 */
describe("fitWithin", () => {
  it("leaves an image smaller than the bound alone", () => {
    // Never scales *up*: blowing a small photo up would cost bytes for no extra
    // detail, and the server would then be storing an upscale nobody asked for.
    expect(fitWithin(800, 600, CHAT_PHOTO_MAX_EDGE)).toEqual({
      width: 800,
      height: 600,
    });
  });

  it("caps the long edge whichever edge that is", () => {
    // Landscape and portrait have to land on the same rule — bounding one axis
    // and letting the other follow is how a portrait photo silently overshoots
    // the very limit it was meant to obey.
    expect(fitWithin(4000, 3000, CHAT_PHOTO_MAX_EDGE)).toEqual({
      width: 1600,
      height: 1200,
    });
    expect(fitWithin(3000, 4000, CHAT_PHOTO_MAX_EDGE)).toEqual({
      width: 1200,
      height: 1600,
    });
  });

  it("keeps the thumbnail's own, smaller bound", () => {
    expect(fitWithin(4000, 3000, CHAT_THUMBNAIL_MAX_EDGE)).toEqual({
      width: 480,
      height: 360,
    });
  });

  it("never computes a zero edge for an extreme panorama", () => {
    // 12000×20 scales to 1600×2.67 — rounding alone is fine here, but a thinner
    // one rounds to zero, and a zero-sized canvas exports nothing at all.
    expect(fitWithin(12000, 4, CHAT_PHOTO_MAX_EDGE)).toEqual({
      width: 1600,
      height: 1,
    });
  });
});
