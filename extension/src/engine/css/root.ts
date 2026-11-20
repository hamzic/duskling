import { isOwnNode, markOwn } from "./own";
import type { Palette } from "../color/palettes";
import { oklchToRgba } from "../color/oklch";
import { formatColor } from "../color/parse";
import { paletteCss } from "../color/transform";

const ORIG = "data-dusk-orig";

type MetaEl = HTMLMetaElement;

const themeMetas = (doc: Document): MetaEl[] => [...doc.querySelectorAll<MetaEl>('meta[name="theme-color" i]')];

// `::placeholder` at 60 % of fg: fg with alpha 0.6.
const placeholder = (p: Palette): string => formatColor({ ...oklchToRgba(p.fg), a: 0.6 });

function metaTint(doc: Document, p: Palette, nativeDark: boolean): string {
  const c = paletteCss(p);
  if (!nativeDark) return c.bg;
  const view = doc.defaultView;
  const own = (el: Element | null): string => (el && view ? view.getComputedStyle(el).backgroundColor : "");
  const transparent = (v: string): boolean => !v || v === "transparent" || /^rgba\([^)]*,\s*0\)$/.test(v);
  const html = own(doc.documentElement);
  if (!transparent(html)) return html;
  const body = own(doc.body);
  return transparent(body) ? c.bg : body;
}

/**
 * Root styles + Safari theme-color tint. Returns the teardown.
 *
 * Meta originals live in the DOM (`data-dusk-orig` holds the JSON of the original `content`, `null` when the attribute was
 * absent), so a second content.js instance on the same page can't save our own tint as the "original", and either
 * instance's teardown restores the document exactly.
 *
 * Measured in the iOS Simulator: iOS 26.5 Safari ignores `meta[name=theme-color]` for its toolbar tint and
 * derives it from the page background / fixed header instead. The meta is still kept in sync because it is harmless and
 * other contexts honor it; the `html` background rule above is what actually tints iOS Safari. Theme-color metas the page
 * adds after this runs are not tracked (Safari ignores them anyway).
 */
export function applyRootStyles(doc: Document, p: Palette, opts: { nativeDark: boolean; metaOnly?: string }): () => void {
  const c = paletteCss(p);
  const parts: string[] = [];
  // iframe: a frame whose page is still light (before Duskling runs in it, or an ad's blank frame) would otherwise get an
  // opaque light canvas, because its color scheme differs from the iframe element's (CSS Color Adjust 1 §2.2,
  // https://drafts.csswg.org/css-color-adjust-1/#color-scheme-effect). With the default scheme it stays transparent; a
  // frame Duskling has darkened gets a dark canvas.
  if (!opts.nativeDark) parts.push(`:root{color-scheme:dark}`, `iframe{color-scheme:normal}`, `html{background-color:${c.bg};color:${c.fg}}`);
  parts.push(`::selection{background-color:${c.selectionBg};color:${c.selectionText}}`);
  if (!opts.nativeDark) {
    parts.push(`::placeholder{color:${placeholder(p)}}`, `:root{scrollbar-color:${c.border} ${c.bg}}`);
  }
  // The contrast-repair passes (the bridge's for closed shadow roots) write `var(--dusk-neutral-bg)` and
  // `var(--dusk-neutral-text)`; with a native dark theme no vars node exists.
  if (opts.nativeDark) parts.push(`:root{--dusk-neutral-bg:${c.bg};--dusk-neutral-text:${c.fg}}`);

  const host = doc.head ?? doc.documentElement;
  // An existing root node (re-application with another theme, or a second instance) is rewritten in place, so a theme
  // change adds or removes no node. `metaOnly` (filter mode) writes no style, only the theme-color tint.
  const nodes = [...doc.querySelectorAll('style[data-dusk="root"]')].filter(isOwnNode);
  for (const extra of nodes.slice(1)) extra.remove();
  let style: Element | null = nodes[0] ?? null;
  if (opts.metaOnly !== undefined) {
    style?.remove();
    style = null;
  } else {
    if (!style) {
      style = markOwn(doc.createElement("style"));
      style.setAttribute("data-dusk", "root");
      style.setAttribute("media", "screen");
      host.append(style);
    }
    const css = parts.join("\n");
    if (style.textContent !== css) style.textContent = css;
  }

  const writeMetas = (tint: string): void => {
    const existing = themeMetas(doc);
    if (existing.length === 0) {
      const m = doc.createElement("meta");
      m.setAttribute("name", "theme-color");
      m.setAttribute("data-dusk", "meta");
      m.setAttribute("content", tint);
      host.append(m);
    } else {
      for (const m of existing) {
        if (m.getAttribute("data-dusk") !== "meta" && !m.hasAttribute(ORIG)) m.setAttribute(ORIG, JSON.stringify(m.getAttribute("content")));
        if (m.getAttribute("content") !== tint) m.setAttribute("content", tint);
      }
    }
  };
  // The site's own background is read on the next frame: the engine calls this right after removing its sheets, and a
  // read now forced a full style recalc that the frame's own recalc then repeats (github.com in WebKit: ~0.5 s).
  const view = doc.defaultView;
  let frame = 0;
  if (opts.metaOnly === undefined && opts.nativeDark && view) frame = view.requestAnimationFrame(() => writeMetas(metaTint(doc, p, true)));
  else writeMetas(opts.metaOnly ?? metaTint(doc, p, opts.nativeDark));

  return () => {
    if (frame) view?.cancelAnimationFrame(frame);
    if (style?.isConnected) style.remove();
    for (const m of themeMetas(doc)) {
      if (m.getAttribute("data-dusk") === "meta") {
        m.remove();
        continue;
      }
      const raw = m.getAttribute(ORIG);
      if (raw === null) continue;
      let orig: string | null = null;
      try {
        orig = JSON.parse(raw) as string | null;
      } catch {
        // Unparseable marker (page tampered with it): treat the original as "no content attribute".
      }
      if (orig === null) m.removeAttribute("content");
      else m.setAttribute("content", orig);
      m.removeAttribute(ORIG);
    }
  };
}

