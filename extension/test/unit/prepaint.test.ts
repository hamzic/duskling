import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import { PALETTES } from "../../src/engine/color/palettes";
import { paletteCss } from "../../src/engine/color/transform";
import { prepaintCss, prepaintFiles, prepaintJs } from "../../src/prepaint/generate";
import { BOOT_CLASSES, bootFiles, bootJs, engineClass } from "../../src/shared/boot";

const prepaintStyles = () => [...document.querySelectorAll('style[data-dusk="prepaint"]')] as HTMLStyleElement[];

afterEach(() => {
  for (const s of prepaintStyles()) s.remove();
});

describe("prepaintCss", () => {
  it("is the template with the palette's bg/fg, under 1 KB, screen-only", () => {
    for (const p of Object.values(PALETTES)) {
      const css = prepaintCss(p);
      const c = paletteCss(p);
      expect(new TextEncoder().encode(css).length).toBeLessThanOrEqual(1024);
      expect(css).toContain("@media screen");
      expect(css).toContain("html:not([data-dusk-ready])");
      expect(css).toBe(
        "@media screen {\n" +
          `  html:not([data-dusk-ready]):not([data-dusk-sampling]) { background-color: ${c.bg} !important; color-scheme: dark !important; }\n` +
          `  html:not([data-dusk-ready]):not([data-dusk-sampling]) body { background-color: ${c.bg} !important; color: ${c.fg} !important; }\n` +
          `  html:not([data-dusk-ready]):not([data-dusk-sampling]) body * { background-color: transparent !important; color: ${c.fg} !important; }\n` +
          `  html:not([data-dusk-ready]):not([data-dusk-sampling]) iframe { color-scheme: normal !important; }\n` +
          "}\n",
      );
    }
  });
});

describe("prepaintJs", () => {
  it("synchronously inserts the same CSS as a screen <style> into documentElement, once", () => {
    const p = PALETTES.midnight;
    new Function(prepaintJs(p))();
    let styles = prepaintStyles();
    expect(styles).toHaveLength(1);
    expect(styles[0]?.parentNode).toBe(document.documentElement);
    expect(styles[0]?.textContent).toBe(prepaintCss(p));
    expect(styles[0]?.media).toBe("screen");
    // Re-registration injects into open pages: a second run must not duplicate.
    new Function(prepaintJs(p))();
    styles = prepaintStyles();
    expect(styles).toHaveLength(1);
  });
});

describe("prepaintFiles", () => {
  it("emits <theme>.css and <theme>.js for every theme", () => {
    const files = prepaintFiles();
    expect(Object.keys(files).sort()).toEqual(["dark.css", "dark.js", "dim.css", "dim.js", "midnight.css", "midnight.js"]);
    expect(files["dim.css"]).toBe(prepaintCss(PALETTES.dim));
    expect(files["dim.js"]).toBe(prepaintJs(PALETTES.dim));
  });
});

describe("boot files", () => {
  it("engineClass encodes (mode, theme, dimImages) and is null for off", () => {
    expect(engineClass("full", "dark", false)).toBe("full-dark");
    expect(engineClass("gentle", "midnight", true)).toBe("gentle-midnight-dim");
    expect(engineClass("filter", "dim", false)).toBe("filter-dim");
    expect(engineClass("off", "dark", true)).toBeNull();
  });

  it("engineClass encodes respectNativeDark off for full and gentle; filter never detects", () => {
    expect(engineClass("full", "dark", false, false)).toBe("full-dark-ignore");
    expect(engineClass("gentle", "dim", true, false)).toBe("gentle-dim-dim-ignore");
    expect(engineClass("filter", "dim", false, false)).toBe("filter-dim");
    expect(bootJs("gentle-dim-dim-ignore")).toBe('globalThis.__duskBoot ??= {mode:"gentle",theme:"dim",dimImages:true,respectNativeDark:false};');
    expect(() => bootJs("filter-dim-ignore")).toThrow();
    expect(() => bootJs("full-dark-ignore-dim")).toThrow();
  });

  it("there are 30 classes, one file each, under boot/", () => {
    expect(BOOT_CLASSES).toHaveLength(30);
    expect(new Set(BOOT_CLASSES).size).toBe(30);
    const files = bootFiles();
    expect(Object.keys(files).sort()).toEqual(BOOT_CLASSES.map((c) => `${c}.js`).sort());
    for (const c of BOOT_CLASSES) expect(files[`${c}.js`]).toBe(bootJs(c));
  });

  it("bootJs sets globalThis.__duskBoot, first-wins", () => {
    expect(bootJs("gentle-midnight-dim")).toBe('globalThis.__duskBoot ??= {mode:"gentle",theme:"midnight",dimImages:true};');
    const ctx: { __duskBoot?: unknown } = {};
    runInNewContext(bootJs("gentle-midnight-dim"), ctx);
    runInNewContext(bootJs("full-dark"), ctx);
    expect(ctx.__duskBoot).toEqual({ mode: "gentle", theme: "midnight", dimImages: true });
    for (const c of BOOT_CLASSES) expect(bootJs(c).length).toBeLessThan(100);
  });

  it("rejects an unknown class", () => {
    expect(() => bootJs("off-dark")).toThrow();
    expect(() => bootJs("full-sepia")).toThrow();
  });
});
