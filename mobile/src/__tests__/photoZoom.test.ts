/**
 * The viewer's zoom geometry (#396). Pure, so every rule a finger can feel is
 * pinned here rather than in a gesture simulation: where a pinch grows from,
 * how far you can pan, and when a photo counts as zoomed at all — the last one
 * decides whether the pager will swipe.
 */

import {
  AT_REST,
  DOUBLE_TAP_SCALE,
  MAX_SCALE,
  clampZoom,
  doubleTapZoom,
  fittedSize,
  isZoomed,
  panZoom,
  pinchZoom,
  settleZoom,
} from '@/photoZoom';

const PAGE = { width: 400, height: 800 };
// A landscape photo on a portrait phone: fitted to the width, letterboxed top
// and bottom.
const LANDSCAPE = fittedSize(PAGE, { width: 1600, height: 1200 });

describe('fittedSize', () => {
  it('fits the whole photo, letterboxing the spare dimension', () => {
    expect(LANDSCAPE).toEqual({ width: 400, height: 300 });
    expect(fittedSize(PAGE, { width: 600, height: 2400 })).toEqual({
      width: 200,
      height: 800,
    });
  });

  it('falls back to the page for a photo that does not know its size', () => {
    expect(fittedSize(PAGE, { width: 0, height: 0 })).toEqual(PAGE);
  });
});

describe('clampZoom', () => {
  it('stops a pan where the photo’s edge meets the page’s', () => {
    // 2× of 400 wide is 800: 200 spare each side.
    expect(clampZoom({ scale: 2, x: 999, y: 0 }, PAGE, LANDSCAPE).x).toBe(200);
    expect(clampZoom({ scale: 2, x: -999, y: 0 }, PAGE, LANDSCAPE).x).toBe(-200);
  });

  it('keeps an axis centred while the photo is still narrower than the page', () => {
    // 2× of 300 tall is 600, still inside 800: nothing to pan to vertically.
    expect(clampZoom({ scale: 2, x: 0, y: 150 }, PAGE, LANDSCAPE).y).toBe(0);
  });
});

describe('pinchZoom', () => {
  it('holds the point under the fingers still while it grows', () => {
    // Pinch 100pt right of centre, out to 2×. The photo point under the
    // fingers was 100 from its centre; at 2× it's 200 from it, so the photo
    // must move 100 left to keep it at 100.
    const zoom = pinchZoom({
      from: AT_REST,
      startFocal: { x: 100, y: 0 },
      focal: { x: 100, y: 0 },
      factor: 2,
      page: PAGE,
      fitted: LANDSCAPE,
    });
    expect(zoom).toEqual({ scale: 2, x: -100, y: 0 });
  });

  it('drags the photo with the fingers when they move mid-pinch', () => {
    const still = pinchZoom({
      from: { scale: 2, x: 0, y: 0 },
      startFocal: { x: 0, y: 0 },
      focal: { x: 0, y: 0 },
      factor: 1,
      page: PAGE,
      fitted: LANDSCAPE,
    });
    const moved = pinchZoom({
      from: { scale: 2, x: 0, y: 0 },
      startFocal: { x: 0, y: 0 },
      focal: { x: 50, y: 0 },
      factor: 1,
      page: PAGE,
      fitted: LANDSCAPE,
    });
    expect(moved.x - still.x).toBe(50);
  });

  it('stops at the most and the least it can zoom', () => {
    const pinch = (factor: number) =>
      pinchZoom({
        from: AT_REST,
        startFocal: { x: 0, y: 0 },
        focal: { x: 0, y: 0 },
        factor,
        page: PAGE,
        fitted: LANDSCAPE,
      }).scale;
    expect(pinch(50)).toBe(MAX_SCALE);
    // Pinching in below fit isn't a smaller photo, it's the same one at rest.
    expect(pinch(0.2)).toBe(1);
  });
});

describe('panZoom', () => {
  it('moves a zoomed photo by the drag, within its edges', () => {
    const from = { scale: 2, x: 0, y: 0 };
    expect(panZoom(from, 50, 0, PAGE, LANDSCAPE)).toEqual({ scale: 2, x: 50, y: 0 });
    expect(panZoom(from, 500, 0, PAGE, LANDSCAPE).x).toBe(200);
  });
});

describe('doubleTapZoom', () => {
  it('zooms in toward where you tapped, and back out on the next one', () => {
    const tapped = doubleTapZoom(AT_REST, { x: 40, y: 0 }, PAGE, LANDSCAPE);
    expect(tapped.scale).toBe(DOUBLE_TAP_SCALE);
    // The tapped point is pulled to the centre: 40 × 2.5 = 100 left.
    expect(tapped.x).toBe(-100);

    expect(doubleTapZoom(tapped, { x: 0, y: 0 }, PAGE, LANDSCAPE)).toEqual(AT_REST);
  });
});

describe('isZoomed / settleZoom', () => {
  it('treats a pinch let go a hair past fit as back at rest', () => {
    // 🔒 The pager only swipes at 1×. A pinch that ends at 1.02× left as it
    // was would lock the pager over a zoom nobody can see.
    expect(isZoomed({ scale: 1.02, x: 3, y: 0 })).toBe(false);
    expect(settleZoom({ scale: 1.02, x: 3, y: 0 })).toEqual(AT_REST);

    const zoomed = { scale: 1.5, x: 10, y: 0 };
    expect(isZoomed(zoomed)).toBe(true);
    expect(settleZoom(zoomed)).toBe(zoomed);
  });
});
