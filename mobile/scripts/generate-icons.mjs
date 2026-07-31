/**
 * Renders the TimeLine brand mark into the Android icon assets.
 *
 *   node scripts/generate-icons.mjs
 *
 * ## Why this script exists
 *
 * The mark is the website's header identity (`frontend/src/components/Layout.jsx`):
 * a rounded vertical **spine** with the emerald **now-dot** near its top. It was
 * previously rendered ad hoc and the geometry lived only in a reviewer's head,
 * which is how the Android layers ended up still holding the stock Expo logo
 * (#171). Committing the generator makes the geometry the source of truth and a
 * re-render a one-liner.
 *
 * No image library: the mark is a capsule and a disc, so exact coverage per
 * pixel is a distance test, and a PNG is a zlib stream plus four CRC'd chunks.
 * Adding `@resvg/resvg-js` (or any rasteriser) to `mobile`'s dependency tree to
 * draw two shapes would cost more than it saves.
 *
 * ## Why each slot gets its own size
 *
 * The three assets are the *same mark* under three different geometry rules, and
 * that is exactly the trap #171 fell into — an adaptive layer was handed to the
 * notification slot, where it renders at half the size of every other app's:
 *
 * - **Notification icon** — Android draws a 24dp slot and expects the glyph to
 *   fill ~22dp of it, so the mark is authored **full-bleed**. Only the alpha
 *   channel is read (the pixels are tinted with `expo-notifications`' `color`),
 *   which is why a colour image renders as a solid blob and why this one is
 *   flat white.
 * - **Adaptive foreground / monochrome** — authored on a 108dp canvas of which
 *   only the central 72dp is ever visible and only the central 66dp circle is
 *   guaranteed safe, because launchers mask and parallax the layer. The mark is
 *   sized so it occupies the same fraction of the *visible* 72dp that it does of
 *   the iOS `icon.png` square, so the two platforms' icons read at one size.
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'images');

/** Design tokens, from `docs/design-system.md`. */
const SPINE = [0xde, 0xd9, 0xcf];
const ACCENT = [0x1c, 0x8a, 0x6a];
const WHITE = [0xff, 0xff, 0xff];

/**
 * The mark, in the `viewBox="0 0 16 20"` units of the `Layout.jsx` SVG:
 * a 2-wide round-capped line from (8,2) to (8,18), and a circle at (8,6) r=4.
 *
 * Round caps push the line to y=1..19, so the union bounding box is x 4..12 by
 * y 1..19 — 8 wide by 18 tall. Everything below is expressed as a fraction of
 * that box so the mark keeps its proportions at any size.
 */
const MARK = {
  height: 18,
  aspect: 8 / 18,
  spine: { top: 2, bottom: 18, radius: 1 }, // centred on the box's x axis
  dot: { cy: 6, radius: 4 },
  boxCentre: { x: 8, y: 10 },
};

/**
 * Coverage of one shape over one pixel, 0..1.
 *
 * Sampled on a 4x4 grid rather than solved analytically: the shapes are a
 * capsule and a disc, so 16 samples is well inside a rounding error of the true
 * area at these sizes, and it keeps the maths to one distance function.
 */
const SAMPLES = 4;

function coverage(px, py, inside) {
  let hits = 0;
  for (let sy = 0; sy < SAMPLES; sy += 1) {
    for (let sx = 0; sx < SAMPLES; sx += 1) {
      const x = px + (sx + 0.5) / SAMPLES;
      const y = py + (sy + 0.5) / SAMPLES;
      if (inside(x, y)) hits += 1;
    }
  }
  return hits / (SAMPLES * SAMPLES);
}

/**
 * Places the mark on a `size`x`size` canvas with its bounding box `glyphHeight`
 * tall and centred, and returns the two shapes as pixel-space predicates.
 */
