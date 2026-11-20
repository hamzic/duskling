import { contrastRatio } from "../color/contrast";
import { oklchToRgba, rgbaToOklch } from "../color/oklch";
import type { Palette } from "../color/palettes";
import { formatColor, parseColor } from "../color/parse";
import type { RGBA } from "../color/parse";
import { transformColor } from "../color/transform";
import { contentColorState, inlineOverrideOwner, lastWrittenStyle, restoreInlineOverrides, writeInlineOverride } from "../css/inline";

const HTML_NS = "http://www.w3.org/1999/xhtml";
const OWNER = "repair";
const MAX_PER_PASS = 300;
/** Layout reads (getBoundingClientRect) per pass, so a pass stays bounded on large DOMs where few elements are in the band. */
const MAX_RECT_READS = 1500;
/** characterData records checked for visibility per observer callback. */
const MAX_TEXT_CHECKS = 20;
const LIGHT_L = 0.8;
const MIN_CONTRAST = 4.5;
const MUTATION_DEBOUNCE = 300;
/** A page that never stops mutating still gets a pass at least this often. */
const MUTATION_MAX_WAIT = 1000;
const SCROLL_THROTTLE = 500;
const NEUTRAL_BG = "var(--dusk-neutral-bg)";
/** Replaced content and embedded media are never repaired ("isn't an image"); their subtrees are skipped too. */
const MEDIA = new Set(["img", "picture", "video", "audio", "canvas", "iframe", "frame", "embed", "object", "svg", "math", "head", "script", "style", "template", "noscript"]);
/** Controls whose text is not a child text node (value, placeholder); a light user-agent face counts as text on it. */
const CONTROLS = new Set(["input", "textarea", "select", "button"]);
const KEEP = "data-dusk-keep";

const blend = (top: RGBA, under: RGBA): RGBA => {
  const a = top.a;
  return { r: top.r * a + under.r * (1 - a), g: top.g * a + under.g * (1 - a), b: top.b * a + under.b * (1 - a), a: 1 };
};

/**
 * The text transform recomputed against the actual background `bg`: the theme's text color for `color`, then its
 * OKLCH L moved away from the background's lightness in 0.02 steps until WCAG contrast ≥ 4.5 (or L reaches 0 or 1).
 */
export function repairTextColor(color: RGBA, bg: RGBA, p: Palette): RGBA {
  const out = transformColor(color, "text", p);
  if (contrastRatio(out, bg) >= MIN_CONTRAST) return out;
  const o = rgbaToOklch(out);
  const up = rgbaToOklch(bg).l < 0.5;
  let c = out;
  while ((up ? o.l < 1 : o.l > 0) && contrastRatio(c, bg) < MIN_CONTRAST) {
    o.l = up ? Math.min(o.l + 0.02, 1) : Math.max(o.l - 0.02, 0);
    c = oklchToRgba(o);
  }
  return c;
}

export interface ContrastRepairDeps {
  /** Yields to the main thread before a pass (`idle` from media/images.ts in production). */
  idle: (fn: () => void) => void;
  /** True for elements whose colors the engine already rewrote; they keep their background (the text rule still applies). */
  isEngineStyled: (el: Element) => boolean;
}

interface Plan { el: Element; bg: boolean; color: string | null }

/**
 * The contrast-repair safety net: after the first theming pass, then on idle after mutations (debounced 300 ms, at most 1 s while mutations continue) and on scroll
 * (throttled 500 ms), it reads computed styles of at most 300 visible elements in the viewport ± 1 screen height and
 * - gives a light surface (computed background OKLCH L > 0.8, no background image, not media, not engine-styled, not a
 *   content color) `background-color: var(--dusk-neutral-bg) !important`;
 * - recomputes the text color of text (engine-styled or not) whose contrast against its effective background is < 4.5:1.
 *   A color InlineStyler overrides inline stays InlineStyler's (it would take it back on its next re-plan).
 * It catches colors the CSSOM rewrite can't see (closed shadow roots, user-agent styles, script-set styles).
 * Writes go through InlineStyler's shared restore map (writeInlineOverride), so stop() restores the page's inline
 * styles exactly, and either part may stop first. All reads of a pass happen before its writes.
 */
export class ContrastRepair {
  private readonly win: Window & typeof globalThis;
  private neutral: RGBA;
  private observer: MutationObserver | null = null;
  private running = false;
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private maxWait: ReturnType<typeof setTimeout> | null = null;
  private throttle: ReturnType<typeof setTimeout> | null = null;
  private idlePending = false;
  /**
   * The last element visited by a pass that hit a cap; the next pass continues after it, and one is requested right
   * away. A pass that reaches the end of the document clears it, so a continuation chain covers the document once.
   */
  private cursor: Element | null = null;

