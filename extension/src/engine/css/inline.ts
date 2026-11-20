import { isOwnNode, markOwn } from "./own";
import { rgbaToOklch } from "../color/oklch";
import type { Palette } from "../color/palettes";
import { formatColor, parseColor } from "../color/parse";
import type { RGBA } from "../color/parse";
import { restoreStyleAttr } from "./csp";
import { rewriteDeclaration } from "./declarations";
import type { RewriteCtx } from "./declarations";
import { rewriteStyle } from "./rules";
import { INLINE_SELECTOR, canRedefine } from "./variables";
import type { VariableRegistry } from "./variables";

const SVG_NS = "http://www.w3.org/2000/svg";
const HTML_NS = "http://www.w3.org/1999/xhtml";

// Presentation attributes → the property they map to.
// SVG 2 §6.6 (https://www.w3.org/TR/SVG2/styling.html#PresentationAttributes): fill, stroke, stop-color and color on SVG
// elements. HTML rendering §15.3.3/§15.3.8 (https://html.spec.whatwg.org/multipage/rendering.html): `bgcolor` on body and
// table parts maps to background-color, `color` on <font> maps to color.
//
// Both are presentational hints, which rank below every author style: CSS Cascade 5 §6.5
// (https://drafts.csswg.org/css-cascade-5/#preshint) puts them in an "author presentational hint origin" that "can be
// overridden by author-origin styles" (SVG 2 §6.6 and HTML's "presentational hints" feed into it). So attribute
// overrides are not written into the inline style (that would beat the page's own CSS for the element); they are
// zero-specificity rules keyed by attribute value in `<style data-dusk="attrs">`, the root's first sheet, inside
// `@layer dusk-attrs`. The first-declared layer is the weakest author layer, so every page rule (layered or not, itself
// rewritten by the style manager) still wins, while ours beats the attribute. Verified in WebKit (unit-webkit/inline.spec.ts).
const ATTRS: [string, string][] = [["fill", "fill"], ["stroke", "stroke"], ["stop-color", "stop-color"], ["color", "color"], ["bgcolor", "background-color"]];
const BGCOLOR_ELEMENTS = new Set(["body", "table", "thead", "tbody", "tfoot", "tr", "td", "th"]);
const SELECTOR = "[style],[fill],[stroke],[stop-color],[color],[bgcolor]";
const SHAPES = "rect,circle,ellipse,path,polygon,polyline,line";
const SHAPE_SET = new Set(SHAPES.split(","));
// Content-color guard: inline background or fill colors.
const GUARDED = new Set(["background-color", "background", "fill"]);
const CONTENT_CHROMA = 0.05;
const SWATCH_MAX = 64;

function attrApplies(el: Element, attr: string): boolean {
  if (el.namespaceURI === SVG_NS) return attr !== "bgcolor";
  if (el.namespaceURI !== HTML_NS) return false;
  if (attr === "bgcolor") return BGCOLOR_ELEMENTS.has(el.localName);
  return attr === "color" && el.localName === "font";
}

interface Orig { value: string; priority: string }
interface Written {
  value: string;
  priority: string;
  intended: string;
  /** Set for overrides written through `writeInlineOverride` by another engine part (e.g. "repair"); unset for InlineStyler's own. */
  owner?: string;
}
interface State {
  /** The page's own `style` attribute, valid while `exact`. */
  attr: string | null;
  /** Its declarations as the page had them (`style.cssText`), for a restore the page's CSP won't re-parse (css/csp.ts). */
  css: string;
  exact: boolean;
  /** The attribute right after our last write, to recognize our own mutations. */
  written: string | null;
  ours: Map<string, Written>;
}

interface AttrSheet { node: Element | null; users: Set<object>; rules: Map<string, string> }
interface Shared { states: WeakMap<Element, State>; originals: WeakMap<Element, Map<string, Orig>>; attrs?: WeakMap<Node, AttrSheet> }
/**
 * Per-element state shared by every InlineStyler in this JS realm (keyed by `Symbol.for`, so a second copy of content.js
 * injected into the same isolated world sees it too). A styler that finds an element already styled by another
 * instance recognizes the overrides as Duskling's and keeps the stored originals, so nothing is transformed twice and
 * whichever instance stops first restores the page's values exactly.
 */
