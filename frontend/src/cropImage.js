// Turn a chosen image file + a crop rectangle (in the image's own pixels, as
// react-easy-crop reports it) into a fresh square File ready to upload.
//
// We do the crop *client-side* and upload only the cropped square (issue #18,
// option a): no backend change, no stored original. The server still runs its
// full safety pipeline on whatever we send (validate-by-decode, EXIF strip,
// size/format caps — see backend/api/imaging.py), so this is purely about
// framing, not trust.
//
// The output is capped to OUTPUT_MAX px per side: avatars are downscaled to 512
// server-side anyway, so uploading anything larger just wastes bytes. We fill
// the canvas white first because avatars are shown as filled circles — if a
// transparent PNG is cropped and re-encoded as JPEG, the transparent areas
// would otherwise come out black.

const OUTPUT_MAX = 1024;

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Could not load the image."));
    img.src = src;
  });
}

// `cropPixels` is react-easy-crop's `croppedAreaPixels`: { x, y, width, height }
// in the natural pixel space of the source image. It's always square here
// (aspect = 1), so we render it into a square canvas.
export async function getCroppedImg(src, cropPixels) {
  const image = await loadImage(src);

  const size = Math.min(Math.round(cropPixels.width), OUTPUT_MAX);
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;

  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not process the image.");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, size, size);
  ctx.drawImage(
    image,
    cropPixels.x,
    cropPixels.y,
    cropPixels.width,
    cropPixels.height,
    0,
    0,
    size,
    size
  );

  const blob = await new Promise((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("Could not process the image."))),
      "image/jpeg",
      0.92
    )
  );

  return new File([blob], "avatar.jpg", { type: "image/jpeg" });
}