  constructor(private readonly doc: Document, private p: Palette, private readonly deps: ContrastRepairDeps) {
    this.win = doc.defaultView as Window & typeof globalThis;
    this.neutral = oklchToRgba(p.bg);
  }

  /**
   * Switches the theme in place (engine `update`) and schedules a pass. Light surfaces use `var(--dusk-neutral-bg)` and
   * follow the new theme by themselves; text fixed against the old surfaces is re-checked by that pass.
   */
  setPalette(p: Palette): void {
    if (this.p === p) return;
    this.p = p;
    this.neutral = oklchToRgba(p.bg);
    this.request();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.observer = new this.win.MutationObserver((records) => this.onMutations(records));
    this.observer.observe(this.doc, { subtree: true, childList: true, attributes: true, characterData: true });
    // Scroll events of inner scrollers don't bubble, but they reach a capturing listener on the document (UI Events §5.2.6,
    // https://w3c.github.io/uievents/#event-type-scroll; DOM §2.5 capture phase).
    this.doc.addEventListener("scroll", this.onScroll, { capture: true, passive: true });
    this.request();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.observer?.disconnect();
    this.observer = null;
    this.doc.removeEventListener("scroll", this.onScroll, { capture: true });
    this.clearMutationTimers();
    if (this.throttle) clearTimeout(this.throttle);
    this.throttle = null;
    this.cursor = null;
    for (const el of this.doc.querySelectorAll("[style]")) restoreInlineOverrides(el, OWNER);
  }

  /** One pass now; returns the number of elements repaired. */
  runOnce(): number {
    const plans = this.read();
    let n = 0;
    for (const { el, bg, color } of plans) {
      let wrote = false;
      if (bg) wrote = writeInlineOverride(el, "background-color", NEUTRAL_BG, "important", OWNER) || wrote;
      if (color) wrote = writeInlineOverride(el, "color", color, "important", OWNER) || wrote;
      if (wrote) n++;
    }
    // Our own mutations are already queued for the observer; drop them so they don't schedule another pass.
    this.observer?.takeRecords();
    if (this.cursor) this.request();
    return n;
  }

  private request(): void {
    if (this.idlePending || !this.running) return;
    this.idlePending = true;
    this.deps.idle(() => {
      this.idlePending = false;
      if (this.running) this.runOnce();
    });
  }

  private readonly onScroll = (): void => {
    if (this.throttle) return;
    this.throttle = setTimeout(() => {
      this.throttle = null;
      this.request();
    }, SCROLL_THROTTLE);
  };

  private onMutations(records: MutationRecord[]): void {
    if (!this.running) return;
    let relevant = false;
    let checks = 0;
    for (const r of records) {
      if (r.type === "attributes") {
        const name = r.attributeName ?? "";
        // Sampling and markers (data-dusk-*) and Duskling's own inline writes (shared state) are not page changes.
        if (name.startsWith("data-dusk")) continue;
        const el = r.target as Element;
        if (name === "style" && el.getAttribute("style") === lastWrittenStyle(el)) continue;
      } else if (r.type === "childList" && isDuskNode(r)) continue;
      else if (r.type === "characterData" && !this.textInBand(r.target, checks++)) continue;
      relevant = true;
      break;
    }
    if (!relevant) return;
    const fire = (): void => {
      this.clearMutationTimers();
      this.request();
    };
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(fire, MUTATION_DEBOUNCE);
    this.maxWait ??= setTimeout(fire, MUTATION_MAX_WAIT);
  }

  /** A text change matters only for visible text near the viewport (bounded number of layout reads per callback). */
  private textInBand(node: Node, n: number): boolean {
    if (n >= MAX_TEXT_CHECKS) return false;
    const el = node.parentElement;
    if (!el?.isConnected) return false;
    const r = el.getBoundingClientRect();
    const h = this.win.innerHeight;
    return r.width > 0 && r.height > 0 && r.bottom >= -h && r.top <= 2 * h;
  }

  private clearMutationTimers(): void {
    if (this.debounce) clearTimeout(this.debounce);
    if (this.maxWait) clearTimeout(this.maxWait);
    this.debounce = this.maxWait = null;
  }