const SHARED = Symbol.for("dusk.inline");
const shared: Shared = ((globalThis as { [SHARED]?: Shared })[SHARED] ??= { states: new WeakMap(), originals: new WeakMap() });
/** The page's own value of every inline property the engine overrides, to restore exactly. */
const originals = shared.originals;
/** One attrs sheet per root, shared by the stylers on it; removed when the last one stops. */
const attrSheets = (shared.attrs ??= new WeakMap());
const MAX_RECHECKS = 3;
/** Marks an element whose presentation-attribute color is content, so the value-keyed rules skip it. */
const KEEP = "data-dusk-keep";
const BGCOLOR_LIST = [...BGCOLOR_ELEMENTS].join(",");
const cssString = (v: string): string => `"${v.replace(/["\\]/g, "\\$&").replace(/\n/g, "\\a ")}"`;

/** The zero-specificity selector for elements whose presentation attribute `attr` is exactly `raw`. */
function attrSelector(attr: string, raw: string): string {
  const match = `[${attr}=${cssString(raw)} i]:not([${KEEP}])`;
  if (attr === "bgcolor") return `:where(:is(${BGCOLOR_LIST})${match})`;
  if (attr === "color") return `:where(svg|*${match}, font${match})`;
  return `:where(svg|*${match})`;
}

const styleOf = (el: Element): CSSStyleDeclaration | null => (el as HTMLElement).style ?? null;
const chroma = (c: RGBA): number => rgbaToOklch(c).c;

/** The page's fill of an SVG shape: its own inline `fill` (from before our write), else the attribute. */
function shapeFill(el: Element): string {
  const o = originals.get(el)?.get("fill");
  return (o ? o.value : styleOf(el)?.getPropertyValue("fill")) || (el.getAttribute("fill") ?? "");
}

const isShape = (el: Element): boolean => el.namespaceURI === SVG_NS && SHAPE_SET.has(el.localName);

/** ≥ 3 sibling shapes under `parent` using ≥ 3 distinct chromatic fills. */
function isChart(parent: Element): boolean {
  const fills = new Set<string>();
  for (const shape of parent.children) {
    if (!isShape(shape)) continue;
    const c = parseColor(shapeFill(shape).trim());
    if (c && chroma(c) >= CONTENT_CHROMA) fills.add(formatColor(c));
    if (fills.size >= 3) return true;
  }
  return false;
}

/** The content-color guard's answer, or "unknown" while the element has no layout box yet (zero area). */
export function contentColorState(el: Element, color: RGBA, charts?: Map<Element, boolean>): boolean | "unknown" {
  if (chroma(color) < CONTENT_CHROMA) return false;
  const parent = el.parentElement;
  if (isShape(el) && parent && el.closest("svg")) {
    let chart = charts?.get(parent);
    if (chart === undefined) {
      chart = isChart(parent);
      charts?.set(parent, chart);
    }
    if (chart) return true;
  }
  // An element with text is never a swatch, whatever its size (also while hidden: a menu shown later).
  if (/\S/.test(el.textContent ?? "")) return false;
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return "unknown";
  return r.width <= SWATCH_MAX && r.height <= SWATCH_MAX;
}

/**
 * Content-color guard: an inline background or fill color is content (kept as is) when the element is at most
 * 64×64 px, has no text and the color has OKLCH chroma ≥ 0.05 (swatch, status dot, avatar), or when it is an SVG shape
 * with ≥ 3 sibling shapes that use ≥ 3 distinct chromatic fills (a chart). `charts` caches the per-parent answer.
 * A textless zero-area element (no layout yet) counts as content here; the styler re-checks it on a later frame.
 */
export function isContentColor(el: Element, color: RGBA, charts?: Map<Element, boolean>): boolean {
  return contentColorState(el, color, charts) !== false;
}

function restoreProp(style: CSSStyleDeclaration, prop: string, o: Orig | undefined): void {
  if (!o || o.value === "") style.removeProperty(prop);
  else style.setProperty(prop, o.value, o.priority);
}

const stillOurs = (style: CSSStyleDeclaration, prop: string, w: Written): boolean =>
  style.getPropertyValue(prop) === w.value && style.getPropertyPriority(prop) === w.priority;

