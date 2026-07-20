/**
 * The geometry behind the avatar cropper, kept pure and out of the gesture
 * component so it can be unit-tested (the gestures and native image work can't
 * be, in Jest).
 *
 * The model, mirroring the web's `react-easy-crop` round cropper: the photo is
 * laid over a square crop window of side `crop` (the circle guide is inscribed
 * in it). At rest the photo is scaled to *cover* that square; the user then
 * pinches to zoom in further and drags to recentre. We export the square — the
 * circle is only a guide, and the `Avatar` masks the result to a circle, exactly
 * as the web does.
 *
 * All on-screen numbers are in the crop window's own coordinate space, whose
 * origin is its top-left corner and whose centre is (`crop`/2, `crop`/2).
 */

/** The scale that makes an image just cover a square crop window of side `crop`. */
export function coverScale(
  imageWidth: number,
  imageHeight: number,
  crop: number
): number {
  return Math.max(crop / imageWidth, crop / imageHeight);
}

/**
 * The furthest the photo may be panned along one axis before an edge would
 * cross into the crop window (which must stay fully covered). `fitScale` is the
 * cover scale; `scale` is the user's pinch factor (≥ 1).
 */
export function maxTranslation(
  imageDimension: number,
  fitScale: number,
  scale: number,
  crop: number
): number {
  const displayed = imageDimension * fitScale * scale;
  return Math.max(0, (displayed - crop) / 2);
}

/** Clamp a pan offset to keep the photo covering the crop window. */
export function clampTranslation(
  offset: number,
  imageDimension: number,
  fitScale: number,
  scale: number,
  crop: number
): number {
  const max = maxTranslation(imageDimension, fitScale, scale, crop);
  return Math.min(max, Math.max(-max, offset));
}

export type CropRect = {
  originX: number;
  originY: number;
  width: number;
  height: number;
};

/**
 * Map the on-screen transform back to a crop rectangle in the *source image's*
 * pixels — what `expo-image-manipulator` needs.
 *
 * Derivation: at scale `s` the photo is drawn `imageWidth·fitScale·s` wide,
 * centred in the crop window plus the pan offset. Invert that to find which
 * source pixel sits under the crop window's top-left corner, and how many source
 * pixels the window spans. The result is clamped to the image bounds so rounding
 * can never hand the native cropper a rectangle that runs off the edge.
 */
export function computeCropRect(params: {
  imageWidth: number;
  imageHeight: number;
  crop: number;
  fitScale: number;
  scale: number;
  translateX: number;
  translateY: number;
}): CropRect {
  const { imageWidth, imageHeight, crop, fitScale, scale, translateX, translateY } =
    params;
  const effective = fitScale * scale;
  const displayedWidth = imageWidth * effective;
  const displayedHeight = imageHeight * effective;

  // Where the photo's top-left sits inside the crop window.
  const imageLeft = crop / 2 + translateX - displayedWidth / 2;
  const imageTop = crop / 2 + translateY - displayedHeight / 2;

  const size = crop / effective;
  const originX = -imageLeft / effective;
  const originY = -imageTop / effective;

  return {
    originX: Math.round(clamp(originX, 0, imageWidth - size)),
    originY: Math.round(clamp(originY, 0, imageHeight - size)),
    width: Math.round(size),
    height: Math.round(size),
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}