function placeMark(size, glyphHeight) {
  const k = glyphHeight / MARK.height; // SVG units -> pixels
  const cx = size / 2;
  const cy = size / 2;
  const toX = (x) => cx + (x - MARK.boxCentre.x) * k;
  const toY = (y) => cy + (y - MARK.boxCentre.y) * k;

  const spineX = toX(8);
  const spineTop = toY(MARK.spine.top);
  const spineBottom = toY(MARK.spine.bottom);
  const spineR = MARK.spine.radius * k;
  const dotY = toY(MARK.dot.cy);
  const dotR = MARK.dot.radius * k;

  return {
    // Distance to the segment, i.e. a capsule — which is what a round cap is.
    spine: (x, y) => {
      const clampedY = Math.min(Math.max(y, spineTop), spineBottom);
      return Math.hypot(x - spineX, y - clampedY) <= spineR;
    },
    dot: (x, y) => Math.hypot(x - spineX, y - dotY) <= dotR,
  };
}

/**
 * Rasterises the mark to straight (un-premultiplied) RGBA.
 *
 * `dotColour` of `null` means one silhouette: the dot is unioned into the spine
 * rather than drawn over it, which is what the alpha-only assets want.
 */
function render({ size, glyphHeight, spineColour, dotColour }) {
  const { spine, dot } = placeMark(size, glyphHeight);
  const rgba = Buffer.alloc(size * size * 4);

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const spineA = coverage(x, y, spine);
      const dotA = dotColour ? coverage(x, y, dot) : 0;
      const silhouetteA = dotColour
        ? 0
        : coverage(x, y, (sx, sy) => spine(sx, sy) || dot(sx, sy));

      // Source-over of the dot onto the spine, in straight alpha.
      const alpha = dotColour ? dotA + spineA * (1 - dotA) : silhouetteA;
      const i = (y * size + x) * 4;
      if (alpha > 0) {
        for (let c = 0; c < 3; c += 1) {
          const top = dotColour ? dotColour[c] * dotA : 0;
          const bottom = spineColour[c] * spineA * (dotColour ? 1 - dotA : 1);
          const base = dotColour ? top + bottom : spineColour[c] * silhouetteA;
          rgba[i + c] = Math.round(base / alpha);
        }
      }
      rgba[i + 3] = Math.round(alpha * 255);
    }
  }

  return { size, rgba };
}

/** Minimal PNG writer: 8-bit RGBA, filter 0, one IDAT. */
function encodePng({ size, rgba }) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0; // filter type: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

/**
 * 96px is xxxhdpi's 24dp slot, so the `expo-notifications` plugin resizes down
 * to every other density and never up. 22 of those 24dp are the glyph.
 */
const NOTIFICATION_SIZE = 96;
const NOTIFICATION_GLYPH = Math.round(NOTIFICATION_SIZE * (22 / 24));

/**
 * 432px is the 108dp adaptive canvas at xxxhdpi. The mark is 46.2% of the iOS
 * `icon.png` square; the visible part of this canvas is 72 of its 108dp, so the
 * same apparent size is 0.462 * (72/108) of the canvas — comfortably inside the
 * 66dp safe circle, which is what stops a round mask clipping it.
 */
const ADAPTIVE_SIZE = 432;
const ADAPTIVE_GLYPH = Math.round(ADAPTIVE_SIZE * 0.462 * (72 / 108));

const ASSETS = [
  {
    file: 'notification-icon.png',
    what: 'status-bar / shade icon (alpha only, tinted by expo-notifications)',
    image: {
      size: NOTIFICATION_SIZE,
      glyphHeight: NOTIFICATION_GLYPH,
      spineColour: WHITE,
      dotColour: null,
    },
  },
  {
    file: 'android-icon-foreground.png',
    what: 'adaptive icon foreground layer',
    image: {
      size: ADAPTIVE_SIZE,
      glyphHeight: ADAPTIVE_GLYPH,
      spineColour: SPINE,
      dotColour: ACCENT,
    },
  },
  {
    file: 'android-icon-monochrome.png',
    what: 'adaptive icon monochrome layer (themed icons)',
    image: {
      size: ADAPTIVE_SIZE,
      glyphHeight: ADAPTIVE_GLYPH,
      spineColour: WHITE,
      dotColour: null,
    },
  },
];

mkdirSync(OUT_DIR, { recursive: true });
for (const asset of ASSETS) {
  const png = encodePng(render(asset.image));
  writeFileSync(join(OUT_DIR, asset.file), png);
  console.log(
    `${asset.file.padEnd(30)} ${asset.image.size}x${asset.image.size}` +
      `  glyph ${asset.image.glyphHeight}px  — ${asset.what}`,
  );
}
