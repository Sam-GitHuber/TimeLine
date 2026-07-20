/**
 * The avatar cropper's geometry — the one part of the round-crop feature Jest
 * can genuinely check (the gestures and native image work can't be).
 *
 * The important property: whatever the user pinches/pans to on screen maps to a
 * crop rectangle in the *source image's* pixels that (a) is centred by default,
 * (b) shrinks as they zoom in, and (c) never runs off the image edge.
 */

import {
  clampTranslation,
  computeCropRect,
  coverScale,
  maxTranslation,
} from '@/avatarCrop';

describe('coverScale', () => {
  it('scales by the larger ratio so the image covers the square', () => {
    // Landscape: height is the tighter dimension, so it sets the scale.
    expect(coverScale(1000, 500, 300)).toBeCloseTo(0.6);
    // Portrait: width is tighter.
    expect(coverScale(500, 1000, 300)).toBeCloseTo(0.6);
    // Square image, square window.
    expect(coverScale(800, 800, 400)).toBeCloseTo(0.5);
  });
});

describe('maxTranslation / clampTranslation', () => {
  it('allows no pan when the image exactly covers the window', () => {
    // scale 1, square image cover-fitted to the window: displayed == crop.
    const fit = coverScale(800, 800, 300);
    expect(maxTranslation(800, fit, 1, 300)).toBe(0);
    expect(clampTranslation(50, 800, fit, 1, 300)).toBe(0);
  });

  it('allows pan up to the overhang, and clamps beyond it', () => {
    const fit = coverScale(1000, 800, 300); // 0.375
    // displayed width at scale 1 = 1000 * 0.375 = 375; overhang = (375-300)/2.
    expect(maxTranslation(1000, fit, 1, 300)).toBeCloseTo(37.5);
    expect(clampTranslation(20, 1000, fit, 1, 300)).toBe(20);
    expect(clampTranslation(100, 1000, fit, 1, 300)).toBeCloseTo(37.5);
    expect(clampTranslation(-100, 1000, fit, 1, 300)).toBeCloseTo(-37.5);
  });

  it('grows the pan range as you zoom in', () => {
    const fit = coverScale(1000, 800, 300);
    expect(maxTranslation(1000, fit, 2, 300)).toBeGreaterThan(
      maxTranslation(1000, fit, 1, 300)
    );
  });
});

describe('computeCropRect', () => {
  const base = { imageWidth: 1000, imageHeight: 800, crop: 300 };
  const fitScale = coverScale(base.imageWidth, base.imageHeight, base.crop);

  it('centres the crop with no zoom or pan', () => {
    const rect = computeCropRect({
      ...base,
      fitScale,
      scale: 1,
      translateX: 0,
      translateY: 0,
    });
    // At rest the window covers the full height (800) of a 1000×800 image,
    // centred horizontally: (1000 − 800) / 2 = 100.
    expect(rect).toEqual({ originX: 100, originY: 0, width: 800, height: 800 });
  });

  it('shrinks and re-centres the crop as you zoom in', () => {
    const rect = computeCropRect({
      ...base,
      fitScale,
      scale: 2,
      translateX: 0,
      translateY: 0,
    });
    // Twice the zoom → half the source captured, still centred.
    expect(rect).toEqual({ originX: 300, originY: 200, width: 400, height: 400 });
  });

  it('moves the crop origin opposite the pan, and never off the image', () => {
    // Pan the photo right → the circle frames further left of the source.
    const panned = computeCropRect({
      ...base,
      fitScale,
      scale: 2,
      translateX: 60,
      translateY: 0,
    });
    expect(panned.originX).toBeLessThan(300);
    expect(panned.originX).toBeGreaterThanOrEqual(0);

    // An absurd pan is clamped so the rectangle stays inside the image.
    const shoved = computeCropRect({
      ...base,
      fitScale,
      scale: 2,
      translateX: 100000,
      translateY: 100000,
    });
    expect(shoved.originX).toBeGreaterThanOrEqual(0);
    expect(shoved.originY).toBeGreaterThanOrEqual(0);
    expect(shoved.originX + shoved.width).toBeLessThanOrEqual(base.imageWidth);
    expect(shoved.originY + shoved.height).toBeLessThanOrEqual(base.imageHeight);
  });
});
