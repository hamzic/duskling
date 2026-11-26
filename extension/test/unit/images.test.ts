import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PALETTES } from "../../src/engine/color/palettes";
import { transformCssColor } from "../../src/engine/color/transform";
import type { RewriteCtx } from "../../src/engine/css/declarations";
import { rewriteDeclaration } from "../../src/engine/css/declarations";
import { InlineStyler } from "../../src/engine/css/inline";
import { StyleManager } from "../../src/engine/css/style-manager";
import { VariableRegistry } from "../../src/engine/css/variables";
import { ImageStyler, classifyPixels, dimImagesCss } from "../../src/engine/media/images";

const p = PALETTES.dark;
const tick = () => new Promise((r) => setTimeout(r, 0));
const now = (fn: () => void) => fn();
const SVG = "http://www.w3.org/2000/svg";

type RGBA4 = [number, number, number, number];
/** A w×h RGBA buffer; `px(i)` gives pixel i's color. */
function buffer(w: number, h: number, px: (i: number) => RGBA4): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) d.set(px(i), i * 4);
  return d;
}
const info = (renderedWidth: number, renderedHeight: number, repeats = false) => ({ renderedWidth, renderedHeight, viewportWidth: 1000, repeats });
// 60 % transparent, the rest one color.
const iconOf = (c: RGBA4) => buffer(32, 32, (i) => (i % 10 < 6 ? [0, 0, 0, 0] : c));

describe("classifyPixels", () => {
  it("a black icon on 60 % transparent pixels is a dark icon", () => {
    expect(classifyPixels(iconOf([0, 0, 0, 255]), 32, 32, info(24, 24))).toBe("dark-icon");
    expect(classifyPixels(iconOf([40, 40, 40, 255]), 32, 32, info(24, 24))).toBe("dark-icon");
  });

  it("the same buffer in saturated red (a brand mark, chroma >= 0.05) is not inverted", () => {
    expect(classifyPixels(iconOf([200, 0, 0, 255]), 32, 32, info(24, 24))).toBe("other");
  });

  it("a light gray icon on transparent is not a dark icon", () => {
    expect(classifyPixels(iconOf([200, 200, 200, 255]), 32, 32, info(24, 24))).toBe("other");
  });

  it("full white wider than half the viewport is a light large image; a narrow or small one is not", () => {
    const white = buffer(32, 32, () => [255, 255, 255, 255]);
    expect(classifyPixels(white, 32, 32, info(900, 400))).toBe("light-large");
    expect(classifyPixels(white, 32, 32, info(400, 400))).toBe("other");
  });

  it("a near-white repeating tile, or one smaller than 128 px, is a light texture", () => {
    const tile = buffer(64, 64, (i) => (i % 7 === 0 ? [240, 240, 240, 255] : [250, 250, 250, 255]));
    expect(classifyPixels(tile, 64, 64, info(900, 600, true))).toBe("light-texture");
    expect(classifyPixels(tile, 64, 64, info(64, 64))).toBe("light-texture");
  });

  it("a random multicolor buffer (> 64 colors) is a photo, even when mostly light or transparent", () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % 256);
    expect(classifyPixels(buffer(32, 32, () => [rnd(), rnd(), rnd(), 255]), 32, 32, info(900, 600))).toBe("photo");
    // 100 distinct dark grays on transparent: photo-like, so never inverted.
    const grays = buffer(32, 32, (i) => (i % 2 ? [0, 0, 0, 0] : [(i >> 1) % 100, (i >> 1) % 100, ((i >> 1) % 100) + 1, 255]));
    expect(classifyPixels(grays, 32, 32, info(24, 24))).toBe("photo");
  });

  it("a mostly opaque light image with average chroma >= 0.05 is a photo, not light-large", () => {
    const pink = buffer(32, 32, () => [255, 200, 220, 255]);
    expect(classifyPixels(pink, 32, 32, info(900, 400))).toBe("photo");
  });

  it("the light rules count >= 85 % of all pixels: 80 % white with 20 % transparent is not light", () => {
    const partly = buffer(32, 32, (i) => (i % 5 === 0 ? [0, 0, 0, 0] : [255, 255, 255, 255]));
    expect(classifyPixels(partly, 32, 32, info(900, 400))).toBe("other");
    expect(classifyPixels(partly, 32, 32, info(64, 64, true))).toBe("other");
    const most = buffer(32, 32, (i) => (i % 10 === 0 ? [0, 0, 0, 0] : [255, 255, 255, 255]));
    expect(classifyPixels(most, 32, 32, info(900, 400))).toBe("light-large");
  });

  it("a fully transparent buffer is other", () => {
    expect(classifyPixels(buffer(32, 32, () => [0, 0, 0, 0]), 32, 32, info(24, 24))).toBe("other");
  });
});