/**
 * A same-origin about:blank or srcdoc frame. A sandbox without `allow-same-origin` gives it an opaque origin (HTML §4.8.5,
 * https://html.spec.whatwg.org/multipage/iframe-embed-object.html#attr-iframe-sandbox), so it isn't one. Checked before
 * touching `contentDocument`: WebKit logs a "Blocked a frame" error for a cross-origin read even though it returns null.
 */
const isSpecial = (f: HTMLIFrameElement): boolean => {
  const sb = f.getAttribute("sandbox");
  if (sb !== null && !/(^|\s)allow-same-origin(\s|$)/i.test(sb)) return false;
  if (f.hasAttribute("srcdoc")) return true;
  const src = f.getAttribute("src");
  return src === null || src.trim() === "" || src.trim().toLowerCase() === "about:blank";
};

/**
 * Themes same-origin about:blank / srcdoc iframes from the parent (Safari doesn't support match_about_blank). `start` runs
 * once per document load of each such frame; the previous document's teardown runs when it is replaced.
 */
export function themeSpecialFrames(doc: Document, start: (childDoc: Document) => () => void): () => void {
  // `root` is the child's documentElement at start time: document.open()/write()/close() keeps the Document object but
  // replaces its tree (wiping our styles), so a changed root means the frame must be themed again.
  const active = new Map<HTMLIFrameElement, { doc: Document; root: Element | null; stop: () => void }>();
  const listening = new WeakSet<HTMLIFrameElement>();

  const drop = (f: HTMLIFrameElement): void => {
    active.get(f)?.stop();
    active.delete(f);
  };

  const sync = (f: HTMLIFrameElement): void => {
    if (!f.isConnected || !isSpecial(f)) return drop(f);
    const child = ((): Document | null => {
      try {
        return f.contentDocument;
      } catch {
        return null;
      }
    })();
    // Mid document.open() the document has no element yet (HTML "document open steps" remove its children); the frame's
    // load event after close() syncs again.
    if (!child?.documentElement) return drop(f);
    const cur = active.get(f);
    if (cur?.doc === child && cur.root === child.documentElement) return;
    cur?.stop();
    active.delete(f);
    active.set(f, { doc: child, root: child.documentElement, stop: start(child) });
  };

  const watch = (f: HTMLIFrameElement): void => {
    if (!listening.has(f)) {
      listening.add(f);
      f.addEventListener("load", () => sync(f));
    }
    sync(f);
  };

  const scan = (n: Node): void => {
    if (n.nodeType !== 1) return;
    const el = n as Element;
    if (el.localName === "iframe") watch(el as HTMLIFrameElement);
    for (const f of el.querySelectorAll("iframe")) watch(f);
  };

  scan(doc.documentElement);
  const mo = new MutationObserver((muts) => {
    for (const m of muts) {
      for (const n of m.addedNodes) scan(n);
      if (m.type === "attributes" && m.target.nodeName === "IFRAME") sync(m.target as HTMLIFrameElement);
    }
    // Removed frames (also nested in removed subtrees) would otherwise stay referenced here forever.
    for (const f of [...active.keys()]) if (!f.isConnected) drop(f);
  });
  mo.observe(doc.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["src", "srcdoc", "sandbox"] });

  return () => {
    mo.disconnect();
    for (const f of [...active.keys()]) drop(f);
  };
}
