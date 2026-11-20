import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PALETTES } from "../../src/engine/color/palettes";
import type { Role } from "../../src/engine/color/transform";
import { transformCssColor } from "../../src/engine/color/transform";
import type { RewriteCtx } from "../../src/engine/css/declarations";
import { StyleManager } from "../../src/engine/css/style-manager";
import type { StyleManagerDeps } from "../../src/engine/css/style-manager";
import { VariableRegistry } from "../../src/engine/css/variables";

const p = PALETTES.dark;
const T = (v: string, role: Role) => transformCssColor(v, role, p) as string;
const OWN = Symbol.for("dusk.own");
const tick = () => new Promise((r) => setTimeout(r, 0));

function deps(over: Partial<StyleManagerDeps> = {}): StyleManagerDeps {
  const vars = new VariableRegistry(p);
  const ctx: RewriteCtx = { palette: p, mode: "full", varRef: (v, r) => vars.varRef(v, r) };
  return { ctx, vars, fetchText: async () => null, schedule: (fn) => fn(), ...over };
}

const overrides = (root: ParentNode = document) => [...root.querySelectorAll<HTMLStyleElement>('style[data-dusk="sheet"]')];

function addStyle(css: string, parent: ParentNode = document.head): HTMLStyleElement {
  const s = document.createElement("style");
  s.textContent = css;
  parent.append(s);
  return s;
}

/** A <link rel=stylesheet> whose sheet behaves like a cross-origin one: reading cssRules throws SecurityError. */
function crossOriginLink(href: string): HTMLLinkElement {
  const link = document.createElement("link");
  const sheet = {
    href,
    disabled: false,
    media: { mediaText: "" },
    get cssRules(): CSSRuleList {
      throw new DOMException("Not allowed to access cross-origin stylesheet", "SecurityError");
    },
  };
  Object.defineProperty(link, "sheet", { get: () => sheet });
  link.setAttribute("rel", "stylesheet");
  return link;
}

let m: StyleManager | null = null;
beforeEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  document.adoptedStyleSheets = [];
});
afterEach(() => {
  m?.stop();
  m = null;
});