/**
 * Brings the element's shared state up to date with page edits made since the last Duskling write: properties the page
 * overwrote are its own again, and once none of ours is left the current attribute becomes the exact original.
 */
function reconcile(el: Element, st: State, style: CSSStyleDeclaration): void {
  const cur = el.getAttribute("style");
  if (cur === st.written) return;
  const origs = originals.get(el);
  for (const [p, w] of st.ours) {
    if (stillOurs(style, p, w)) continue;
    st.ours.delete(p);
    origs?.delete(p);
  }
  if (st.ours.size === 0) {
    st.attr = cur;
    st.css = style.cssText;
    st.exact = true;
    origs?.clear();
  } else st.exact = false;
  st.written = cur;
}

/** Puts the page's `style` attribute back byte-for-byte when none of our overrides is left and the page hasn't edited it. */
function restoreExactAttr(el: Element, st: State): void {
  if (st.ours.size === 0 && st.exact && el.getAttribute("style") !== st.attr) {
    restoreStyleAttr(el, st.attr, st.css);
  }
  st.written = el.getAttribute("style");
}

/**
 * Writes an inline override (`setProperty(prop, value, priority)`) for an engine part other than InlineStyler (`owner`,
 * e.g. the contrast-repair pass), through the same realm-shared state and originals as InlineStyler: the page's
 * value is kept for an exact restore, InlineStyler recognizes the resulting mutation as Duskling's own and leaves the
 * override in place, and InlineStyler.stop() restores it too. A property InlineStyler already overrides is left alone
 * (returns false).
 */
export function writeInlineOverride(el: Element, prop: string, value: string, priority: string, owner: string): boolean {
  const style = styleOf(el);
  if (!style) return false;
  let st = shared.states.get(el);
  if (st) reconcile(el, st, style);
  else {
    const attr = el.getAttribute("style");
    shared.states.set(el, (st = { attr, css: style.cssText, exact: true, written: attr, ours: new Map() }));
  }
  const w = st.ours.get(prop);
  if (w && w.owner !== owner) return false;
  let origs = originals.get(el);
  if (!origs) originals.set(el, (origs = new Map()));
  if (!origs.has(prop)) origs.set(prop, { value: style.getPropertyValue(prop), priority: style.getPropertyPriority(prop) });
  style.setProperty(prop, value, priority);
  st.ours.set(prop, { value: style.getPropertyValue(prop), priority: style.getPropertyPriority(prop), intended: value, owner });
  st.written = el.getAttribute("style");
  return true;
}

/** Who overrides `prop` inline on `el`: an owner name, "" for InlineStyler, or null when the value is the page's. */
export function inlineOverrideOwner(el: Element, prop: string): string | null {
  const st = shared.states.get(el);
  const style = styleOf(el);
  const w = st?.ours.get(prop);
  if (!st || !style || !w || !stillOurs(style, prop, w)) return null;
  return w.owner ?? "";
}

/**
 * The page's own inline background of `el` when Duskling overrides it inline (InlineStyler or another owner), for sampling
 * (native-dark signal 5, `sampleBackground`'s `originalBackground` contract): `null` when no inline background override is in
 * place, else the original inline value of the overridden property (`""` when the page had none).
 */
export function originalInlineBackground(el: Element): string | null {
  const st = shared.states.get(el);
  const style = styleOf(el);
  if (!st || !style) return null;
  for (const p of ["background", "background-color"]) {
    const w = st.ours.get(p);
    if (w && stillOurs(style, p, w)) return originals.get(el)?.get(p)?.value ?? "";
  }
  return null;
}

/** The `style` attribute value Duskling wrote last on `el` (to recognize Duskling's own mutations), or undefined. */
export function lastWrittenStyle(el: Element): string | null | undefined {
  return shared.states.get(el)?.written;
}

/** Restores every override `owner` wrote on `el` (byte-exact when nothing else of ours is left), dropping the state if empty. */
export function restoreInlineOverrides(el: Element, owner: string): void {
  const st = shared.states.get(el);
  const style = styleOf(el);
  if (!st || !style) return;
  reconcile(el, st, style);
  const origs = originals.get(el);
  for (const [p, w] of [...st.ours]) {
    if (w.owner !== owner) continue;
    if (stillOurs(style, p, w)) restoreProp(style, p, origs?.get(p));
    st.ours.delete(p);
    origs?.delete(p);
  }
  restoreExactAttr(el, st);
  if (st.ours.size === 0) {
    shared.states.delete(el);
    originals.delete(el);
  }
}

