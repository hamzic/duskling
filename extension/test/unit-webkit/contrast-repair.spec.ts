// ContrastRepair in real WebKit: computed styles from the cascade, layout for the band and the guard, CSSOM writes that
// fire `style` mutations (happy-dom has none of these; pure logic is in test/unit/contrast-repair.test.ts).
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import type { DuskGlobal } from "./engine-bundle";
import { engineBundle } from "./engine-bundle";

let bundle = "";
test.beforeAll(async () => {
  bundle = await engineBundle();
});

/** A themed page: the root and `--dusk-neutral-bg` carry the dark theme background, as root.ts/vars do. */
async function themed(page: Page, body: string, css = ""): Promise<void> {
  await page.setContent(`<!doctype html><html><head><style id="theme"></style><style>${css}</style></head><body>${body}<i id="probe"></i></body></html>`);
  await page.addScriptTag({ content: bundle });
  await page.evaluate(() => {
    const D = (window as unknown as { Dusk: DuskGlobal }).Dusk;
    const bg = D.transformCssColor("#fff", "bg", D.PALETTES.dark) as string;
    (document.getElementById("theme") as HTMLStyleElement).textContent = `:root{--dusk-neutral-bg:${bg};background:${bg};color:#ddd}body{margin:0}`;
  });
}

test("a script-set white panel after the pass is repaired on the next pass; own writes don't retrigger; stop() restores", async ({ page }) => {
  await themed(page, '<div id="panel" style="width:400px ; height:50px">panel</div><div id="host"></div>', ".card{background:#fafafa;height:30px}");
  const r = await page.evaluate(async () => {
    const D = (window as unknown as { Dusk: DuskGlobal }).Dusk;
    const probe = document.getElementById("probe") as HTMLElement;
    probe.style.backgroundColor = "var(--dusk-neutral-bg)";
    const neutral = getComputedStyle(probe).backgroundColor;
    probe.removeAttribute("style");
    const Native = window.MutationObserver;
    let callbacks = 0;
    window.MutationObserver = class extends Native {
      constructor(cb: MutationCallback) {
        super((rs, o) => (callbacks++, cb(rs, o)));
      }
    };
    let passes = 0;
    const repair = new D.ContrastRepair(document, D.PALETTES.dark, { idle: (fn) => (passes++, fn()), isEngineStyled: () => false });
    repair.start();
    window.MutationObserver = Native;
    const wait = (ms: number) => new Promise((res) => setTimeout(res, ms));
    await wait(50);
    const panel = document.getElementById("panel") as HTMLElement;
    const first = { passes, style: panel.getAttribute("style") };
    panel.style.backgroundColor = "white";
    const card = Object.assign(document.createElement("div"), { className: "card", textContent: "card" });
    (document.getElementById("host") as HTMLElement).append(card);
    const pageStyle = panel.getAttribute("style");
    await wait(450);
    const got = { panel: getComputedStyle(panel).backgroundColor, card: getComputedStyle(card).backgroundColor };
    const afterRepair = { passes, callbacks };
    await wait(800);
    const settled = { passes, callbacks };
    repair.stop();
    return { first, pageStyle, neutral, got, afterRepair, settled, panelAfter: panel.getAttribute("style"), cardAfter: card.getAttribute("style") };
  });
  expect(r.first).toEqual({ passes: 1, style: "width:400px ; height:50px" });
  expect(r.got).toEqual({ panel: r.neutral, card: r.neutral });
  expect(r.afterRepair.passes).toBe(2);
  // One callback for the page's two changes; our own writes are taken back from the queue and never schedule a pass.
  expect(r.afterRepair.callbacks).toBeLessThanOrEqual(2);
  expect(r.settled).toEqual(r.afterRepair);
  expect(r.panelAfter).toBe(r.pageStyle);
  expect(r.cardAfter).toBeNull();
});

