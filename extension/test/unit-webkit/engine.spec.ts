// Orchestrator cases that need real WebKit: layout and elementsFromPoint for sampling, StyleSheet.disabled in the
// cascade, CSS transitions, filters and fixed positioning (happy-dom lacks all of these).
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import type { DuskGlobal } from "./engine-bundle";
import { engineBundle } from "./engine-bundle";

// pngjs (devDependency) ships no types.
const { PNG } = createRequire(import.meta.url)("pngjs") as { PNG: { sync: { read(b: Buffer): { width: number; data: Buffer } } } };

const RICH = readFileSync(fileURLToPath(new URL("../fixtures/pages/teardown-rich.html", import.meta.url)), "utf8");

let bundle = "";
test.beforeAll(async () => {
  bundle = await engineBundle();
});

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
});

/** Loads the bundle and defines `window.__start(rule)` creating an engine with a recording bridge. */
async function setup(page: Page, html: string): Promise<void> {
  await page.setContent(html);
  await page.addScriptTag({ content: bundle });
  await page.evaluate(() => {
    const D = (window as unknown as { Dusk: DuskGlobal }).Dusk;
    const w = window as unknown as Record<string, unknown>;
    w.__promotion = [];
    w.__sheetCbs = [];
    w.__start = async (over: Record<string, unknown> = {}) => {
      const engine = D.createEngine({
        doc: document,
        win: window,
        rule: { enabled: true, mode: "full", modeIsExplicit: false, theme: "dark", respectNativeDark: true, trustNativeDark: false, dimImages: false, matchedHost: null, ...over },
        siteDefault: {},
        fetchResource: async () => ({ ok: false }),
        bridge: {
          setPromotion: (on) => (w.__promotion as boolean[]).push(on),
          onSheetChange: (cb) => (w.__sheetCbs as unknown[]).push(cb),
          onShadowAttached: () => {},
        },
      });
      w.__engine = engine;
      return engine.start();
    };
  });
}

const frames = (page: Page, n = 3) => page.evaluate((n) => new Promise<void>((r) => {
  let i = 0;
  const step = () => (++i >= n ? r() : requestAnimationFrame(step));
  requestAnimationFrame(step);
}), n);

test("teardown completeness on the rich fixture (styles, inline, svg attrs, bgcolor, images, srcdoc, theme-color, shadow root)", async ({ page }) => {
  await setup(page, RICH);
  await page.evaluate(() => {
    const sr = (document.getElementById("host") as HTMLElement).attachShadow({ mode: "open" });
    sr.innerHTML = '<style>.in{background:#fff;color:#000}</style><p class="in" style="border-color:#ccc">shadow</p>';
  });
  const snap = () => page.evaluate(() => {
    const c = document.documentElement.cloneNode(true) as Element;
    c.removeAttribute("data-dusk-ready");
    const sr = (document.getElementById("host") as HTMLElement).shadowRoot as ShadowRoot;
    const fc = (document.querySelector("iframe") as HTMLIFrameElement).contentDocument?.documentElement.cloneNode(true) as Element | undefined;
    fc?.removeAttribute("data-dusk-ready"); // the frame's engine keeps it set after stop too
    const frame = fc?.outerHTML ?? "";
    return { html: c.outerHTML, shadow: sr.innerHTML, frame, adopted: document.adoptedStyleSheets.length };
  });
  const before = await snap();
  const st = await page.evaluate(() => (window as unknown as { __start: () => Promise<unknown> }).__start());
  expect(st).toMatchObject({ mode: "full", nativeDark: "none", active: true });
  await frames(page, 5);
  const during = await page.evaluate(() => ({
    sheets: document.querySelectorAll('style[data-dusk="sheet"]').length,
    shadow: !!document.getElementById("host")?.shadowRoot?.querySelector('style[data-dusk="sheet"]'),
    frame: !!(document.querySelector("iframe") as HTMLIFrameElement).contentDocument?.querySelector('style[data-dusk="root"]'),
    bodyBg: getComputedStyle(document.body).backgroundColor,
  }));
  expect(during.sheets).toBeGreaterThan(0);
  expect(during.shadow).toBe(true);
  expect(during.frame).toBe(true);
  expect(during.bodyBg).not.toBe("rgb(255, 255, 255)");
  await page.evaluate(() => (window as unknown as { __engine: { stop(): void } }).__engine.stop());
  expect(await snap()).toEqual(before);
  expect(await page.evaluate(() => document.documentElement.hasAttribute("data-dusk-ready"))).toBe(true);
});

