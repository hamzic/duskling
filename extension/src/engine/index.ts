// The engine orchestrator: resolves the mode, runs native-dark detection in parallel with
// theming, wires every engine part together and tears all of it down again.
import { isOwnNode, markOwn } from "./css/own";
import { PALETTES } from "./color/palettes";
import type { Palette } from "./color/palettes";
import type { RewriteCtx } from "./css/declarations";
import { mirrorBlockedStyles } from "./css/csp";
import type { StyleMirror } from "./css/csp";
import { InlineStyler, inlineOverrideOwner, originalInlineBackground } from "./css/inline";
import { applyRootStyles, themeSpecialFrames } from "./css/root";
import { OWN_SHEET, StyleManager } from "./css/style-manager";
import { VariableRegistry } from "./css/variables";
import {
  applyClassThemeToggle,
  collectDarkSchemeRules,
  declaredScheme,
  findClassThemeToggle,
  hasRootDarkTheme,
  pageSheets,
  promote,
  sampleBackground,
  suspendOwnSheets,
} from "./detect/native-dark";
import type { NativeVerdict } from "./detect/native-dark";
import { ImageStyler, dimImagesCss, idle } from "./media/images";
import { FILTER_TINT, applyFilterMode } from "./modes/filter";
import { ContrastRepair } from "./repair/contrast-repair";
import type { FetchResult, PageStatus } from "../shared/messages";
import { normalizeHost } from "../shared/rules";
import { effectiveMode } from "../shared/site-defaults";
import type { SiteDefault } from "../shared/site-defaults";
import type { EffectiveRule, Mode } from "../shared/types";

export { applyFilterMode } from "./modes/filter";

export interface EngineBridge {
  setPromotion(on: boolean): void;
  /** Switches the bridge's contrast-repair pass inside closed shadow roots, which the engine can't reach. */
  setClosedRepair?(on: boolean): void;
  onSheetChange(cb: (root: Document | ShadowRoot) => void): void;
  onShadowAttached(cb: (host: Element) => void): void;
}

export interface EngineDeps {
  doc: Document;
  win: Window;
  rule: EffectiveRule;
  siteDefault: SiteDefault;
  fetchResource: (url: string, as: "text" | "blob") => Promise<FetchResult>;
  bridge: EngineBridge;
  /** Batches DOM work; default requestAnimationFrame. */
  schedule?: (fn: () => void) => void;
}

export interface Engine {
  start(): Promise<PageStatus>;
  update(rule: EffectiveRule): Promise<PageStatus>;
  stop(): void;
  status(): PageStatus;
}

type Root = Document | ShadowRoot;
interface RootParts { sm: StyleManager; inline: InlineStyler; mo: MutationObserver; mirror: StyleMirror | null }
interface Theming {
  mode: Mode;
  vars: VariableRegistry;
  roots: Map<Root, RootParts>;
  images: ImageStyler | null;
  repair: ContrastRepair | null;
  stopRoot: () => void;
  stopFrames: () => void;
  children: Set<Engine>;
}

// Transitions are switched off while sampling: a `transition: background-color` would otherwise make the computed value
// read right after suspending still report Duskling's color (CSS Transitions 1 §3, the after-change style starts a transition
// from the before-change value; https://drafts.csswg.org/css-transitions-1/#starting).
const NO_TRANSITIONS = "*,*::before,*::after{transition:none!important}";
const DARK_QUERY = "(prefers-color-scheme: dark)";
const NOOP_BRIDGE: EngineBridge = { setPromotion() {}, onSheetChange() {}, onShadowAttached() {} };

/**
 * On the Document: which promotion signals are ruled out for the page's lifetime (a light verdict, or the page removed the
 * marker). A `Symbol.for` key, so a second content.js instance in the same world (re-registration) shares it.
 */
const RULED_OUT = Symbol.for("dusk.promotion.ruledOut");
/** Longest the pre-paint waits for cross-origin sheets pending at DOMContentLoaded. */
const READY_HOLD_MS = 1000;
interface RuledOut { media: boolean; toggle: boolean }

