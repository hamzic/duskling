// Expected lab/lch/oklch values cross-checked against WebKit (Playwright webkit, canvas fillStyle -> getImageData).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { formatColor, isColorKeyword, parseColor } from "../../src/engine/color/parse";

const rgb = (s: string) => {
  const c = parseColor(s);
  return c && { r: Math.round(c.r), g: Math.round(c.g), b: Math.round(c.b), a: +c.a.toFixed(3) };
};

describe("parseColor", () => {
  it("parses hex in 3, 4, 6 and 8 digits", () => {
    expect(rgb("#f80")).toEqual({ r: 255, g: 136, b: 0, a: 1 });
    expect(rgb("#f808")).toEqual({ r: 255, g: 136, b: 0, a: 0.533 });
    expect(rgb("#FF8800")).toEqual({ r: 255, g: 136, b: 0, a: 1 });
    expect(rgb("#ff880080")).toEqual({ r: 255, g: 136, b: 0, a: 0.502 });
  });

  it("parses rgb()/rgba() with commas, spaces + slash alpha and percentages", () => {
    expect(rgb("rgb(10, 20, 30)")).toEqual({ r: 10, g: 20, b: 30, a: 1 });
    expect(rgb("rgba(10, 20, 30, 0.5)")).toEqual({ r: 10, g: 20, b: 30, a: 0.5 });
    expect(rgb("rgb(10 20 30 / 0.25)")).toEqual({ r: 10, g: 20, b: 30, a: 0.25 });
    expect(rgb("rgb(10 20 30 / 50%)")).toEqual({ r: 10, g: 20, b: 30, a: 0.5 });
    expect(rgb("rgb(100% 0% 50%)")).toEqual({ r: 255, g: 0, b: 128, a: 1 });
  });

  it("parses hsl()/hsla() with deg, turn and rad", () => {
    expect(rgb("hsl(0, 100%, 50%)")).toEqual({ r: 255, g: 0, b: 0, a: 1 });
    expect(rgb("hsl(120deg 100% 25%)")).toEqual({ r: 0, g: 128, b: 0, a: 1 });
    expect(rgb("hsla(240, 100%, 50%, 0.5)")).toEqual({ r: 0, g: 0, b: 255, a: 0.5 });
    expect(rgb("hsl(0.5turn 100% 50%)")).toEqual({ r: 0, g: 255, b: 255, a: 1 });
    expect(rgb(`hsl(${Math.PI}rad 100% 50%)`)).toEqual({ r: 0, g: 255, b: 255, a: 1 });
  });

  it("parses named colors", () => {
    expect(rgb("rebeccapurple")).toEqual({ r: 102, g: 51, b: 153, a: 1 });
    expect(rgb("white")).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(rgb("BLACK")).toEqual({ r: 0, g: 0, b: 0, a: 1 });
    expect(rgb("transparent")).toEqual({ r: 0, g: 0, b: 0, a: 0 });
  });

  it("knows 148 named colors", () => {
    const src = readFileSync(resolve(process.cwd(), "src/engine/color/parse.ts"), "utf8");
    const block = /NAMED_PACKED =([\s\S]*?);\n/.exec(src)?.[1] ?? "";
    const tokens = [...block.matchAll(/"([^"]*)"/g)].map((m) => m[1]).join("").trim().split(" ");
    expect(tokens.length / 2).toBe(148);
    for (let i = 0; i < tokens.length; i += 2) {
      const name = tokens[i] ?? "";
      const c = parseColor(name);
      expect(c && formatColor(c)).toBe(`#${tokens[i + 1]}`);
    }
  });

  it("parses oklch, oklab, lab, lch and color(srgb)", () => {
    expect(rgb("oklch(0.7 0.1 200)")).toEqual({ r: 64, g: 177, b: 183, a: 1 });
    expect(rgb("oklch(1 0 0)")).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(rgb("oklab(0.628 0.2249 0.1258)")).toEqual({ r: 255, g: 0, b: 0, a: 1 });
    expect(rgb("lab(50% 40 59.5)")).toEqual({ r: 191, g: 87, b: 0, a: 1 });
    expect(rgb("lab(100 0 0)")).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(rgb("lch(52.2345% 72.2 56.2)")).toEqual({ r: 198, g: 93, b: 6, a: 1 });
    expect(rgb("color(srgb 1 0 0)")).toEqual({ r: 255, g: 0, b: 0, a: 1 });
    expect(rgb("color(srgb 0 0.5 1 / 0.5)")).toEqual({ r: 0, g: 128, b: 255, a: 0.5 });
  });

  it("treats none channels as 0", () => {
    expect(rgb("rgb(none 20 30)")).toEqual({ r: 0, g: 20, b: 30, a: 1 });
    expect(rgb("oklch(1 none none)")).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(rgb("hsl(none 100% 50%)")).toEqual({ r: 255, g: 0, b: 0, a: 1 });
  });

  it("returns null for invalid or unsupported input", () => {
    for (const bad of ["#ggg", "#12", "rgb(1,2)", "var(--x)", "color-mix(in srgb, red, blue)", "notacolor", "", "currentcolor", "inherit", "color(display-p3 1 0 0)"]) {
      expect(parseColor(bad)).toBeNull();
    }
  });
});

describe("formatColor", () => {
  it("emits #rrggbb when opaque and rgba() otherwise", () => {
    expect(formatColor({ r: 255, g: 136, b: 0, a: 1 })).toBe("#ff8800");
    expect(formatColor({ r: 10.4, g: 20.6, b: 30, a: 0.12345 })).toBe("rgba(10, 21, 30, 0.123)");
    expect(formatColor({ r: 0, g: 0, b: 0, a: 0 })).toBe("rgba(0, 0, 0, 0)");
  });
});

describe("isColorKeyword", () => {
  it("recognizes non-parseable keywords and transparent", () => {
    for (const k of ["transparent", "currentcolor", "currentColor", "inherit", "initial", "unset", "revert", "revert-layer"]) {
      expect(isColorKeyword(k)).toBe(true);
    }
    expect(isColorKeyword("red")).toBe(false);
  });
});