describe("rule-level background images (ctx.imageUrl)", () => {
  const ctx = (lookup: (u: string) => string | null, baseUrl?: string): RewriteCtx => ({ palette: p, mode: "full", varRef: (v) => v, imageUrl: lookup, baseUrl });
  const DATA = "data:image/png;base64,AAAA";

  it("replaces analyzed url()s in background-image and background, looked up by absolute URL", () => {
    const seen: string[] = [];
    const lookup = (u: string) => (seen.push(u), u.endsWith("icon.png") ? DATA : null);
    expect(rewriteDeclaration("background-image", 'url("img/icon.png")', ctx(lookup, "https://a.test/css/s.css"))).toBe(`url("${DATA}")`);
    expect(seen).toEqual(["https://a.test/css/img/icon.png"]);
    const out = rewriteDeclaration("background", "url(icon.png) no-repeat, linear-gradient(#fff, #000)", ctx(lookup, "https://a.test/"));
    expect(out).toBe(`url("${DATA}") no-repeat, linear-gradient(${transformCssColor("#fff", "bg", p)}, ${transformCssColor("#000", "bg", p)})`);
  });

  it("leaves unanalyzed URLs, other properties and gentle mode alone", () => {
    expect(rewriteDeclaration("background-image", "url(x.png)", ctx(() => null, "https://a.test/"))).toBeNull();
    expect(rewriteDeclaration("list-style-image", "url(icon.png)", ctx(() => DATA, "https://a.test/"))).toBeNull();
    expect(rewriteDeclaration("background-image", "url(icon.png)", { ...ctx(() => DATA, "https://a.test/"), mode: "gentle" })).toBeNull();
  });

  it("StyleManager.imagesReady re-emits only the sheets that referenced the URLs", () => {
    document.head.innerHTML = '<style>.x::after{background-image:url("https://a.test/icon.png")}</style><style>.y{color:#000}</style>';
    const ready = new Set<string>();
    const vars = new VariableRegistry(p);
    const m = new StyleManager(document, {
      ctx: { palette: p, mode: "full", varRef: (v, r) => vars.varRef(v, r), imageUrl: (u) => (ready.has(u) ? DATA : null) },
      vars,
      fetchText: async () => null,
      schedule: now,
    });
    m.start();
    const out = () => [...document.querySelectorAll('style[data-dusk="sheet"]')].map((n) => n.textContent ?? "");
    const before = out();
    expect(before[0]).toBe("");
    ready.add("https://a.test/icon.png");
    m.imagesReady(["https://a.test/other.png"]);
    expect(out()).toEqual(before);
    m.imagesReady(["https://a.test/icon.png"]);
    expect(out()[0]).toContain(DATA);
    expect(out()[1]).toBe(before[1]);
    m.stop();
  });
});

describe("InlineStyler.setComputed (inline SVG icons)", () => {
  it("writes the text transform of a computed color as a restorable inline override, unless the element declares it", () => {
    document.body.innerHTML = `<svg id="a" xmlns="${SVG}"><path d="M0 0h1"/></svg><svg id="b" fill="#333"></svg>`;
    const a = document.getElementById("a") as Element;
    const b = document.getElementById("b") as Element;
    const s = new InlineStyler(document, { palette: p, mode: "full", varRef: (v) => v });
    s.start();
    s.setComputed(a, "fill", "rgb(0, 0, 0)");
    s.setComputed(b, "fill", "rgb(0, 0, 0)");
    const want = document.createElement("div");
    want.style.setProperty("fill", transformCssColor("rgb(0, 0, 0)", "text", p) as string);
    expect((a as SVGElement).style.getPropertyValue("fill")).toBe(want.style.getPropertyValue("fill"));
    expect((a as SVGElement).style.getPropertyPriority("fill")).toBe("important");
    // b declares its own fill attribute (handled by the attribute path), so the computed black is not what it gets.
    expect((b as SVGElement).style.getPropertyValue("fill")).not.toBe(want.style.getPropertyValue("fill"));
    s.setComputed(a, "fill", null);
    expect(a.hasAttribute("style")).toBe(false);
    s.setComputed(a, "fill", "rgb(0, 0, 0)");
    s.stop();
    expect(a.hasAttribute("style")).toBe(false);
  });
});

