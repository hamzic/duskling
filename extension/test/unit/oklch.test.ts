import { describe, expect, it } from "vitest";
import { contrastRatio, relativeLuminance } from "../../src/engine/color/contrast";
import { oklchToRgba, rgbaToOklch } from "../../src/engine/color/oklch";
import { parseColor } from "../../src/engine/color/parse";

const c = (s: string) => {
  const v = parseColor(s);
  if (!v) throw new Error(s);
  return v;
};

describe("rgbaToOklch", () => {
  it("maps white and black", () => {
    const w = rgbaToOklch(c("#fff"));
    expect(w.l).toBeCloseTo(1, 3);
    expect(w.c).toBeCloseTo(0, 3);
    expect(rgbaToOklch(c("#000")).l).toBeCloseTo(0, 3);
  });

  it("maps #ff0000 to the published OKLCH values", () => {
    const o = rgbaToOklch(c("#ff0000"));
    expect(Math.abs(o.l - 0.628)).toBeLessThan(0.005);
    expect(Math.abs(o.c - 0.258)).toBeLessThan(0.005);
    expect(Math.abs(o.h - 29.2)).toBeLessThan(0.5);
  });

  it("preserves alpha", () => {
    expect(rgbaToOklch({ r: 10, g: 20, b: 30, a: 0.4 }).a).toBe(0.4);
  });
});

describe("oklchToRgba", () => {
  it("round-trips 1000 random sRGB colors within 0.5 per channel", () => {
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 255;
    for (let i = 0; i < 1000; i++) {
      const src = { r: rnd(), g: rnd(), b: rnd(), a: 1 };
      const back = oklchToRgba(rgbaToOklch(src));
      expect(Math.abs(back.r - src.r)).toBeLessThan(0.5);
      expect(Math.abs(back.g - src.g)).toBeLessThan(0.5);
      expect(Math.abs(back.b - src.b)).toBeLessThan(0.5);
    }
  });

  it("gamut-maps out-of-gamut oklch(0.7 0.4 150) into sRGB by reducing chroma", () => {
    const out = oklchToRgba({ l: 0.7, c: 0.4, h: 150, a: 1 });
    for (const v of [out.r, out.g, out.b]) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(255);
    }
    const back = rgbaToOklch(out);
    expect(back.c).toBeLessThan(0.4);
    expect(Math.abs(back.h - 150)).toBeLessThan(3);
    expect(Math.abs(back.l - 0.7)).toBeLessThan(0.02);
  });
});

describe("contrast", () => {
  it("computes WCAG contrast", () => {
    expect(contrastRatio(c("#fff"), c("#000"))).toBe(21);
    expect(contrastRatio(c("#000"), c("#fff"))).toBe(21);
    expect(contrastRatio(c("#777"), c("#fff"))).toBeCloseTo(4.48, 2);
    expect(relativeLuminance(c("#fff"))).toBe(1);
    expect(relativeLuminance(c("#000"))).toBe(0);
  });
});
