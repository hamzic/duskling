import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PALETTES } from "../../src/engine/color/palettes";
import { paletteCss } from "../../src/engine/color/transform";
import { applyFilterMode, createEngine } from "../../src/engine/index";
import type { Engine, EngineDeps } from "../../src/engine/index";
import type { SiteDefault } from "../../src/shared/site-defaults";
import type { EffectiveRule } from "../../src/shared/types";

const RICH = readFileSync(resolve(__dirname, "../fixtures/pages/teardown-rich.html"), "utf8");
const tick = () => new Promise((r) => setTimeout(r, 0));

const baseRule = (over: Partial<EffectiveRule> = {}): EffectiveRule => ({
  enabled: true,
  mode: "full",
  modeIsExplicit: false,
  theme: "dark",
  respectNativeDark: true,
  trustNativeDark: false,
  dimImages: false,
  matchedHost: null,
  ...over,
});

interface Harness { engine: Engine; promotion: boolean[]; closedRepair: boolean[]; sheetCbs: ((r: Document | ShadowRoot) => void)[] }

let engines: Engine[] = [];
function make(rule: EffectiveRule = baseRule(), siteDefault: SiteDefault = {}, over: Partial<EngineDeps> = {}): Harness {
  const promotion: boolean[] = [];
  const closedRepair: boolean[] = [];
  const sheetCbs: ((r: Document | ShadowRoot) => void)[] = [];
  const engine = createEngine({
    doc: document,
    win: window,
    rule,
    siteDefault,
    fetchResource: async () => ({ ok: false }),
    bridge: {
      setPromotion: (on) => promotion.push(on),
      setClosedRepair: (on) => closedRepair.push(on),
      onSheetChange: (cb) => sheetCbs.push(cb),
      onShadowAttached: () => {},
    },
    schedule: (fn) => fn(),
    ...over,
  });
  engines.push(engine);
  return { engine, promotion, closedRepair, sheetCbs };
}

/**
 * happy-dom has no layout: every sample point sees body over html (the canvas). It also ignores StyleSheet.disabled in the
 * cascade (native-dark.test.ts), so while `html[data-dusk-sampling]` is set, computed styles are read with disabled sheets
 * taken out the way happy-dom honors (detached / un-adopted) and put back right after. The real suspension is exercised
 * in WebKit by test/unit-webkit/engine.spec.ts.
 */
function stubSampling(): void {
  (document as unknown as { elementsFromPoint: unknown }).elementsFromPoint = () => [document.body, document.documentElement];
  const real = window.getComputedStyle.bind(window);
  vi.spyOn(window, "getComputedStyle").mockImplementation((el: Element, pseudo?: string | null) => {
    if (!document.documentElement.hasAttribute("data-dusk-sampling")) return real(el, pseudo);
    const roots: (Document | ShadowRoot)[] = [document, ...[...document.querySelectorAll("*")].flatMap((e) => (e.shadowRoot ? [e.shadowRoot] : []))];
    const moved: [Element, Node, Node | null][] = [];
    const adopted: [Document | ShadowRoot, CSSStyleSheet[]][] = [];
    for (const r of roots) {
      // Re-inserting a <style> gives it a fresh, enabled sheet in happy-dom, so the suspended set is matched by the
      // attribute suspendOwnSheets uses rather than by `sheet.disabled`.
      for (const s of r.querySelectorAll('style[data-dusk]:not([data-dusk="native"]), link[data-dusk]')) moved.push([s, s.parentNode as Node, s.nextSibling]);
      if (r.adoptedStyleSheets.some((s) => s.disabled)) {
        adopted.push([r, r.adoptedStyleSheets]);
        r.adoptedStyleSheets = r.adoptedStyleSheets.filter((s) => !s.disabled);
      }
    }
    for (const [s] of moved) s.remove();
    const cs = real(el, pseudo);
    const snap = { backgroundColor: cs.backgroundColor, scheme: cs.getPropertyValue("color-scheme") };
    for (const [s, parent, next] of moved.reverse()) parent.insertBefore(s, next);
    for (const [r, list] of adopted) r.adoptedStyleSheets = list;
    return { backgroundColor: snap.backgroundColor, getPropertyValue: (p: string) => (p === "color-scheme" ? snap.scheme : "") } as unknown as CSSStyleDeclaration;
  });
}

