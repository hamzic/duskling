import { markOwn } from "../css/own";
import { rgbaToOklch } from "../color/oklch";
import { PALETTES } from "../color/palettes";
import type { Palette } from "../color/palettes";
import { parseColor } from "../color/parse";
import { transformColor } from "../color/transform";
import { restoreStyleAttr } from "../css/csp";
import type { InlineStyler } from "../css/inline";

export type ImageClass = "dark-icon" | "light-texture" | "light-large" | "photo" | "other";
export interface PixelInfo { renderedWidth: number; renderedHeight: number; viewportWidth: number; repeats: boolean }
/**
 * A cross-origin image fetched by the background. `corsOk`: the response carried
 * `Access-Control-Allow-Origin: *` or the page's origin; missing means false.
 */
export interface FetchedImage { dataUrl: string; corsOk?: boolean }
type FetchBlobUrl = (url: string) => Promise<FetchedImage | null>;
interface Source { src: string; corsOk: boolean }

// Thresholds.
const TRANSPARENT_SHARE = 0.5;
const ICON_L = 0.3;
const MONO_C = 0.05;
const LIGHT_L = 0.85;
const LIGHT_SHARE = 0.85;
const TILE = 128;
const LARGE_SHARE = 0.5;
const PHOTO_COLORS = 64;
const SAMPLE = 32;
const MAX = 512;
/** Backdrop shapes: only in an `<svg>` larger than this, the swatch size of the content-color guard. */
const BACKDROP_MIN = 64;
const BACKDROP_SHAPES = "rect, circle, ellipse, path, polygon";
/** Light large background images are re-rendered at their natural size up to this, then left alone (memory bound). */
const MAX_DIM = 2048;
// A pixel counts as transparent below half alpha (antialiased icon edges then don't count as icon ink).
const OPAQUE_ALPHA = 128;

/**
 * Classifies an RGBA sample. Photo-like (more than 64 distinct colors, or mostly opaque with average chroma
 * ≥ 0.05) is checked first. With ≥ 50 % transparent pixels it is a dark icon only when the opaque pixels average
 * OKLCH L < 0.3 and chroma < 0.05 (colored brand marks are never inverted). Otherwise ≥ 85 % of all pixels being opaque
 * with L > 0.85 make a light texture (repeating, or under 128 px in both dimensions) or a light large image (wider than
 * half the viewport).
 */
export function classifyPixels(data: Uint8ClampedArray, w: number, h: number, info: PixelInfo): ImageClass {
  const n = w * h;
  const colors = new Set<number>();
  let opaque = 0;
  let sumL = 0;
  let sumC = 0;
  let light = 0;
  for (let i = 0; i < n * 4; i += 4) {
    if ((data[i + 3] as number) < OPAQUE_ALPHA) continue;
    const r = data[i] as number;
    const g = data[i + 1] as number;
    const b = data[i + 2] as number;
    opaque++;
    if (colors.size <= PHOTO_COLORS) colors.add((r << 16) | (g << 8) | b);
    const o = rgbaToOklch({ r, g, b, a: 1 });
    sumL += o.l;
    sumC += o.c;
    if (o.l > LIGHT_L) light++;
  }
  if (opaque === 0) return "other";
  if (colors.size > PHOTO_COLORS) return "photo";
  const avgC = sumC / opaque;
  if (n - opaque >= n * TRANSPARENT_SHARE) return sumL / opaque < ICON_L && avgC < MONO_C ? "dark-icon" : "other";
  if (avgC >= MONO_C) return "photo";
  if (light < n * LIGHT_SHARE) return "other";
  if (info.repeats || (info.renderedWidth < TILE && info.renderedHeight < TILE)) return "light-texture";
  return info.renderedWidth > info.viewportWidth * LARGE_SHARE ? "light-large" : "other";
}

// At most 4 fetch/decode jobs at once on image-heavy pages; waiting jobs start in priority order (lower first: nearer
// the viewport).
const MAX_LOADS = 4;
let loads = 0;
const waiting: { p: number; go: () => void }[] = [];

