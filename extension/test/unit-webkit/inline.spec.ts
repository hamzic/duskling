// InlineStyler in real WebKit: CSSOM writes fire `style` attribute mutations here (happy-dom doesn't), so this checks
// that our own writes don't loop, that restore is byte-exact after real re-serialization, and the guard with real layout.
import { expect, test } from "@playwright/test";
import type { DuskGlobal } from "./engine-bundle";
import { engineBundle } from "./engine-bundle";

let bundle = "";
test.beforeAll(async () => {
  bundle = await engineBundle();
});

test("own writes don't loop, page changes are re-processed, stop() restores exactly; the guard uses layout", async ({ page }) => {
  await page.setContent(`<!doctype html><html><head></head><body>
    <p id="t" style="color:#000 ;  background : #fff">text</p>
    <span id="sw" style="display:inline-block;width:24px;height:24px;background:#e53935"></span>
    <div id="bar" style="width:300px;height:40px;background:#e53935">Label</div>
    <svg id="chart" width="200" height="100"><rect width="10" height="10" fill="#e53935"/><rect width="10" height="10" fill="#43a047"/><rect width="10" height="10" fill="#1e88e5"/></svg>
    <svg id="icon" width="200" height="200"><path id="path" fill="#000" d="M0 0h200v200z"/></svg>
    <i id="probe"></i></body></html>`);
  await page.addScriptTag({ content: bundle });
  const r = await page.evaluate(async () => {
    const D = (window as unknown as { Dusk: DuskGlobal }).Dusk;
    const p = D.PALETTES.dark;
    const before = [...document.querySelectorAll("[id]:not(#probe)")].map((e) => [e.id, e.getAttribute("style")]);
    const Native = window.MutationObserver;
    let callbacks = 0;
    window.MutationObserver = class extends Native {
      constructor(cb: MutationCallback) {
        super((rs, o) => (callbacks++, cb(rs, o)));
      }
    };
    const s = new D.InlineStyler(document, { palette: p, mode: "full", varRef: (v) => v });
    s.start();
    window.MutationObserver = Native;
    const settle = () => new Promise((res) => setTimeout(res, 20));
    await settle();
    const afterStart = callbacks;
    const t = document.getElementById("t") as HTMLElement;
    for (let i = 1; i < 6; i++) {
      t.style.color = `#${i}${i}${i}`;
      await settle();
    }
    const probe = document.getElementById("probe") as HTMLElement;
    const norm = (v: string) => ((probe.style.color = v), getComputedStyle(probe).color);
    const cs = (id: string, prop: string) => getComputedStyle(document.getElementById(id) as Element).getPropertyValue(prop);
    const got = { t: cs("t", "color"), sw: cs("sw", "background-color"), bar: cs("bar", "background-color"), path: cs("path", "fill") };
    const want = {
      t: norm(D.transformCssColor("#555", "text", p) as string),
      sw: norm("#e53935"),
      bar: norm(D.transformCssColor("#e53935", "bg", p) as string),
      path: norm(D.transformCssColor("#000", "text", p) as string),
    };
    const chartStyled = [...document.querySelectorAll("rect")].some((x) => x.hasAttribute("style"));
    t.setAttribute("style", "color:#000 ;  background : #fff");
    await settle();
    s.stop();
    const after = [...document.querySelectorAll("[id]:not(#probe)")].map((e) => [e.id, e.getAttribute("style")]);
    return { afterStart, callbacks, got, want, chartStyled, before, after };
  });
  expect(r.got).toEqual(r.want);
  expect(r.chartStyled).toBe(false);
  expect(r.afterStart).toBeLessThanOrEqual(1);
  // 5 page writes + 1 setAttribute, each answered by one write of ours that is recognized and ignored.
  expect(r.callbacks).toBeLessThanOrEqual(r.afterStart + 12);
  expect(r.after).toEqual(r.before);
});

