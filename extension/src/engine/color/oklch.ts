import type { RGBA } from "./parse";

export interface Oklch { l: number; c: number; h: number; a: number }

// Matrices: Björn Ottosson, "A perceptual color space for image processing"
// https://bottosson.github.io/posts/oklab/ (linear sRGB <-> OKLab, D65).

const toLinear = (v: number): number => {
  const s = v / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
// IEC 61966-2-1 sRGB transfer function; returns 0..255 (unclamped).
export const fromLinear = (v: number): number =>
  255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.sign(v) * Math.abs(v) ** (1 / 2.4) - 0.055);

/** Linear sRGB (0..1) to OKLab [L, a, b]. */
export function linearToOklab(r: number, g: number, b: number): [number, number, number] {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** OKLab to linear sRGB (0..1, may be out of gamut). */
export function oklabToLinear(L: number, a: number, b: number): [number, number, number] {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

export const clamp255 = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : v);

export function rgbaToOklch(c: RGBA): Oklch {
  const [L, a, b] = linearToOklab(toLinear(c.r), toLinear(c.g), toLinear(c.b));
  const chroma = Math.hypot(a, b);
  let h = (Math.atan2(b, a) * 180) / Math.PI;
  if (h < 0) h += 360;
  return { l: L, c: chroma < 1e-7 ? 0 : chroma, h: chroma < 1e-7 ? 0 : h, a: c.a };
}

const EPS = 1e-4;
const inGamut = (v: [number, number, number]): boolean => v.every((x) => x >= -EPS && x <= 1 + EPS);

/** OKLab to RGBA, clamping to sRGB without chroma reduction. */
export function oklabToRgba(L: number, a: number, b: number, alpha: number): RGBA {
  const [r, g, bl] = oklabToLinear(L, a, b);
  return { r: clamp255(fromLinear(r)), g: clamp255(fromLinear(g)), b: clamp255(fromLinear(bl)), a: alpha };
}

/** Out-of-gamut input is mapped by binary-searching chroma down (12 iterations). */
export function oklchToRgba(o: Oklch): RGBA {
  const rad = (o.h * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const lin = (c: number) => oklabToLinear(o.l, c * cos, c * sin);
  let chroma = Math.max(o.c, 0);
  if (!inGamut(lin(chroma))) {
    let lo = 0;
    let hi = chroma;
    for (let i = 0; i < 12; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut(lin(mid))) lo = mid;
      else hi = mid;
    }
    chroma = lo;
  }
  return oklabToRgba(o.l, chroma * cos, chroma * sin, o.a);
}