interface Plan { el: Element; want: Map<string, [string, string]> | null; keep: boolean | null }

export interface InlineStylerDeps {
  /** Inline custom properties are reported to it and redefined on the element. */
  vars?: VariableRegistry;
  /** Batches mutation work (requestAnimationFrame in production). Without it, mutations are processed as delivered. */
  schedule?: (fn: () => void) => void;
}

/**
 * Inline `style` colors and presentation attributes. Inline style overrides are written into the element's
 * `style` with `setProperty(…, "important")`; presentation attributes get value-keyed rules in the attrs sheet (see
 * above), and the attributes themselves are never changed. The page's inline values are kept so `stop()` restores the
 * `style` attribute byte-for-byte when the page hasn't touched it since, and per property otherwise. Mutations caused by
 * our own writes are recognized by comparing the attribute with the last value we wrote.
 *
 * With a VariableRegistry, inline custom properties (`style="--x: #fff"`) are reported as definitions (INLINE_SELECTOR),
 * so stylesheet `var(--x)` is rewritten, and their role redefinitions (`--dusk-bg--x`) are written on the element.
 */
export class InlineStyler {
  private readonly states = shared.states;
  private readonly scratch: CSSStyleDeclaration;
  private readonly doc: Document;
  private readonly vars: VariableRegistry | undefined;
  private observer: MutationObserver | null = null;
  private running = false;
  private subscribed = false;
  private busy = false;
  private scheduled = false;
  private readonly pending = new Set<Element>();
  private readonly recheck = new Set<Element>();
  private readonly rechecks = new WeakMap<Element, number>();
  private charts = new Map<Element, boolean>();
  private readonly removed = new Set<Element>();
  /** Elements whose inline custom properties are a registry source, with the last reported definitions. */
  private readonly varSig = new Map<Element, string>();
  private readonly attrSheet: AttrSheet;
  /** Computed colors to transform where the element declares none (inline SVG icons drawn in the initial black fill). */
  private computed = new WeakMap<Element, Map<string, string>>();
  /** SVG shapes that are an illustration's backdrop: their fill takes the background transform. */
  private backdrops = new WeakSet<Element>();

  constructor(private readonly root: Document | ShadowRoot, private readonly ctx: RewriteCtx, private readonly deps: InlineStylerDeps = {}) {
    this.doc = root.nodeType === 9 ? (root as Document) : (root.ownerDocument as Document);
    this.scratch = this.doc.createElement("div").style;
    this.vars = deps.vars;
    let sheet = attrSheets.get(root);
    if (!sheet) attrSheets.set(root, (sheet = { node: null, users: new Set(), rules: new Map() }));
    this.attrSheet = sheet;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    if (this.vars && !this.subscribed) {
      this.subscribed = true;
      this.vars.onRolesChanged(() => this.rolesChanged());
    }
    this.observer = new MutationObserver((records) => this.onMutations(records));
    this.observer.observe(this.root, { subtree: true, childList: true, attributes: true, attributeFilter: ["style", ...ATTRS.map(([a]) => a)] });
    this.attrSheet.users.add(this);
    this.batch(this.root.querySelectorAll(SELECTOR));
  }

  /**
   * Transforms `value` (the element's computed `prop`, e.g. an inline SVG icon's `fill`) with the text role as an inline
   * override, as long as the element has no own declaration or presentation attribute for `prop`. `null` drops it again.
   */
  setComputed(el: Element, prop: string, value: string | null): void {
    let m = this.computed.get(el);
    if (value === null) {
      if (!m?.delete(prop)) return;
    } else {
      if (m?.get(prop) === value) return;
      if (!m) this.computed.set(el, (m = new Map()));
      m.set(prop, value);
    }
    if (this.running) this.enqueue([el]);
  }