test("two InlineStyler copies (content.js injected twice) transform once and restore exactly", async ({ page }) => {
  await page.setContent('<!doctype html><html><head></head><body><div id="d" style="background-color:#fff;color:#000;width:300px">text</div><i id="probe"></i></body></html>');
  await page.addScriptTag({ content: bundle });
  await page.evaluate(() => {
    (window as unknown as { D1: unknown }).D1 = (window as unknown as { Dusk: unknown }).Dusk;
  });
  await page.addScriptTag({ content: bundle });
  const r = await page.evaluate(async () => {
    const w = window as unknown as { Dusk: DuskGlobal; D1: DuskGlobal };
    const p = w.Dusk.PALETTES.dark;
    const ctx = { palette: p, mode: "full" as const, varRef: (v: string) => v };
    const el = document.getElementById("d") as HTMLElement;
    const before = el.getAttribute("style");
    const a = new w.D1.InlineStyler(document, ctx);
    const b = new w.Dusk.InlineStyler(document, ctx, { schedule: (fn) => requestAnimationFrame(fn) });
    a.start();
    b.start();
    await new Promise((res) => setTimeout(res, 50));
    const probe = document.getElementById("probe") as HTMLElement;
    const norm = (v: string) => ((probe.style.color = v), getComputedStyle(probe).color);
    const got = getComputedStyle(el).backgroundColor;
    const want = norm(w.Dusk.transformCssColor("#fff", "bg", p) as string);
    a.stop();
    const afterA = el.getAttribute("style");
    await new Promise((res) => setTimeout(res, 50));
    b.stop();
    return { got, want, before, afterA, after: el.getAttribute("style") };
  });
  expect(r.got).toBe(r.want);
  expect(r.afterA).toBe(r.before);
  expect(r.after).toBe(r.before);
});

test("presentation attributes lose to author CSS, beat the attribute itself; charts untouched; hidden menus with text transformed", async ({ page }) => {
  await page.setContent(`<!doctype html><html><head><style>.icon path{fill:#1a73e8} @layer page{.lay path{fill:#2e7d32}}</style></head><body>
    <svg class="icon"><path id="author" fill="#000" d="M0 0h9v9z"/></svg>
    <svg class="lay"><path id="layered" fill="#000" d="M0 0h9v9z"/></svg>
    <svg><path id="plain" fill="#000" d="M0 0h9v9z"/></svg>
    <svg width="90" height="30"><rect id="r1" width="9" height="9" fill="#e53935"/><rect width="9" height="9" fill="#43a047"/><rect width="9" height="9" fill="#1e88e5"/></svg>
    <table><tr><td id="td" bgcolor="white">x</td></tr></table>
    <div id="menu" style="display:none;background-color:#e53935">Menu item</div>
    <i id="probe"></i></body></html>`);
  await page.addScriptTag({ content: bundle });
  const r = await page.evaluate(async () => {
    const D = (window as unknown as { Dusk: DuskGlobal }).Dusk;
    const p = D.PALETTES.dark;
    const vars = new D.VariableRegistry(p);
    const ctx = { palette: p, mode: "full" as const, varRef: (v: string, role: "bg" | "text" | "border") => vars.varRef(v, role) };
    const m = new D.StyleManager(document, { ctx, vars, fetchText: async () => null, schedule: (fn) => fn() });
    const s = new D.InlineStyler(document, ctx, { vars });
    m.start();
    s.start();
    const menu = document.getElementById("menu") as HTMLElement;
    menu.style.display = "block";
    await new Promise((res) => setTimeout(res, 30));
    const probe = document.getElementById("probe") as HTMLElement;
    const norm = (v: string) => ((probe.style.color = v), getComputedStyle(probe).color);
    const T = (v: string, role: "bg" | "text") => norm(D.transformCssColor(v, role, p) as string);
    const cs = (id: string, prop: string) => getComputedStyle(document.getElementById(id) as Element).getPropertyValue(prop);
    const got = { author: cs("author", "fill"), layered: cs("layered", "fill"), plain: cs("plain", "fill"), r1: cs("r1", "fill"), td: cs("td", "background-color"), menu: cs("menu", "background-color") };
    const want = { author: T("#1a73e8", "text"), layered: T("#2e7d32", "text"), plain: T("#000", "text"), r1: norm("#e53935"), td: T("white", "bg"), menu: T("#e53935", "bg") };
    s.stop();
    m.stop();
    return { got, want, left: document.querySelectorAll("[data-dusk], [data-dusk-keep]").length, plainAfter: cs("plain", "fill"), black: norm("#000") };
  });
  expect(r.got).toEqual(r.want);
  expect(r.left).toBe(0);
  expect(r.plainAfter).toBe(r.black);
});
