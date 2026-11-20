// "Dim images" in real WebKit: layout (containing blocks) and the native-dark path need a real engine.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import type { Mode } from "../../src/shared/types";
import type { DuskGlobal } from "./engine-bundle";
import { engineBundle } from "./engine-bundle";

const PAGES = fileURLToPath(new URL("../fixtures/pages/", import.meta.url));
const PHOTO = readFileSync(`${PAGES}assets/photo.png`);
const FIXTURE = readFileSync(`${PAGES}absolute-picture.html`, "utf8");
// The same cards on a page that declares itself dark, so the engine takes the native-dark path.
const NATIVE = FIXTURE.replace("<head>", '<head><meta name="color-scheme" content="dark">').replace("background: #ffffff; color: #222222", "background: #111111; color: #eeeeee");

let bundle = "";
test.beforeAll(async () => {
  bundle = await engineBundle();
});

async function open(page: Page, html: string, dimImages: boolean, mode: Mode = "full"): Promise<void> {
  await page.emulateMedia({ colorScheme: "light" });
  await page.route("http://dusk.test/**", (route) =>
    route.request().url().endsWith("/assets/photo.png") ? route.fulfill({ contentType: "image/png", body: PHOTO }) : route.fulfill({ contentType: "text/html", body: html }),
  );
  await page.goto("http://dusk.test/absolute-picture.html");
  await page.addScriptTag({ content: bundle });
  await page.evaluate(async ({ dimImages, mode }) => {
    const D = (window as unknown as { Dusk: DuskGlobal }).Dusk;
    const e = D.createEngine({
      doc: document,
      win: window,
      rule: { enabled: true, mode, modeIsExplicit: false, theme: "dark", respectNativeDark: true, trustNativeDark: false, dimImages, matchedHost: null },
      siteDefault: {},
      fetchResource: async () => ({ ok: false }),
      bridge: { setPromotion() {}, onSheetChange() {}, onShadowAttached() {} },
    });
    (window as unknown as { __engine: typeof e }).__engine = e;
    await e.start();
  }, { dimImages, mode });
}

const measure = (page: Page) =>
  page.evaluate(() => {
    const box = (id: string) => {
      const r = document.getElementById(id)!.getBoundingClientRect();
      return [Math.round(r.width), Math.round(r.height)];
    };
    const f = (id: string) => getComputedStyle(document.getElementById(id)!).filter;
    return {
      sizes: { inPicture: box("in-picture"), card: box("card-picture"), inBox: box("in-box"), plain: box("plain") },
      filters: { inPicture: f("in-picture"), pic: f("pic"), inBox: f("in-box"), plain: f("plain") },
    };
  });

test("dimImages keeps an absolutely positioned <img> inside an inline <picture> at its box size, dimmed once", async ({ page }) => {
  await open(page, FIXTURE, true);
  const m = await measure(page);
  expect(m.sizes.inPicture).toEqual(m.sizes.card);
  expect(m.sizes.inBox).toEqual(m.sizes.card);
  expect(m.sizes.plain).toEqual([200, 100]);
  // The <img> carries the filter; the <picture> around it doesn't, so the image isn't dimmed twice (0.75²).
  expect(m.filters).toEqual({ inPicture: "brightness(0.75)", pic: "none", inBox: "brightness(0.75)", plain: "brightness(0.75)" });
});

test("dimImages applies on a page using its own dark theme, and toggles there in place", async ({ page }) => {
  await open(page, NATIVE, true);
  expect(await page.evaluate(() => (window as unknown as { __engine: { status(): { nativeDark: string } } }).__engine.status().nativeDark)).toBe("used");
  expect((await measure(page)).filters.plain).toBe("brightness(0.75)");
  const rule = { enabled: true, mode: "full", modeIsExplicit: false, theme: "dark", respectNativeDark: true, matchedHost: null };
  await page.evaluate((r) => (window as unknown as { __engine: { update(r: unknown): Promise<unknown> } }).__engine.update({ ...r, dimImages: false }), rule);
  expect((await measure(page)).filters.plain).toBe("none");
  await page.evaluate((r) => (window as unknown as { __engine: { update(r: unknown): Promise<unknown> } }).__engine.update({ ...r, dimImages: true }), rule);
  expect((await measure(page)).filters.plain).toBe("brightness(0.75)");
  await page.evaluate(() => (window as unknown as { __engine: { stop(): void } }).__engine.stop());
  expect((await measure(page)).filters.plain).toBe("none");
  expect(await page.evaluate(() => document.querySelectorAll('style[data-dusk="dim"]').length)).toBe(0);
});

test("Simple mode keeps an absolutely positioned <img> inside an inline <picture> at its box size, re-inverted once", async ({ page }) => {
  await open(page, FIXTURE, false, "filter");
  const m = await measure(page);
  expect(m.sizes.inPicture).toEqual(m.sizes.card);
  // The <img> is inverted back itself; the <picture> around it isn't, so the img isn't sized by its empty inline box.
  expect(m.filters.inPicture).toBe("invert(1) hue-rotate(180deg)");
  expect(m.filters.pic).toBe("none");
});