async function limited<T>(priority: number, fn: () => Promise<T>): Promise<T> {
  if (loads < MAX_LOADS) loads++;
  else {
    await new Promise<void>((go) => {
      const i = waiting.findIndex((w) => w.p > priority);
      waiting.splice(i < 0 ? waiting.length : i, 0, { p: priority, go });
    });
  }
  try {
    return await fn();
  } finally {
    const next = waiting.shift();
    if (next) next.go(); // The slot passes to the next job.
    else loads--;
  }
}

const sources = new Map<string, Promise<Source | null>>();

function sameOrigin(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "data:" || u.protocol === "blob:" || u.origin === globalThis.location?.origin;
  } catch {
    return false;
  }
}

/** A URL that can be drawn without tainting the canvas: same-origin as is, cross-origin http(s) through the background. */
function sourceOf(url: string, fetchBlobUrl: FetchBlobUrl): Promise<Source | null> {
  let s = sources.get(url);
  if (!s) {
    s = sameOrigin(url)
      ? Promise.resolve({ src: url, corsOk: true })
      : /^https?:/i.test(url)
        ? fetchBlobUrl(url).then((f) => (f ? { src: f.dataUrl, corsOk: f.corsOk === true } : null), () => null)
        : Promise.resolve(null);
    sources.set(url, s);
  }
  return s;
}

async function decode(src: string): Promise<HTMLImageElement | null> {
  const img = document.createElement("img");
  img.src = src;
  try {
    await img.decode();
  } catch {
    return null; // Decode failed: unchanged.
  }
  return img.naturalWidth > 0 && img.naturalHeight > 0 ? img : null;
}

/** Draws `img` at w×h and reads the pixels, or null when the canvas can't be read (tainted, no 2D context). */
function draw(img: CanvasImageSource, w: number, h: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; data: ImageData } | null {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  try {
    ctx.drawImage(img, 0, 0, w, h);
    return { canvas, ctx, data: ctx.getImageData(0, 0, w, h) };
  } catch {
    return null; // SecurityError on a tainted canvas (HTML §4.12.5.1, "origin-clean"): unchanged, never a guess.
  }
}

const sample = (img: CanvasImageSource): Uint8ClampedArray | null => draw(img, SAMPLE, SAMPLE)?.data.data ?? null;

// invert(1) then hue-rotate(180deg), per pixel: Filter Effects 1 §9.1 (invert) and the feColorMatrix "hueRotate" matrix
// for 180° (https://drafts.fxtf.org/filter-effects/#feColorMatrixElement), applied to sRGB values.
const HUE180 = [-0.574, 1.43, 0.144, 0.426, 0.43, 0.144, 0.426, 1.43, -0.856];
const clamp = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

function invertPixels(d: Uint8ClampedArray): void {
  const m = HUE180;
  for (let i = 0; i < d.length; i += 4) {
    const r = 255 - (d[i] as number);
    const g = 255 - (d[i + 1] as number);
    const b = 255 - (d[i + 2] as number);
    d[i] = clamp(m[0]! * r + m[1]! * g + m[2]! * b);
    d[i + 1] = clamp(m[3]! * r + m[4]! * g + m[5]! * b);
    d[i + 2] = clamp(m[6]! * r + m[7]! * g + m[8]! * b);
  }
}

function darkenPixels(d: Uint8ClampedArray, p: Palette): void {
  const memo = new Map<number, number>();
  for (let i = 0; i < d.length; i += 4) {
    const key = ((d[i] as number) << 16) | ((d[i + 1] as number) << 8) | (d[i + 2] as number);
    let out = memo.get(key);
    if (out === undefined) {
      const c = transformColor({ r: d[i] as number, g: d[i + 1] as number, b: d[i + 2] as number, a: 1 }, "bg", p);
      out = (clamp(c.r) << 16) | (clamp(c.g) << 8) | clamp(c.b);
      memo.set(key, out);
    }
    d[i] = out >> 16;
    d[i + 1] = (out >> 8) & 255;
    d[i + 2] = out & 255;
  }
}

// brightness(0.5): feComponentTransfer, type linear, slope 0.5 on each color channel (Filter Effects 1 §12.2,
// https://drafts.fxtf.org/filter-effects/#brightnessEquivalent).
function dimPixels(d: Uint8ClampedArray): void {
  for (let i = 0; i < d.length; i += 4) {
    d[i] = Math.round((d[i] as number) / 2);
    d[i + 1] = Math.round((d[i + 1] as number) / 2);
    d[i + 2] = Math.round((d[i + 2] as number) / 2);
  }
}