  /**
   * Marks `el` (an SVG shape the image styler found covering its `<svg>`) as a backdrop, or unmarks it: its own
   * fill, from the attribute or its inline style, then gets the background transform instead of the foreground one.
   */
  setBackdrop(el: Element, on: boolean): void {
    if (this.backdrops.has(el) === on) return;
    if (on) this.backdrops.add(el);
    else this.backdrops.delete(el);
    if (this.running) this.enqueue([el]);
  }

  /**
   * Switches the theme in place (engine `update`): mutates `ctx.palette`, drops the value-keyed attrs rules (they were
   * transformed with the old palette) and re-plans every styled element now. Overrides are rewritten in the same `style`
   * attributes and attrs sheet node; nothing is added or removed. The registry's palette is the caller's to switch first.
   */
  setPalette(p: Palette): void {
    if (this.ctx.palette === p) return;
    this.ctx.palette = p;
    if (!this.running) return;
    this.attrSheet.rules.clear();
    this.batch(this.root.querySelectorAll(SELECTOR));
  }

  /** Re-plans elements with an inline `url()` once image analysis results arrive (`ctx.imageUrl`). */
  imagesReady(): void {
    if (this.running) this.enqueue(this.root.querySelectorAll('[style*="url("]'));
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.computed = new WeakMap();
    this.observer?.disconnect();
    this.observer = null;
    this.pending.clear();
    this.recheck.clear();
    this.doc.removeEventListener("DOMContentLoaded", this.onReady);
    for (const el of this.root.querySelectorAll("[style]")) {
      const st = this.states.get(el);
      const style = styleOf(el);
      if (!st || !style) continue;
      const cur = el.getAttribute("style");
      if (st.exact && cur === st.written) {
        if (cur !== st.attr) restoreStyleAttr(el, st.attr, st.css);
      } else {
        const origs = originals.get(el);
        for (const [p, w] of st.ours) if (stillOurs(style, p, w)) restoreProp(style, p, origs?.get(p));
      }
      this.states.delete(el);
      originals.delete(el);
    }
    for (const el of this.varSig.keys()) this.vars?.forgetSource(el);
    this.varSig.clear();
    this.removed.clear();
    const sheet = this.attrSheet;
    sheet.users.delete(this);
    if (sheet.users.size === 0) {
      sheet.node?.remove();
      for (const n of this.root.querySelectorAll('style[data-dusk="attrs"]')) if (isOwnNode(n)) n.remove();
      sheet.node = null;
      sheet.rules.clear();
      for (const el of this.root.querySelectorAll(`[${KEEP}]`)) el.removeAttribute(KEEP);
    }
  }

  private rolesChanged(): void {
    if (!this.running) return;
    const els = this.root.querySelectorAll('[style*="--"]');
    if (this.busy) for (const el of els) this.pending.add(el);
    else this.enqueue(els);
  }

  private readonly onReady = (): void => this.later();

  /** Processes `els` now (no scheduler) or on the next scheduled frame. */
  private enqueue(els: Iterable<Element>): void {
    const schedule = this.deps.schedule;
    if (!schedule) return this.batch(els);
    for (const el of els) this.pending.add(el);
    if (this.scheduled) return;
    this.scheduled = true;
    schedule(() => {
      this.scheduled = false;
      if (!this.running) return;
      const next = [...this.pending];
      this.pending.clear();
      this.batch(next);
    });
  }

  /** Elements whose guard answer was unknown (no layout yet) are re-checked on a later frame. */
  private later(): void {
    if (!this.running || this.recheck.size === 0) return;
    const els = [...this.recheck];
    this.recheck.clear();
    const schedule = this.deps.schedule ?? ((fn: () => void) => (globalThis.requestAnimationFrame ?? setTimeout)(fn));
    schedule(() => {
      if (!this.running) return;
      const next = this.deps.schedule;
      if (next) this.enqueue(els);
      else this.batch(els);
    });
  }

