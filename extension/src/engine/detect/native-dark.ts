import { markOwn } from "../css/own";
import { rgbaToOklch } from "../color/oklch";
import { parseColor } from "../color/parse";
import type { RGBA } from "../color/parse";
import { absolutizeUrls, kindOf, printOnly } from "../css/rules";
import { mirrorOf, restoreStyleAttr } from "../css/csp";
import { OWN_SHEET } from "../css/style-manager";
import { closeParen, splitTop } from "../css/syntax";

export type NativeVerdict = "dark" | "light" | "unknown";

export interface ThemeToggle { target: "html" | "body"; kind: "class" | "attr"; name: string; value?: string; declarationCount: number }

// Signal 1 / signal 4 marker tokens.
const MARKER_CLASS = /^(?:dark|dark-mode|darkmode|theme-dark|night|night-mode)$/i;
const MARKER_ATTRS = ["data-theme", "data-bs-theme", "data-color-mode", "data-mode", "data-color-scheme", "theme"];
const DARK_VALUE = /dark|night/i;
const TOGGLE_MIN_DECLARATIONS = 20;

type Rules = CSSRuleList | readonly CSSRule[];

const isOwnSheet = (s: CSSStyleSheet): boolean =>
  !!(s as unknown as Record<symbol, unknown>)[OWN_SHEET] || !!(s.ownerNode as Element | null)?.hasAttribute?.("data-dusk");

function readRules(s: CSSStyleSheet | CSSImportRule["styleSheet"]): CSSRuleList | null {
  try {
    return s?.cssRules ?? null; // Throws SecurityError for cross-origin sheets (CSSOM §6.1.3).
  } catch {
    return null;
  }
}

const childRules = (r: CSSRule): CSSRuleList | null => (r as CSSRule & { cssRules?: CSSRuleList }).cssRules ?? null;
const preludeOf = (r: CSSRule): string => r.cssText.slice(0, r.cssText.indexOf("{")).trim();

/**
 * Disables Duskling's own sheets of a document or shadow root (`[data-dusk]` style/link sheets and adopted sheets marked `OWN_SHEET`) and returns
 * the function that re-enables exactly those. `<style data-dusk="native">` stays enabled: it is the site's own dark theme
 * promoted, and the re-sample after promotion has to see it. `StyleSheet.disabled` removes a sheet from the
 * cascade (CSSOM §6.1, https://drafts.csswg.org/cssom/#dom-stylesheet-disabled; BCD api.StyleSheet.disabled, safari_ios 1)
 * and applies to constructed sheets too (BCD api.Document.adoptedStyleSheets, safari_ios 16.4).
 */
export function suspendOwnSheets(doc: Document | ShadowRoot): () => void {
  const off: CSSStyleSheet[] = [];
  const consider = (s: CSSStyleSheet | null | undefined): void => {
    if (!s || s.disabled) return;
    s.disabled = true;
    off.push(s);
  };
  for (const el of Array.from(doc.querySelectorAll<HTMLStyleElement | HTMLLinkElement>('style[data-dusk]:not([data-dusk="native"]), link[data-dusk]'))) consider(el.sheet);
  // A CSP mirror (css/csp.ts) is suspended like the element it stands in for; the promoted theme's stays on.
  for (const s of doc.adoptedStyleSheets ?? []) if ((s as unknown as Record<symbol, unknown>)[OWN_SHEET] && mirrorOf(s)?.getAttribute("data-dusk") !== "native") consider(s);
  return () => {
    for (const s of off) s.disabled = false;
  };
}

/** Runs `read` with `html[data-dusk-sampling]` set (the pre-paint selector excludes it), then removes it again. */
function withSampling<T>(doc: Document, suspend: () => () => void, read: () => T): T {
  const root = doc.documentElement;
  const had = root.hasAttribute("data-dusk-sampling");
  if (!had) root.setAttribute("data-dusk-sampling", "");
  try {
    const resume = suspend();
    try {
      return read();
    } finally {
      resume();
    }
  } finally {
    if (!had) root.removeAttribute("data-dusk-sampling");
  }
}