const rendered = new Map<string, Promise<string | null>>();

/**
 * The image at `url` re-rendered as a PNG `data:` URL: `invert` = invert + 180° hue rotation, `darken` = L mapped through
 * the background transform, `dim` = brightness(0.5) (a light large image). Images larger than 512×512
 * (2048×2048 for `dim`) are left alone (a downscaled replacement would change the intrinsic size, and with it sprite
 * positions). Null when the image can't be fetched, decoded or read. Cached by
 * `url|kind|theme`.
 *
 * Cross-origin bytes come from the privileged background fetch, which the page's own Same-Origin Policy doesn't limit.
 * A transformed `data:` URL is written back into the page, where scripts can read its pixels, so it is produced only
 * when the response was CORS-permissive (the page could read it anyway); otherwise the image stays unchanged.
 * Classification alone (a marker on an `<img>`) may still use non-CORS bytes: it leaks at most the class.
 */
export function transformImageDataUrl(url: string, kind: "invert" | "darken" | "dim", p: Palette, fetchBlobUrl: FetchBlobUrl): Promise<string | null> {
  const key = `${url}|${kind}|${p.id}`;
  let r = rendered.get(key);
  if (!r) {
    r = limited(0, async () => {
      const src = await sourceOf(url, fetchBlobUrl);
      const img = src?.corsOk ? await decode(src.src) : null;
      const max = kind === "dim" ? MAX_DIM : MAX;
      if (!img || img.naturalWidth > max || img.naturalHeight > max) return null;
      const out = draw(img, img.naturalWidth, img.naturalHeight);
      if (!out) return null;
      if (kind === "invert") invertPixels(out.data.data);
      else if (kind === "dim") dimPixels(out.data.data);
      else darkenPixels(out.data.data, p);
      out.ctx.putImageData(out.data, 0, 0);
      return out.canvas.toDataURL("image/png");
    });
    rendered.set(key, r);
  }
  return r;
}

/**
 * "Dim images" (img, picture, video and canvas). `<picture>` gets no filter of its own: it only provides
 * sources to its `<img>` (HTML §4.8.1), which is dimmed already, and a filter on it would make that (usually empty,
 * inline) box the containing block of an absolutely positioned `<img>` inside it, sizing the image to nothing (Filter
 * Effects 1, https://drafts.fxtf.org/filter-effects/#FilterProperty: "A value other than none for the filter property
 * results in the creation of a containing block for absolute and fixed positioned descendants"). It would also dim
 * the image twice.
 */
export const dimImagesCss = "img,video,canvas{filter:brightness(.75)}";
const MARKER_CSS = "[data-dusk-img=invert]{filter:invert(1) hue-rotate(180deg)!important}[data-dusk-img=dim]{filter:brightness(.5)!important}";
const MARK = "data-dusk-img";
const SVG_NS = "http://www.w3.org/2000/svg";
const CHUNK = 50;
const URLS = /url\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^)\s]*))\s*\)/gi;

/**
 * Yields to the main thread: requestIdleCallback where available, else setTimeout. Safari (incl. iOS) has no
 * requestIdleCallback (@mdn/browser-compat-data 8.1.6, api.Window.requestIdleCallback: safari_ios false).
 */
export function idle(fn: () => void): void {
  const ric = (globalThis as { requestIdleCallback?: (cb: () => void) => number }).requestIdleCallback;
  if (ric) ric(() => fn());
  else setTimeout(fn, 0);
}

export interface ImageStylerDeps {
  fetchBlobUrl: FetchBlobUrl;
  /** Yields between analysis chunks (`idle` in production). */
  schedule: (fn: () => void) => void;
  palette?: Palette;
  dimImages?: boolean;
  /** Writes the text transform of inline SVG icons' computed fill/stroke (InlineStyler.setComputed). */
  inline?: InlineStyler;
  /** Called with URLs whose rule-level replacement became available, so their sheets re-emit (StyleManager.imagesReady). */
  onImagesReady?: (urls: string[]) => void;
  /**
   * Simple (filter) mode: only `<img>` markers, no marker styles and no background-image analysis (there are no
   * rule-level replacements). The filter stylesheet skips re-inverting `[data-dusk-img="invert"]`, so dark icons turn light.
   */
  markersOnly?: boolean;
}