test("sampling a themed light page reads light, and suspending/restoring starts no transition", async ({ page }) => {
  await setup(page, `<!doctype html><html><head><style>
    html,body{margin:0;background:#fff;transition:background-color 2s}
    .card{width:100vw;height:100vh;background-color:#fafafa;transition:background-color 2s}
    @media (prefers-color-scheme: dark){.btn{color:#9cf}}</style></head>
    <body><div class="card" id="card" style="background-color:#fff">x</div><button class="btn">b</button></body></html>`);
  const st = await page.evaluate(() => (window as unknown as { __start: () => Promise<unknown> }).__start());
  expect(st).toMatchObject({ nativeDark: "none" });
  const r = await page.evaluate(() => ({
    animations: document.getAnimations().length,
    card: getComputedStyle(document.getElementById("card") as Element).backgroundColor,
    native: !!document.querySelector('style[data-dusk="native"]'),
    sampling: document.documentElement.hasAttribute("data-dusk-sampling"),
    adopted: document.adoptedStyleSheets.length,
    promotion: (window as unknown as { __promotion: boolean[] }).__promotion,
  }));
  expect(r.animations).toBe(0);
  expect(r.card).not.toBe("rgb(255, 255, 255)");
  expect(r.native).toBe(false);
  expect(r.sampling).toBe(false);
  expect(r.adopted).toBe(0);
  expect(r.promotion.at(-1)).toBe(false);
});

test("a natively dark page: theming torn down, root additions only, status used", async ({ page }) => {
  await setup(page, `<!doctype html><html><head><style>html,body{margin:0;background:#121212;color:#ddd}</style></head><body><p style="color:#ccc">x</p></body></html>`);
  const st = await page.evaluate(() => (window as unknown as { __start: () => Promise<unknown> }).__start());
  expect(st).toMatchObject({ nativeDark: "used" });
  expect(await page.evaluate(() => [document.querySelectorAll('style[data-dusk="sheet"], style[data-dusk="vars"]').length, document.querySelector("p")?.getAttribute("style")])).toEqual([0, "color:#ccc"]);
});

test("promotes a media-query dark theme on a light system and keeps it when the page samples dark", async ({ page }) => {
  await setup(page, `<!doctype html><html><head><style>html,body{margin:0;background:#fff;color:#000}
    @media (prefers-color-scheme: dark){html,body{background:#101010;color:#eee}}</style></head><body><p>x</p></body></html>`);
  const st = await page.evaluate(() => (window as unknown as { __start: () => Promise<unknown> }).__start());
  expect(st).toMatchObject({ nativeDark: "used" });
  expect(await page.evaluate(() => [getComputedStyle(document.body).backgroundColor, (window as unknown as { __promotion: boolean[] }).__promotion])).toEqual(["rgb(16, 16, 16)", [true]]);
});

test("adoptedStyleSheets pushed in place are picked up on the next document-targeted sheet change", async ({ page }) => {
  await setup(page, `<!doctype html><html><head></head><body><div id="h"></div></body></html>`);
  await page.evaluate(() => (document.getElementById("h") as HTMLElement).attachShadow({ mode: "open" }));
  await page.evaluate(() => (window as unknown as { __start: () => Promise<unknown> }).__start());
  const r = await page.evaluate(() => {
    const sr = (document.getElementById("h") as HTMLElement).shadowRoot as ShadowRoot;
    const a = new CSSStyleSheet();
    a.replaceSync(".x{background:#fff}");
    const b = new CSSStyleSheet();
    b.replaceSync(".y{background:#fff}");
    document.adoptedStyleSheets.push(a);
    sr.adoptedStyleSheets.push(b);
    for (const cb of (window as unknown as { __sheetCbs: ((r: Document) => void)[] }).__sheetCbs) cb(document);
    return [document.adoptedStyleSheets.length, sr.adoptedStyleSheets.length];
  });
  expect(r).toEqual([2, 2]);
});

