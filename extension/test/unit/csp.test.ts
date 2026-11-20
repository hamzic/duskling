import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mirrorBlockedStyles, mirrorOf, restoreStyleAttr } from "../../src/engine/css/csp";
import type { StyleMirror } from "../../src/engine/css/csp";
import { markOwn } from "../../src/engine/css/own";
import { createEngine } from "../../src/engine/index";
import type { Engine } from "../../src/engine/index";

const tick = () => new Promise((r) => setTimeout(r, 0));

/** happy-dom has no CSP: a strict `style-src` is simulated the way Safari shows it, `sheet` stays null. */
function refuseDuskStyles(): void {
  const desc = Object.getOwnPropertyDescriptor(HTMLStyleElement.prototype, "sheet")!;
  vi.spyOn(HTMLStyleElement.prototype, "sheet", "get").mockImplementation(function (this: HTMLStyleElement) {
    return this.hasAttribute("data-dusk") ? null : (desc.get!.call(this) as CSSStyleSheet);
  });
}

function duskStyle(kind: string, css: string, media = "screen"): HTMLStyleElement {
  const s = markOwn(document.createElement("style"));
  s.setAttribute("data-dusk", kind);
  s.setAttribute("media", media);
  s.textContent = css;
  document.head.append(s);
  return s;
}

const mirrors = () => document.adoptedStyleSheets.filter((s) => mirrorOf(s));
const text = (s: CSSStyleSheet) => [...s.cssRules].map((r) => r.cssText).join("");

beforeEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  document.adoptedStyleSheets = [];
});

let started: StyleMirror[] = [];
const mirror = (): StyleMirror => {
  const m = mirrorBlockedStyles(document, window);
  started.push(m);
  return m;
};

afterEach(() => {
  for (const m of started) m.stop();
  started = [];
  vi.restoreAllMocks();
});

describe("mirrorBlockedStyles", () => {
  it("mirrors a refused <style data-dusk> into a constructed sheet after the page's own, and follows its changes", async () => {
    refuseDuskStyles();
    const page = new CSSStyleSheet();
    document.adoptedStyleSheets = [page];
    const a = duskStyle("root", "html{background:#111}");
    const m = mirror();
    expect(document.adoptedStyleSheets[0]).toBe(page);
    expect(mirrors()).toHaveLength(1);
    expect(text(mirrors()[0]!)).toContain("#111");

    duskStyle("dim", "img{opacity:.75}");
    a.textContent = "html{background:#222}";
    await tick();
    expect(mirrors().map((s) => mirrorOf(s)?.getAttribute("data-dusk"))).toEqual(["root", "dim"]);
    expect(text(mirrors()[0]!)).toContain("#222");

    a.remove();
    await tick();
    expect(mirrors().map((s) => mirrorOf(s)?.getAttribute("data-dusk"))).toEqual(["dim"]);
    m.stop();
    expect(document.adoptedStyleSheets).toEqual([page]);
  });

  it("never mirrors a <style data-dusk> the page made: its CSS stays refused", async () => {
    refuseDuskStyles();
    const forged = document.createElement("style");
    forged.setAttribute("data-dusk", "sheet");
    forged.textContent = "input[value^=a]{background:url(/leak?a)}";
    document.head.append(forged);
    mirror();
    duskStyle("root", "html{background:#111}");
    await tick();
    expect(mirrors().map((s) => mirrorOf(s))).toEqual([document.querySelector('style[data-dusk="root"]')]);
  });

  it("does nothing when the page's CSP lets the <style> apply", async () => {
    duskStyle("root", "html{background:#111}");
    const m = mirror();
    duskStyle("dim", "img{opacity:.75}");
    await tick();
    expect(document.adoptedStyleSheets).toHaveLength(0);
    m.stop();
  });
});

describe("restoreStyleAttr", () => {
  it("puts the attribute back byte-identical", () => {
    const el = document.createElement("div");
    el.setAttribute("style", "color:#333");
    const css = el.style.cssText;
    el.style.setProperty("background-color", "#111", "important");
    restoreStyleAttr(el, "color:#333", css);
    expect(el.getAttribute("style")).toBe("color:#333");
    expect(el.style.cssText).toBe(css);
  });

});

describe("engine under a strict CSP", () => {
  let engine: Engine | null = null;
  afterEach(() => engine?.stop());

  it("never takes over a page-made <style data-dusk> as its own node, and leaves it in place on stop", async () => {
    document.head.innerHTML = '<style>body{background:#fff;color:#222}</style><style data-dusk="sheet">.page{}</style><style data-dusk="vars"></style>';
    engine = createEngine({
      doc: document,
      win: window,
      rule: { enabled: true, mode: "full", modeIsExplicit: false, theme: "dark", respectNativeDark: false, trustNativeDark: false, dimImages: false, matchedHost: null },
      siteDefault: {},
      fetchResource: async () => ({ ok: false }),
      bridge: { setPromotion() {}, onSheetChange() {}, onShadowAttached() {} },
      schedule: (fn) => fn(),
    });
    const [forged, forgedVars] = [...document.querySelectorAll('style[data-dusk="sheet"], style[data-dusk="vars"]')];
    await engine.start();
    expect(forged!.textContent).toBe(".page{}");
    expect(forgedVars!.textContent).toBe("");
    expect(document.querySelectorAll('style[data-dusk="sheet"]').length).toBeGreaterThan(1);
    engine.stop();
    engine = null;
    expect(forged!.isConnected && forgedVars!.isConnected).toBe(true);
  });

  it("themes through mirrors and takes them all away on stop", async () => {
    refuseDuskStyles();
    document.head.innerHTML = "<style>body{background:#fff;color:#222}</style>";
    document.body.innerHTML = "<p>x</p>";
    engine = createEngine({
      doc: document,
      win: window,
      rule: { enabled: true, mode: "full", modeIsExplicit: false, theme: "dark", respectNativeDark: true, trustNativeDark: false, dimImages: false, matchedHost: null },
      siteDefault: {},
      fetchResource: async () => ({ ok: false }),
      bridge: { setPromotion() {}, onSheetChange() {}, onShadowAttached() {} },
      schedule: (fn) => fn(),
    });
    await engine.start();
    await tick();
    const kinds = mirrors().map((s) => mirrorOf(s)?.getAttribute("data-dusk"));
    expect(kinds).toContain("sheet");
    expect(kinds).toContain("root");
    engine.stop();
    engine = null;
    expect(document.adoptedStyleSheets).toHaveLength(0);
  });
});
