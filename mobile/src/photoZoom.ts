/**
 * The geometry of zooming a photo in the viewer (`PhotoLightbox`, #396).
 *
 * Pure and unit-tested; the component owns only the gestures, which Jest can
 * reach but not *feel*. Every function works in **page coordinates with the
 * origin at the page's centre**, because that's the origin a `scale` transform
 * grows from — so a translation of `{x: 0, y: 0}` is "the photo centred", which
 * is where it rests at 1×.
 *
 * The photo is drawn `contain`-fitted into the page and then transformed:
 * translate first, then scale about the centre. That ordering is what the maths
 * below assumes — change the transform order in the component and every
 * function here is wrong.
 */

export type Size = { width: number; height: number };
/** Where the photo sits: its zoom, and its centre's offset from the page's. */
export type Zoom = { scale: number; x: number; y: number };

/** At rest: fit to the page, centred. */
export const AT_REST: Zoom = { scale: 1, x: 0, y: 0 };

/** As far as a pinch goes — enough to read a screenshot's small print. */
export const MAX_SCALE = 4;
/** What a double tap zooms to: closer, without the jump feeling violent. */
export const DOUBLE_TAP_SCALE = 2.5;
/**
 * Below this the photo counts as back at 1×. A pinch that ends at 1.02× is
 * someone letting go, not someone asking for 2% — and leaving it there would
 * lock the pager (it only swipes at 1×) over a zoom nobody can see.
 */
const SNAP_BACK = 1.05;

/**
 * The size the photo is actually drawn at 1×: `contain`, so the whole photo
 * fits and one dimension is letterboxed. Falls back to the page when the photo
 * doesn't know its own size (a dimension of 0), which only costs some precision
 * in how far you can pan.
 */
export function fittedSize(page: Size, photo: Size): Size {
  if (!(photo.width > 0 && photo.height > 0)) return page;
  const ratio = Math.min(page.width / photo.width, page.height / photo.height);
  return { width: photo.width * ratio, height: photo.height * ratio };
}

/**
 * Keep an offset on one axis inside what the zoomed photo covers.
 *
 * You can pan until the photo's edge meets the page's edge and no further — and
 * on an axis where the zoomed photo is still *narrower* than the page (a tall
 * photo's width at 1.5×, say), it stays centred, since there's nothing to pan
 * to. That second case is the `Math.max(0, …)`.
 */
function clampAxis(offset: number, scale: number, fitted: number, page: number) {
  const max = Math.max(0, (fitted * scale - page) / 2);
  return Math.min(max, Math.max(-max, offset));
}

export function clampZoom(zoom: Zoom, page: Size, fitted: Size): Zoom {
  return {
    scale: zoom.scale,
    x: clampAxis(zoom.x, zoom.scale, fitted.width, page.width),
    y: clampAxis(zoom.y, zoom.scale, fitted.height, page.height),
  };
}

/**
 * Where a pinch has taken the photo.
 *
 * `from` is where it was when the pinch began and `startFocal` where the two
 * fingers were then; `factor` and `focal` are the pinch now. The rule is that
 * **the point of the photo that was under your fingers stays under your
 * fingers** — so zooming grows from where you pinched rather than the middle,
 * and moving both fingers while pinching drags the photo with them, the way
 * every photo viewer behaves.
 *
 * The content point under the start focal is `(startFocal - from) / from.scale`
 * in unscaled photo space; holding it under `focal` at the new scale gives the
 * new offset.
 */
export function pinchZoom({
  from,
  startFocal,
  focal,
  factor,
  page,
  fitted,
}: {
  from: Zoom;
  startFocal: { x: number; y: number };
  focal: { x: number; y: number };
  factor: number;
  page: Size;
  fitted: Size;
}): Zoom {
  const scale = Math.min(MAX_SCALE, Math.max(1, from.scale * factor));
  const pointX = (startFocal.x - from.x) / from.scale;
  const pointY = (startFocal.y - from.y) / from.scale;
  return clampZoom(
    { scale, x: focal.x - pointX * scale, y: focal.y - pointY * scale },
    page,
    fitted
  );
}

/** Where a one-finger drag of `dx, dy` takes a zoomed photo. */
export function panZoom(from: Zoom, dx: number, dy: number, page: Size, fitted: Size): Zoom {
  return clampZoom({ scale: from.scale, x: from.x + dx, y: from.y + dy }, page, fitted);
}

/**
 * A double tap: zoomed in → back to rest; at rest → `DOUBLE_TAP_SCALE`,
 * centred on where you tapped, so tapping a face zooms to the face.
 */
export function doubleTapZoom(
  from: Zoom,
  tap: { x: number; y: number },
  page: Size,
  fitted: Size
): Zoom {
  if (isZoomed(from)) return AT_REST;
  return pinchZoom({
    from: AT_REST,
    startFocal: tap,
    // Pull the tapped point toward the centre rather than holding it under the
    // finger: you double-tapped it because you want to look *at* it.
    focal: { x: 0, y: 0 },
    factor: DOUBLE_TAP_SCALE,
    page,
    fitted,
  });
}

/** Has a gesture left the photo meaningfully zoomed in? */
export function isZoomed(zoom: Zoom): boolean {
  return zoom.scale >= SNAP_BACK;
}

/** Where a finished gesture should come to rest: as-is, or snapped home. */
export function settleZoom(zoom: Zoom): Zoom {
  return isZoomed(zoom) ? zoom : AT_REST;
}