function setPage(html: string): void {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const root = document.documentElement;
  for (const a of [...root.attributes]) root.removeAttribute(a.name);
  for (const a of doc.documentElement.attributes) root.setAttribute(a.name, a.value);
  document.head.innerHTML = doc.head.innerHTML;
  document.body.innerHTML = doc.body.innerHTML;
  for (const a of [...document.body.attributes]) document.body.removeAttribute(a.name);
  for (const a of doc.body.attributes) document.body.setAttribute(a.name, a.value);
}

const dusk = () => document.querySelectorAll("[data-dusk]");
const overrides = () => document.querySelectorAll('style[data-dusk="sheet"]');
const snapshot = () => {
  const clone = document.documentElement.cloneNode(true) as Element;
  clone.removeAttribute("data-dusk-ready");
  return clone.outerHTML;
};

beforeEach(() => {
  // A new page load starts with nothing ruled out; the tests reuse one Document.
  delete (document as unknown as Record<symbol, unknown>)[Symbol.for("dusk.promotion.ruledOut")];
  setPage("<!doctype html><html><head></head><body></body></html>");
  document.adoptedStyleSheets = [];
  stubSampling();
});

afterEach(() => {
  for (const e of engines) e.stop();
  engines = [];
  vi.restoreAllMocks();
});

