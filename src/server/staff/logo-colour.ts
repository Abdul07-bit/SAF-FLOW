import { PNG } from "pngjs";
import jpeg from "jpeg-js";

/**
 * Picks a business's brand colour from its uploaded logo, so staff ID cards
 * carry the shop's own identity instead of the SAF product colour.
 *
 * - Transparent and near-white pixels (logo background) are ignored.
 * - The most common *coloured* tone wins; a black / grey logo gives a dark grey.
 * - The result is darkened until white text on it is readable (WCAG 4.5:1),
 *   because the card header prints the business name in white on this colour.
 *
 * Returns null when the logo cannot be decoded or is blank, so callers fall back.
 */
export function brandHexFromLogo(body: Uint8Array, contentType: string): string | null {
  let w: number, h: number, data: Uint8Array;
  try {
    if (contentType === "image/png") {
      const img = PNG.sync.read(Buffer.from(body));
      ({ width: w, height: h } = img);
      data = img.data;
    } else {
      const img = jpeg.decode(body, { useTArray: true, maxMemoryUsageInMB: 256 });
      ({ width: w, height: h } = img);
      data = img.data;
    }
  } catch {
    return null;
  }

  const step = Math.max(1, Math.floor(Math.sqrt((w * h) / 20000))); // sample ~20k pixels
  const chroma = new Map<number, { n: number; r: number; g: number; b: number }>();
  const neutral = { n: 0, r: 0, g: 0, b: 0 };
  let chromaCount = 0;

  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      const i = (y * w + x) * 4;
      const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
      if (a < 128) continue;
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      if (min > 225) continue; // white / paper background
      const l = (max + min) / 510;
      const s = max === min ? 0 : (max - min) / (255 - Math.abs(max + min - 255));
      if (s > 0.25 && l > 0.08 && l < 0.92) {
        const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
        const bin = chroma.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
        bin.n++; bin.r += r; bin.g += g; bin.b += b;
        chroma.set(key, bin);
        chromaCount++;
      } else {
        neutral.n++; neutral.r += r; neutral.g += g; neutral.b += b;
      }
    }
  }

  let pick: { n: number; r: number; g: number; b: number } | null = null;
  // A real accent colour, even if most of the logo is black text.
  if (chromaCount >= Math.max(20, (chromaCount + neutral.n) * 0.04)) {
    // Merge neighbouring bins so anti-aliased shades of one colour count together.
    let best = -1;
    for (const [key, bin] of chroma) {
      const kr = key >> 8, kg = (key >> 4) & 15, kb = key & 15;
      let n = 0;
      for (const [k2, b2] of chroma) {
        if (Math.abs((k2 >> 8) - kr) <= 1 && Math.abs(((k2 >> 4) & 15) - kg) <= 1 && Math.abs((k2 & 15) - kb) <= 1) n += b2.n;
      }
      if (n > best) { best = n; pick = bin; }
    }
  } else if (neutral.n > 0) {
    pick = neutral;
  }
  if (!pick) return null;

  // Darken by lowering HSL lightness only, so the hue stays vivid (orange -> deep orange, not brown).
  const [hh, ss, ll] = toHsl(pick.r / pick.n, pick.g / pick.n, pick.b / pick.n);
  let rgbOut = fromHsl(hh, ss, ll);
  for (let l = ll; l > 0 && contrastWithWhite(...rgbOut) < 4.5; ) { l = Math.max(0, l - 0.01); rgbOut = fromHsl(hh, ss, l); }
  return "#" + rgbOut.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
}

function toHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
  if (d === 0) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}

function fromHsl(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

function contrastWithWhite(r: number, g: number, b: number): number {
  const lin = (v: number) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const L = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return 1.05 / (L + 0.05);
}
