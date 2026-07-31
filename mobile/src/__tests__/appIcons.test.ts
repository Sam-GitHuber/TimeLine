/**
 * The Android icon assets, checked as *geometry* rather than as bytes.
 *
 * Icons are the one part of the app no test suite normally looks at, which is
 * how the Android build shipped for a whole phase with the **stock Expo logo**
 * in all three adaptive layers, and a notification icon that rendered at half
 * the size of every neighbouring app's (#171). Both were visible only to a
 * person holding a phone.
 *
 * The trap is that Android has *three* icon slots with three different geometry
 * rules, and an asset authored for one looks plausible in another right up until
 * it renders:
 *
 * - **Notification** — a 24dp slot with the glyph expected to fill ~22dp, so the
 *   asset is authored **full-bleed**. Android reads only its alpha channel and
 *   tints it, so a colour image renders as a solid blob.
 * - **Adaptive foreground / monochrome** — a 108dp canvas of which only the
 *   central 72dp is visible and only the central 66dp *circle* is safe from a
 *   launcher's mask, so the glyph sits well inside a wide transparent margin.
 *
 * Hand the second to the first — which is exactly what #171 was — and you get a
 * glyph at ~45% of the slot. So these tests assert what each slot needs: how
 * much of its canvas the glyph fills, and that the glyph is still our mark.
 *
 * A checksum would be a worse test: it would fail on every legitimate re-render
 * and would still have passed on the stock Expo logo, which is the bug we had.
 * Regenerate with `node scripts/generate-icons.mjs`.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';

const MOBILE_ROOT = join(__dirname, '..', '..');

type Png = { width: number; height: number; alpha: Uint8Array };

/**
 * Decodes an 8-bit RGBA PNG far enough to read its alpha channel.
 *
 * Deliberately hand-rolled rather than adding an image dependency to the app's
 * tree for a test: the assets are written by `scripts/generate-icons.mjs`, which
 * is itself dependency-free for the same reason.
 */
function decodePng(path: string): Png {
  const buf = readFileSync(path);
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error(`${path}: not a PNG`);

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colourType = 0;
  const idat: Buffer[] = [];

  // Walk the chunk list: 4-byte length, 4-byte type, payload, 4-byte CRC.
  for (let at = 8; at < buf.length; ) {
    const length = buf.readUInt32BE(at);
    const type = buf.toString('ascii', at + 4, at + 8);
    const body = buf.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      bitDepth = body[8];
      colourType = body[9];
    } else if (type === 'IDAT') {
      idat.push(body);
    } else if (type === 'IEND') {
      break;
    }
    at += length + 12;
  }

  if (bitDepth !== 8 || colourType !== 6) {
    throw new Error(`${path}: expected 8-bit RGBA, got depth ${bitDepth} type ${colourType}`);
  }

  const raw = inflateSync(Buffer.concat(idat));
  const bpp = 4;
  const stride = width * bpp;
  const pixels = Buffer.alloc(height * stride);

  // Undo the per-row filters (PNG spec 9.2). Every row may pick its own.
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x += 1) {
      const a = x >= bpp ? pixels[y * stride + x - bpp] : 0;
      const b = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y > 0 ? pixels[(y - 1) * stride + x - bpp] : 0;
      let value = line[x];
      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += (a + b) >> 1;
      else if (filter === 4) {
        // Paeth: pick whichever neighbour the gradient predictor lands nearest.
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      pixels[y * stride + x] = value & 0xff;
    }
  }

  const alpha = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i += 1) alpha[i] = pixels[i * bpp + 3];
  return { width, height, alpha };
}

/** Where the visible glyph sits, and how much of the canvas it takes up. */
function glyphBox({ width, height, alpha }: Png) {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  let opaque = 0;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      // 10/255 ignores anti-aliasing spill without ignoring real edges.
      if (alpha[y * width + x] <= 10) continue;
      opaque += 1;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  if (maxX < 0) throw new Error('asset is entirely transparent');
  const boxWidth = maxX - minX + 1;
  const boxHeight = maxY - minY + 1;
  return {
    width: boxWidth,
    height: boxHeight,
    aspect: boxWidth / boxHeight,
    fillsHeight: boxHeight / height,
    fillsWidth: boxWidth / width,
    /** Fraction of the whole canvas that is ink — a filled rect would be 1. */
    inkFraction: opaque / (width * height),
    centreX: (minX + maxX + 1) / 2,
    centreY: (minY + maxY + 1) / 2,
  };
}