const modeOf = (rule: EffectiveRule, d: SiteDefault): Mode => (rule.enabled ? effectiveMode(rule, d) : "off");

function mark(win: Window, name: string): void {
  try {
    win.performance?.mark?.(name);
  } catch {
    // performance.mark can throw in exotic frames; marks are diagnostics only.
  }
}

/**
 * Creates the engine for one document. `start()` resolves once `html[data-dusk-ready]` is set, which happens after the
 * first pass over the sheets present at DOMContentLoaded (immediately when that's already past). Native-dark sampling
 * runs at DOMContentLoaded and at `load`; a dark verdict replaces theming with the site's own theme (root additions and
 * contrast repair only), a light one reverts any promotion. `stop()` restores the document exactly, except that
 * `data-dusk-ready` stays set so the pre-paint CSS stays off.
 *
 * The bridge offers no unsubscribe, so its callbacks are registered once per engine and do nothing while not theming.
 */
export function createEngine(deps: EngineDeps): Engine {
  const { doc, win, siteDefault, bridge } = deps;
  const schedule = deps.schedule ?? ((fn: () => void) => void win.requestAnimationFrame(() => fn()));
  let rule = deps.rule;
  let palette: Palette = PALETTES[rule.theme];
  let running = false;
  let gen = 0;
  let subscribed = false;
  let theming: Theming | null = null;
  let native: { stopRoot: () => void; repair: ContrastRepair } | null = null;
  let filter: { stopFilter: () => void; stopRoot: () => void; images: ImageStyler } | null = null;
  let promoted: (() => void) | null = null;
  /** The document's CSP mirror (css/csp.ts), from start to stop in every mode but off; shadow roots get their own. */
  let mirror: StyleMirror | null = null;
  /** The "Dim images" node, present while running in Full or Gentle, themed or native dark alike. */
  let dim: Element | null = null;
  let toggle: (() => void) | null = null;
  /** Signals 3 and 4 ruled out for this page's lifetime, surviving restarts (mode changes) of this engine. */
  const ruledOut = ((doc as unknown as Record<symbol, RuledOut>)[RULED_OUT] ??= { media: false, toggle: false });
  let promoAllowed = false;
  let respect = true;
  /** The user's "use" rule: a declared dark scheme counts even when it samples light. */
  let trust = false;
  let onLoad: (() => void) | null = null;
  let onReady: (() => void) | null = null;
  /** Resolves a start() still waiting for DOMContentLoaded (stop() before it). */
  let wake: (() => void) | null = null;
  const host = ((): string | null => {
    try {
      return normalizeHost(win.location.hostname);
    } catch {
      return null;
    }
  })();
  let status: PageStatus = { host, mode: modeOf(rule, siteDefault), theme: rule.theme, nativeDark: "none", active: false };

  const setReady = (): void => {
    if (!doc.documentElement.hasAttribute("data-dusk-ready")) doc.documentElement.setAttribute("data-dusk-ready", "");
    mark(win, "dusk:themed");
  };

  const fetchText = async (url: string): Promise<string | null> => {
    const r = await deps.fetchResource(url, "text");
    return r.ok && typeof r.text === "string" ? r.text : null;
  };
  const fetchBlobUrl = async (url: string): Promise<{ dataUrl: string; corsOk: boolean } | null> => {
    const r = await deps.fetchResource(url, "blob");
    // `corsOk` comes from the background fetch; missing means false (images.ts FetchedImage).
    return r.ok && r.dataUrl ? { dataUrl: r.dataUrl, corsOk: (r as { corsOk?: boolean }).corsOk === true } : null;
  };

  // ---- theming (full / gentle) ----

  function findShadows(t: Theming, n: Node): void {
    if (n.nodeType !== 1 && n.nodeType !== 9 && n.nodeType !== 11) return;
    const el = n as Element;
    if (n.nodeType === 1 && el.shadowRoot) addRoot(t, el.shadowRoot);
    // Hosts inserted with their subtree (detached hosts, declarative shadow DOM) never fire dusk:shadow-attached here.
    for (const d of (n as ParentNode).querySelectorAll("*")) if (d.shadowRoot) addRoot(t, d.shadowRoot);
  }

  function addRoot(t: Theming, root: Root, inline?: InlineStyler): void {
    if (t.roots.has(root)) return;
    const ctx = (): RewriteCtx => {
      const c: RewriteCtx = { palette, mode: t.mode, varRef: (v, r) => t.vars.varRef(v, r) };
      if (t.images) c.imageUrl = t.images.imageUrl;
      return c;
    };
    const il = inline ?? new InlineStyler(root, ctx(), { vars: t.vars, schedule });
    const sm = new StyleManager(root, { ctx: ctx(), vars: t.vars, fetchText, schedule });
    const mo = new MutationObserver((records) => {
      for (const r of records) for (const n of r.addedNodes) findShadows(t, n);
    });
    t.roots.set(root, { sm, inline: il, mo, mirror: root === doc ? null : mirrorBlockedStyles(root, win) });
    sm.start();
    il.start();
    mo.observe(root, { childList: true, subtree: true });
    findShadows(t, root);
  }

  function startTheming(mode: Mode): void {
    const full = mode === "full";
    const vars = new VariableRegistry(palette);
    const t: Theming = {
      mode,
      vars,
      roots: new Map(),
      images: null,
      repair: null,
      stopRoot: () => {},
      stopFrames: () => {},
      children: new Set(),
    };
    theming = t;
    // The styler keeps this object by reference, so the image lookup can be added once the image styler exists.
    const docCtx: RewriteCtx = { palette, mode, varRef: (v, r) => vars.varRef(v, r) };
    const docInline = new InlineStyler(doc, docCtx, { vars, schedule });
    if (full) {
      // Started before the style managers: imageUrl only queues unknown URLs while the styler runs (images.ts).
      t.images = new ImageStyler(doc, {
        fetchBlobUrl,
        schedule: idle,
        palette,
        dimImages: false,
        inline: docInline,
        onImagesReady: (urls) => {
          for (const p of t.roots.values()) {
            p.sm.imagesReady(urls);
            p.inline.imagesReady();
          }
        },
      });
      t.images.start();
      docCtx.imageUrl = t.images.imageUrl;
    }
    addRoot(t, doc, docInline);
    t.stopRoot = applyRootStyles(doc, palette, { nativeDark: false });
    t.stopFrames = themeSpecialFrames(doc, (child) => {
      const view = child.defaultView;
      if (!view) return () => {};
      const e = createEngine({ ...deps, doc: child, win: view, rule, bridge: NOOP_BRIDGE });
      t.children.add(e);
      void e.start();
      return () => {
        t.children.delete(e);
        e.stop();
      };
    });
    if (full) {
      t.repair = new ContrastRepair(doc, palette, {
        idle,
        isEngineStyled: (el) => inlineOverrideOwner(el, "background-color") === "" || inlineOverrideOwner(el, "background") === "",
      });
      t.repair.start();
      bridge.setClosedRepair?.(true);
    }
  }

  function stopTheming(): void {
    const t = theming;
    if (!t) return;
    theming = null;
    if (t.repair) bridge.setClosedRepair?.(false);
    t.repair?.stop();
    t.images?.stop();
    for (const p of t.roots.values()) {
      p.mo.disconnect();
      p.inline.stop();
      p.sm.stop();
      p.mirror?.stop();
    }
    t.roots.clear();
    t.stopFrames();
    t.stopRoot();
  }

  function rescanAll(): void {
    if (theming) for (const p of theming.roots.values()) p.sm.rescan();
  }

  // ---- dim images ----

  /**
   * Inserts or rewrites the dim node. Always present (empty when off) while running, so toggling dimImages rewrites one
   * node. It outlives a switch from theming to the page's own dark theme: dimming is about the photos, not the palette.
   */
  function applyDim(): void {
    const css = rule.dimImages ? dimImagesCss : "";
    if (!dim) {
      dim = markOwn(doc.createElement("style"));
      dim.setAttribute("data-dusk", "dim");
      dim.setAttribute("media", "screen");
    }
    if (dim.textContent !== css) dim.textContent = css;
    if (!dim.isConnected) (doc.head ?? doc.documentElement).append(dim);
  }

  // ---- native dark ----

  function startNative(): void {
    const repair = new ContrastRepair(doc, palette, { idle, isEngineStyled: () => false });
    native = { stopRoot: applyRootStyles(doc, palette, { nativeDark: true }), repair };
    repair.start();
    bridge.setClosedRepair?.(true);
    status.nativeDark = "used";
  }

  function stopNative(): void {
    if (!native) return;
    bridge.setClosedRepair?.(false);
    native.repair.stop();
    native.stopRoot();
    native = null;
  }

  function revertMedia(): void {
    promoted?.();
    promoted = null;
  }

  function revertToggle(): void {
    toggle?.();
    toggle = null;
  }

  function revertPromotions(): void {
    revertToggle();
    revertMedia();
  }

  const promoSheets = (): CSSStyleSheet[] => pageSheets(doc);
  const canPromote = (): boolean => promoAllowed && !win.matchMedia?.(DARK_QUERY).matches;

  /** Signal 4: applies the class/attribute toggle when one has enough rules; true when applied. */
  function tryToggle(): boolean {
    if (!canPromote() || ruledOut.toggle || promoted || toggle) return false;
    const t = findClassThemeToggle(promoSheets());
    if (t) toggle = applyClassThemeToggle(doc, t, onToggleRemoved);
    return !!toggle;
  }

  /**
   * Signals 3 and 4: promote the media-query dark theme, else the class/attribute toggle, as soon as candidate rules
   * exist. Skipped once ruled out, while one is applied, and when the system is already dark (the page's own dark media
   * rules then apply by themselves). This reads the isolated world's matchMedia, which the MAIN-world bridge doesn't patch.
   */
  function tryPromote(): void {
    if (!canPromote()) return;
    if (!promoted && !ruledOut.media) {
      const css = collectDarkSchemeRules(promoSheets());
      if (hasRootDarkTheme(css, doc)) {
        // Signal 3 comes first: a toggle applied before this sheet arrived gives way (detection only runs until a
        // verdict, so a toggle that already decided dark is never replaced).
        revertToggle();
        const before = new Set(doc.querySelectorAll('style[data-dusk="native"]'));
        void promote(doc, css, bridge);
        // promote() inserts its node and switches the bridge on synchronously. Its teardown arrives a microtask later
        // and could then switch off a newer promotion, so it is not used: this synchronous one does the same.
        const node = [...doc.querySelectorAll('style[data-dusk="native"]')].find((n) => !before.has(n)) ?? null;
        const stopWatch = watchPromotion(node);
        promoted = () => {
          stopWatch();
          node?.remove();
          bridge.setPromotion(false);
        };
        return;
      }
    }
    tryToggle();
  }

  /** Re-collects the promoted dark rules on the next scheduled frame; set by watchPromotion while a promotion is applied. */
  let refreshPromotion: (() => void) | null = null;

  /**
   * Keeps a media promotion complete: CSS that arrives later (an SPA chunk, a `<link>` that finishes loading, CSS-in-JS
   * through the CSSOM, which the bridge reports) can carry its own dark block, so the promoted node is rewritten from all
   * sheets again. Duskling's own nodes are ignored.
   */
  function watchPromotion(node: Element | null): () => void {
    if (!node) return () => {};
    let queued = false;
    const refresh = (): void => {
      if (queued) return;
      queued = true;
      schedule(() => {
        queued = false;
        if (refreshPromotion !== refresh) return;
        const css = collectDarkSchemeRules(promoSheets());
        if (node.textContent !== css) node.textContent = css;
        // Same specificity, so the later sheet wins (CSS Cascade 5 §6.1, order of appearance): the promoted node moves
        // after a page sheet inserted behind it, or that sheet's light rules beat their own dark block.
        const after = [...doc.querySelectorAll("style,link")].some((n) => isPageStyle(n) && node.compareDocumentPosition(n) & 4);
        if (after) (doc.head ?? doc.documentElement).append(node);
      });
    };
    const isPageStyle = (n: Node | null): boolean =>
      !!n && n.nodeType === 1 && /^(style|link)$/i.test(n.nodeName) && !(n as Element).hasAttribute("data-dusk");
    const mo = new MutationObserver((records) => {
      for (const r of records)
        if (isPageStyle(r.target) || isPageStyle(r.target.parentNode) || [...r.addedNodes, ...r.removedNodes].some(isPageStyle)) return refresh();
    });
    mo.observe(doc, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["media", "disabled", "href"] });
    const onLinkLoad = (e: Event): void => {
      if (isPageStyle(e.target as Node)) refresh();
    };
    doc.addEventListener("load", onLinkLoad, true);
    refreshPromotion = refresh;
    return () => {
      mo.disconnect();
      doc.removeEventListener("load", onLinkLoad, true);
      if (refreshPromotion === refresh) refreshPromotion = null;
    };
  }

  /** The page's own script removed the toggled marker: don't fight it, fall back to theming for the page's lifetime. */
  function onToggleRemoved(): void {
    toggle = null;
    ruledOut.toggle = true;
    if (promoAllowed) bridge.setPromotion(false);
    if (!running || !native) return;
    stopNative();
    status.nativeDark = "none";
    startTheming(status.mode);
  }

  function sample(): NativeVerdict {
    const roots = (): Root[] => [doc, ...(theming ? [...theming.roots.keys()].filter((r) => r !== doc) : [])];
    // A frame document can lack parts of the API surface (or throw on access); no verdict then, never a broken start.
    try {
      return sampleNow(roots);
    } catch {
      return "unknown";
    }
  }

  function sampleNow(roots: () => Root[]): NativeVerdict {
    return sampleBackground(doc, win, {
      originalBackground: originalInlineBackground,
      suspend: () => {
        // A node inserted in this task (the promoted theme) gets its mirror only when the observer's records arrive.
        mirror?.sync();
        for (const p of theming?.roots.values() ?? []) p.mirror?.sync();
        const list = roots();
        const resumes = list.map((r) => suspendOwnSheets(r));
        // Constructed in the document's own realm: adopting a sheet from another realm throws (CSSOM §6.1.2,
        // https://drafts.csswg.org/cssom/#dom-documentorshadowroot-adoptedstylesheets), and frames get their own engine.
        const noTransitions = new (win as Window & typeof globalThis).CSSStyleSheet({ media: "screen" });
        noTransitions.replaceSync(NO_TRANSITIONS);
        (noTransitions as unknown as Record<symbol, boolean>)[OWN_SHEET] = true;
        for (const r of list) r.adoptedStyleSheets = [...r.adoptedStyleSheets, noTransitions];
        return () => {
          for (const resume of resumes) resume();
          // Recompute styles with Duskling's sheets back but transitions still off, so restoring starts no transition either.
          void win.getComputedStyle(doc.documentElement).backgroundColor;
          for (const r of list) r.adoptedStyleSheets = r.adoptedStyleSheets.filter((s) => s !== noTransitions);
        };
      },
    });
  }

  /** Sampling at DOMContentLoaded (`final` false) and at load (`final` true). */
  /**
   * Sets ready once every cross-origin sheet being fetched is rewritten, at most READY_HOLD_MS later. Such a sheet already
   * applies to the page, so releasing the pre-paint before its rewrite showed a light frame between pages.
   */
  function readyAfterRemote(): void {
    const t = theming;
    if (!t) return setReady();
    const timer = win.setTimeout(setReady, READY_HOLD_MS);
    void Promise.all([...t.roots.values()].map((p) => p.sm.whenRemoteSettled())).then(() => {
      win.clearTimeout(timer);
      setReady();
    });
  }

  function useNativeNow(): void {
    stopTheming();
    startNative();
  }

  /**
   * Sampling at DOMContentLoaded (`final` false) and at load (`final` true), in signal order: the declared scheme (the
   * head may not have been parsed at document start), then media-query promotion; when that samples light it is
   * reverted and the class/attribute toggle is tried and sampled in the same task. Only a light verdict (or no verdict
   * by load) rules promotion out.
   */
  function detect(final: boolean): void {
    if (!running || !theming) return;
    // While a promotion is applied, a dark declared scheme can be the promoted theme's own (`html.dark{color-scheme:dark}`),
    // which reverting would undo; sampling decides then.
    const declared = !promoted && !toggle && declaredScheme(doc) === "dark";
    if (declared && (trust || sample() !== "light")) {
      if (!respect) status.nativeDark = "ignored";
      else {
        revertPromotions();
        useNativeNow();
      }
      return;
    }
    if (declared && respect) status.nativeDark = "overridden";
    tryPromote();
    let v = sample();
    if (v !== "dark" && promoted && (v === "light" || final)) {
      revertMedia();
      ruledOut.media = true;
      if (tryToggle()) v = sample();
    }
    if (v === "dark") {
      if (respect) useNativeNow();
      else status.nativeDark = "ignored";
      return;
    }
    if (v === "light" || final) {
      ruledOut.media = ruledOut.toggle = true;
      revertPromotions();
      if (promoAllowed) bridge.setPromotion(false);
    }
  }

  function subscribe(): void {
    if (subscribed) return;
    subscribed = true;
    bridge.onSheetChange((root) => {
      if (running && root.nodeType === 9) refreshPromotion?.();
      // Gentle mode has no bridge-driven CSSOM tracking.
      if (!running || theming?.mode !== "full") return;
      // A document-targeted change (e.g. adoptedStyleSheets replaced, or a sheet without a known owner) means rescan
      // everything; rescan also re-reads adoptedStyleSheets, whose in-place push/splice no event reports.
      if (root.nodeType === 9) return rescanAll();
      const p = theming.roots.get(root);
      if (p) p.sm.rescan();
      else addRoot(theming, root);
    });
    bridge.onShadowAttached((h) => {
      if (running && theming && h.shadowRoot) addRoot(theming, h.shadowRoot);
    });
  }

  function clearListeners(): void {
    if (onReady) doc.removeEventListener("DOMContentLoaded", onReady);
    if (onLoad) win.removeEventListener("load", onLoad);
    onReady = onLoad = null;
    wake?.();
    wake = null;
  }

  // ---- public API ----

  async function start(): Promise<PageStatus> {
    await run();
    return { ...status };
  }

  async function run(): Promise<void> {
    if (running) return;
    mark(win, "dusk:start");
    running = true;
    const g = ++gen;
    palette = PALETTES[rule.theme];
    const mode = modeOf(rule, siteDefault);
    status = { host, mode, theme: rule.theme, nativeDark: "none", active: false };
    respect = rule.respectNativeDark;
    trust = respect && rule.trustNativeDark;
    promoAllowed = respect && mode === "full" && !siteDefault.noNativePromotion;
    if (!promoAllowed) bridge.setPromotion(false);
    if (mode === "off") {
      setReady();
      return;
    }
    status.active = true;
    mirror = mirrorBlockedStyles(doc, win);
    if (mode === "filter") {
      // Ready at once: the dark pre-paint background would turn light under the inverting filter.
      // Native-dark detection stays off: Simple is a fallback the user picked for this site. The image classifier runs
      // for <img> markers only, so dark icons are left un-re-inverted and turn light.
      const images = new ImageStyler(doc, { fetchBlobUrl, schedule: idle, palette, markersOnly: true });
      filter = { stopFilter: applyFilterMode(doc), stopRoot: applyRootStyles(doc, palette, { nativeDark: false, metaOnly: FILTER_TINT }), images };
      images.start();
      setReady();
      return;
    }
    applyDim();
    // A declared dark scheme counts only when the page doesn't paint light: a page can declare it and stay white. While
    // the document loads the body isn't painted, so sampling sees only the dark canvas the declaration gives and can't
    // rule a light page out: going native then set ready and showed the light page until DOMContentLoaded. So the page
    // is themed meanwhile and detect() decides at DOMContentLoaded; only the user's "use" rule decides now.
    const declared = declaredScheme(doc) === "dark";
    const settled = trust || doc.readyState !== "loading";
    if (declared && settled && (trust || sample() !== "light")) {
      if (respect) {
        startNative();
        setReady();
        return;
      }
      status.nativeDark = "ignored";
    } else if (declared && settled && respect) status.nativeDark = "overridden";
    // Signal 1 (dark-state markers) counts only when sampling agrees, and a dark sampling verdict is decisive by
    // itself, so markers are not evaluated separately.
    subscribe();
    startTheming(mode);
    tryPromote();
    if (doc.readyState === "loading") {
      await new Promise<void>((resolve) => {
        wake = resolve;
        onReady = () => {
          onReady = wake = null;
          resolve();
        };
        doc.addEventListener("DOMContentLoaded", onReady, { once: true });
      });
      if (g !== gen) return;
    }
    rescanAll();
    const complete = doc.readyState === "complete";
    detect(complete);
    readyAfterRemote();
    if (!complete) {
      onLoad = () => {
        onLoad = null;
        if (g !== gen) return;
        rescanAll();
        detect(true);
      };
      win.addEventListener("load", onLoad, { once: true });
    }
    return;
  }

  function stop(): void {
    if (!running) return;
    running = false;
    gen++;
    clearListeners();
    stopTheming();
    stopNative();
    dim?.remove();
    dim = null;
    revertPromotions();
    if (promoAllowed) bridge.setPromotion(false);
    if (filter) {
      filter.images.stop();
      filter.stopFilter();
      filter.stopRoot();
      filter = null;
    }
    // The pre-paint JS twin's node is inert once data-dusk-ready is set; it goes too.
    for (const n of doc.querySelectorAll('style[data-dusk="prepaint"]')) if (isOwnNode(n)) n.remove();
    mirror?.stop();
    mirror = null;
    status = { ...status, nativeDark: "none", active: false };
  }

  /** A theme or dimImages change is applied in place to the nodes already in the document; anything else restarts. */
  function retheme(): void {
    palette = PALETTES[rule.theme];
    const t = theming;
    if (t) {
      t.vars.setPalette(palette);
      for (const p of t.roots.values()) {
        p.inline.setPalette(palette);
        p.sm.setPalette(palette);
      }
      t.images?.setPalette(palette);
      t.repair?.setPalette(palette);
      t.stopRoot = applyRootStyles(doc, palette, { nativeDark: false });
      for (const c of t.children) void c.update(rule);
    }
    if (native) {
      native.stopRoot = applyRootStyles(doc, palette, { nativeDark: true });
      native.repair.setPalette(palette);
    }
    if (dim) applyDim();
  }

  async function update(next: EffectiveRule): Promise<PageStatus> {
    const prev = rule;
    rule = next;
    if (!running) return { ...status };
    if (modeOf(prev, siteDefault) !== modeOf(next, siteDefault) || prev.respectNativeDark !== next.respectNativeDark || prev.trustNativeDark !== next.trustNativeDark) {
      stop();
      return start();
    }
    if (prev.theme !== next.theme || prev.dimImages !== next.dimImages) retheme();
    status = { ...status, theme: next.theme };
    return { ...status };
  }

  return { start, update, stop, status: () => ({ ...status }) };
}