describe("StyleManager", () => {
  it("an initial <style> gets an override sibling right after it, with media=screen", () => {
    const s = addStyle(".a{color:#000}");
    addStyle(".b{color:#111}");
    m = new StyleManager(document, deps());
    m.start();
    const o = s.nextElementSibling as HTMLStyleElement;
    expect(o.getAttribute("data-dusk")).toBe("sheet");
    expect(o.getAttribute("media")).toBe("screen");
    expect(o.textContent).toBe(`.a{color:${T("#000", "text")};}`);
    expect(overrides()).toHaveLength(2);
    expect(document.querySelectorAll('style[data-dusk="vars"]')).toHaveLength(1);
    expect(document.querySelector('style[data-dusk="vars"]')?.getAttribute("media")).toBe("screen");
  });

  it("a <style> added later is handled", async () => {
    m = new StyleManager(document, deps());
    m.start();
    const s = addStyle(".a{background-color:#fff}");
    await tick();
    expect(s.nextElementSibling?.textContent).toBe(`.a{background-color:${T("#fff", "bg")};}`);
  });

  it("changing a <style>'s textContent re-emits", async () => {
    const s = addStyle(".a{color:#000}");
    m = new StyleManager(document, deps());
    m.start();
    s.textContent = ".a{color:#222}";
    await tick();
    expect(overrides()).toHaveLength(1);
    expect(s.nextElementSibling?.textContent).toBe(`.a{color:${T("#222", "text")};}`);
    s.append(document.createTextNode(".b{color:#333}"));
    await tick();
    expect(s.nextElementSibling?.textContent).toContain(`.b{color:${T("#333", "text")};}`);
  });

  it("removing the source removes the override", async () => {
    const s = addStyle(".a{color:#000}");
    m = new StyleManager(document, deps());
    m.start();
    s.remove();
    await tick();
    expect(overrides()).toHaveLength(0);
  });

  it("rescan() picks up CSSOM edits (insertRule) by cssRules.length", () => {
    const s = addStyle(".a{color:#000}");
    m = new StyleManager(document, deps());
    m.start();
    s.sheet?.insertRule(".z{color:#444}", 1);
    m.rescan();
    expect(s.nextElementSibling?.textContent).toContain(`.z{color:${T("#444", "text")};}`);
  });

  it("a source with media keeps it around the override; print-only media emits nothing", () => {
    const s = addStyle(".a{color:#000}");
    s.setAttribute("media", "(max-width: 600px)");
    const pr = addStyle(".b{color:#000}");
    pr.setAttribute("media", "print");
    m = new StyleManager(document, deps());
    m.start();
    expect(s.nextElementSibling?.textContent).toBe(`@media (max-width: 600px){.a{color:${T("#000", "text")};}}`);
    expect(pr.nextElementSibling?.textContent ?? "").toBe("");
  });

  it("a cross-origin <link> (cssRules throws) is fetched with fetchText, @import followed", async () => {
    const fetchText = vi.fn(async (url: string) => {
      if (url === "https://cdn.example/css/site.css") return '/* {a} @import url("ignored.css"); */ @import url("parts/a.css") screen; @import "https://other.example/print.css" print; .b{background-color:#fff}';
      if (url === "https://cdn.example/css/parts/a.css") return ".i{color:#000}";
      return null;
    });
    const link = crossOriginLink("https://cdn.example/css/site.css");
    document.head.append(link);
    m = new StyleManager(document, deps({ fetchText }));
    m.start();
    await tick();
    await tick();
    expect(fetchText).toHaveBeenCalledWith("https://cdn.example/css/site.css");
    expect(fetchText).toHaveBeenCalledWith("https://cdn.example/css/parts/a.css");
    expect(fetchText).not.toHaveBeenCalledWith("https://other.example/print.css");
    expect(fetchText).toHaveBeenCalledTimes(2);
    const o = link.nextElementSibling as HTMLStyleElement;
    expect(o.getAttribute("data-dusk")).toBe("sheet");
    expect(o.textContent).toBe(`@media screen{.i{color:${T("#000", "text")};}}.b{background-color:${T("#fff", "bg")};}`);
  });

  it("cross-origin @import recursion stops at depth 3", async () => {
    const fetchText = vi.fn(async (url: string) => {
      const n = Number(/(\d+)\.css$/.exec(url)?.[1]);
      return `@import url(${n + 1}.css); .d${n}{color:#000}`;
    });
    const link = crossOriginLink("https://cdn.example/0.css");
    document.head.append(link);
    m = new StyleManager(document, deps({ fetchText }));
    m.start();
    for (let i = 0; i < 6; i++) await tick();
    expect(fetchText.mock.calls.map((c) => c[0])).toEqual(["https://cdn.example/0.css", "https://cdn.example/1.css", "https://cdn.example/2.css", "https://cdn.example/3.css"]);
  });

  it("adopted sheets get a constructed override right after each source", () => {
    const a = new CSSStyleSheet();
    a.replaceSync(".a{color:#000}");
    const b = new CSSStyleSheet();
    b.replaceSync(".b{background-color:#fff}");
    document.adoptedStyleSheets = [a, b];
    m = new StyleManager(document, deps());
    m.start();
    const list = document.adoptedStyleSheets;
    expect(list).toHaveLength(4);
    expect(list[0]).toBe(a);
    expect(list[2]).toBe(b);
    const oa = list[1] as CSSStyleSheet & { [OWN]?: boolean };
    expect(oa[OWN]).toBe(true);
    expect(oa.cssRules[0]?.cssText.replace(/\s/g, "")).toBe(`.a{color:${T("#000", "text")};}`.replace(/\s/g, ""));
    m.rescan();
    expect(document.adoptedStyleSheets).toEqual(list);
    m.stop();
    m = null;
    expect(document.adoptedStyleSheets).toEqual([a, b]);
  });

  it("re-emits a sheet when a later sheet defines a variable it uses", () => {
    const a = addStyle(".x{background-color:var(--bg)}");
    m = new StyleManager(document, deps());
    m.start();
    expect(a.nextElementSibling?.textContent).toBe("");
    const b = addStyle(":root{--bg:#fff}");
    m.rescan();
    expect(a.nextElementSibling?.textContent).toBe(".x{background-color:var(--dusk-bg--bg);}");
    // The redefinition sits in the defining sheet's own override, not in the shared vars node.
    expect(b.nextElementSibling?.textContent).toBe(`:root{--dusk-bg--bg:${T("#fff", "bg")};}`);
    expect(document.querySelector('style[data-dusk="vars"]')?.textContent).not.toContain("--dusk-bg--bg");
  });

  it("each sheet's redefinitions follow its cascade position; re-filling an earlier sheet doesn't leak stale values", async () => {
    const first = addStyle("");
    const second = addStyle(":root{--x:#000} body{color:var(--x)}");
    const d = deps();
    m = new StyleManager(document, d);
    m.start();
    first.textContent = ":root{--x:#fff}";
    await tick();
    expect(first.nextElementSibling?.textContent).toBe(`:root{--dusk-text--x:${T("#fff", "text")};}`);
    expect(second.nextElementSibling?.textContent).toContain(`:root{--dusk-text--x:${T("#000", "text")};}`);
    const size = d.vars.size;
    for (let i = 0; i < 20; i++) {
      first.textContent = `:root{--x:#${(100 + i).toString()}}`;
      await tick();
    }
    expect(d.vars.size).toBe(size);
    first.remove();
    await tick();
    expect(d.vars.size).toBe(size - 1);
  });

  it("relative url()s in a <link> sheet's overrides are made absolute against the sheet URL", () => {
    const link = document.createElement("link");
    const real = new CSSStyleSheet();
    real.replaceSync('.x{background-image:linear-gradient(#fff, #eee), url("../img/a.png")} .y{fill:url(#grad) #000}');
    const sheet = { href: "https://site.example/css/theme/site.css", disabled: false, media: { mediaText: "" }, cssRules: real.cssRules };
    Object.defineProperty(link, "sheet", { get: () => sheet });
    link.setAttribute("rel", "stylesheet");
    document.head.append(link);
    m = new StyleManager(document, deps());
    m.start();
    const css = link.nextElementSibling?.textContent ?? "";
    expect(css).toContain('url("https://site.example/css/img/a.png")');
    expect(css).not.toContain("../img");
    expect(css).toContain("url(#grad)");
  });

  it("a same-origin sheet that @imports a cross-origin sheet follows it through fetchText", async () => {
    const fetchText = vi.fn(async (url: string) => (url === "https://cdn.example/x.css" ? ".i{color:#000}" : null));
    const own = new CSSStyleSheet();
    own.replaceSync(".o{color:#111}");
    const imp = {
      type: 3,
      href: "https://cdn.example/x.css",
      cssText: '@import url("https://cdn.example/x.css");',
      media: { mediaText: "" },
      styleSheet: { href: "https://cdn.example/x.css", get cssRules(): CSSRuleList { throw new DOMException("x", "SecurityError"); } },
    };
    const style = document.createElement("style");
    const sheet = { href: null, disabled: false, media: { mediaText: "" }, cssRules: [imp, ...own.cssRules] };
    Object.defineProperty(style, "sheet", { get: () => sheet });
    document.head.append(style);
    m = new StyleManager(document, deps({ fetchText }));
    m.start();
    expect(style.nextElementSibling?.textContent).toBe(`.o{color:${T("#111", "text")};}`);
    await tick();
    await tick();
    expect(fetchText).toHaveBeenCalledWith("https://cdn.example/x.css");
    expect(style.nextElementSibling?.textContent).toBe(`.i{color:${T("#000", "text")};}.o{color:${T("#111", "text")};}`);
  });

  it("two managers on one root don't fight over adoptedStyleSheets", () => {
    const a = new CSSStyleSheet();
    a.replaceSync(".a{color:#000}");
    document.adoptedStyleSheets = [a];
    const first = new StyleManager(document, deps());
    first.start();
    m = new StyleManager(document, deps());
    m.start();
    const list = document.adoptedStyleSheets;
    expect(list).toHaveLength(2);
    first.rescan();
    m.rescan();
    expect(document.adoptedStyleSheets).toEqual(list);
    first.stop();
    m.rescan();
    expect(document.adoptedStyleSheets).toHaveLength(2);
  });

  it("idempotent under a mutation storm: one override per source, never an override of an override", async () => {
    const d = deps();
    const schedule = vi.fn((fn: () => void) => fn());
    m = new StyleManager(document, { ...d, schedule });
    m.start();
    const kept: HTMLStyleElement[] = [];
    for (let i = 0; i < 500; i++) {
      switch (i % 5) {
        case 0: kept.push(addStyle(`.s${i}{color:#000}`)); break;
        case 1: (kept[kept.length - 1] as HTMLStyleElement).textContent = `.t${i}{background-color:#fff}`; break;
        case 2: addStyle(`.r${i}{color:#111}`, document.body).remove(); break;
        case 3: document.head.insertBefore(addStyle(`.u${i}{color:#222}`), kept[0] as HTMLStyleElement).remove(); break;
        default: (kept[kept.length - 1] as HTMLStyleElement).setAttribute("media", i % 2 ? "screen" : "all");
      }
    }
    await tick();
    await tick();
    const outs = overrides();
    expect(outs).toHaveLength(kept.length);
    for (const s of kept) expect(s.nextElementSibling?.getAttribute("data-dusk")).toBe("sheet");
    for (const o of outs) expect(o.previousElementSibling?.hasAttribute("data-dusk")).toBe(false);
    // Our own writes don't schedule more work: a quiet tick schedules nothing.
    const calls = schedule.mock.calls.length;
    await tick();
    expect(schedule.mock.calls.length).toBe(calls);
    expect(calls).toBeLessThan(50);
  });

  it("start() on a root that already has our nodes (second injection) doesn't duplicate them", () => {
    addStyle(".a{color:#000}");
    const first = new StyleManager(document, deps());
    first.start();
    m = new StyleManager(document, deps());
    m.start();
    expect(overrides()).toHaveLength(1);
    expect(document.querySelectorAll('style[data-dusk="vars"]')).toHaveLength(1);
    first.stop();
  });

  it("handles a shadow root", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const shadow = host.attachShadow({ mode: "open" });
    const s = addStyle(".a{color:#000}", shadow);
    m = new StyleManager(shadow, deps());
    m.start();
    expect(s.nextElementSibling?.getAttribute("data-dusk")).toBe("sheet");
    expect(shadow.querySelectorAll('style[data-dusk="vars"]')).toHaveLength(1);
    m.stop();
    m = null;
    expect(shadow.querySelectorAll("[data-dusk]")).toHaveLength(0);
  });

  it("stop() leaves no [data-dusk] nodes", async () => {
    addStyle(".a{color:#000}");
    addStyle(".b{color:#000}", document.body);
    m = new StyleManager(document, deps());
    m.start();
    expect(document.querySelectorAll("[data-dusk]").length).toBeGreaterThan(0);
    m.stop();
    m = null;
    expect(document.querySelectorAll("[data-dusk]")).toHaveLength(0);
    addStyle(".c{color:#000}");
    await tick();
    expect(document.querySelectorAll("[data-dusk]")).toHaveLength(0);
  });

  it("a relative @import in a <style> resolves against the document base URL", async () => {
    const fetchText = vi.fn(async () => ".i{color:#000}");
    const base = document.createElement("base");
    base.href = "https://site.example/dir/";
    document.head.append(base);
    const imp = {
      type: 3,
      href: "parts/x.css",
      cssText: '@import url("parts/x.css");',
      media: { mediaText: "" },
      styleSheet: { href: null, get cssRules(): CSSRuleList { throw new DOMException("x", "SecurityError"); } },
    };
    const style = document.createElement("style");
    const sheet = { href: null, disabled: false, media: { mediaText: "" }, cssRules: [imp] };
    Object.defineProperty(style, "sheet", { get: () => sheet });
    document.head.append(style);
    m = new StyleManager(document, deps({ fetchText }));
    m.start();
    await tick();
    expect(fetchText).toHaveBeenCalledWith("https://site.example/dir/parts/x.css");
  });
});