const appJson = JSON.parse(readFileSync(join(MOBILE_ROOT, 'app.json'), 'utf8'));
const { android, plugins } = appJson.expo;

const notificationsPlugin = plugins.find(
  (plugin: unknown) => Array.isArray(plugin) && plugin[0] === 'expo-notifications',
);

function asset(relativePath: string) {
  return decodePng(join(MOBILE_ROOT, relativePath));
}

/**
 * The mark is the `Layout.jsx` spine + now-dot: an 8-wide by 18-tall bounding
 * box, so decidedly taller than it is wide. The stock Expo chevron this
 * replaced was *wider* than tall (196x176), which is what makes the aspect a
 * real check on identity and not just on shape.
 */
const MARK_ASPECT = 8 / 18;

describe('app.json icon references', () => {
  it('names only assets that exist', () => {
    const referenced = [
      appJson.expo.icon,
      appJson.expo.splash ?? null,
      android.adaptiveIcon.foregroundImage,
      android.adaptiveIcon.backgroundImage ?? null,
      android.adaptiveIcon.monochromeImage,
      notificationsPlugin[1].icon,
    ].filter((path): path is string => typeof path === 'string');

    for (const path of referenced) {
      expect(() => readFileSync(join(MOBILE_ROOT, path))).not.toThrow();
    }
  });

  it('gives the adaptive icon a background, by image or by colour', () => {
    // Dropping `backgroundImage` is only safe because a colour is set; without
    // either, the launcher falls back to a bare white plate.
    expect(
      android.adaptiveIcon.backgroundImage ?? android.adaptiveIcon.backgroundColor,
    ).toBeTruthy();
  });
});

describe('the notification icon', () => {
  const icon = asset(notificationsPlugin[1].icon);
  const box = glyphBox(icon);

  it('is not the adaptive monochrome layer', () => {
    // The bug in #171 in one line: the two slots have different geometry rules,
    // so one asset cannot correctly serve both.
    expect(notificationsPlugin[1].icon).not.toBe(android.adaptiveIcon.monochromeImage);
  });

  it('is square, so Android scales it evenly into the 24dp slot', () => {
    expect(icon.width).toBe(icon.height);
  });

  it('fills its canvas, rather than sitting in an adaptive-icon safe zone', () => {
    // Android draws the glyph at ~22 of the slot's 24dp. The stock asset managed
    // 45%, which is what made TimeLine's push visibly smaller than every other
    // app's; anything under 85% is that bug again.
    expect(box.fillsHeight).toBeGreaterThanOrEqual(0.85);
  });

  it('is a silhouette, not a filled colour image', () => {
    // Only the alpha channel is read, so an opaque colour image — the other
    // classic mistake here — renders as a solid tinted blob.
    expect(box.inkFraction).toBeLessThan(0.6);
    expect(box.inkFraction).toBeGreaterThan(0.05);
  });

  it('is the TimeLine mark', () => {
    expect(box.aspect).toBeCloseTo(MARK_ASPECT, 1);
  });

  it('is tinted with the accent, since Android ignores the asset colours', () => {
    expect(notificationsPlugin[1].color).toBe('#1C8A6A');
  });
});

describe.each([
  ['foreground', android.adaptiveIcon.foregroundImage],
  ['monochrome', android.adaptiveIcon.monochromeImage],
])('the adaptive icon %s layer', (_name, path) => {
  const layer = asset(path);
  const box = glyphBox(layer);

  it('is the TimeLine mark, not the stock Expo chevron', () => {
    expect(box.aspect).toBeCloseTo(MARK_ASPECT, 1);
  });

  it('is square', () => {
    expect(layer.width).toBe(layer.height);
  });

  it('is centred', () => {
    // A launcher parallaxes the layer against its background, so an off-centre
    // glyph drifts out of the mask.
    expect(box.centreX).toBeCloseTo(layer.width / 2, 0);
    expect(box.centreY).toBeCloseTo(layer.height / 2, 0);
  });

  it('stays inside the 66dp safe circle', () => {
    // The canvas is 108dp; anything outside the central 66dp circle can be
    // clipped by a round mask. Corner-to-corner of the glyph box is what has to
    // fit, not its height.
    const diagonal = Math.hypot(box.width, box.height);
    expect(diagonal / layer.width).toBeLessThanOrEqual(66 / 108);
  });

  it('is not so small it reads as a different app from the iOS icon', () => {
    // The mark is 46% of the iOS `icon.png` square; only 72 of these 108dp are
    // ever visible, so the same apparent size is ~31% of this canvas.
    expect(box.fillsHeight).toBeGreaterThan(0.2);
  });
});