describe("ImageStyler", () => {
  let s: ImageStyler | null = null;
  beforeEach(() => {
    document.head.innerHTML = "";
    document.body.innerHTML = "";
  });
  afterEach(() => {
    s?.stop();
    s = null;
  });

  it("inserts one screen-only style with the marker rules, plus dimImagesCss only when dimImages; stop() removes it", () => {
    s = new ImageStyler(document, { fetchBlobUrl: async () => null, schedule: now });
    s.start();
    const style = () => document.querySelectorAll('style[data-dusk="img"]');
    expect(style().length).toBe(1);
    const node = style()[0] as Element;
    expect(node.getAttribute("media")).toBe("screen");
    expect(node.textContent).toBe("[data-dusk-img=invert]{filter:invert(1) hue-rotate(180deg)!important}[data-dusk-img=dim]{filter:brightness(.5)!important}");
    s.stop();
    expect(style().length).toBe(0);
    s = new ImageStyler(document, { fetchBlobUrl: async () => null, schedule: now, dimImages: true });
    s.start();
    expect(style()[0]?.textContent).toContain(dimImagesCss);
    expect(dimImagesCss).toBe("img,video,canvas{filter:brightness(.75)}");
  });

  it("a cross-origin src goes through fetchBlobUrl; a failed fetch leaves the image unchanged", async () => {
    const fetchBlobUrl = vi.fn(async () => null);
    document.body.innerHTML = '<img id="i" src="https://cdn.other.test/logo.png">';
    const img = document.getElementById("i") as HTMLImageElement;
    Object.defineProperty(img, "complete", { value: true });
    img.getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 24, bottom: 24, width: 24, height: 24, toJSON: () => ({}) }) as DOMRect;
    s = new ImageStyler(document, { fetchBlobUrl, schedule: now });
    s.start();
    await tick();
    await tick();
    expect(fetchBlobUrl).toHaveBeenCalledWith("https://cdn.other.test/logo.png");
    expect(img.hasAttribute("data-dusk-img")).toBe(false);
  });

  it("a fetched <img> source isn't kept once it has been sampled", async () => {
    // Only the 32×32 sample (cached per styler) is needed for an <img> marker; the fetched data URL is a full copy of
    // the image. Seen from outside: a later styler (a fresh sample cache) fetches it again rather than reusing it.
    const fetchBlobUrl = vi.fn(async () => ({ dataUrl: "data:image/png;base64,AAAA", corsOk: true }));
    const show = () => {
      document.body.innerHTML = '<img id="i" src="https://cdn.other.test/released.png">';
      const img = document.getElementById("i") as HTMLImageElement;
      Object.defineProperty(img, "complete", { value: true });
      img.getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 24, bottom: 24, width: 24, height: 24, toJSON: () => ({}) }) as DOMRect;
    };
    for (let i = 0; i < 2; i++) {
      show();
      s = new ImageStyler(document, { fetchBlobUrl, schedule: now });
      s.start();
      for (let t = 0; t < 4; t++) await tick();
      s.stop();
    }
    s = null;
    expect(fetchBlobUrl).toHaveBeenCalledTimes(2);
  });

  it("imageUrl() never fetches: a url() in a rule no element shows (other breakpoint, :hover, unused sprite) isn't loaded", async () => {
    // Re-fetches only for resources the page already loads. Only elements' computed backgrounds start analysis.
    const fetchBlobUrl = vi.fn(async () => null);
    s = new ImageStyler(document, { fetchBlobUrl, schedule: now });
    s.start();
    expect(s.imageUrl("https://cdn.other.test/a.png")).toBeNull();
    await tick();
    await tick();
    expect(fetchBlobUrl).not.toHaveBeenCalled();
  });

  it("on 1,000 images, only marker-eligible ones are fetched, at most 4 at a time", async () => {
    let inflight = 0;
    let max = 0;
    const urls: string[] = [];
    const fetchBlobUrl = async (u: string) => {
      urls.push(u);
      max = Math.max(max, ++inflight);
      await tick();
      inflight--;
      return null;
    };
    const rect = (w: number, h: number) => () => ({ x: 0, y: 0, top: 0, left: 0, right: w, bottom: h, width: w, height: h, toJSON: () => ({}) }) as DOMRect;
    for (let i = 0; i < 1000; i++) {
      const img = document.createElement("img");
      img.src = `https://cdn.other.test/${i}.png`;
      Object.defineProperty(img, "complete", { value: true });
      // Even: a 24×24 icon (eligible). Odd: 500×600 — too large for an icon, too narrow for light-large (viewport 1024).
      img.getBoundingClientRect = i % 2 ? rect(500, 600) : rect(24, 24);
      document.body.append(img);
    }
    s = new ImageStyler(document, { fetchBlobUrl, schedule: now });
    s.start();
    for (let i = 0; i < 400 && urls.length < 500; i++) await tick();
    for (let i = 0; i < 10; i++) await tick();
    expect(urls.length).toBe(500);
    expect(urls.every((u) => Number(/(\d+)\.png$/.exec(u)?.[1]) % 2 === 0)).toBe(true);
    expect(max).toBeLessThanOrEqual(4);
    expect(max).toBeGreaterThan(1);
  });
});
