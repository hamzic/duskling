import { beforeEach, describe, expect, it } from "vitest";
import { contrastRatio } from "../../src/engine/color/contrast";
import { oklchToRgba, rgbaToOklch } from "../../src/engine/color/oklch";
import { PALETTES } from "../../src/engine/color/palettes";
import { formatColor, parseColor } from "../../src/engine/color/parse";
import { clearColorCache, colorCacheSize, paletteCss, transformColor, transformCssColor } from "../../src/engine/color/transform";
import type { ThemeId } from "../../src/shared/types";

const c = (s: string) => {
  const v = parseColor(s);
  if (!v) throw new Error(s);
  return v;
};
const L = (s: string, role: "bg" | "text" | "border", id: ThemeId) => rgbaToOklch(transformColor(c(s), role, PALETTES[id])).l;
const IDS: ThemeId[] = ["dark", "midnight", "dim"];

describe.each(IDS)("transforms (%s)", (id) => {
  const p = PALETTES[id];

  it("meets the background anchors within 0.01 L", () => {
    expect(Math.abs(L("#ffffff", "bg", id) - p.bg.l)).toBeLessThan(0.01);
    expect(Math.abs(L("#f5f5f5", "bg", id) - (p.bg.l + 0.015))).toBeLessThan(0.01);
    const mid = oklchToRgba({ l: 0.5, c: 0, h: 0, a: 1 });
    expect(Math.abs(rgbaToOklch(transformColor(mid, "bg", p)).l - (p.bg.l + 0.18))).toBeLessThan(0.01);
    expect(Math.abs(L("#000000", "bg", id) - Math.max(p.bg.l - 0.08, 0))).toBeLessThan(0.01);
  });

  it("keeps hue for tinted backgrounds (#ffe0e0 stays pinkish)", () => {
    const before = rgbaToOklch(c("#ffe0e0")).h;
    const after = rgbaToOklch(transformColor(c("#ffe0e0"), "bg", p)).h;
    expect(Math.abs(after - before)).toBeLessThan(15);
  });

  it("maps #000 text to the theme foreground lightness", () => {
    expect(Math.abs(L("#000000", "text", id) - p.fg.l)).toBeLessThan(0.01);
  });

  it("guarantees 4.5:1 text contrast against the theme background for 1000 random inputs", () => {
    const bg = oklchToRgba(p.bg);
    let seed = 99;
    const rnd = () => Math.floor(((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 256);
    for (let i = 0; i < 1000; i++) {
      const out = transformColor({ r: rnd(), g: rnd(), b: rnd(), a: 1 }, "text", p);
      expect(contrastRatio(out, bg)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("applies the border formula", () => {
    expect(Math.abs(L("#ffffff", "border", id) - (p.bg.l + 0.08))).toBeLessThan(0.01);
    expect(Math.abs(L("#000000", "border", id) - (p.bg.l + 0.3))).toBeLessThan(0.01);
  });

  it("preserves alpha", () => {
    for (const role of ["bg", "text", "border"] as const) {
      expect(transformColor({ r: 10, g: 200, b: 90, a: 0.37 }, role, p).a).toBe(0.37);
    }
    expect(transformCssColor("rgba(10, 200, 90, 0.37)", "bg", p)).toMatch(/, 0\.37\)$/);
  });
});

describe("dim", () => {
  // #fff text maps to L=1 (achromatic by definition), so the hue anchor uses neutral dark/gray text.
  it("tints neutral text warm (hue 70-80)", () => {
    const dim = PALETTES.dim;
    const black = rgbaToOklch(transformColor(c("#000000"), "text", dim));
    expect(Math.abs(black.l - dim.fg.l)).toBeLessThan(0.01);
    expect(black.h).toBeGreaterThanOrEqual(70);
    expect(black.h).toBeLessThanOrEqual(80.01);
    const gray = rgbaToOklch(transformColor(c("#808080"), "text", dim));
    expect(gray.h).toBeGreaterThanOrEqual(70);
    expect(gray.h).toBeLessThanOrEqual(80.01);
  });
});

describe("midnight", () => {
  it("maps white to pure black and keeps relative steps for #e0e0e0 (L about 0.04)", () => {
    expect(formatColor(transformColor(c("#ffffff"), "bg", PALETTES.midnight))).toBe("#000000");
    expect(Math.abs(L("#e0e0e0", "bg", "midnight") - 0.04)).toBeLessThan(0.01);
  });
});

describe("transformCssColor", () => {
  beforeEach(() => clearColorCache());

  it("returns null when the value cannot be parsed", () => {
    expect(transformCssColor("var(--x)", "bg", PALETTES.dark)).toBeNull();
  });

  it("returns identical strings for identical inputs and caps the cache at 5000", () => {
    const p = PALETTES.dark;
    expect(transformCssColor("#123456", "bg", p)).toBe(transformCssColor("#123456", "bg", p));
    clearColorCache();
    for (let i = 0; i < 5001; i++) transformCssColor(`oklch(0.5 0.05 ${i / 10})`, "bg", p);
    expect(colorCacheSize()).toBe(5000);
  });
});

describe("paletteCss", () => {
  it("formats root colors", () => {
    const css = paletteCss(PALETTES.midnight);
    expect(css.bg).toBe("#000000");
    expect(css.fg).toMatch(/^#[0-9a-f]{6}$/);
    expect(css.selectionBg).toMatch(/^rgba\(\d+, \d+, \d+, 0\.6\)$/);
    expect(css.selectionText).toBe(css.fg);
    expect(css.border).toMatch(/^#[0-9a-f]{6}$/);
  });
});