describe("createEngine", () => {
  it("off: injects nothing and sets ready", async () => {
    setPage('<html><head><style>body{background:#fff;color:#000}</style></head><body><p style="color:#333">x</p></body></html>');
    const before = snapshot();
    const { engine, promotion } = make(baseRule({ mode: "off", modeIsExplicit: true }));
    const st = await engine.start();
    expect(st).toMatchObject({ mode: "off", active: false, nativeDark: "none" });
    expect(dusk()).toHaveLength(0);
    expect(document.documentElement.hasAttribute("data-dusk-ready")).toBe(true);
    expect(snapshot()).toBe(before);
    expect(promotion).toEqual([false]);
  });

  it("disabled behaves like off", async () => {
    const { engine } = make(baseRule({ enabled: false }));
    expect((await engine.start()).mode).toBe("off");
    expect(dusk()).toHaveLength(0);
  });

  it("full: overrides, vars, root styles and ready", async () => {
    setPage('<html><head><style>body{background:#fff;color:#000}</style></head><body><p style="color:#333">x</p></body></html>');
    const { engine } = make();
    const st = await engine.start();
    expect(st).toMatchObject({ mode: "full", theme: "dark", active: true, nativeDark: "none" });
    expect(overrides()).toHaveLength(1);
    expect(document.querySelector('style[data-dusk="vars"]')).not.toBeNull();
    expect(document.querySelector('style[data-dusk="root"]')?.textContent).toContain(paletteCss(PALETTES.dark).bg);
    expect(document.querySelector('style[data-dusk="img"]')).not.toBeNull();
    expect((document.querySelector("p") as HTMLElement).style.getPropertyPriority("color")).toBe("important");
    expect(document.documentElement.hasAttribute("data-dusk-ready")).toBe(true);
  });

  it("a declared dark scheme on a page that paints white isn't the site's dark theme: Duskling themes it", async () => {
    setPage('<html><head><meta name="color-scheme" content="dark"><style>html,body{background:#fff;color:#111}</style></head><body><p>x</p></body></html>');
    const { engine } = make();
    const st = await engine.start();
    // "overridden" lets the popup say why the site's own dark theme isn't used.
    expect(st.nativeDark).toBe("overridden");
    expect(overrides().length).toBeGreaterThan(0);
  });

  it("with the site's \"use\" rule the declared dark scheme is followed even though the page paints white", async () => {
    setPage('<html><head><meta name="color-scheme" content="dark"><style>html,body{background:#fff;color:#111}</style></head><body><p>x</p></body></html>');
    const { engine } = make(baseRule({ trustNativeDark: true }));
    const st = await engine.start();
    expect(st.nativeDark).toBe("used");
    expect(overrides()).toHaveLength(0);
  });

  it("switching to the \"use\" rule restarts the engine onto the site's theme", async () => {
    setPage('<html><head><meta name="color-scheme" content="dark"><style>html,body{background:#fff;color:#111}</style></head><body><p>x</p></body></html>');
    const { engine } = make();
    expect((await engine.start()).nativeDark).toBe("overridden");
    const st = await engine.update(baseRule({ trustNativeDark: true }));
    expect(st.nativeDark).toBe("used");
    expect(overrides()).toHaveLength(0);
  });

  it("the same when the declaration is only parsed by DOMContentLoaded", async () => {
    setPage("<html><head></head><body><p>x</p></body></html>");
    const state = vi.spyOn(document, "readyState", "get").mockReturnValue("loading");
    const { engine } = make();
    const p = engine.start();
    await tick();
    const meta = document.createElement("meta");
    meta.name = "color-scheme";
    meta.content = "dark";
    const css = document.createElement("style");
    css.textContent = "html,body{background:#fff;color:#111}";
    document.head.append(meta, css);
    state.mockReturnValue("interactive");
    document.dispatchEvent(new Event("DOMContentLoaded"));
    expect((await p).nativeDark).toBe("overridden");
    expect(overrides().length).toBeGreaterThan(0);
    state.mockRestore();
  });

  // Seen on digi.no in dark mode: dark, then light, then dark: while the document loads the body isn't
  // painted, so sampling sees only the dark canvas a dark declaration gives and can't rule a light page out. Going native
  // then set ready and showed the light page until DOMContentLoaded proved it light.
  it("a dark declaration seen while loading keeps the page themed and the pre-paint on until DOMContentLoaded decides", async () => {
    setPage('<html><head><meta name="color-scheme" content="dark"><style>body{background:#fff;color:#111}</style></head><body></body></html>');
    const body = document.body;
    body.remove(); // not parsed yet: only the canvas shows
    const state = vi.spyOn(document, "readyState", "get").mockReturnValue("loading");
    try {
      const { engine } = make();
      const p = engine.start();
      await tick();
      expect(document.documentElement.hasAttribute("data-dusk-ready")).toBe(false);
      expect(overrides().length).toBeGreaterThan(0);
      document.documentElement.append(body);
      body.innerHTML = "<p>x</p>";
      state.mockReturnValue("interactive");
      document.dispatchEvent(new Event("DOMContentLoaded"));
      expect((await p).nativeDark).toBe("overridden");
      expect(overrides().length).toBeGreaterThan(0);
    } finally {
      if (!body.isConnected) document.documentElement.append(body);
      state.mockRestore();
    }
  });

  it("the same page really dark: the site's theme is used from DOMContentLoaded", async () => {
    setPage('<html><head><meta name="color-scheme" content="dark"><style>html,body{background:#111;color:#eee}</style></head><body><p>x</p></body></html>');
    const state = vi.spyOn(document, "readyState", "get").mockReturnValue("loading");
    const { engine } = make();
    const p = engine.start();
    await tick();
    expect(document.documentElement.hasAttribute("data-dusk-ready")).toBe(false);
    state.mockReturnValue("interactive");
    document.dispatchEvent(new Event("DOMContentLoaded"));
    expect((await p).nativeDark).toBe("used");
    expect(overrides()).toHaveLength(0);
    state.mockRestore();
  });

  it("native dark meta: status used, no theming overrides, root additions only", async () => {
    setPage('<html><head><meta name="color-scheme" content="dark"><style>body{background:#111;color:#eee}</style></head><body><p style="color:#333">x</p></body></html>');
    const { engine } = make();
    const st = await engine.start();
    expect(st.nativeDark).toBe("used");
    expect(overrides()).toHaveLength(0);
    expect(document.querySelector('style[data-dusk="vars"]')).toBeNull();
    expect((document.querySelector("p") as HTMLElement).getAttribute("style")).toBe("color:#333");
    const root = document.querySelector('style[data-dusk="root"]')?.textContent ?? "";
    expect(root).not.toContain("color-scheme");
    expect(root).toContain("--dusk-neutral-bg");
    expect(document.documentElement.hasAttribute("data-dusk-ready")).toBe(true);
  });

  it("a light page whose dark media block only styles .btn: no promotion, sampling says light, Full stays", async () => {
    setPage(
      "<html><head><style>html,body{background:#fff;color:#000}.btn{color:#06c}@media (prefers-color-scheme: dark){.btn{color:#9cf}}</style></head>" +
        '<body><button class="btn">b</button></body></html>',
    );
    const { engine, promotion } = make();
    const st = await engine.start();
    expect(st.nativeDark).toBe("none");
    expect(document.querySelector('style[data-dusk="native"]')).toBeNull();
    expect(overrides()).toHaveLength(1);
    expect(promotion.at(-1)).toBe(false);
    expect(document.documentElement.hasAttribute("data-dusk-sampling")).toBe(false);
  });

  it("a page dark by its own CSS (sampled through Duskling's suspended sheets): theming torn down, status used", async () => {
    setPage("<html><head><style>html,body{background:#121212;color:#ddd}</style></head><body><p>x</p></body></html>");
    const { engine } = make();
    const st = await engine.start();
    expect(st.nativeDark).toBe("used");
    expect(overrides()).toHaveLength(0);
    expect(document.querySelector('style[data-dusk="img"]')).toBeNull();
  });

  it("promotes a media-query dark theme on html and keeps it when the page samples dark", async () => {
    setPage(
      "<html><head><style>html,body{background:#fff;color:#000}@media (prefers-color-scheme: dark){html,body{background:#101010;color:#eee}}</style></head>" +
        "<body><p>x</p></body></html>",
    );
    const { engine, promotion } = make();
    const st = await engine.start();
    expect(st.nativeDark).toBe("used");
    expect(document.querySelector('style[data-dusk="native"]')?.textContent).toContain("#101010");
    expect(promotion).toContain(true);
    expect(overrides()).toHaveLength(0);
    engine.stop();
    expect(document.querySelector('style[data-dusk="native"]')).toBeNull();
    expect(promotion.at(-1)).toBe(false);
  });

  it("stop removes the pre-paint JS twin's node it made, not a page node that looks like it", async () => {
    const twin = document.createElement("style");
    (twin as unknown as Record<symbol, boolean>)[Symbol.for("dusk.own.node")] = true;
    twin.setAttribute("data-dusk", "prepaint");
    const page = document.createElement("style");
    page.setAttribute("data-dusk", "prepaint");
    document.documentElement.append(twin, page);
    const { engine } = make();
    await engine.start();
    engine.stop();
    expect(twin.isConnected).toBe(false);
    expect(page.isConnected).toBe(true);
    page.remove();
  });

  const PROMOTED_PAGE =
    "<html><head><style>html,body{background:#fff;color:#000}@media (prefers-color-scheme: dark){html,body{background:#101010;color:#eee}}</style></head>" +
    "<body><p>x</p></body></html>";
  const nativeText = () => document.querySelector('style[data-dusk="native"]')?.textContent ?? "";

  it("a promoted theme also takes the dark rules of a stylesheet added after the verdict (SPA chunk)", async () => {
    setPage(PROMOTED_PAGE);
    const { engine } = make();
    expect((await engine.start()).nativeDark).toBe("used");
    const late = document.createElement("style");
    late.textContent = ".chunk{background:#f5f5f5}@media (prefers-color-scheme: dark){.chunk{background:#1d1d22}}";
    document.head.append(late);
    await tick();
    expect(nativeText()).toContain("#1d1d22");
    expect(nativeText()).toContain("#101010");
    expect(document.querySelectorAll('style[data-dusk="native"]')).toHaveLength(1);
    // After the late sheet, so its dark block beats its light rules of the same specificity.
    expect(late.compareDocumentPosition(document.querySelector('style[data-dusk="native"]')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("a promoted theme also takes dark rules inserted through the CSSOM (CSS-in-JS), reported by the bridge", async () => {
    setPage(PROMOTED_PAGE);
    const { engine, sheetCbs } = make();
    expect((await engine.start()).nativeDark).toBe("used");
    const sheet = (document.querySelector("style:not([data-dusk])") as HTMLStyleElement).sheet as CSSStyleSheet;
    sheet.insertRule("@media (prefers-color-scheme: dark){.css-in-js{color:#abcdef}}", sheet.cssRules.length);
    for (const cb of sheetCbs) cb(document);
    await tick();
    expect(nativeText()).toContain("#abcdef");
  });

  it("after stop, a late stylesheet brings no promoted node back", async () => {
    setPage(PROMOTED_PAGE);
    const { engine } = make();
    await engine.start();
    engine.stop();
    const late = document.createElement("style");
    late.textContent = "@media (prefers-color-scheme: dark){.chunk{background:#1d1d22}}";
    document.head.append(late);
    await tick();
    expect(document.querySelector('style[data-dusk="native"]')).toBeNull();
  });

  const TOGGLE_RULES = Array.from({ length: 20 }, (_, i) => `html.dark .c${i}{background:#222}`).join("") + "html.dark body{background:#111}";

  it("signal order: a media promotion that samples light is reverted and the class toggle is tried and sampled in the same task", async () => {
    setPage(
      `<html><head><style>html,body{background:#fff}@media (prefers-color-scheme: dark){:root{--x:#000}}${TOGGLE_RULES}</style></head><body></body></html>`,
    );
    const { engine, promotion } = make();
    const st = await engine.start();
    expect(st.nativeDark).toBe("used");
    expect(document.querySelector('style[data-dusk="native"]')).toBeNull();
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(promotion).toEqual([true, false]);
    expect(overrides()).toHaveLength(0);
    engine.stop();
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("a toggle applied early gives way to a media root theme whose sheet arrives before sampling", async () => {
    setPage(`<html><head><style>html,body{background:#fff}${TOGGLE_RULES}</style></head><body></body></html>`);
    const state = vi.spyOn(document, "readyState", "get").mockReturnValue("loading");
    const { engine } = make();
    const p = engine.start();
    await tick();
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    const late = document.createElement("style");
    late.textContent = "@media (prefers-color-scheme: dark){html,body{background:#101010}}";
    document.head.append(late);
    state.mockReturnValue("interactive");
    document.dispatchEvent(new Event("DOMContentLoaded"));
    const st = await p;
    expect(st.nativeDark).toBe("used");
    expect(document.querySelector('style[data-dusk="native"]')?.textContent).toContain("#101010");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    state.mockRestore();
  });

  it("a toggle whose theme declares color-scheme: dark is kept: the declared scheme it causes is no signal 2 verdict", async () => {
    // Sheets are parsed before DOMContentLoaded, so the toggle is applied early; then detection runs.
    setPage(`<html><head><style>html,body{background:#fff}${TOGGLE_RULES}html.dark{color-scheme:dark}</style></head><body></body></html>`);
    const state = vi.spyOn(document, "readyState", "get").mockReturnValue("loading");
    const { engine } = make();
    const p = engine.start();
    await tick();
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    state.mockReturnValue("interactive");
    document.dispatchEvent(new Event("DOMContentLoaded"));
    expect((await p).nativeDark).toBe("used");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    state.mockRestore();
  });

  it("the page removing the toggled class brings theming back and switches the bridge promotion off", async () => {
    setPage(`<html><head><style>html,body{background:#fff}${TOGGLE_RULES}</style></head><body><p style="color:#333">x</p></body></html>`);
    const { engine, promotion } = make();
    expect((await engine.start()).nativeDark).toBe("used");
    expect(overrides()).toHaveLength(0);
    document.documentElement.classList.remove("dark");
    await tick();
    expect(engine.status().nativeDark).toBe("none");
    expect(overrides()).toHaveLength(1);
    expect(promotion.at(-1)).toBe(false);
  });

  it("a ruled-out promotion stays ruled out for the page's lifetime across a restart", async () => {
    setPage(
      "<html><head><style>html,body{background:#fff}@media (prefers-color-scheme: dark){:root{--x:#000}}</style></head><body></body></html>",
    );
    const { engine, promotion } = make();
    await engine.start();
    expect(promotion[0]).toBe(true);
    expect(promotion.at(-1)).toBe(false);
    await engine.update(baseRule({ mode: "gentle", modeIsExplicit: true }));
    await engine.update(baseRule({ mode: "full", modeIsExplicit: true }));
    expect(promotion.filter((x) => x)).toHaveLength(1);
    expect(document.querySelector('style[data-dusk="native"]')).toBeNull();
  });

  it("a color-scheme meta parsed after document start is honored at DOMContentLoaded", async () => {
    const state = vi.spyOn(document, "readyState", "get").mockReturnValue("loading");
    const { engine } = make();
    const p = engine.start();
    await tick();
    expect(overrides().length + document.querySelectorAll('style[data-dusk="vars"]').length).toBeGreaterThan(0);
    const meta = document.createElement("meta");
    meta.setAttribute("name", "color-scheme");
    meta.setAttribute("content", "dark");
    document.head.append(meta);
    state.mockReturnValue("interactive");
    document.dispatchEvent(new Event("DOMContentLoaded"));
    expect((await p).nativeDark).toBe("used");
    expect(document.querySelector('style[data-dusk="vars"]')).toBeNull();
    state.mockRestore();
  });

  it("start and update return copies of the status", async () => {
    const { engine } = make();
    const st = await engine.start();
    st.theme = "midnight";
    expect(engine.status().theme).toBe("dark");
    const up = await engine.update(baseRule({ theme: "dim" }));
    up.active = false;
    expect(engine.status().active).toBe(true);
  });

  it("siteDefault.noNativePromotion skips promotion and switches the bridge promotion off", async () => {
    setPage(
      "<html><head><style>html,body{background:#fff}@media (prefers-color-scheme: dark){html,body{background:#101010}}</style></head><body></body></html>",
    );
    const { engine, promotion } = make(baseRule(), { noNativePromotion: true });
    const st = await engine.start();
    expect(st.nativeDark).toBe("none");
    expect(document.querySelector('style[data-dusk="native"]')).toBeNull();
    expect(promotion).toEqual([false]);
  });

  it("respectNativeDark:false: ignored, overrides present", async () => {
    setPage('<html><head><meta name="color-scheme" content="dark"><style>body{background:#111;color:#eee}</style></head><body></body></html>');
    const { engine } = make(baseRule({ respectNativeDark: false }));
    const st = await engine.start();
    expect(st.nativeDark).toBe("ignored");
    expect(overrides()).toHaveLength(1);
  });

  it("filter: html filter style and theme-color only", async () => {
    setPage('<html><head><style>body{background:#fff}</style></head><body><p style="color:#333">x</p></body></html>');
    const { engine } = make(baseRule({ mode: "filter", modeIsExplicit: true }));
    const st = await engine.start();
    expect(st.mode).toBe("filter");
    const f = document.querySelector('style[data-dusk="filter"]');
    expect(f?.getAttribute("media")).toBe("screen");
    expect(f?.textContent).toContain("html{filter:invert(.9) hue-rotate(180deg)");
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute("content")).toBe("rgb(26, 26, 26)");
    expect(document.querySelector('style[data-dusk="root"]')).toBeNull();
    expect(overrides()).toHaveLength(0);
    expect((document.querySelector("p") as HTMLElement).getAttribute("style")).toBe("color:#333");
    expect(document.documentElement.hasAttribute("data-dusk-ready")).toBe(true);
  });

  it("siteDefault.mode filter applies only when the user hasn't chosen a mode", async () => {
    const a = make(baseRule({ modeIsExplicit: false }), { mode: "filter" });
    expect((await a.engine.start()).mode).toBe("filter");
    a.engine.stop();
    const b = make(baseRule({ mode: "full", modeIsExplicit: true }), { mode: "filter" });
    expect((await b.engine.start()).mode).toBe("full");
    expect(document.querySelector('style[data-dusk="filter"]')).toBeNull();
  });

  it("gentle: style and inline rewriting without images or repair", async () => {
    setPage('<html><head><style>body{background:#fff;color:#000}</style></head><body><p style="color:#333">x</p></body></html>');
    const { engine, closedRepair } = make(baseRule({ mode: "gentle", modeIsExplicit: true }));
    expect((await engine.start()).mode).toBe("gentle");
    expect(overrides()).toHaveLength(1);
    expect(document.querySelector('style[data-dusk="img"]')).toBeNull();
    expect(closedRepair).toEqual([]);
  });

  it("the bridge's closed-shadow-root repair runs with the contrast-repair pass (full and native dark) and stops with it", async () => {
    setPage('<html><head><style>body{background:#fff;color:#000}</style></head><body><p>x</p></body></html>');
    const full = make();
    await full.engine.start();
    expect(full.closedRepair).toEqual([true]);
    full.engine.stop();
    expect(full.closedRepair).toEqual([true, false]);
    setPage('<html><head><meta name="color-scheme" content="dark"></head><body><p>x</p></body></html>');
    const native = make();
    expect((await native.engine.start()).nativeDark).toBe("used");
    expect(native.closedRepair).toEqual([true]);
    expect(document.querySelector('style[data-dusk="root"]')?.textContent).toContain("--dusk-neutral-text");
    native.engine.stop();
    expect(native.closedRepair).toEqual([true, false]);
  });

  it("teardown completeness on the rich fixture: outerHTML equal before start and after stop", async () => {
    setPage(RICH);
    const host = document.getElementById("host") as HTMLElement;
    const sr = host.attachShadow({ mode: "open" });
    sr.innerHTML = '<style>.in{background:#fff;color:#000}</style><p class="in" style="border-color:#ccc">shadow</p>';
    const own = new CSSStyleSheet();
    own.replaceSync(".adopted{background:#fff}");
    document.adoptedStyleSheets = [own];
    const before = snapshot();
    const shadowBefore = sr.innerHTML;
    const { engine } = make(baseRule({ dimImages: true }));
    await engine.start();
    await tick();
    expect(dusk().length).toBeGreaterThan(4);
    expect(sr.querySelector('style[data-dusk="sheet"]')).not.toBeNull();
    expect(document.adoptedStyleSheets.length).toBe(2);
    engine.stop();
    expect(snapshot()).toBe(before);
    expect(sr.innerHTML).toBe(shadowBefore);
    expect(document.adoptedStyleSheets).toEqual([own]);
    expect(document.documentElement.hasAttribute("data-dusk-ready")).toBe(true);
  });

  it("update theme dark→dim changes the root background in place without node churn", async () => {
    setPage(RICH);
    const { engine } = make();
    await engine.start();
    const nodes = [...dusk()];
    const sheetText = overrides()[0]?.textContent;
    const header = document.querySelector("header") as HTMLElement;
    const headerBg = header.style.getPropertyValue("background-color");
    const st = await engine.update(baseRule({ theme: "dim" }));
    expect(st.theme).toBe("dim");
    expect(document.querySelector('style[data-dusk="root"]')?.textContent).toContain(paletteCss(PALETTES.dim).bg);
    expect([...dusk()]).toEqual(nodes);
    expect(overrides()[0]?.textContent).not.toBe(sheetText);
    expect(header.style.getPropertyValue("background-color")).not.toBe(headerBg);
    expect(document.querySelector('style[data-dusk="vars"]')?.textContent).toContain(paletteCss(PALETTES.dim).bg);
  });

  it("update dimImages toggles the dim rules in the same node", async () => {
    const { engine } = make();
    await engine.start();
    const dim = document.querySelector('style[data-dusk="dim"]');
    expect(dim?.textContent).toBe("");
    await engine.update(baseRule({ dimImages: true }));
    expect(document.querySelector('style[data-dusk="dim"]')).toBe(dim);
    expect(dim?.textContent).toContain("brightness");
  });

  it("update mode full→filter restarts; stop leaves the document as it was", async () => {
    setPage('<html><head><style>body{background:#fff}</style></head><body><p style="color:#333">x</p></body></html>');
    const before = snapshot();
    const { engine } = make();
    await engine.start();
    const st = await engine.update(baseRule({ mode: "filter", modeIsExplicit: true }));
    expect(st.mode).toBe("filter");
    expect(overrides()).toHaveLength(0);
    expect(document.querySelector('style[data-dusk="filter"]')).not.toBeNull();
    engine.stop();
    expect(snapshot()).toBe(before);
  });

  it("shadow roots inserted with their host (no attach event) are themed", async () => {
    const { engine } = make();
    await engine.start();
    const host = document.createElement("div");
    const sr = host.attachShadow({ mode: "open" });
    sr.innerHTML = "<style>.z{background:#fff}</style>";
    document.body.append(host);
    await tick();
    expect(sr.querySelector('style[data-dusk="sheet"]')).not.toBeNull();
  });

  it("stopping a second instance on the same page leaves the first one's overrides in place (self-healing) and both stops restore", async () => {
    setPage('<html><head><style>body{background:#fff;color:#000}</style></head><body><p style="color:#333">x</p></body></html>');
    const before = snapshot();
    const a = make();
    const b = make();
    await a.engine.start();
    await b.engine.start();
    expect(overrides()).toHaveLength(1);
    b.engine.stop();
    await tick();
    expect(overrides()).toHaveLength(1);
    expect((document.querySelector("p") as HTMLElement).style.getPropertyPriority("color")).toBe("important");
    a.engine.stop();
    expect(snapshot()).toBe(before);
  });

  it("stop before DOMContentLoaded resolves start without theming afterwards", async () => {
    const state = vi.spyOn(document, "readyState", "get").mockReturnValue("loading");
    const { engine } = make();
    const p = engine.start();
    engine.stop();
    state.mockRestore();
    await p;
    document.dispatchEvent(new Event("DOMContentLoaded"));
    expect(overrides()).toHaveLength(0);
    expect(dusk()).toHaveLength(0);
  });

  it("ready waits for DOMContentLoaded while loading", async () => {
    const state = vi.spyOn(document, "readyState", "get").mockReturnValue("loading");
    const { engine } = make();
    const p = engine.start();
    await tick();
    expect(document.documentElement.hasAttribute("data-dusk-ready")).toBe(false);
    state.mockReturnValue("interactive");
    document.dispatchEvent(new Event("DOMContentLoaded"));
    await p;
    expect(document.documentElement.hasAttribute("data-dusk-ready")).toBe(true);
    window.dispatchEvent(new Event("load"));
  });
});

describe("applyFilterMode", () => {
  it("adds one screen style re-inverting media but not dark-icon markers, and removes it", () => {
    const stop = applyFilterMode(document);
    const css = document.querySelector('style[data-dusk="filter"]')?.textContent ?? "";
    expect(css).toContain("svg image");
    expect(css).toContain('[style*="url("]');
    expect(css).toContain(':not([data-dusk-img="invert"])');
    expect(css).toContain("background-color:white");
    stop();
    expect(dusk()).toHaveLength(0);
  });
});