interface Sample { px: Uint8ClampedArray; w: number; h: number }

/**
 * Image analysis for `<img>`, inline `<svg>` icons and elements with a computed `background-image: url()`:
 * `<img>` results are attribute markers (`data-dusk-img="invert|dim"`) styled by one `<style data-dusk="img">`.
 * Background images are replaced at rule level instead (`imageUrl`, used as `RewriteCtx.imageUrl`), so the element's
 * text and children are never filtered. Inline SVG icons drawn with a dark computed fill/stroke get the text transform
 * through InlineStyler, without a canvas.
 */
export class ImageStyler {
  private readonly doc: Document;
  private palette: Palette;
  private readonly samples = new Map<string, Promise<Sample | null>>();
  /** URLs whose rule-level replacement has been requested. */
  private readonly ruled = new Set<string>();
  private readonly infos = new Map<string, PixelInfo>();
  private readonly replaced = new Map<string, string | null>();
  private readonly marked = new Set<Element>();
  /** Inline SVG icons → the properties given to InlineStyler.setComputed. */
  private readonly icons = new Map<Element, Set<string>>();
  /** Each `<svg>`'s backdrop shapes marked in InlineStyler. */
  private readonly backdrops = new Map<Element, Element[]>();
  /** Re-checks of an `<svg>` whose shapes had no layout yet (an animation library draws its first frame later). */
  private readonly backdropRetries = new WeakMap<Element, number>();
  /** An icon's `style` attribute right after reading around our override, so that mutation isn't re-visited. */
  private readonly toggled = new WeakMap<Element, string | null>();
  private readonly loading = new WeakSet<Element>();
  private readonly queue = new Set<Element>();
  private style: Element | null = null;
  private observer: MutationObserver | null = null;
  private running = false;
  private scheduled = false;
  private gen = 0;