test("filter mode inverts a transparent page everywhere and keeps position:fixed fixed", async ({ page }) => {
  await page.setViewportSize({ width: 400, height: 600 });
  await setup(page, `<!doctype html><html><head><style>body{margin:0}</style></head><body><p style="margin:0;height:40px">x</p>
    <div id="f" style="position:fixed;top:0;right:0;width:40px;height:40px;background:#00f"></div><div style="height:3000px"></div></body></html>`);
  await page.evaluate(() => (window as unknown as { __start: (o: unknown) => Promise<unknown> }).__start({ mode: "filter", modeIsExplicit: true }));
  const box = await page.evaluate(() => {
    const r = (document.getElementById("f") as HTMLElement).getBoundingClientRect();
    return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)] as const;
  });
  const px = async () => {
    const png = PNG.sync.read(await page.screenshot());
    const k = png.width / 400; // the Desktop Safari device renders at a device scale factor of 2
    const at = (x: number, y: number) => {
      const i = (Math.round(y * k) * png.width + Math.round(x * k)) * 4;
      return [png.data[i] ?? 0, png.data[i + 1] ?? 0, png.data[i + 2] ?? 0];
    };
    return { canvas: at(200, 580), fixed: at(box[0], box[1]) };
  };
  const before = await px();
  await page.evaluate(() => window.scrollTo(0, 800));
  await frames(page, 3);
  const after = await px();
  const top = await page.evaluate(() => (document.getElementById("f") as HTMLElement).getBoundingClientRect().top);
  // White through invert(.9) ≈ 26; the fixed box stays at the top right while scrolled.
  for (const c of [before.canvas, after.canvas]) for (const v of c) expect(v).toBeLessThan(40);
  expect(top).toBe(0);
  expect(after.fixed).toEqual(before.fixed);
  expect(Math.max(...after.fixed)).toBeGreaterThan(150);
});

test("filter mode: a dark icon <img> gets the invert marker and is not re-inverted, other media are", async ({ page }) => {
  const icon = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><circle cx="8" cy="8" r="4" fill="#000"/></svg>`;
  await page.route("http://dusk.test/**", (route) => {
    const url = route.request().url();
    if (url.endsWith("/icon.svg")) return route.fulfill({ contentType: "image/svg+xml", body: icon });
    return route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html><head></head><body><img id="i" width="16" height="16" src="/icon.svg"><video id="v" width="40" height="20"></video></body></html>`,
    });
  });
  await page.goto("http://dusk.test/");
  await page.addScriptTag({ content: bundle });
  await page.evaluate(async () => {
    const D = (window as unknown as { Dusk: DuskGlobal }).Dusk;
    const e = D.createEngine({
      doc: document,
      win: window,
      rule: { enabled: true, mode: "filter", modeIsExplicit: true, theme: "dark", respectNativeDark: true, trustNativeDark: false, dimImages: false, matchedHost: null },
      siteDefault: {},
      fetchResource: async () => ({ ok: false }),
      bridge: { setPromotion() {}, onSheetChange() {}, onShadowAttached() {} },
    });
    (window as unknown as { __engine: typeof e }).__engine = e;
    await e.start();
  });
  await page.waitForFunction(() => document.getElementById("i")?.getAttribute("data-dusk-img") === "invert");
  const r = await page.evaluate(() => ({
    img: getComputedStyle(document.getElementById("i") as Element).filter,
    video: getComputedStyle(document.getElementById("v") as Element).filter,
    imgStyle: document.querySelectorAll('style[data-dusk="img"]').length,
  }));
  expect(r).toEqual({ img: "none", video: "invert(1) hue-rotate(180deg)", imgStyle: 0 });
  await page.evaluate(() => (window as unknown as { __engine: { stop(): void } }).__engine.stop());
  expect(await page.evaluate(() => document.querySelectorAll("[data-dusk], [data-dusk-img]").length)).toBe(0);
});

test("a frame document without a document element (mid document.open) is themed once written, without an error", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await setup(page, `<body style="background:#fff"><iframe id="blank"></iframe></body>`);
  // document.open() empties the frame's document (HTML §8.4.1 "document open steps": all its children are removed), so
  // the engine starts while the frame has no documentElement.
  await page.evaluate(() => (document.getElementById("blank") as HTMLIFrameElement).contentDocument!.open());
  await page.evaluate(() => (window as unknown as { __start(): Promise<unknown> }).__start());
  await page.evaluate(() => {
    const d = (document.getElementById("blank") as HTMLIFrameElement).contentDocument!;
    d.write("<!doctype html><style>body{background:#fff;color:#222}</style><p>written</p>");
    d.close();
  });
  await frames(page);
  await page.waitForTimeout(100);
  const bg = await page.evaluate(() => getComputedStyle((document.getElementById("blank") as HTMLIFrameElement).contentDocument!.body).backgroundColor);
  expect(errors).toEqual([]);
  expect(bg).not.toBe("rgb(255, 255, 255)");
});