  private onMutations(records: MutationRecord[]): void {
    const els = new Set<Element>();
    for (const r of records) {
      if (r.type === "attributes") {
        const el = r.target as Element;
        if (r.attributeName === "style" && el.getAttribute("style") === this.states.get(el)?.written) continue;
        els.add(el);
        continue;
      }
      for (const n of r.addedNodes) {
        if (n.nodeType !== 1) continue;
        const el = n as Element;
        if (el.matches(SELECTOR)) els.add(el);
        if (el.firstElementChild) for (const d of el.querySelectorAll(SELECTOR)) els.add(d);
      }
      if (this.varSig.size === 0) continue;
      for (const n of r.removedNodes) {
        if (n.nodeType !== 1) continue;
        const el = n as Element;
        if (this.varSig.has(el)) this.removed.add(el);
        if (el.firstElementChild) for (const d of el.querySelectorAll('[style*="--"]')) if (this.varSig.has(d)) this.removed.add(d);
      }
    }
    if (els.size || this.removed.size) this.enqueue(els);
  }

  /** Reads everything first (including layout for the content-color guard), then writes, to avoid layout thrashing. */
  private batch(els: Iterable<Element>): void {
    this.busy = true;
    this.charts = new Map();
    try {
      // Elements removed for good stop being registry sources (moved ones are connected again by now).
      for (const el of this.removed) {
        if (el.isConnected) continue;
        this.vars?.forgetSource(el);
        this.varSig.delete(el);
      }
      this.removed.clear();
      const plans: Plan[] = [];
      for (const el of els) {
        if (!el.isConnected) continue;
        const plan = this.plan(el);
        if (plan) plans.push(plan);
      }
      for (const plan of plans) this.apply(plan);
      this.writeAttrSheet();
    } finally {
      this.busy = false;
    }
    if (this.pending.size && this.running && !this.deps.schedule) {
      const next = [...this.pending];
      this.pending.clear();
      this.batch(next);
    } else if (this.pending.size) this.enqueue([]);
    if (this.recheck.size) {
      if (this.doc.readyState === "loading") this.doc.addEventListener("DOMContentLoaded", this.onReady, { once: true });
      else this.later();
    }
  }

  private guarded(el: Element, prop: string, value: string): boolean {
    if (!GUARDED.has(prop)) return false;
    const c = parseColor(value.trim());
    if (c === null) return false;
    const state = contentColorState(el, c, this.charts);
    if (state !== "unknown") return state;
    // No layout box yet (or the document is still parsing): keep the color for now and look again later, a few times.
    const n = this.rechecks.get(el) ?? 0;
    if (n < MAX_RECHECKS) {
      this.rechecks.set(el, n + 1);
      this.recheck.add(el);
    }
    return true;
  }

  private plan(el: Element): Plan | null {
    const style = styleOf(el);
    if (!style) return null;
    const st = this.states.get(el);
    // The page changed the style: properties it overwrote are its own again.
    if (st) reconcile(el, st, style);
    const origs = originals.get(el);
    // The page's own declarations: the current ones with our overrides swapped back for the originals.
    const view = this.scratch;
    view.cssText = style.cssText;
    if (st) for (const p of st.ours.keys()) restoreProp(view, p, origs?.get(p));

    const want = new Map<string, [string, string]>();
    rewriteStyle(view, this.ctx, (prop, value) => {
      if (!this.guarded(el, prop, view.getPropertyValue(prop))) want.set(prop, [value, "important"]);
    });
    // Presentation attributes: a value-keyed rule in the attrs sheet; a content color marks the element to be skipped.
    let keep: boolean | null = null;
    for (const [attr, prop] of ATTRS) {
      const v = el.getAttribute(attr);
      if (v === null || !attrApplies(el, attr)) continue;
      keep ??= false;
      const next = rewriteDeclaration(prop, v.trim(), this.ctx);
      if (next === null) continue;
      if (this.guarded(el, prop, v)) keep = true;
      const key = `${attr}\n${v}`;
      if (!this.attrSheet.rules.has(key)) this.attrSheet.rules.set(key, `${attrSelector(attr, v)}{${prop}:${next}}`);
    }
    if (this.backdrops.has(el)) {
      const v = view.getPropertyValue("fill") || el.getAttribute("fill")?.trim() || "";
      const next = v && !this.guarded(el, "fill", v) ? rewriteDeclaration("background-color", v, this.ctx) : null;
      if (next !== null) want.set("fill", [next, "important"]);
    }
    for (const [prop, v] of this.computed.get(el) ?? []) {
      if (want.has(prop) || view.getPropertyValue(prop) !== "" || el.hasAttribute(prop)) continue;
      const next = rewriteDeclaration(prop, v, this.ctx);
      if (next !== null) want.set(prop, [next, "important"]);
    }
    const vars = this.vars;
    if (vars) {
      const defs: [string, string, string][] = [];
      for (let i = 0; i < view.length; i++) {
        const p = view.item(i);
        if (!p.startsWith("--") || p.startsWith("--dusk-")) continue;
        const value = view.getPropertyValue(p);
        // Only values that can be redefined per role are reported (not `10px`, `"a"` or JSON blobs).
        if (canRedefine(value)) defs.push([p, value, view.getPropertyPriority(p)]);
      }
      // The element's previous inline definitions are replaced, so a value the page keeps changing doesn't accumulate;
      // unchanged definitions skip the registry entirely.
      const sig = defs.map((d) => d.join("\u0000")).join("\u0001");
      if (sig !== (this.varSig.get(el) ?? "")) {
        vars.replaceSource(el, () => {
          for (const [p, value, priority] of defs) vars.observeDefinition(INLINE_SELECTOR, p, value, { important: priority === "important", source: el });
        });
        if (defs.length) this.varSig.set(el, sig);
        else this.varSig.delete(el);
      }
      for (const [p, value, priority] of defs) for (const [prop, v] of vars.inlineDefinitions(p, value)) want.set(prop, [v, priority]);
    }
    if (!st && want.size === 0) return keep === null && !el.hasAttribute(KEEP) ? null : { el, want: null, keep };
    return { el, want, keep };
  }

