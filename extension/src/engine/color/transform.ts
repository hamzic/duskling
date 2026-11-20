import { contrastRatio } from "./contrast";
import { oklchToRgba, rgbaToOklch } from "./oklch";
import type { Oklch } from "./oklch";
import type { Palette } from "./palettes";
import { formatColor, parseColor } from "./parse";
import type { RGBA } from "./parse";

export type Role = "bg" | "text" | "border";

const NEUTRAL_C = 0.02;
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

function bgOklch(o: Oklch, p: Palette): Oklch {
  const bgL = p.bg.l;
  const neutral = o.c < NEUTRAL_C;
  const l = o.l >= 0.5 ? bgL + (1 - o.l) * 0.36 : lerp(Math.max(bgL - 0.08, 0), bgL + 0.18, o.l / 0.5);
  const c = o.l >= 0.5 ? Math.min(o.c, 0.12) * 0.7 : Math.min(o.c, 0.14);
  return { l, c: neutral ? p.neutralChroma : c, h: neutral ? p.neutralHue : o.h, a: o.a };
}

function textOklch(o: Oklch, p: Palette): Oklch {
  const fgL = p.fg.l;
  const neutral = o.c < NEUTRAL_C;
  const l = o.l <= 0.6 ? fgL - (o.l / 0.6) * 0.12 : Math.max(o.l, fgL - 0.12);
  const c = o.l <= 0.6 ? Math.min(o.c, 0.15) : o.c;
  // Achromatic text takes the theme's fg tint (fg C/h), keeping the warm/cool character.
  return { l, c: neutral ? p.fg.c : c, h: neutral ? p.fg.h : o.h, a: o.a };
}

function borderOklch(o: Oklch, p: Palette): Oklch {
  const neutral = o.c < NEUTRAL_C;
  return {
    l: p.bg.l + 0.08 + (1 - o.l) * 0.22,
    c: neutral ? p.neutralChroma : Math.min(o.c, 0.08),
    h: neutral ? p.neutralHue : o.h,
    a: o.a,
  };
}

export function transformColor(c: RGBA, role: Role, p: Palette): RGBA {
  const o = rgbaToOklch(c);
  if (role === "bg") return oklchToRgba(bgOklch(o, p));
  if (role === "border") return oklchToRgba(borderOklch(o, p));
  // Contrast guarantee: raise L in 0.02 steps until WCAG >= 4.5 against the theme background, or L = 1.
  const t = textOklch(o, p);
  const bg = oklchToRgba(p.bg);
  let out = oklchToRgba(t);
  while (t.l < 1 && contrastRatio(out, bg) < 4.5) {
    t.l = Math.min(t.l + 0.02, 1);
    out = oklchToRgba(t);
  }
  return out;
}

const CACHE_CAP = 5000;
const cache = new Map<string, string | null>();

export function transformCssColor(value: string, role: Role, p: Palette): string | null {
  const key = `${p.id}|${role}|${value}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const parsed = parseColor(value);
  const out = parsed ? formatColor(transformColor(parsed, role, p)) : null;
  if (cache.size >= CACHE_CAP) cache.delete(cache.keys().next().value as string);
  cache.set(key, out);
  return out;
}

export const colorCacheSize = (): number => cache.size;
export const clearColorCache = (): void => cache.clear();

export function paletteCss(p: Palette): { bg: string; fg: string; selectionBg: string; selectionText: string; border: string } {
  const fg = formatColor(oklchToRgba(p.fg));
  const sel = transformColor({ r: 0x33, g: 0x8f, b: 0xff, a: 1 }, "bg", p);
  return {
    bg: formatColor(oklchToRgba(p.bg)),
    fg,
    selectionBg: formatColor({ ...sel, a: 0.6 }),
    selectionText: fg,
    // Default hairline border: the border transform of a light gray (#ccc).
    border: formatColor(transformColor({ r: 204, g: 204, b: 204, a: 1 }, "border", p)),
  };
}
