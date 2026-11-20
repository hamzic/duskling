// A page's CSP `style-src` without 'unsafe-inline': Safari refuses every `<style>` Duskling inserts (its
// `sheet` stays null) and doesn't re-parse a changed `style` attribute, but applies constructed sheets in
// `adoptedStyleSheets` and CSSOM writes. So a refused `<style data-dusk>` is mirrored into a constructed sheet, and
// `style` attributes are restored through the CSSOM when re-parsing them was refused.
import { isOwnNode } from "./own";
import { MIRROR_OF, OWN_SHEET } from "./style-manager";

type Mirror = CSSStyleSheet & { [OWN_SHEET]?: true; [MIRROR_OF]?: Element; css?: string };

/** The refused `<style data-dusk>` a constructed sheet stands in for, if it is a mirror. */
export const mirrorOf = (s: CSSStyleSheet): Element | undefined => (s as Mirror)[MIRROR_OF];

export interface StyleMirror {
  /** Brings the mirrors up to date now; sampling calls it, as observer records arrive a microtask later. */
  sync(): void;
  stop(): void;
}

const isDusk = (n: Node | null): boolean => n?.nodeType === 1 && (n as Element).localName === "style" && (n as Element).hasAttribute("data-dusk");
const hasDusk = (n: Node): boolean => isDusk(n) || (n.nodeType === 1 && !!(n as Element).querySelector("style[data-dusk]"));

/**
 * Mirrors each refused `<style data-dusk>` in `root` into a constructed sheet with its text and media, at the end of
 * `root.adoptedStyleSheets` in document order (after the page's own sheets: the order of appearance among Duskling's own
 * sheets is kept, not their position between the page's). Nothing happens on a page whose CSP lets them apply.
 */
export function mirrorBlockedStyles(root: Document | ShadowRoot, win: Window): StyleMirror {
  const mirrors = new Map<Element, Mirror>();
  const ours = new WeakSet<CSSStyleSheet>();
  const Sheet = (win as Window & typeof globalThis).CSSStyleSheet;
  const sync = (): void => {
    mo.takeRecords();
    const want: Mirror[] = [];
    for (const el of root.querySelectorAll<HTMLStyleElement>("style[data-dusk]")) {
      // Only nodes Duskling made: mirroring a page-made <style data-dusk> would apply CSS the page's CSP refused.
      if (el.sheet || !isOwnNode(el)) continue;
      const media = el.getAttribute("media") ?? "";
      let m = mirrors.get(el);
      if (!m || m.media.mediaText !== media) {
        // Constructed in the root's own realm: adopting a sheet from another realm throws (CSSOM §6.1.2).
        m = new Sheet({ media }) as Mirror;
        m[OWN_SHEET] = true;
        m[MIRROR_OF] = el;
        ours.add(m);
        mirrors.set(el, m);
      }
      const css = el.textContent ?? "";
      if (m.css !== css) {
        m.replaceSync(css);
        m.css = css;
      }
      want.push(m);
    }
    for (const [el, m] of mirrors) if (!want.includes(m)) mirrors.delete(el);
    const list = root.adoptedStyleSheets;
    const next = [...list.filter((s) => !ours.has(s)), ...want];
    if (next.length !== list.length || next.some((s, i) => s !== list[i])) root.adoptedStyleSheets = next;
  };
  const mo = new MutationObserver((records) => {
    for (const r of records) if (isDusk(r.target) || isDusk(r.target.parentNode) || [...r.addedNodes, ...r.removedNodes].some(hasDusk)) return sync();
  });
  mo.observe(root, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["media", "data-dusk"] });
  sync();
  return {
    sync,
    stop() {
      mo.disconnect();
      mirrors.clear();
      const list = root.adoptedStyleSheets;
      if (list.some((s) => ours.has(s))) root.adoptedStyleSheets = list.filter((s) => !ours.has(s));
    },
  };
}

/**
 * Puts a `style` attribute back byte-identical. `css` is the element's `style.cssText` while it had that attribute. The
 * declarations go back through the CSSOM first: the CSP may refuse to re-parse the attribute, which then leaves them as
 * they are. A markup attribute the CSP refused from the start has an empty `css` and stays refused.
 */
export function restoreStyleAttr(el: Element, attr: string | null, css: string): void {
  const st = (el as HTMLElement).style;
  if (st && st.cssText !== css) st.cssText = css;
  // Reading the attribute also writes that CSSOM change into it: WebKit does so lazily, and a removeAttribute before
  // it would leave `style=""` behind once something reads the attribute.
  if (el.getAttribute("style") === attr) return;
  if (attr === null) el.removeAttribute("style");
  else el.setAttribute("style", attr);
}