// `color-scheme` value "only dark" / "dark" (CSS Color Adjust 1 §2, https://drafts.csswg.org/css-color-adjust-1/#color-scheme-prop;
// the meta uses the same syntax, HTML §4.2.5.4 https://html.spec.whatwg.org/multipage/semantics.html#meta-color-scheme).
// BCD: css.properties.color-scheme safari_ios 13, html.elements.meta.name.color-scheme safari_ios 12.2.
const onlyDark = (value: string): boolean => {
  const tokens = value.trim().toLowerCase().split(/\s+/).filter((t) => t && t !== "only");
  return tokens.length === 1 && tokens[0] === "dark";
};

/**
 * Signal 2: `<meta name="color-scheme">` or the computed `color-scheme` of `:root` containing only `dark`. The computed
 * value is read with Duskling's own styles suspended (pre-paint and the root sheet both set `color-scheme: dark`).
 */
export function declaredScheme(doc: Document): NativeVerdict {
  const meta = doc.querySelector<HTMLMetaElement>('meta[name="color-scheme" i][content]');
  if (meta && onlyDark(meta.content)) return "dark";
  const view = doc.defaultView;
  if (!view) return "unknown";
  const computed = withSampling(doc, () => suspendOwnSheets(doc), () => view.getComputedStyle(doc.documentElement).getPropertyValue("color-scheme"));
  return onlyDark(computed) ? "dark" : "unknown";
}

/** Signal 1: a dark-state class token or attribute on `html` or `body`. Only a candidate: sampling has to agree. */
export function markerVerdict(doc: Document): NativeVerdict {
  for (const el of [doc.documentElement, doc.body]) {
    if (!el) continue;
    for (const c of Array.from(el.classList)) if (MARKER_CLASS.test(c)) return "dark";
    for (const a of MARKER_ATTRS) {
      const v = el.getAttribute(a);
      if (v !== null && DARK_VALUE.test(v)) return "dark";
    }
  }
  return "unknown";
}