  /** Read phase: candidates in the band, computed styles and effective backgrounds; no writes. */
  private read(): Plan[] {
    const body = this.doc.body;
    if (!body) return [];
    const h = this.win.innerHeight;
    const w = this.win.innerWidth;
    const walker = this.doc.createTreeWalker(body, 1, {
      acceptNode: (n) => (MEDIA.has((n as Element).localName) || (n as Element).namespaceURI !== HTML_NS ? 2 : 1),
    });
    // Continue after the element where the previous pass stopped (if it's still in the document), else from the top.
    const from = this.cursor;
    this.cursor = null;
    let next: Element | null = body;
    if (from?.isConnected && body.contains(from) && from !== body) {
      walker.currentNode = from;
      next = walker.nextNode() as Element | null;
    }

    const effective = new Map<Element, RGBA | null>();
    const charts = new Map<Element, boolean>();
    const plans: Plan[] = [];
    let examined = 0;
    let reads = 0;
    let last: Element | null = null;
    for (let el = next; el; last = el, el = walker.nextNode() as Element | null) {
      if (examined >= MAX_PER_PASS || reads >= MAX_RECT_READS) {
        this.cursor = last;
        break;
      }
      if (el.hasAttribute(KEEP)) continue;
      reads++;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0 || r.bottom < -h || r.top > 2 * h || r.right < 0 || r.left > w) continue;
      const cs = this.win.getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.visibility === "collapse" || cs.opacity === "0") continue;
      examined++;
      // Only the light-surface rule skips what the engine already rewrote; text is checked on every element.
      const styled = this.deps.isEngineStyled(el);
      const own = parseColor(cs.backgroundColor);
      const image = hasImage(cs);
      const under = image ? null : this.effectiveBg(el.parentElement, effective);
      let bg = false;
      let surface: RGBA | null = null;
      if (own && own.a > 0 && !image) {
        surface = own.a >= 1 ? own : under ? blend(own, under) : null;
        // A light chromatic swatch or chart color is content (content-color guard), not a missed surface.
        if (surface && !styled && rgbaToOklch(surface).l > LIGHT_L && inlineOverrideOwner(el, "background-color") !== "") {
          if (contentColorState(el, own, charts) !== false) continue;
          bg = true;
          surface = this.neutral;
        }
      } else if (!image) surface = under;
      effective.set(el, surface);

      let color: string | null = null;
      if (surface && hasText(el) && inlineOverrideOwner(el, "color") !== "") {
        const fg = parseColor(cs.color);
        const fill = parseColor(cs.getPropertyValue("-webkit-text-fill-color"));
        // Text painted by -webkit-text-fill-color (gradient or clipped text) isn't governed by `color`.
        const painted = !fill || sameColor(fill, fg);
        if (fg && fg.a > 0 && painted && contrastRatio(blend(fg, surface), surface) < MIN_CONTRAST) {
          color = formatColor(repairTextColor({ ...fg, a: 1 }, surface, this.p));
        }
      }
      if (bg || color) plans.push({ el, bg, color });
    }
    return plans;
  }

  /**
   * The opaque color behind `el`'s content: its background composited over its ancestors', from the planned values of
   * this pass where known. Null when a background image is in the way. The canvas is the theme background.
   */
  private effectiveBg(el: Element | null, cache: Map<Element, RGBA | null>): RGBA | null {
    if (!el) return this.neutral;
    const hit = cache.get(el);
    if (hit !== undefined) return hit;
    const cs = this.win.getComputedStyle(el);
    let out: RGBA | null;
    if (hasImage(cs)) out = null;
    else {
      const own = parseColor(cs.backgroundColor);
      if (own && own.a >= 1) out = own;
      else {
        const under = this.effectiveBg(el.parentElement, cache);
        out = own && own.a > 0 && under ? blend(own, under) : under;
      }
    }
    cache.set(el, out);
    return out;
  }
}

const hasImage = (cs: CSSStyleDeclaration): boolean => cs.backgroundImage !== "" && cs.backgroundImage !== "none";
const sameColor = (a: RGBA, b: RGBA | null): boolean => !!b && a.r === b.r && a.g === b.g && a.b === b.b && a.a === b.a;

function hasText(el: Element): boolean {
  if (CONTROLS.has(el.localName)) return true;
  for (let n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 3 && /\S/.test(n.nodeValue ?? "")) return true;
  return false;
}

/** Mutations that only add or remove Duskling's own nodes (`<style data-dusk=…>`). */
function isDuskNode(r: MutationRecord): boolean {
  const nodes = [...r.addedNodes, ...r.removedNodes];
  return nodes.length > 0 && nodes.every((n) => n.nodeType === 1 && (n as Element).hasAttribute("data-dusk"));
}