  /** Writes the attrs sheet (when its rules changed) and keeps it the first sheet of the root. */
  private writeAttrSheet(): void {
    const sheet = this.attrSheet;
    if (sheet.rules.size === 0) return;
    const parent = this.root.nodeType === 9 ? (this.doc.head ?? this.doc.documentElement) : this.root;
    if (!parent) return;
    if (!sheet.node || sheet.node.getRootNode() !== this.root) {
      sheet.node = [...this.root.querySelectorAll('style[data-dusk="attrs"]')].find(isOwnNode) ?? null;
      if (!sheet.node) {
        sheet.node = markOwn(this.doc.createElementNS(HTML_NS, "style"));
        sheet.node.setAttribute("data-dusk", "attrs");
        sheet.node.setAttribute("media", "screen");
      }
    }
    // The layer is declared before any page layer only while this is the root's first sheet.
    if (sheet.node.parentNode !== parent || parent.firstElementChild !== sheet.node) parent.insertBefore(sheet.node, parent.firstChild);
    const css = `@namespace svg url(${SVG_NS});@layer dusk-attrs{${[...sheet.rules.values()].join("")}}`;
    if (sheet.node.textContent !== css) sheet.node.textContent = css;
  }

  private apply({ el, want, keep }: Plan): void {
    if (keep) {
      if (!el.hasAttribute(KEEP)) el.setAttribute(KEEP, "");
    } else if (el.hasAttribute(KEEP)) el.removeAttribute(KEEP);
    if (!want) return;
    const style = styleOf(el) as CSSStyleDeclaration;
    let st = this.states.get(el);
    if (!st) {
      const attr = el.getAttribute("style");
      st = { attr, css: style.cssText, exact: true, written: attr, ours: new Map() };
      this.states.set(el, st);
    }
    let origs = originals.get(el);
    if (!origs) originals.set(el, (origs = new Map()));
    for (const [p, w] of [...st.ours]) {
      // Overrides of other engine parts (writeInlineOverride) stay; a property we want ourselves is taken over below.
      if (want.has(p) || w.owner !== undefined) continue;
      restoreProp(style, p, origs.get(p));
      st.ours.delete(p);
      origs.delete(p);
    }
    for (const [p, [v, priority]] of want) {
      const w = st.ours.get(p);
      if (w && w.owner === undefined && w.intended === v && w.priority === priority && stillOurs(style, p, w)) continue;
      if (!origs.has(p)) origs.set(p, { value: style.getPropertyValue(p), priority: style.getPropertyPriority(p) });
      style.setProperty(p, v, priority);
      st.ours.set(p, { value: style.getPropertyValue(p), priority: style.getPropertyPriority(p), intended: v });
    }
    restoreExactAttr(el, st);
  }
}
