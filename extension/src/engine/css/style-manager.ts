import { isOwnNode, markOwn } from "./own";
import type { Palette } from "../color/palettes";
import type { RewriteCtx } from "./declarations";
import { absolutizeUrls, printOnly, rewriteRuleList, stripCssComments } from "./rules";
import { closeParen } from "./syntax";
import type { VariableRegistry } from "./variables";

export interface StyleManagerDeps {
  ctx: RewriteCtx;
  vars: VariableRegistry;
  fetchText: (url: string) => Promise<string | null>;
  schedule: (fn: () => void) => void;
}

/** Marks constructed sheets created by the engine; the bridge ignores them. */
export const OWN_SHEET = Symbol.for("dusk.own");
/** On an own sheet: the adopted source it overrides, so another StyleManager on the same root reuses it. */
const OWN_FOR = Symbol.for("dusk.own.for");
/** On a constructed sheet that mirrors a `<style data-dusk>` the page's CSP refused (css/csp.ts): that element. */
export const MIRROR_OF = Symbol.for("dusk.own.mirror");
type OwnSheet = CSSStyleSheet & { [OWN_SHEET]?: true; [OWN_FOR]?: CSSStyleSheet; [MIRROR_OF]?: Element };

const MAX_IMPORT_DEPTH = 3;
const VAR_NAME = /var\(\s*(--[\w-]+)/g;
const PENDING = 0;

interface Entry {
  sheet: CSSStyleSheet | null;
  /** Base for relative url()s: the sheet's own URL (a <link>), else the document's. */
  base: string | undefined;
  /** Custom properties this sheet defines (its redefinitions live in its override). */
  defines: Set<string>;
  len: number;
  media: string;
  disabled: boolean;
  names: Set<string>;
  /** Image URLs this sheet's rewrite looked up (ctx.imageUrl), so arriving analysis results re-emit it. */
  images: Set<string>;
  out: Element | CSSStyleSheet | null;
  css: string;
}

const isOwnSheet = (s: CSSStyleSheet): boolean => (s as OwnSheet)[OWN_SHEET] === true;
/** Mirrors belong to css/csp.ts, which keeps them last; this manager leaves them in place. */
const isMirror = (s: CSSStyleSheet): boolean => !!(s as OwnSheet)[MIRROR_OF];
const isOurs = (n: Node): boolean => n.nodeType === 1 && (n as Element).hasAttribute("data-dusk");
const isStylesheetLink = (el: Element): boolean =>
  el.localName === "link" && (el.getAttribute("rel") ?? "").toLowerCase().split(/\s+/).includes("stylesheet");
const isSource = (n: Node): n is Element =>
  n.nodeType === 1 && !isOurs(n) && ((n as Element).localName === "style" || isStylesheetLink(n as Element));
const normMedia = (m: string): string => (m.trim().toLowerCase() === "all" ? "" : m.trim());
// An element's sheet takes its media from the element's `media` attribute (HTML "update a style block",
// https://html.spec.whatwg.org/multipage/semantics.html#update-a-style-block, and the link "create a CSS style sheet" step).
const elementMedia = (el: Element): string => normMedia(el.getAttribute("media") ?? "");
const sheetMedia = (s: CSSStyleSheet): string => normMedia(s.media?.mediaText ?? "");

function sheetOf(el: Element): CSSStyleSheet | null {
  return (el as HTMLStyleElement).sheet ?? null;
}

/**
 * Splits the condition after an `@import` URL (`layer(x) supports(y) screen`) into wrappers, outermost first.
 * CSS Cascade 5 §2.1 https://drafts.csswg.org/css-cascade-5/#at-import. Returns null when the import is print-only.
 */
function importWrappers(cond: string): string[] | null {
  const out: string[] = [];
  let rest = cond.trim();
  const layer = /^layer\b(\()?/i.exec(rest);
  if (layer) {
    const end = layer[1] ? closeParen(rest, layer[0].length - 1) : layer[0].length - 1;
    out.push(layer[1] ? `@layer ${rest.slice(layer[0].length, end).trim()}` : "@layer");
    rest = rest.slice(end + 1).trim();
  }
  const sup = /^supports\(/i.exec(rest);
  if (sup) {
    const end = closeParen(rest, sup[0].length - 1);
    const c = rest.slice(sup[0].length, end).trim();
    out.push(`@supports ${c.startsWith("(") ? c : `(${c})`}`);
    rest = rest.slice(end + 1).trim();
  }
  if (rest) {
    if (printOnly(rest)) return null;
    out.push(`@media ${rest}`);
  }
  return out;
}

// @import must precede all other rules except @charset and @layer statements (CSS Cascade 5 §2.1), so only the text
// before the first block is scanned.
const IMPORT = /@import\s+(?:url\(\s*(["']?)([^"')]*)\1\s*\)|(["'])([^"']*)\3)([^;]*);/gi;

/**
 * Collects every stylesheet of one document or shadow root (`<style>`, `<link rel=stylesheet>`, `adoptedStyleSheets`)
 * and keeps a rewritten override next to each one:
 * - element sources get a `<style data-dusk="sheet" media="screen">` inserted immediately after them, so the override
 *   sits at the same cascade position as its source;
 * - adopted sheets get a constructed `CSSStyleSheet({ media: "screen" })` (marked with `Symbol.for("dusk.own")`) placed
 *   right after each source in `adoptedStyleSheets`;
 * - one `<style data-dusk="vars">` holds `vars.definitionsCss()`.
 *
 * Cross-origin sheets (reading `cssRules` throws a SecurityError, CSSOM §6.1.3
 * https://drafts.csswg.org/cssom/#dom-cssstylesheet-cssrules) are fetched through `fetchText` and parsed into a detached
 * sheet with `replaceSync`, which drops `@import` rules (CSSOM https://drafts.csswg.org/cssom/#dom-cssstylesheet-replacesync),
 * so imports are fetched and inlined here, up to depth 3. Constructable sheets and adoptedStyleSheets: Safari iOS 16.4
 * (@mdn/browser-compat-data 8.1.6, api.CSSStyleSheet.CSSStyleSheet, api.Document.adoptedStyleSheets).
 *
 * Mutations are batched through `deps.schedule`. The manager's own nodes (`[data-dusk]`) and sheets never trigger
 * work, and `start()` adopts override nodes already present (a second injection of content.js), so nothing is duplicated.
 */
export class StyleManager {
  private readonly ctx: RewriteCtx;
  private readonly doc: Document;
  private readonly elements = new Map<Element, Entry>();
  private readonly adopted = new Map<CSSStyleSheet, Entry>();
  private readonly dirty = new Set<Entry>();
  private readonly marked = new Set<Element>();
  private readonly selfRemoved = new WeakSet<Node>();
  private readonly remote = new Map<string, CSSStyleSheet | typeof PENDING | null>();
  /** Entries waiting for a remote sheet (a cross-origin sheet or @import) to arrive. */
  private readonly waiting = new Map<string, Set<Entry>>();
  private readonly claimed = new Set<Element>();
  private current: Entry | null = null;
  private observer: MutationObserver | null = null;
  private varsNode: Element | null = null;
  private varsDirty = true;
  private structural = true;
  private running = false;
  private subscribed = false;
  private scheduled = false;
  private flushing = false;
  private again = false;
  private collecting: Set<string> | null = null;
  /** Callers of `whenRemoteSettled()` still waiting. */
  private settledWaiters: (() => void)[] = [];
  private readonly failed = new WeakSet<Element>();

  constructor(private readonly root: Document | ShadowRoot, private readonly deps: StyleManagerDeps) {
    this.doc = root.nodeType === 9 ? (root as Document) : (root.ownerDocument as Document);
    const { vars } = deps;
    this.ctx = {
      ...deps.ctx,
      varRef: (v, role) => {
        if (this.collecting) for (const m of v.matchAll(VAR_NAME)) this.collecting.add(m[1] as string);
        return vars.varRef(v, role);
      },
      onVariable: (s, n, v, o) => {
        deps.ctx.onVariable?.(s, n, v, o);
        const e = this.current;
        e?.defines.add(n);
        vars.observeDefinition(s, n, v, e ? { ...o, source: e } : o);
      },
      importRules: (url) => this.remoteRules(url),
    };
    const lookup = deps.ctx.imageUrl;
    if (lookup) {
      this.ctx.imageUrl = (url) => {
        this.current?.images.add(url);
        return lookup(url);
      };
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    if (!this.subscribed) {
      this.subscribed = true;
      this.deps.vars.onRolesChanged((names) => this.rolesChanged(names));
    }
    this.observer = new MutationObserver((records) => this.onMutations(records));
    this.observer.observe(this.root, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["rel", "href", "media", "disabled", "type"],
    });
    this.root.addEventListener("load", this.onLoad, true);
    this.root.addEventListener("error", this.onError, true);
    this.structural = true;
    this.varsDirty = true;
    this.flush();
  }

  /** Diffs all sheets by identity, `cssRules.length`, media and disabled state, and re-emits the changed ones. */
  rescan(): void {
    if (!this.running) return;
    this.structural = true;
    this.flush();
  }

  /** Re-emits the sheets whose rewrite looked up any of `urls` (image analysis results arrived). */
  imagesReady(urls: readonly string[]): void {
    if (!this.running) return;
    for (const e of [...this.elements.values(), ...this.adopted.values()]) if (urls.some((u) => e.images.has(u))) this.dirty.add(e);
    this.request();
  }

  /**
   * Switches the theme in place (engine `update`): every override and the vars node are rewritten with `p`
   * into the nodes and constructed sheets they already occupy, so no node is added or removed. The registry's own palette
   * (`var()` fallbacks) is the caller's to switch first.
   */
  setPalette(p: Palette): void {
    if (this.ctx.palette === p) return;
    this.ctx.palette = p;
    if (!this.running) return;
    for (const e of [...this.elements.values(), ...this.adopted.values()]) this.dirty.add(e);
    this.varsDirty = true;
    this.flush();
  }

  /**
   * Resolves once no remote sheet is being fetched and the ones that arrived are written. The engine holds the pre-paint
   * until then: a cross-origin sheet already applies to the page while its rewrite is pending.
   */
  whenRemoteSettled(): Promise<void> {
    if (!this.running || !this.remotePending()) return Promise.resolve();
    return new Promise((resolve) => this.settledWaiters.push(resolve));
  }

  private remotePending(): boolean {
    for (const v of this.remote.values()) if (v === PENDING) return true;
    // A stylesheet link still loading: once it applies, a cross-origin one needs a fetch too. One that failed has no sheet
    // either; it's `failed` after its error event, and the engine's cap covers one that failed before we listened.
    for (const el of this.elements.keys()) {
      if (isStylesheetLink(el) && !(el as HTMLLinkElement).sheet && !this.failed.has(el)) return true;
    }
    return false;
  }

  private notifySettled(): void {
    if (this.settledWaiters.length === 0 || (this.running && this.remotePending())) return;
    const ws = this.settledWaiters;
    this.settledWaiters = [];
    for (const w of ws) w();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.notifySettled();
    this.observer?.disconnect();
    this.observer = null;
    this.root.removeEventListener("load", this.onLoad, true);
    this.root.removeEventListener("error", this.onError, true);
    for (const e of this.elements.values()) if (e.out instanceof Element) e.out.remove();
    for (const e of [...this.elements.values(), ...this.adopted.values()]) this.deps.vars.forgetSource(e);
    this.varsNode?.remove();
    for (const n of this.root.querySelectorAll('style[data-dusk="sheet"], style[data-dusk="vars"]')) if (isOwnNode(n)) n.remove();
    const list = this.root.adoptedStyleSheets;
    if (list.some((s) => isOwnSheet(s) && !isMirror(s))) this.root.adoptedStyleSheets = list.filter((s) => !isOwnSheet(s) || isMirror(s));
    this.elements.clear();
    this.adopted.clear();
    this.dirty.clear();
    this.marked.clear();
    this.claimed.clear();
    this.waiting.clear();
    this.varsNode = null;
  }

  private readonly onLoad = (ev: Event): void => {
    const t = ev.target as Node | null;
    if (!t || !isSource(t)) return;
    this.mark(t);
    // With the pre-paint held, a loaded cross-origin sheet is fetched now rather than at the next scheduled batch.
    if (this.settledWaiters.length) {
      this.flush();
      this.notifySettled();
    }
  };

  private readonly onError = (ev: Event): void => {
    const t = ev.target as Element | null;
    if (t?.localName !== "link") return;
    this.failed.add(t);
    this.notifySettled();
  };

  private mark(el: Element): void {
    this.marked.add(el);
    this.request();
  }

  private request(): void {
    if (!this.running) return;
    if (this.flushing) {
      this.again = true;
      return;
    }
    if (this.scheduled) return;
    this.scheduled = true;
    this.deps.schedule(() => {
      this.scheduled = false;
      this.flush();
    });
  }

  private rolesChanged(names: string[]): void {
    if (!this.running) return;
    this.varsDirty = true;
    for (const e of [...this.elements.values(), ...this.adopted.values()]) {
      if (names.some((n) => e.names.has(n) || e.defines.has(n))) this.dirty.add(e);
    }
    this.request();
  }

  private relevant(n: Node, removed: boolean): boolean {
    if (isOurs(n)) return removed && !n.isConnected && !this.selfRemoved.has(n);
    if (isSource(n)) return true;
    return n.nodeType === 1 && (n as Element).firstElementChild !== null && (n as Element).querySelector("style, link") !== null;
  }

  private onMutations(records: MutationRecord[]): void {
    let any = false;
    for (const r of records) {
      const t = r.target;
      if (r.type === "characterData") {
        const parent = t.parentNode;
        if (parent && isSource(parent)) {
          this.marked.add(parent);
          any = true;
        }
        continue;
      }
      if (isOurs(t)) continue;
      if (r.type === "attributes") {
        if ((t as Element).localName === "style" || (t as Element).localName === "link") {
          this.marked.add(t as Element);
          this.structural = any = true;
        }
        continue;
      }
      if (isSource(t)) {
        this.marked.add(t);
        any = true;
      }
      for (const n of r.addedNodes) if (this.relevant(n, false)) this.structural = any = true;
      for (const n of r.removedNodes) if (this.relevant(n, true)) this.structural = any = true;
    }
    if (any) this.request();
  }

  private flush(): void {
    if (!this.running || this.flushing) return;
    this.flushing = true;
    try {
      do {
        this.again = false;
        this.pass();
      } while (this.again && this.running);
    } finally {
      this.flushing = false;
    }
  }

  private pass(): void {
    if (this.structural || this.marked.size) {
      const seen = new Set<Element>();
      const list = this.structural ? this.root.querySelectorAll("style, link") : this.marked;
      for (const el of list) {
        if (!isSource(el) || !el.isConnected || el.getRootNode() !== this.root) continue;
        seen.add(el);
        this.syncElement(el);
      }
      if (this.structural) {
        for (const [el, e] of this.elements) {
          if (seen.has(el)) continue;
          this.removeOut(e);
          this.dirty.delete(e);
          this.elements.delete(el);
          this.deps.vars.forgetSource(e);
        }
      }
      this.marked.clear();
      this.syncAdopted();
      this.structural = false;
    }
    for (const e of this.dirty) this.emit(e);
    this.dirty.clear();
    for (const [el, e] of this.elements) if (e.out instanceof Element && !this.placed(el, e.out)) this.place(el, e);
    if (this.varsDirty || !this.varsNode?.isConnected) this.writeVars();
  }

  private placed(el: Element, out: Element): boolean {
    return out.isConnected && out.previousElementSibling === el;
  }

  private syncElement(el: Element): void {
    let e = this.elements.get(el);
    const sheet = sheetOf(el);
    if (!e) {
      e = { sheet: null, base: undefined, defines: new Set(), len: -1, media: "", disabled: false, names: new Set(), images: new Set(), out: null, css: "" };
      this.elements.set(el, e);
    }
    // A <style>'s relative URLs (and @imports) resolve against the document's base URL.
    e.base = sheet?.href ?? this.doc.baseURI;
    if (this.changed(e, sheet, elementMedia(el)) || this.marked.has(el)) this.emit(e);
    if (!(e.out instanceof Element) || !this.placed(el, e.out)) this.place(el, e);
  }

  private syncAdopted(): void {
    const list = this.root.adoptedStyleSheets;
    const sources = list.filter((s) => !isOwnSheet(s));
    const mirrors = list.filter(isMirror);
    if (sources.length === 0 && this.adopted.size === 0) {
      if (list.length !== mirrors.length) this.root.adoptedStyleSheets = mirrors;
      return;
    }
    const want: CSSStyleSheet[] = [];
    const seen = new Set<CSSStyleSheet>();
    for (const s of sources) {
      seen.add(s);
      let e = this.adopted.get(s);
      if (!e) {
        // Another StyleManager on this root (a second injection) may already have placed an override for `s`: reuse it.
        const next = list[list.indexOf(s) + 1] as OwnSheet | undefined;
        let own = next && isOwnSheet(next) && next[OWN_FOR] === s ? next : null;
        if (!own) {
          own = new CSSStyleSheet({ media: "screen" }) as OwnSheet;
          own[OWN_SHEET] = true;
          own[OWN_FOR] = s;
        }
        e = { sheet: null, base: undefined, defines: new Set(), len: -1, media: "", disabled: false, names: new Set(), images: new Set(), out: own, css: "" };
        this.adopted.set(s, e);
      }
      if (this.changed(e, s, sheetMedia(s))) this.emit(e);
      want.push(s, e.out as CSSStyleSheet);
    }
    for (const [s, e] of this.adopted) {
      if (seen.has(s)) continue;
      this.dirty.delete(e);
      this.adopted.delete(s);
      this.deps.vars.forgetSource(e);
    }
    want.push(...mirrors);
    if (want.length !== list.length || want.some((s, i) => s !== list[i])) this.root.adoptedStyleSheets = want;
  }

  private changed(e: Entry, sheet: CSSStyleSheet | null, media: string): boolean {
    const len = sheet ? this.ruleCount(sheet) : -1;
    const disabled = sheet?.disabled ?? false;
    if (e.sheet === sheet && e.len === len && e.media === media && e.disabled === disabled) return false;
    e.sheet = sheet;
    e.len = len;
    e.media = media;
    e.disabled = disabled;
    return true;
  }

  private ruleCount(sheet: CSSStyleSheet): number {
    try {
      return sheet.cssRules.length;
    } catch {
      const r = sheet.href ? this.remote.get(sheet.href) : undefined;
      return r ? r.cssRules.length : -2;
    }
  }

  private rules(sheet: CSSStyleSheet): CSSRuleList | null {
    try {
      return sheet.cssRules;
    } catch {
      return sheet.href ? this.remoteRules(sheet.href, 0) : null;
    }
  }

  /**
   * Rules of a sheet that can't be read in place (cross-origin), fetched through `fetchText`. While the fetch is
   * pending this returns null and the current entry is re-emitted when the text arrives. Same-origin sheets that
   * @import a cross-origin one reach this through `ctx.importRules` (depth 1).
   */
  private remoteRules(href: string, depth = 1): CSSRuleList | null {
    const r = this.remote.get(href);
    if (r) return r.cssRules;
    if (r === PENDING && this.current) {
      let w = this.waiting.get(href);
      if (!w) this.waiting.set(href, (w = new Set()));
      w.add(this.current);
    }
    if (r === undefined) this.fetchRemote(href, depth);
    return null;
  }

  private fetchRemote(href: string, depth: number): void {
    this.remote.set(href, PENDING);
    if (this.current) this.waiting.set(href, new Set([this.current]));
    const done = (parsed: CSSStyleSheet | null): void => {
      this.remote.set(href, parsed);
      const w = this.waiting.get(href);
      this.waiting.delete(href);
      if (this.running && parsed && w) {
        for (const e of w) this.dirty.add(e);
        // With the pre-paint held for it, written now rather than at the next scheduled batch.
        if (this.settledWaiters.length) this.flush();
        else this.request();
      }
      this.notifySettled();
    };
    void this.resolveText(href, depth, false).then((text) => {
      if (text === null) return done(null);
      try {
        // A detached sheet, never attached to any document: used only to read the rules.
        const parsed = new CSSStyleSheet();
        parsed.replaceSync(text);
        done(parsed);
      } catch {
        done(null);
      }
    }, () => done(null));
  }

  /**
   * Fetches `url` and inlines its `@import`s (wrapped in their layer/supports/media conditions), up to depth 3.
   * Imported text gets its relative url()s made absolute against its own URL (`absolute`); the top-level sheet's are
   * handled by the rewrite's `baseUrl`.
   */
  private async resolveText(url: string, depth: number, absolute: boolean): Promise<string | null> {
    const raw = await this.deps.fetchText(url);
    if (raw === null) return null;
    // Comments are removed first, so a `{` or an @import inside one doesn't confuse the prelude scan.
    let text = stripCssComments(raw);
    if (absolute) text = absolutizeUrls(text, url);
    if (depth >= MAX_IMPORT_DEPTH) return text;
    const brace = text.indexOf("{");
    const head = brace === -1 ? text : text.slice(0, brace);
    // The @import rules are removed from the text itself: once the imported text is inlined before it, they would no
    // longer be at the top of the sheet.
    const body = head.replace(IMPORT, "") + (brace === -1 ? "" : text.slice(brace));
    const parts: Promise<string>[] = [];
    for (const m of head.matchAll(IMPORT)) {
      const wrappers = importWrappers(m[5] ?? "");
      if (!wrappers) continue;
      let abs: string;
      try {
        abs = new URL((m[2] ?? m[4] ?? "").trim(), url).href;
      } catch {
        continue;
      }
      parts.push(this.resolveText(abs, depth + 1, true).then((t) => (t === null ? "" : wrappers.reduceRight((inner, w) => `${w}{${inner}}`, t))));
    }
    if (parts.length === 0) return body;
    return (await Promise.all(parts)).join("") + body;
  }

  private emit(e: Entry): void {
    const sheet = e.sheet;
    let css: string;
    e.names.clear();
    e.defines.clear();
    e.images.clear();
    this.current = e;
    try {
      const rules = sheet && !e.disabled && !printOnly(e.media) ? this.rules(sheet) : null;
      const out: string[] = [];
      // The sheet's old definitions are replaced by the ones this pass reports (also when it now has none).
      this.deps.vars.replaceSource(e, () => {
        if (!rules) return;
        this.collecting = e.names;
        try {
          rewriteRuleList(rules, e.base ? { ...this.ctx, baseUrl: e.base } : this.ctx, out);
        } finally {
          this.collecting = null;
        }
      });
      // Redefinitions go into the sheet's own override, so they keep its cascade position.
      css = this.deps.vars.sheetDefinitionsCss(e, this.ctx.palette) + out.join("");
      if (css && e.media) css = `@media ${e.media}{${css}}`;
    } finally {
      this.current = null;
    }
    this.varsDirty = true;
    if (css === e.css && e.out) return;
    e.css = css;
    if (e.out instanceof Element) {
      if (e.out.textContent !== css) e.out.textContent = css;
    } else if (e.out) {
      e.out.replaceSync(css);
    }
  }

  private create(kind: "sheet" | "vars", ns: string | null): Element {
    const n = markOwn(this.doc.createElementNS(ns ?? "http://www.w3.org/1999/xhtml", "style"));
    n.setAttribute("data-dusk", kind);
    n.setAttribute("media", "screen");
    return n;
  }

  private place(el: Element, e: Entry): void {
    if (!(e.out instanceof Element)) {
      const next = el.nextElementSibling;
      // Reuses a node of a second injection (same world, same mark), never one the page made to look like it.
      e.out = next && next.localName === "style" && next.getAttribute("data-dusk") === "sheet" && isOwnNode(next) && !this.claimed.has(next) ? next : this.create("sheet", el.namespaceURI);
      this.claimed.add(e.out);
    }
    if (!this.placed(el, e.out)) el.after(e.out);
    if (e.out.textContent !== e.css) e.out.textContent = e.css;
  }

  private removeOut(e: Entry): void {
    if (!(e.out instanceof Element)) return;
    this.claimed.delete(e.out);
    this.selfRemoved.add(e.out);
    e.out.remove();
  }

  private writeVars(): void {
    this.varsDirty = false;
    const parent = this.root.nodeType === 9 ? (this.doc.head ?? this.doc.documentElement) : this.root;
    if (!parent) {
      this.varsDirty = true;
      return;
    }
    if (!this.varsNode || this.varsNode.getRootNode() !== this.root) {
      this.varsNode = [...this.root.querySelectorAll('style[data-dusk="vars"]')].find(isOwnNode) ?? this.create("vars", null);
    }
    if (!this.varsNode.isConnected) parent.append(this.varsNode);
    const css = this.deps.vars.definitionsCss(this.ctx.palette);
    if (this.varsNode.textContent !== css) this.varsNode.textContent = css;
  }
}