  constructor(private readonly root: Document | ShadowRoot, private readonly deps: ImageStylerDeps) {
    this.doc = root.nodeType === 9 ? (root as Document) : (root.ownerDocument as Document);
    this.palette = deps.palette ?? PALETTES.dark;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    if (!this.deps.markersOnly) {
      const style = markOwn(this.doc.createElement("style"));
      style.setAttribute("data-dusk", "img");
      style.setAttribute("media", "screen");
      style.textContent = MARKER_CSS + (this.deps.dimImages ? dimImagesCss : "");
      (this.root.nodeType === 9 ? (this.doc.head ?? this.doc.documentElement) : this.root).append(style);
      this.style = style;
    }
    this.observer = new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === "attributes") {
          const el = r.target as Element;
          if (r.attributeName === "style" && this.toggled.has(el) && el.getAttribute("style") === this.toggled.get(el)) continue;
          this.enqueue(el);
        } else {
          // Shapes drawn into an existing <svg> (animation libraries) re-check its outermost <svg> (icons, backdrops).
          let svg = (r.target as Element).closest?.("svg");
          while (svg?.parentElement?.closest("svg")) svg = svg.parentElement.closest("svg");
          if (svg) this.enqueue(svg);
          for (const n of r.addedNodes) if (n.nodeType === 1) this.enqueueTree(n as Element);
          if (r.removedNodes.length) this.prune();
        }
      }
    });
    this.observer.observe(this.root, { subtree: true, childList: true, attributes: true, attributeFilter: ["src", "srcset", "style", "class"] });
    for (const el of this.root.querySelectorAll("*")) this.enqueue(el);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.gen++;
    this.observer?.disconnect();
    this.observer = null;
    this.style?.remove();
    this.style = null;
    for (const el of this.marked) el.removeAttribute(MARK);
    this.marked.clear();
    for (const [el, props] of this.icons) for (const prop of props) this.deps.inline?.setComputed(el, prop, null);
    this.icons.clear();
    for (const shapes of this.backdrops.values()) for (const s of shapes) this.deps.inline?.setBackdrop(s, false);
    this.backdrops.clear();
    this.queue.clear();
  }

  /**
   * The replacement `data:` URL for an analyzed dark-icon or light-texture background image, else null. A lookup never
   * starts a fetch: a rule's `url()` may be one the page never loads (another breakpoint, `:hover`, an unused sprite), and
   * re-fetches are allowed only for resources the page loads. Analysis starts from elements' computed backgrounds
   * (`visit`), and `onImagesReady` reports the URL once its replacement exists, so the sheets that looked it up re-emit.
   */
  readonly imageUrl = (url: string): string | null => this.replaced.get(url) ?? null;

  /**
   * Switches the theme in place (engine `update`): background images already analyzed are derived again with `p`
   * (darkened textures depend on it; `transformImageDataUrl` caches by `url|kind|theme`), and their sheets re-emit via
   * `onImagesReady` when a replacement changes. Until then the previous replacement stays in use, so nothing flashes.
   */
  setPalette(p: Palette): void {
    if (this.palette === p) return;
    this.palette = p;
    if (!this.running) return;
    // URLs without a replacement (not an icon or texture, or unreadable) don't depend on the palette: left as they are.
    for (const url of [...this.ruled]) {
      if (this.replaced.get(url) === null) continue;
      this.ruled.delete(url);
      void this.rule(url);
    }
  }

  /** Removed elements lose their marker and icon override (a re-inserted one is visited again). */
  private prune(): void {
    for (const el of this.marked) if (!el.isConnected) this.mark(el, null);
    for (const [el, props] of this.icons) {
      if (el.isConnected) continue;
      for (const prop of props) this.deps.inline?.setComputed(el, prop, null);
      this.icons.delete(el);
    }
  }

  private enqueueTree(el: Element): void {
    this.enqueue(el);
    if (el.firstElementChild) for (const d of el.querySelectorAll("*")) this.enqueue(d);
  }

  private enqueue(item: Element): void {
    this.queue.add(item);
    if (this.scheduled) return;
    this.scheduled = true;
    this.deps.schedule(() => this.drain());
  }

  private drain(): void {
    this.scheduled = false;
    if (!this.running) return void this.queue.clear();
    let n = 0;
    for (const item of this.queue) {
      this.queue.delete(item);
      if (item.isConnected) this.visit(item);
      if (++n >= CHUNK) break;
    }
    if (this.queue.size && !this.scheduled) {
      this.scheduled = true;
      this.deps.schedule(() => this.drain());
    }
  }

  private viewport(): number {
    return this.doc.documentElement.clientWidth || this.doc.defaultView?.innerWidth || 0;
  }

  /** Distance in px from the viewport (0 inside it): the fetch/decode priority. */
  private distance(r: DOMRect): number {
    const vh = this.doc.documentElement.clientHeight || this.doc.defaultView?.innerHeight || 0;
    return r.top > vh ? r.top - vh : r.bottom < 0 ? -r.bottom : 0;
  }

  private visit(el: Element): void {
    if (el.localName === "img" && el.namespaceURI !== SVG_NS) return this.visitImg(el as HTMLImageElement);
    if (el.localName === "svg" && el.namespaceURI === SVG_NS) {
      if (!(el.parentElement?.closest("svg"))) this.visitSvg(el);
      return;
    }
    if (this.deps.markersOnly) return;
    this.visitBackground(el, getComputedStyle(el));
    // Icons are often a ::before/::after background, which only the pseudo-element's computed style shows.
    for (const pseudo of ["::before", "::after"]) {
      const ps = getComputedStyle(el, pseudo);
      if (ps.content !== "none" && ps.content !== "normal") this.visitBackground(el, ps);
    }
  }

  private visitBackground(el: Element, cs: CSSStyleDeclaration): void {
    const bg = cs.backgroundImage;
    if (!bg || !bg.includes("url(")) return;
    const r = el.getBoundingClientRect();
    const repeats = !/^no-repeat$/i.test(cs.backgroundRepeat.trim());
    for (const m of bg.matchAll(URLS)) {
      const raw = (m[1] ?? m[2] ?? m[3] ?? "").replace(/\\(.)/g, "$1");
      let url: string;
      try {
        url = new URL(raw, this.doc.baseURI).href;
      } catch {
        continue;
      }
      // The first element seen with the URL gives the rendering context for its rule-level classification.
      if (!this.infos.has(url) && r.width > 0 && r.height > 0) {
        this.infos.set(url, { renderedWidth: r.width, renderedHeight: r.height, viewportWidth: this.viewport(), repeats });
      }
      this.rule(url, this.distance(r));
    }
  }

  private visitImg(img: HTMLImageElement): void {
    if (!img.complete) {
      if (this.loading.has(img)) return;
      this.loading.add(img);
      img.addEventListener("load", () => {
        this.loading.delete(img);
        if (this.running) this.enqueue(img);
      }, { once: true });
      return;
    }
    const url = img.currentSrc || img.src;
    // Only images that could get a marker are analyzed: a dark icon up to 512×512 rendered, or a light image wider
    // than half the viewport.
    const r = img.getBoundingClientRect();
    const icon = r.width > 0 && r.height > 0 && r.width <= MAX && r.height <= MAX;
    if (!url || (!icon && !(r.width > this.viewport() * LARGE_SHARE))) return this.mark(img, null);
    const gen = this.gen;
    this.analyzeUrl(url, img, this.distance(r)).then((s) => {
      if (gen !== this.gen || !img.isConnected || (img.currentSrc || img.src) !== url) return;
      const b = img.getBoundingClientRect();
      const cls = s && classifyPixels(s.px, SAMPLE, SAMPLE, { renderedWidth: b.width, renderedHeight: b.height, viewportWidth: this.viewport(), repeats: false });
      const small = b.width <= MAX && b.height <= MAX;
      this.mark(img, cls === "dark-icon" && small ? "invert" : cls === "light-large" ? "dim" : null);
    });
  }

  private mark(el: Element, value: "invert" | "dim" | null): void {
    if (value === null) {
      if (this.marked.delete(el)) el.removeAttribute(MARK);
      return;
    }
    if (el.getAttribute(MARK) !== value) el.setAttribute(MARK, value);
    this.marked.add(el);
  }

  /**
   * Inline SVG icons up to 512×512: a dark, achromatic computed fill or stroke gets the text transform. The color is read
   * with our own override taken out (the attribute is put back byte-for-byte), so a later visit sees the page's color
   * and drops the override when the icon no longer qualifies.
   */
  private visitSvg(svg: Element): void {
    const inline = this.deps.inline;
    if (!inline) return;
    const r = svg.getBoundingClientRect();
    const fits = r.width <= MAX && r.height <= MAX && (r.width > 0 || r.height > 0);
    const had = this.icons.get(svg);
    const page = fits ? this.pageColors(svg as SVGElement, had) : null;
    const props = new Set<string>();
    for (const prop of ["fill", "stroke"]) {
      const v = page?.[prop === "fill" ? 0 : 1] ?? "";
      const c = parseColor(v);
      const o = c && c.a > 0 ? rgbaToOklch(c) : null;
      if (o && o.l < ICON_L && o.c < MONO_C) {
        inline.setComputed(svg, prop, v);
        props.add(prop);
      } else if (had?.has(prop)) inline.setComputed(svg, prop, null);
    }
    if (props.size) this.icons.set(svg, props);
    else this.icons.delete(svg);
    this.markBackdrops(svg, r);
  }

  /**
   * Illustration backdrops: in an `<svg>` larger than 64×64, a shape among its first 8 outside `<defs>`, clip paths
   * and masks (drawn first, so beneath the rest) whose box covers at least 75 % of the `<svg>`'s visible box is the picture's
   * background, not ink, so its fill takes the background transform. Icons and smaller shapes keep the foreground
   * transform. While its shapes have no layout yet, the `<svg>` is checked again (5 times, 500 ms apart).
   */
  private markBackdrops(svg: Element, r: DOMRect): void {
    const inline = this.deps.inline!;
    // Coverage of what can be seen: the <svg>'s box clipped to the viewport (an illustration may overhang the screen),
    // or the whole box while it is off screen.
    const view = this.doc.defaultView;
    const vw = view?.innerWidth ?? 0, vh = view?.innerHeight ?? 0;
    const cl = Math.max(r.left, 0), ct = Math.max(r.top, 0), cr = Math.min(r.right, vw), cb = Math.min(r.bottom, vh);
    const [L, T, R, B] = cr > cl && cb > ct ? [cl, ct, cr, cb] : [r.left, r.top, r.right, r.bottom];
    const area = (R - L) * (B - T);
    const found: Element[] = [];
    let unlaid = false;
    if (r.width > BACKDROP_MIN && r.height > BACKDROP_MIN) {
      for (const s of [...svg.querySelectorAll(BACKDROP_SHAPES)].filter((x) => !x.closest("defs,clipPath,mask")).slice(0, 8)) {
        const b = s.getBoundingClientRect();
        if (!b.width && !b.height) unlaid = true;
        const w = Math.min(b.right, R) - Math.max(b.left, L);
        const h = Math.min(b.bottom, B) - Math.max(b.top, T);
        if (w > 0 && h > 0 && w * h >= 0.75 * area) found.push(s);
      }
    }
    for (const s of this.backdrops.get(svg) ?? []) if (!found.includes(s)) inline.setBackdrop(s, false);
    for (const s of found) inline.setBackdrop(s, true);
    if (found.length) this.backdrops.set(svg, found);
    else this.backdrops.delete(svg);
    const n = this.backdropRetries.get(svg) ?? 0;
    if (!found.length && unlaid && n < 5) {
      this.backdropRetries.set(svg, n + 1);
      setTimeout(() => this.running && this.enqueue(svg), 500);
    }
  }

  /** Computed fill and stroke without the overrides InlineStyler wrote for `had`. */
  private pageColors(svg: SVGElement, had: Set<string> | undefined): [string, string] {
    const read = (): [string, string] => {
      const cs = getComputedStyle(svg);
      return [cs.getPropertyValue("fill").trim(), cs.getPropertyValue("stroke").trim()];
    };
    if (!had?.size) return read();
    const attr = svg.getAttribute("style");
    const css = svg.style.cssText;
    for (const prop of had) svg.style.removeProperty(prop);
    const out = read();
    restoreStyleAttr(svg, attr, css);
    this.toggled.set(svg, attr);
    return out;
  }

  /**
   * Samples `url` once (32×32). A same-origin `<img>` is drawn directly; anything else is decoded from the URL. An `<img>`
   * needs only the sample, so its fetched source (a full copy of the image as a data URL) is dropped once sampled; a
   * background image's is kept, since its replacement is drawn from it again for each theme.
   */
  private analyzeUrl(url: string, img: HTMLImageElement | null, priority: number): Promise<Sample | null> {
    let s = this.samples.get(url);
    if (!s) {
      if (img && sameOrigin(url)) {
        const px = sample(img);
        s = Promise.resolve(px && { px, w: img.naturalWidth, h: img.naturalHeight });
      } else {
        s = limited(priority, async () => {
          const pending = sourceOf(url, this.deps.fetchBlobUrl);
          const src = await pending;
          const el = src && (await decode(src.src));
          const px = el && sample(el);
          if (img && sources.get(url) === pending) sources.delete(url);
          return px && el ? { px, w: el.naturalWidth, h: el.naturalHeight } : null;
        });
      }
      this.samples.set(url, s);
    }
    return s;
  }

  /**
   * Derives the rule-level replacement of a background image: inverted dark icon, darkened light texture, or a
   * light large image at brightness(0.5) (as a replacement image, so the element's text and children aren't filtered).
   */
  private async rule(url: string, priority = 0): Promise<void> {
    if (this.ruled.has(url)) return;
    this.ruled.add(url);
    const s = await this.analyzeUrl(url, null, priority);
    if (!s) return void this.replaced.set(url, null);
    const info = this.infos.get(url) ?? { renderedWidth: s.w, renderedHeight: s.h, viewportWidth: this.viewport(), repeats: false };
    const cls = classifyPixels(s.px, SAMPLE, SAMPLE, info);
    const kind = cls === "dark-icon" ? "invert" : cls === "light-texture" ? "darken" : cls === "light-large" ? "dim" : null;
    const out = kind && (await transformImageDataUrl(url, kind, this.palette, this.deps.fetchBlobUrl));
    const prev = this.replaced.get(url);
    this.replaced.set(url, out || null);
    if ((out || null) !== (prev ?? null)) this.deps.onImagesReady?.([url]);
  }
}