// Signal 4 marker compounds: an optional `html` / `:root` / `body` plus one marker class or attribute, and nothing else
// in the compound, so the next character ends it (whitespace, a combinator, or `,` / `)` closing an :is()/:where() argument).
// A class like `.darken` or Tailwind's escaped `.dark\:bg-x` continues the identifier and doesn't match.
const COMPOUND_END = String.raw`(?=$|[\s>+~,)])`;
const SEL_CLASS = new RegExp(String.raw`^(html|:root|body)?\.(dark|dark-mode|darkmode|theme-dark|night|night-mode)` + COMPOUND_END, "i");
const SEL_ATTR = new RegExp(
  String.raw`^(html|:root|body)?\[\s*(${MARKER_ATTRS.join("|")})\s*=\s*(?:"([^"]*)"|'([^']*)'|([\w-]+))\s*(?:[is]\s*)?\]` + COMPOUND_END,
  "i",
);
const IS_WHERE = /:(?:is|where)\(/gi;

type Marker = Omit<ThemeToggle, "declarationCount">;

function compoundMarker(s: string): Marker | null {
  const c = SEL_CLASS.exec(s);
  if (c) return { target: c[1]?.toLowerCase() === "body" ? "body" : "html", kind: "class", name: c[2] as string };
  const a = SEL_ATTR.exec(s);
  if (!a) return null;
  const value = a[3] ?? a[4] ?? a[5] ?? "";
  if (!DARK_VALUE.test(value)) return null;
  return { target: a[1]?.toLowerCase() === "body" ? "body" : "html", kind: "attr", name: (a[2] as string).toLowerCase(), value };
}

/**
 * Markers of one complex selector: its first compound, or the first compound of any :is()/:where() argument. That covers
 * `html.dark .x`, `:is(.dark .x)` and `.x:where(.dark, .dark *)` (the class-variant output of common utility frameworks)
 * while `.btn .dark` stays excluded.
 */
function selectorMarkers(sel: string): Marker[] {
  const out: Marker[] = [];
  const first = compoundMarker(sel.trim());
  if (first) out.push(first);
  for (const m of sel.matchAll(IS_WHERE)) {
    const open = (m.index ?? 0) + m[0].length - 1;
    const close = closeParen(sel, open);
    for (const arg of splitTop(sel.slice(open + 1, close), ",")) {
      const mk = compoundMarker(arg.trim());
      if (mk) out.push(mk);
    }
  }
  return out;
}

const markerKey = (m: Marker): string => `${m.target}|${m.kind}|${m.name}|${m.value ?? ""}`;

/** Custom properties, plus one for a background (shorthand or longhands) and one for `color`. */
function themeDeclarations(style: CSSStyleDeclaration): number {
  let n = style.getPropertyValue("background-color") || style.getPropertyValue("background-image") || style.getPropertyValue("background") ? 1 : 0;
  if (style.getPropertyValue("color")) n++;
  for (let i = 0; i < style.length; i++) if (style.item(i).startsWith("--")) n++;
  return n;
}

/**
 * Every sheet of the document once: `document.styleSheets` plus `adoptedStyleSheets`. Safari 26 and earlier also list
 * adopted sheets in `document.styleSheets`; Safari 27 doesn't (CSSOM; Safari 27 release notes, 174583340), so without
 * the dedupe an adopted theme would count twice on one and once on the other.
 */
export function pageSheets(doc: Document): CSSStyleSheet[] {
  return [...new Set([...(doc.styleSheets as unknown as CSSStyleSheet[]), ...(doc.adoptedStyleSheets ?? [])])];
}

/**
 * Signal 4: finds the class or attribute dark theme with the most theme declarations (custom properties,
 * backgrounds and colors in rules whose selector starts with a root/body dark marker), if it has at least 20. Counting
 * declarations, not rules, finds themes written as a few rules of many custom properties (Bootstrap 5.3's
 * `[data-bs-theme=dark]`). Nested rules inherit their parent's marker.
 */
export function findClassThemeToggle(sheets: CSSStyleSheet[]): ThemeToggle | null {
  const counts = new Map<string, ThemeToggle>();
  const walk = (rules: Rules, inherited: readonly Marker[], depth: number): void => {
    if (depth > 32) return;
    for (let i = 0; i < rules.length; i++) {
      const rule = rules[i] as CSSRule;
      const kind = kindOf(rule);
      if (kind === "style") {
        const r = rule as CSSStyleRule;
        const found = new Map<string, Marker>();
        for (const sel of splitTop(r.selectorText, ",")) for (const m of selectorMarkers(sel)) found.set(markerKey(m), m);
        const markers = found.size ? [...found.values()] : inherited;
        const n = markers.length ? themeDeclarations(r.style) : 0;
        if (n) {
          for (const m of markers) {
            const k = markerKey(m);
            const t = counts.get(k) ?? { ...m, declarationCount: 0 };
            t.declarationCount += n;
            counts.set(k, t);
          }
        }
        const nested = childRules(r);
        if (nested) walk(nested, markers, depth + 1);
      } else if (kind === "import") {
        const imp = rule as CSSImportRule;
        if (printOnly(imp.media?.mediaText ?? "")) continue;
        const list = readRules(imp.styleSheet);
        if (list) walk(list, inherited, depth + 1);
      } else if (kind !== "skip" && kind !== "decls") {
        if (kind === "media" && printOnly((rule as CSSMediaRule).media.mediaText)) continue;
        const list = childRules(rule);
        if (list) walk(list, inherited, depth + 1);
      }
    }
  };
  for (const s of sheets) {
    if (isOwnSheet(s) || printOnly(s.media?.mediaText ?? "")) continue;
    const list = readRules(s);
    if (list) walk(list, [], 0);
  }
  let best: ThemeToggle | null = null;
  for (const t of counts.values()) if (!best || t.declarationCount > best.declarationCount) best = t;
  if (!best || best.declarationCount < TOGGLE_MIN_DECLARATIONS) return null;
  const { value, ...rest } = best;
  return value === undefined ? rest : { ...rest, value };
}

/**
 * Adds the toggle's class or attribute and returns the teardown, which reverts only what this call changed. If the page's
 * own script removes it (or changes the attribute), `onSiteRemoved` runs once and the engine doesn't fight it.
 * A `body` target needs `doc.body` to exist; without it nothing is applied.
 */
export function applyClassThemeToggle(doc: Document, t: ThemeToggle, onSiteRemoved: () => void): () => void {
  const el = t.target === "html" ? doc.documentElement : doc.body;
  if (!el) return () => {};
  const present = (): boolean => (t.kind === "class" ? el.classList.contains(t.name) : el.getAttribute(t.name) === t.value);
  const before = t.kind === "attr" ? el.getAttribute(t.name) : null;
  const added = !present();
  if (added) {
    if (t.kind === "class") el.classList.add(t.name);
    else el.setAttribute(t.name, t.value ?? "");
  }
  let watching = true;
  const observer = new MutationObserver(() => {
    if (!watching || present()) return;
    watching = false;
    observer.disconnect();
    onSiteRemoved();
  });
  observer.observe(el, { attributes: true, attributeFilter: [t.kind === "class" ? "class" : t.name] });
  return () => {
    observer.disconnect();
    const stillOurs = watching && present();
    watching = false;
    if (!added || !stillOurs) return;
    if (t.kind === "class") el.classList.remove(t.name);
    else if (before === null) el.removeAttribute(t.name);
    else el.setAttribute(t.name, before);
  };
}

/**
 * HTML "rules for parsing a legacy color value" (HTML §2.3.6.4,
 * https://html.spec.whatwg.org/multipage/common-microsyntaxes.html#rules-for-parsing-a-legacy-colour-value), used for
 * the `bgcolor` attribute. `null` means failure (the attribute then sets nothing).
 */
export function parseLegacyColor(input: string): RGBA | null {
  let s = input.trim();
  if (s === "" || s.toLowerCase() === "transparent") return null;
  const named = /^[a-z]+$/i.test(s) ? parseColor(s) : null;
  if (named) return named;
  if (/^#[0-9a-f]{3}$/i.test(s)) return parseColor(s);
  s = Array.from(s, (ch) => ((ch.codePointAt(0) ?? 0) > 0xffff ? "00" : ch)).join("");
  if (s.length > 128) s = s.slice(0, 128);
  if (s.startsWith("#")) s = s.slice(1);
  s = s.replace(/[^0-9a-f]/gi, "0");
  while (s.length === 0 || s.length % 3 !== 0) s += "0";
  let n = s.length / 3;
  let parts = [s.slice(0, n), s.slice(n, 2 * n), s.slice(2 * n)];
  if (n > 8) {
    parts = parts.map((x) => x.slice(n - 8));
    n = 8;
  }
  while (n > 2 && parts.every((x) => x[0] === "0")) {
    parts = parts.map((x) => x.slice(1));
    n--;
  }
  if (n > 2) parts = parts.map((x) => x.slice(0, 2));
  const [r, g, b] = parts.map((x) => parseInt(x, 16)) as [number, number, number];
  return { r, g, b, a: 1 };
}

/**
 * The color of a `background-color` or `background` value: the value itself, or else the last top-level token of the final
 * layer that parses as a color (CSS Backgrounds 3 §3.10, https://drafts.csswg.org/css-backgrounds-3/#background: only the
 * final layer carries a color). `null` when there is none (e.g. `var()`).
 */
function backgroundColorOf(value: string): RGBA | null {
  const direct = parseColor(value);
  if (direct) return direct;
  const layers = splitTop(value, ",");
  const tokens = splitTop((layers[layers.length - 1] ?? "").trim(), " ");
  for (let i = tokens.length - 1; i >= 0; i--) {
    const c = parseColor((tokens[i] as string).trim());
    if (c) return c;
  }
  return null;
}

/**
 * `el`'s background-color with its inline `background*` declarations taken out. They are removed, read, and the `style`
 * attribute is put back byte-identical, all synchronously, so nothing is painted. Observers still get attribute records for
 * `style`; by delivery the attribute equals what was there before, so an observer that compares with its last write (the
 * InlineStyler does) sees no change.
 */
function backgroundWithoutInline(el: Element, win: Window): string {
  const style = (el as HTMLElement).style;
  const saved = el.getAttribute("style");
  if (!style || saved === null) return win.getComputedStyle(el).backgroundColor;
  const css = style.cssText;
  try {
    style.removeProperty("background-color");
    style.removeProperty("background");
    return win.getComputedStyle(el).backgroundColor;
  } finally {
    restoreStyleAttr(el, saved, css);
  }
}

// Signal 5 sample points: the center and four points at 25 % insets.
const POINTS: [number, number][] = [[0.5, 0.5], [0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]];
const DARK_BELOW = 0.35;
const LIGHT_ABOVE = 0.6;
const WHITE: RGBA = { r: 255, g: 255, b: 255, a: 1 };
// The canvas under all-transparent backgrounds when only dark is declared: the Canvas system color of the dark scheme
// (CSS Color Adjust 1 §2.2, https://drafts.csswg.org/css-color-adjust-1/#color-scheme-effect). Its exact value differs
// per browser; any near-black reads as dark here.
const DARK_CANVAS: RGBA = { r: 18, g: 18, b: 18, a: 1 };

/**
 * Signal 5. Runs synchronously inside one task, so no frame is painted with Duskling's styles off: sets
 * `html[data-dusk-sampling]`, calls `suspend()`, reads the background at five points, then restores and removes the attribute.
 * (Setting and removing the attribute queues two attribute records for `html` for every observer of it; at delivery the
 * attribute is absent again, so an observer that reads the current state sees no change. Engine observers should skip
 * `data-dusk-*` attribute records.)
 *
 * At each point the stack from `elementsFromPoint` (topmost first; CSSOM View §5,
 * https://drafts.csswg.org/cssom-view/#dom-document-elementsfrompoint, BCD api.Document.elementsFromPoint safari_ios 11.3) is
 * walked down to the first opaque background; translucent layers on the way are composited over it. What shows through is
 * the canvas: the root's background, or, when that is transparent, body's, which then paints the canvas instead of body
 * (CSS Backgrounds 3 §2.11.2, https://drafts.csswg.org/css-backgrounds-3/#body-background); with neither, white.
 *
 * `originalBackground(el)` is `null` when the engine did not override `el`'s background. Otherwise it is the original inline
 * value: its color is used (a `background` shorthand's color component; no color, e.g. `var()`, counts as transparent), and
 * `""` means the page had no inline background, so the color comes from the `bgcolor` attribute (HTML legacy color parsing)
 * or else from the element's computed background with the engine's inline override taken out.
 */
export function sampleBackground(doc: Document, win: Window, opts: { suspend: () => () => void; originalBackground: (el: Element) => string | null }): NativeVerdict {
  const w = win.innerWidth;
  const h = win.innerHeight;
  if (!(w > 0 && h > 0)) return "unknown";
  let groundLight = false;
  const ls = withSampling(doc, opts.suspend, () => {
    const cache = new Map<Element, RGBA | null>();
    const bgOf = (el: Element): RGBA | null => {
      if (cache.has(el)) return cache.get(el) ?? null;
      const orig = opts.originalBackground(el);
      let c: RGBA | null;
      if (orig === null) c = parseColor(win.getComputedStyle(el).backgroundColor);
      else if (orig.trim() !== "") c = backgroundColorOf(orig);
      else {
        const attr = el.getAttribute("bgcolor");
        c = attr !== null ? parseLegacyColor(attr) : parseColor(backgroundWithoutInline(el, win));
      }
      cache.set(el, c);
      return c;
    };
    const html = doc.documentElement;
    const body = doc.body;
    const rootBg = bgOf(html);
    const propagated = !!body && !(rootBg && rootBg.a > 0);
    const canvas = rootBg && rootBg.a > 0 ? rootBg : (body && bgOf(body)) ?? null;
    const meta = doc.querySelector<HTMLMetaElement>('meta[name="color-scheme" i][content]');
    const base = (meta && onlyDark(meta.content)) || onlyDark(win.getComputedStyle(html).getPropertyValue("color-scheme")) ? DARK_CANVAS : WHITE;
    // A fixed layer (a consent dialog, a cookie banner) over a page whose canvas, as painted, is light isn't the page's
    // theme: skipped then. With no background set the canvas is `base` (white unless only dark is declared). Over a dark
    // canvas a fixed app shell may be the page, so it counts.
    const painted = canvas && canvas.a >= 0.999 ? canvas : base;
    const lightCanvas = rgbaToOklch(painted).l > LIGHT_ABOVE;
    // The page's own background as the page sets it: body's when opaque (it covers the content area), else the root's.
    // With neither set, an app shell may be the page, so the points decide.
    const bodyBg = body ? bgOf(body) : null;
    const ground = bodyBg && bodyBg.a >= 0.999 ? bodyBg : canvas && canvas.a >= 0.999 ? canvas : null;
    groundLight = !!ground && rgbaToOklch(ground).l > LIGHT_ABOVE;
    const fixed = new Map<Element, boolean>();
    const inFixed = (el: Element | null): boolean => {
      if (!el || el === body || el === html) return false;
      let v = fixed.get(el);
      if (v === undefined) fixed.set(el, (v = win.getComputedStyle(el).position === "fixed" || inFixed(el.parentElement)));
      return v;
    };
    const out: number[] = [];
    for (const [fx, fy] of POINTS) {
      const stack = doc.elementsFromPoint(w * fx, h * fy);
      if (stack.length === 0) continue;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      const add = (c: RGBA | null): void => {
        if (!c || c.a <= 0 || a >= 0.999) return;
        const k = (1 - a) * c.a;
        r += c.r * k;
        g += c.g * k;
        b += c.b * k;
        a += k;
      };
      for (const el of stack) {
        if (el === html || (propagated && el === body)) continue; // painted as the canvas below
        if (lightCanvas && inFixed(el)) continue;
        add(bgOf(el));
        if (a >= 0.999) break;
      }
      add(canvas);
      add(base);
      out.push(rgbaToOklch({ r, g, b, a: 1 }).l);
    }
    return out;
  });
  if (ls.length === 0) return "unknown";
  ls.sort((x, y) => x - y);
  const median = ls[Math.floor(ls.length / 2)] as number;
  // Dark boxes on a light page background don't make the page dark (a news page: a big dark lead story under three of
  // the five points). A natively dark page paints its own background dark.
  if (median < DARK_BELOW && groundLight) return "light";
  return median < DARK_BELOW ? "dark" : median > LIGHT_ABOVE ? "light" : "unknown";
}

// Media Queries 5 §12.5 (https://drafts.csswg.org/mediaqueries-5/#prefers-color-scheme); BCD
// css.at-rules.media.prefers-color-scheme safari_ios 13.
const DARK_FEATURE = /\(\s*prefers-color-scheme\s*:\s*dark\s*\)/i;
const UNCONDITIONAL = /^(?:only\s+)?(?:all|screen)$/i;

/**
 * For a media query list, the condition left once `(prefers-color-scheme: dark)` is taken out: `null` when no query in the
 * list asks for dark, `""` when one becomes unconditional, otherwise the remaining queries. Negated, `or` and print-only
 * queries are left alone, because removing the feature from them would change their meaning.
 */
function darkRemainder(mediaText: string): string | null {
  const rest: string[] = [];
  let any = false;
  for (const raw of splitTop(mediaText, ",")) {
    const q = raw.trim();
    if (!DARK_FEATURE.test(q) || /^not\b/i.test(q)) continue;
    const r = q
      .replace(DARK_FEATURE, "")
      .replace(/\band\s+and\b/gi, "and")
      .replace(/^\s*and\b/i, "")
      .replace(/\band\s*$/i, "")
      .trim();
    if (/\b(?:or|not)\b/i.test(r) || printOnly(r)) continue;
    any = true;
    if (r === "" || UNCONDITIONAL.test(r)) return "";
    rest.push(r);
  }
  return any ? rest.join(", ") : null;
}

const wrapAll = (wrappers: readonly string[], inner: string): string => wrappers.reduceRight((acc, w) => `${w}{${acc}}`, inner);

const sheetBase = (s: CSSStyleSheet | null | undefined): string | null => s?.href ?? null;

/**
 * The cssText of `list` with relative `url()`s made absolute against `base` (the sheet's URL; `null` for a `<style>`, whose
 * URLs already resolve against the document like the promoted `<style>`'s). `@import` rules are not copied: a readable
 * import's rules are inlined in their place (inside its media condition), with the imported sheet's URL as their base.
 */
function rulesText(list: Rules, base: string | null, depth = 0): string {
  let s = "";
  for (let i = 0; i < list.length; i++) {
    const rule = list[i] as CSSRule;
    if (kindOf(rule) !== "import") {
      s += base ? absolutizeUrls(rule.cssText, base) : rule.cssText;
      continue;
    }
    const imp = rule as CSSImportRule;
    const mt = imp.media?.mediaText ?? "";
    const inner = depth < 32 && !printOnly(mt) ? readRules(imp.styleSheet) : null;
    if (!inner) continue;
    const text = rulesText(inner, sheetBase(imp.styleSheet) ?? base, depth + 1);
    if (text) s += mt ? `@media ${mt}{${text}}` : text;
  }
  return s;
}

/**
 * Signal 3: the CSS of every `@media (prefers-color-scheme: dark)` block (at any depth) and of every sheet whose own
 * media asks for dark (`<link|style media=…dark>`, `@import … (prefers-color-scheme: dark)`), without the dark condition.
 * Enclosing @media/@supports/@layer/@container/@scope blocks and parent style rules (CSS nesting) are kept around the copy;
 * print-only media and Duskling's own sheets are skipped; unreadable (cross-origin) sheets are skipped. Relative `url()`s are made
 * absolute against the sheet they came from (CSS Values 4 §4.5.1), because the copy lives in a `<style>` in the document.
 */
export function collectDarkSchemeRules(sheets: CSSStyleSheet[]): string {
  const out: string[] = [];
  const take = (list: Rules, remainder: string, wrappers: readonly string[], base: string | null): void => {
    const inner = rulesText(list, base);
    if (inner) out.push(wrapAll(remainder ? [...wrappers, `@media ${remainder}`] : wrappers, inner));
  };
  const walk = (rules: Rules, wrappers: readonly string[], base: string | null, depth: number): void => {
    if (depth > 32) return;
    for (let i = 0; i < rules.length; i++) {
      const rule = rules[i] as CSSRule;
      const kind = kindOf(rule);
      if (kind === "skip" || kind === "decls") continue;
      if (kind === "import") {
        const imp = rule as CSSImportRule;
        const mt = imp.media?.mediaText ?? "";
        if (printOnly(mt)) continue;
        const list = readRules(imp.styleSheet);
        if (!list) continue;
        const b = sheetBase(imp.styleSheet) ?? base;
        const rem = darkRemainder(mt);
        if (rem !== null) take(list, rem, wrappers, b);
        else walk(list, mt ? [...wrappers, `@media ${mt}`] : wrappers, b, depth + 1);
        continue;
      }
      const list = childRules(rule);
      if (!list || list.length === 0) continue;
      let prelude: string;
      if (kind === "media") {
        const mt = (rule as CSSMediaRule).media.mediaText;
        if (printOnly(mt)) continue;
        const rem = darkRemainder(mt);
        if (rem !== null) {
          take(list, rem, wrappers, base);
          continue;
        }
        prelude = `@media ${mt}`;
      } else if (kind === "style") prelude = (rule as CSSStyleRule).selectorText;
      else if (kind === "supports") prelude = `@supports ${(rule as CSSSupportsRule).conditionText}`;
      else if (kind === "layer") prelude = `@layer ${(rule as CSSRule & { name: string }).name}`.trimEnd();
      else prelude = preludeOf(rule); // @container, @scope
      walk(list, [...wrappers, prelude], base, depth + 1);
    }
  };
  for (const s of sheets) {
    if (isOwnSheet(s)) continue;
    const mt = s.media?.mediaText ?? "";
    if (printOnly(mt)) continue;
    const list = readRules(s);
    if (!list) continue;
    const base = sheetBase(s);
    const rem = darkRemainder(mt);
    if (rem !== null) take(list, rem, [], base);
    else walk(list, mt ? [`@media ${mt}`] : [], base, 0);
  }
  return out.join("\n");
}

// A single compound selector with a class or id and no combinators, e.g. `.x108lcm5`, `.a.b`, `#app[data-x]`: what CSS-in-JS
// tools put on html. Only these are tried with matches(), which keeps the check cheap on large dark sheets.
const CLASS_COMPOUND = /^[^\s>+~]*[.#][^\s>+~]*$/;

/** "html" or "body" when `sel` is a class/id compound selector that matches that element of `doc`. */
function matchesRoot(doc: Document | undefined, sel: string): string | null {
  if (!doc || !CLASS_COMPOUND.test(sel.trim())) return null;
  try {
    if (doc.documentElement.matches(sel)) return "html";
    if (doc.body?.matches(sel)) return "body";
  } catch {
    // An invalid or unsupported selector.
  }
  return null;
}

// A single compound selector on html, body or :root (no combinators), e.g. `html`, `:root`, `html.js`, `body[data-x]`.
const ROOT_SELECTOR = /^(html|body|:root)(?![\w-])[^\s>+~]*$/i;

/**
 * Whether collected dark CSS is a page-level theme: it sets `background`/`background-color` on html, body or
 * :root, or defines custom properties on :root (or html). Parsed with a constructed, never-attached sheet
 * (BCD api.CSSStyleSheet.CSSStyleSheet safari_ios 16.4). With `doc`, a selector that matches its root or body element
 * counts as html or body too: CSS-in-JS tools put the theme on an atomic class of html (seen on chatgpt.com).
 */
export function hasRootDarkTheme(css: string, doc?: Document): boolean {
  if (!css.trim()) return false;
  const s = new CSSStyleSheet();
  try {
    s.replaceSync(css);
  } catch {
    return false;
  }
  const walk = (rules: Rules, depth: number): boolean => {
    if (depth > 32) return false;
    for (let i = 0; i < rules.length; i++) {
      const rule = rules[i] as CSSRule;
      const kind = kindOf(rule);
      if (kind === "style") {
        const r = rule as CSSStyleRule;
        for (const sel of splitTop(r.selectorText, ",")) {
          const which = ROOT_SELECTOR.exec(sel.trim())?.[1]?.toLowerCase() ?? matchesRoot(doc, sel);
          if (!which) continue;
          const st = r.style;
          if (st.getPropertyValue("background-color") || st.getPropertyValue("background")) return true;
          if (which !== "body") for (let j = 0; j < st.length; j++) if (st.item(j).startsWith("--")) return true;
        }
      } else if (kind !== "skip" && kind !== "decls" && kind !== "import") {
        const list = childRules(rule);
        if (list && walk(list, depth + 1)) return true;
      }
    }
    return false;
  };
  return walk(s.cssRules, 0);
}

/**
 * Promotes the site's dark theme: inserts `css` as `<style data-dusk="native" media="screen">` and tells the
 * bridge to make `matchMedia('(prefers-color-scheme: dark)')` match. The teardown removes the style and switches the bridge
 * promotion off; it is idempotent.
 */
export async function promote(doc: Document, css: string, bridge: { setPromotion(on: boolean): void }): Promise<() => void> {
  const style = markOwn(doc.createElement("style"));
  style.setAttribute("data-dusk", "native");
  style.setAttribute("media", "screen");
  style.textContent = css;
  (doc.head ?? doc.documentElement).append(style);
  bridge.setPromotion(true);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    style.remove();
    bridge.setPromotion(false);
  };
}