test("light-gray text on the dark background below 4.5:1 is fixed from its computed color", async ({ page }) => {
  await themed(page, '<p id="t">gray text</p><p id="ok">fine</p><div style="background:rgba(255,255,255,.08)"><span id="s">on a tint</span></div>', "#t,#s{color:#777}");
  const r = await page.evaluate(() => {
    const D = (window as unknown as { Dusk: DuskGlobal }).Dusk;
    const lum = (c: string) => {
      const [r, g, b] = (c.match(/[\d.]+/g) ?? []).map(Number).map((v) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
    };
    const ratio = (a: string, b: string) => {
      const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
      return ((x ?? 0) + 0.05) / ((y ?? 0) + 0.05);
    };
    const root = getComputedStyle(document.documentElement).backgroundColor;
    const color = (id: string) => getComputedStyle(document.getElementById(id) as Element).color;
    const before = ratio(color("t"), root);
    const n = new D.ContrastRepair(document, D.PALETTES.dark, { idle: (fn) => fn(), isEngineStyled: () => false }).runOnce();
    return { before, n, after: ratio(color("t"), root), tint: ratio(color("s"), root), ok: document.getElementById("ok")?.getAttribute("style") };
  });
  expect(r.before).toBeLessThan(4.5);
  expect(r.n).toBe(2);
  expect(r.after).toBeGreaterThanOrEqual(4.5);
  // The tint is slightly lighter than the root, so this stays a conservative check of the composited case.
  expect(r.tint).toBeGreaterThanOrEqual(4.5);
  expect(r.ok).toBeNull();
});

test("images, media, background images and guarded content colors are skipped; engine-styled elements only get text repair", async ({ page }) => {
  const png = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="#fff"/></svg>');
  await themed(
    page,
    `<img id="img" src="${png}" style="background:#fff;padding:4px"><video id="vid" style="background:#fff;width:100px;height:40px"></video>
     <div id="bgi" style="background:#fff linear-gradient(#fff,#eee);height:30px">text</div>
     <span id="sw" style="display:inline-block;width:24px;height:24px;background:#ffeb3b"></span>
     <div id="keep" data-dusk-keep style="background:#fff">kept</div><div id="eng" style="background:#fff">engine</div>
     <div id="ctl" style="background:#fff">control</div>`,
  );
  const r = await page.evaluate(() => {
    const D = (window as unknown as { Dusk: DuskGlobal }).Dusk;
    const ids = ["img", "vid", "bgi", "sw", "keep"];
    const styles = () => ids.map((id) => document.getElementById(id)?.getAttribute("style"));
    const before = styles();
    const n = new D.ContrastRepair(document, D.PALETTES.dark, { idle: (fn) => fn(), isEngineStyled: (el) => el.id === "eng" }).runOnce();
    const eng = document.getElementById("eng") as HTMLElement;
    const engColor = eng.style.getPropertyValue("color");
    return {
      n,
      same: JSON.stringify(styles()) === JSON.stringify(before),
      ctl: document.getElementById("ctl")?.style.getPropertyValue("background-color"),
      engBg: eng.style.getPropertyValue("background-color"),
      engColor: engColor !== "",
    };
  });
  // The engine-styled element keeps its background; its light (#ddd) text on white is still repaired (text rule).
  expect(r).toEqual({ n: 2, same: true, ctl: "var(--dusk-neutral-bg)", engBg: "rgb(255, 255, 255)", engColor: true });
});

test("at most 300 visible elements per pass in the viewport ± 1 screen", async ({ page }) => {
  await themed(page, `${'<div class="w">w</div>'.repeat(400)}<div style="height:5000px"></div><div class="w" id="far">far</div>`, ".w{background:#fff;height:1px;overflow:hidden;font-size:1px}");
  const r = await page.evaluate(() => {
    const D = (window as unknown as { Dusk: DuskGlobal }).Dusk;
    const repair = new D.ContrastRepair(document, D.PALETTES.dark, { idle: (fn) => fn(), isEngineStyled: () => false });
    const count = () => document.querySelectorAll('[style*="dusk-neutral-bg"]').length;
    const first = repair.runOnce();
    const c1 = count();
    const second = repair.runOnce();
    return { first, c1, second, total: count(), far: document.getElementById("far")?.hasAttribute("style") };
  });
  // The body is the first element examined, so the first pass repairs 299 surfaces.
  expect(r.first).toBe(299);
  expect(r.c1).toBe(299);
  expect(r.second).toBe(101);
  expect(r.total).toBe(400);
  expect(r.far).toBe(false);
});

test("repair and InlineStyler on one element restore byte-exactly in either stop order", async ({ page }) => {
  for (const order of ["repair", "styler"]) {
    await themed(page, '<div id="both" class="white" style="color:#000 ;  width : 300px">both</div>', ".white{background:#fff}");
    const r = await page.evaluate(async (order) => {
      const D = (window as unknown as { Dusk: DuskGlobal }).Dusk;
      const p = D.PALETTES.dark;
      const el = document.getElementById("both") as HTMLElement;
      const before = el.getAttribute("style");
      const styler = new D.InlineStyler(document, { palette: p, mode: "full", varRef: (v) => v });
      styler.start();
      const repair = new D.ContrastRepair(document, p, { idle: (fn) => fn(), isEngineStyled: () => false });
      repair.start();
      const wait = () => new Promise((res) => setTimeout(res, 50));
      await wait();
      const styled = { bg: el.style.getPropertyValue("background-color"), color: el.style.getPropertyPriority("color") };
      // InlineStyler's observer sees the repair write and recognizes it as Duskling's: the override stays.
      await wait();
      const kept = el.style.getPropertyValue("background-color");
      const stops = order === "repair" ? [repair, styler] : [styler, repair];
      for (const s of stops) s.stop();
      return { before, after: el.getAttribute("style"), styled, kept };
    }, order);
    expect(r.styled).toEqual({ bg: "var(--dusk-neutral-bg)", color: "important" });
    expect(r.kept).toBe("var(--dusk-neutral-bg)");
    expect(r.after).toBe(r.before);
  }
});
