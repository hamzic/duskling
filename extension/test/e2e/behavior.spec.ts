// Behavior gates: native dark detection and promotion, images, frames, print, the mode ladder,
// SPA mutations, the back/forward cache, and the contrast-repair heuristics, each on its fixture page in Playwright WebKit.
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import {
  contrastAudit,
  cssLightness,
  darkness,
  fixtureUrl,
  lightness,
  luminanceShare,
  makeSettings,
  maxChannelDiff,
  openThemed,
  pageStatus,
  readPng,
  setSettings,
  settle,
  waitForIdle,
} from "./helpers";

const SHEET = '[data-dusk="sheet"]';
const count = (page: Page, sel: string) => page.locator(sel).count();
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

/** The same fixture without Duskling, in a fresh page of the same context (same viewport and device). */
async function unthemed(page: Page, fixture: string): Promise<Page> {
  const p = await page.context().newPage();
  await p.emulateMedia({ colorScheme: "light" });
  await p.goto(fixtureUrl(fixture), { waitUntil: "load" });
  await waitForIdle(p);
  return p;
}

test.describe("native dark", () => {
  test("native-dark-media: the media-query theme is promoted, status used, no override sheets", async ({ page }) => {
    await openThemed(page, "native-dark-media");
    expect((await pageStatus(page))?.nativeDark).toBe("used");
    expect(await count(page, SHEET)).toBe(0);
    expect(await count(page, 'style[data-dusk="native"]')).toBe(1);
    expect(await darkness(page)).toBeGreaterThanOrEqual(0.9);
  });

  test("native-dark-media-late: dark rules from a link and CSSOM inserts after the verdict are promoted too", async ({ page }) => {
    await openThemed(page, "native-dark-media-late");
    expect((await pageStatus(page))?.nativeDark).toBe("used");
    const bg = (sel: string) => page.evaluate((s) => getComputedStyle(document.querySelector(s)!).backgroundColor, sel);
    // The site's own dark colors (late-dark.css and the inserted rule), which neither theming nor contrast repair produce.
    await expect.poll(() => bg(".late-panel")).toBe("rgb(30, 28, 20)");
    await expect.poll(() => bg(".js-panel")).toBe("rgb(20, 28, 38)");
    expect(await count(page, 'style[data-dusk="native"]')).toBe(1);
    expect(await count(page, SHEET)).toBe(0);
  });

  test("native-dark-root-class: a dark theme on an atomic class of html is promoted", async ({ page }) => {
    await openThemed(page, "native-dark-root-class");
    expect((await pageStatus(page))?.nativeDark).toBe("used");
    expect(await count(page, SHEET)).toBe(0);
    expect(await darkness(page)).toBeGreaterThanOrEqual(0.9);
    expect((await contrastAudit(page)).failures).toEqual([]);
  });

  test("declared-dark-canvas: a declared dark scheme with no background (the dark canvas) is the site's own theme", async ({ page }) => {
    await openThemed(page, "declared-dark-canvas");
    expect((await pageStatus(page))?.nativeDark).toBe("used");
    expect(await count(page, SHEET)).toBe(0);
    expect(await darkness(page)).toBeGreaterThanOrEqual(0.9);
  });

  test("declared-dark-white: a page that declares dark but paints white is themed by Duskling", async ({ page }) => {
    await openThemed(page, "declared-dark-white");
    expect((await pageStatus(page))?.nativeDark).toBe("overridden");
    expect(await count(page, SHEET)).toBeGreaterThan(0);
    expect(await darkness(page)).toBeGreaterThanOrEqual(0.9);
  });

  test('declared-dark-white with the site rule nativeDark "use": the site\'s own theme is followed', async ({ page }) => {
    await openThemed(page, "declared-dark-white", makeSettings({ sites: { localhost: { nativeDark: "use" } } }));
    expect((await pageStatus(page))?.nativeDark).toBe("used");
    expect(await count(page, SHEET)).toBe(0);
  });

  test('native-dark-media with the site override nativeDark "ignore": overrides are present', async ({ page }) => {
    await openThemed(page, "native-dark-media", makeSettings({ sites: { localhost: { nativeDark: "ignore" } } }));
    expect((await pageStatus(page))?.nativeDark).not.toBe("used");
    expect(await count(page, 'style[data-dusk="native"]')).toBe(0);
    expect(await count(page, SHEET)).toBeGreaterThan(0);
  });

  test("native-dark-class: an already-dark page gets no overrides", async ({ page }) => {
    await openThemed(page, "native-dark-class");
    expect((await pageStatus(page))?.nativeDark).toBe("used");
    expect(await count(page, SHEET)).toBe(0);
    expect(await page.locator("[style*='--dusk'], [style*='important']").count()).toBe(0);
  });

  test("native-dark-class-toggle: html.dark is applied, status used; the site removing it falls back to Full", async ({ page }) => {
    await openThemed(page, "native-dark-class-toggle");
    expect((await pageStatus(page))?.nativeDark).toBe("used");
    expect(await page.evaluate(() => document.documentElement.classList.contains("dark"))).toBe(true);
    expect(await count(page, SHEET)).toBe(0);
    expect(await darkness(page)).toBeGreaterThanOrEqual(0.9);
    await page.evaluate(() => (window as unknown as { setTheme(d: boolean): void }).setTheme(false));
    await expect.poll(async () => (await pageStatus(page))?.nativeDark).toBe("none");
    await expect.poll(() => count(page, SHEET)).toBeGreaterThan(0);
    await waitForIdle(page);
    expect(await page.evaluate(() => document.documentElement.classList.contains("dark"))).toBe(false);
    expect(await darkness(page)).toBeGreaterThanOrEqual(0.9);
  });

  test("native-dark-class-toggle-bs: a few rules of many custom properties promote [data-bs-theme=dark]", async ({ page }) => {
    await openThemed(page, "native-dark-class-toggle-bs");
    expect((await pageStatus(page))?.nativeDark).toBe("used");
    expect(await page.evaluate(() => document.documentElement.getAttribute("data-bs-theme"))).toBe("dark");
    expect(await count(page, SHEET)).toBe(0);
    expect(await darkness(page)).toBeGreaterThanOrEqual(0.9);
  });
});

test.describe("strict CSP style-src", () => {
  test("csp-strict: themed through constructed sheets in every mode, and off restores the page's CSSOM styles", async ({ page }) => {
    const mode = async () => (await pageStatus(page))?.mode;
    await openThemed(page, "csp-strict");
    // The fixture reproduces the block: Duskling's <style> nodes get no sheet.
    expect(await page.evaluate(() => [...document.querySelectorAll("style[data-dusk]")].every((s) => !(s as HTMLStyleElement).sheet))).toBe(true);
    expect(await darkness(page)).toBeGreaterThanOrEqual(0.9);
    expect(await cssLightness(page, await page.evaluate(() => getComputedStyle(document.getElementById("cssom-card")!).backgroundColor))).toBeLessThan(0.4);

    await setSettings(page, makeSettings({ sites: { localhost: { mode: "filter" } } }));
    await expect.poll(mode).toBe("filter");
    await waitForIdle(page);
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).filter)).toContain("invert");

    await setSettings(page, makeSettings({ sites: { localhost: { mode: "off" } } }));
    await expect.poll(mode).toBe("off");
    await waitForIdle(page);
    const after = await page.evaluate(() => ({
      css: document.getElementById("cssom-card")!.style.cssText,
      orig: (window as unknown as { cssomCardCss: string }).cssomCardCss,
      adopted: document.adoptedStyleSheets.length,
      htmlBg: getComputedStyle(document.documentElement).backgroundColor,
    }));
    expect(after.css).toBe(after.orig);
    expect(after.adopted).toBe(0);
    expect(after.htmlBg).toBe("rgb(255, 255, 255)");
  });
});

test.describe("images", () => {
  test("images: photo pixels unchanged (± 3 per channel), the dark logo gets the invert marker", async ({ page }) => {
    await openThemed(page, "images");
    await expect(page.locator("#logo-dark")).toHaveAttribute("data-dusk-img", "invert");
    const ref = await unthemed(page, "images");
    // Element screenshots: the fixtures have no viewport meta, so the iPhone layout viewport is zoomed out (980 px) and
    // CSS-px clips don't map 1:1 to screenshot pixels.
    const [a, b] = [await page.locator("#photo").screenshot(), await ref.locator("#photo").screenshot()];
    // An element screenshot is rounded out to whole CSS px, so at a fractional position its outer CSS px holds some of
    // the (themed) background behind the box: that frame (one CSS px in screenshot pixels) is not photo pixels.
    const px = Math.ceil(readPng(a).width / (await page.locator("#photo").evaluate((el) => el.getBoundingClientRect().width)));
    expect(maxChannelDiff(a, b, px)).toBeLessThanOrEqual(3);
    expect(await page.locator("#photo").evaluate((el) => getComputedStyle(el).filter)).toBe("none");
    await ref.close();
  });

  test("sprites-pseudo: every icon renders light on the dark page and its host has no filter", async ({ page }) => {
    await openThemed(page, "sprites-pseudo");
    await waitForIdle(page);
    const icons: [string, string | null][] = [
      ["#icon-home", "::before"],
      ["#icon-star", "::before"],
      ["#icon-ext", "::after"],
      ["#sprite-search", null],
      ["#sprite-menu", null],
      ["#sprite-close", null],
      ["#sprite-plus", null],
      ["#btn-close", "::before"],
    ];
    for (const [sel, pseudo] of icons) {
      const host = page.locator(sel);
      expect(await host.evaluate((el) => getComputedStyle(el).filter), `${sel} filter`).toBe("none");
      // Only the icon is ink: the host's own text is made transparent for the shot (the pseudo-element's or sprite's
      // background image doesn't use `color`), and the li's bottom border stays outside the host box.
      if (pseudo) await host.evaluate((el) => (el as HTMLElement).style.setProperty("color", "transparent", "important"));
      const ls = lightness(await host.screenshot());
      if (pseudo) await host.evaluate((el) => (el as HTMLElement).style.removeProperty("color"));
      const bg = median(ls);
      const ink = ls.filter((l) => Math.abs(l - bg) > 0.1);
      expect(ink.length, `${sel} has visible ink`).toBeGreaterThan(0);
      expect(mean(ink), `${sel} ink lightness`).toBeGreaterThan(0.6);
      expect(bg, `${sel} sits on a dark background`).toBeLessThan(0.5);
    }
  });

  test("blend-modes: the multiply product image stays visible (mean L of its box > 0.3)", async ({ page }) => {
    await openThemed(page, "blend-modes");
    await waitForIdle(page);
    expect(mean(lightness(await page.locator("#product").screenshot()))).toBeGreaterThan(0.3);
  });

  test("swatches-charts: swatch, dot and chart fills are byte-identical, avatars and axis text are themed", async ({ page }) => {
    await openThemed(page, "swatches-charts");
    const ref = await unthemed(page, "swatches-charts");
    const read = (p: Page) =>
      p.evaluate(() => ({
        swatches: [...document.querySelectorAll(".swatch, .dot")].map((e) => getComputedStyle(e).backgroundColor),
        bars: [...document.querySelectorAll("#chart .bar")].map((e) => getComputedStyle(e).fill),
        avatars: [...document.querySelectorAll(".avatar")].map((e) => getComputedStyle(e).backgroundColor),
        axis: [...document.querySelectorAll("#chart .axis")].map((e) => getComputedStyle(e).fill),
      }));
    const [themed, plain] = [await read(page), await read(ref)];
    expect(themed.swatches).toEqual(plain.swatches);
    expect(themed.bars).toEqual(plain.bars);
    expect(themed.swatches).toHaveLength(8);
    expect(themed.bars).toHaveLength(5);
    themed.avatars.forEach((c, i) => expect(c, `avatar ${i}`).not.toBe(plain.avatars[i]));
    for (const c of themed.axis) expect(await cssLightness(page, c)).toBeGreaterThan(0.6);
    await ref.close();
  });

  test("textures-overlays: darkness ≥ 0.9, the light banner included", async ({ page }) => {
    await openThemed(page, "textures-overlays");
    await waitForIdle(page);
    expect(await darkness(page)).toBeGreaterThanOrEqual(0.9);
    // darkness() leaves url() background boxes out, so the large light banner (light large image) is checked on its
    // own with the same criterion.
    expect(luminanceShare(await page.locator(".banner").screenshot(), (l) => l < 0.3)).toBeGreaterThanOrEqual(0.9);
  });
});

test.describe("frames, print and layout", () => {
  test("iframes: srcdoc, about:blank and the cross-origin 4101 frame are dark, with no page errors", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await openThemed(page, "iframes");
    const cross = page.frames().find((f) => f.url().startsWith("http://localhost:4101/"))!;
    await expect.poll(() => cross.evaluate(() => document.documentElement.hasAttribute("data-dusk-ready"))).toBe(true);
    await waitForIdle(page);
    for (const id of ["srcdoc", "blank", "cross", "same"]) {
      const png = await page.locator(`#${id}`).screenshot();
      expect(luminanceShare(png, (l) => l < 0.3), `#${id} dark share`).toBeGreaterThanOrEqual(0.9);
    }
    expect(errors).toEqual([]);
  });

  test("print: the themed page prints exactly like the unthemed one", async ({ page }) => {
    await openThemed(page, "print");
    const ref = await unthemed(page, "print");
    await page.emulateMedia({ media: "print" });
    await ref.emulateMedia({ media: "print" });
    const [a, b] = [await page.screenshot({ fullPage: true }), await ref.screenshot({ fullPage: true })];
    expect(maxChannelDiff(a, b)).toBe(0);
    await ref.close();
  });

  test("fixed-position in filter mode: the fixed header stays at top 0 after scrolling 1,000 px", async ({ page }) => {
    await openThemed(page, "fixed-position", makeSettings({ sites: { localhost: { mode: "filter" } } }));
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).filter)).not.toBe("none");
    const top = async (p: Page) => {
      await p.evaluate(() => window.scrollTo(0, 1000));
      await waitForIdle(p);
      expect(await p.evaluate(() => window.scrollY), "the page scrolled").toBeGreaterThan(900);
      return p.locator("#header").evaluate((el) => el.getBoundingClientRect().top);
    };
    // The zoomed-out iPhone layout viewport (no viewport meta) leaves sub-pixel noise in the rect; a header that isn't
    // fixed any more (filter on html makes it the containing block) would be at about -1000.
    const ref = await unthemed(page, "fixed-position");
    const [themed, plain] = [await top(page), await top(ref)];
    expect(themed).toBeCloseTo(plain, 2);
    expect(Math.abs(themed)).toBeLessThan(0.5);
    await ref.close();
  });
});

test.describe("mode ladder, mutations and navigation", () => {
  test("mode ladder full → gentle → filter → off through storage, without reload; off restores the DOM", async ({ page }) => {
    const fixture = "basic-article";
    const ref = await unthemed(page, fixture);
    const original = await ref.evaluate(() => document.documentElement.outerHTML);
    await ref.close();
    await openThemed(page, fixture);
    await page.evaluate(() => ((window as unknown as { __sameDocument: boolean }).__sameDocument = true));
    const mode = async () => (await pageStatus(page))?.mode;
    expect(await mode()).toBe("full");
    expect(await count(page, SHEET)).toBeGreaterThan(0);
    expect(await count(page, 'style[data-dusk="img"]')).toBe(1);

    await setSettings(page, makeSettings({ sites: { localhost: { mode: "gentle" } } }));
    await expect.poll(mode).toBe("gentle");
    await waitForIdle(page);
    expect(await count(page, SHEET)).toBeGreaterThan(0);
    expect(await count(page, 'style[data-dusk="img"]')).toBe(0);
    expect(await darkness(page)).toBeGreaterThanOrEqual(0.9);

    await setSettings(page, makeSettings({ sites: { localhost: { mode: "filter" } } }));
    await expect.poll(mode).toBe("filter");
    await waitForIdle(page);
    expect(await count(page, SHEET)).toBe(0);
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).filter)).toContain("invert");

    await setSettings(page, makeSettings({ sites: { localhost: { mode: "off" } } }));
    await expect.poll(mode).toBe("off");
    await waitForIdle(page);
    expect(await page.evaluate(() => (window as unknown as { __sameDocument?: boolean }).__sameDocument)).toBe(true);
    // What stays is the registered pre-paint style (a user stylesheet in Safari, a <style> in this harness) and
    // data-dusk-ready, which keeps it off (engine stop() contract). The JS twin's <style> goes.
    expect(await count(page, 'style[data-dusk="prepaint"]')).toBe(0);
    const after = await page.evaluate(() => {
      const root = document.documentElement.cloneNode(true) as Element;
      root.removeAttribute("data-dusk-ready");
      for (const n of root.querySelectorAll('style[data-dusk="prepaint-css"]')) n.remove();
      return root.outerHTML;
    });
    expect(after).toBe(original);
  });

  test("spa-mutations: after 50 content swaps the page is dark and override sheets don't pile up", async ({ page }) => {
    await openThemed(page, "spa-mutations");
    for (let i = 0; i < 50; i++) {
      await page.evaluate(() => (window as unknown as { swap(): void }).swap());
      if (i % 10 === 9) await page.evaluate(() => new Promise((r) => requestAnimationFrame(r)));
    }
    await waitForIdle(page);
    expect(await page.evaluate(() => (window as unknown as { swapCount: number }).swapCount)).toBe(51);
    const sources = await page.locator('style:not([data-dusk]), link[rel="stylesheet"]').count();
    expect(await count(page, SHEET)).toBeLessThanOrEqual(sources);
    expect(await darkness(page)).toBeGreaterThanOrEqual(0.9);
  });

  test("bfcache: a theme changed while the page was away is applied after goBack (logged)", async ({ page }, info) => {
    await page.addInitScript(() => {
      const w = window as unknown as { __pageshows?: boolean[] };
      w.__pageshows = [];
      addEventListener("pageshow", (e) => w.__pageshows!.push((e as PageTransitionEvent).persisted));
    });
    await openThemed(page, "basic-article");
    const bodyBg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    const dark = await bodyBg();
    await page.goto(fixtureUrl("print"));
    await page.waitForSelector("html[data-dusk-ready]", { state: "attached" });
    await setSettings(page, makeSettings({ theme: "midnight" }));
    await page.goBack();
    await page.waitForSelector("html[data-dusk-ready]", { state: "attached" });
    await expect.poll(async () => (await pageStatus(page))?.theme).toBe("midnight");
    await expect.poll(bodyBg).not.toBe(dark);
    const shows = await page.evaluate(() => (window as unknown as { __pageshows: boolean[] }).__pageshows);
    const persisted = shows.includes(true);
    info.annotations.push({ type: "A16", description: `pageshow.persisted on goBack: ${persisted} (events ${JSON.stringify(shows)})` });
    console.log(`A16: pageshow.persisted on goBack = ${persisted}; pageshow events ${JSON.stringify(shows)}`);
  });
});

test.describe("contrast repair", () => {
  test("channel-tokens: rgb()/hsl() over triple variables is themed by the override sheets, with nothing left to repair", async ({ page }) => {
    await openThemed(page, "channel-tokens");
    const color = (sel: string, prop: "color" | "backgroundColor") =>
      page.evaluate(([s, p]) => getComputedStyle(document.querySelector(s!)!)[p as "color"], [sel, prop]);
    for (const sel of ["h1", ".body p", ".top-bar .name", ".subtitle"]) expect(await cssLightness(page, await color(sel, "color"))).toBeGreaterThan(0.7);
    expect(await cssLightness(page, await color(".top-bar", "color"))).toBeGreaterThan(0.7);
    expect(await cssLightness(page, await color(".banner", "backgroundColor"))).toBeLessThan(0.4);
    // The fixture has no style attributes: any one is an inline override, i.e. the sheets missed the variable.
    expect(await page.evaluate(() => [...document.querySelectorAll("body [style]")].map((e) => e.outerHTML.slice(0, 80)))).toEqual([]);
  });

  test("svg-backdrop: an illustration's full-size backdrop shape takes the background transform, icons and ink don't", async ({ page }) => {
    await openThemed(page, "svg-backdrop");
    const fill = (id: string) => page.evaluate((i) => getComputedStyle(document.getElementById(i)!).fill, id);
    expect(await cssLightness(page, await fill("hero-bg"))).toBeLessThan(0.4);
    expect(await cssLightness(page, await fill("panel-bg"))).toBeLessThan(0.4);
    // Drawn into the <svg> by script after load.
    await expect.poll(async () => cssLightness(page, await fill("late-bg"))).toBeLessThan(0.4);
    // Overhanging the screen: coverage of the visible part counts.
    expect(await cssLightness(page, await fill("wide-bg"))).toBeLessThan(0.4);
    // No layout at the first check, shown later by an attribute change: the check is repeated.
    await expect.poll(async () => cssLightness(page, await fill("shown-bg")), { timeout: 4000 }).toBeLessThan(0.4);
    // A 24 px icon's shapes stay foreground: white stays light.
    expect(await cssLightness(page, await fill("icon-bg"))).toBeGreaterThan(0.8);
    expect(await darkness(page)).toBeGreaterThanOrEqual(0.9);
  });

  test("settle waits for the repair of text added after load, so measurements see the repaired page", async ({ page }) => {
    // On the site's own dark theme only the contrast-repair pass fixes text (no theming); it runs 300 ms after the mutation.
    await openThemed(page, "native-dark-media");
    expect((await pageStatus(page))?.nativeDark).toBe("used");
    await page.evaluate(() => {
      const p = document.createElement("p");
      p.style.cssText = "color:#717171;background:#272727";
      p.textContent = "Late low-contrast text";
      document.querySelector("main")!.append(p);
    });
    await settle(page);
    const c = await contrastAudit(page);
    expect(c.failures).toEqual([]);
  });

  test("missed-surfaces: no visible light surface is left after the repair pass, the image box excepted", async ({ page }) => {
    await openThemed(page, "missed-surfaces");
    await page.waitForSelector("html[data-fixture-late]", { state: "attached" });
    const light = () =>
      page.evaluate(() => {
        const cv = document.createElement("canvas");
        cv.width = cv.height = 1;
        const ctx = cv.getContext("2d", { willReadFrequently: true })!;
        const lin = (v: number) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
        const L = (c: string) => {
          ctx.clearRect(0, 0, 1, 1);
          ctx.fillStyle = "rgba(0,0,0,0)";
          ctx.fillStyle = c;
          ctx.fillRect(0, 0, 1, 1);
          const [r, g, b, a] = [...ctx.getImageData(0, 0, 1, 1).data].map((x, i) => (i < 3 ? lin(x!) : x! / 255)) as [number, number, number, number];
          if (a === 0) return 0;
          const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
          const m = Math.cbrt(0.2119034982 * r + 0.6806995457 * g + 0.1073969561 * b);
          const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
          return 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
        };
        // A translucent background is judged by what it composites to over the surface below it.
        const surface = new Map<Element | null, string>([[null, "rgb(255,255,255)"]]);
        const under = (el: Element): string => {
          const p = el.parentElement ?? ((el.parentNode as ShadowRoot | null)?.host ?? null);
          if (!surface.has(p)) surface.set(p, effective(p!));
          return surface.get(p)!;
        };
        const effective = (el: Element): string => {
          const c = getComputedStyle(el).backgroundColor;
          ctx.clearRect(0, 0, 1, 1);
          ctx.fillStyle = under(el);
          ctx.fillRect(0, 0, 1, 1);
          ctx.fillStyle = c;
          ctx.fillRect(0, 0, 1, 1);
          const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
          return `rgb(${r},${g},${b})`;
        };
        const out: string[] = [];
        const visit = (root: Document | ShadowRoot) => {
          for (const el of root.querySelectorAll("*")) {
            if (el.shadowRoot) visit(el.shadowRoot);
            if (el.id === "imgbox") continue;
            const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
            if (r.width < 1 || r.height < 1 || cs.visibility !== "visible") continue;
            const own = cs.backgroundColor;
            if (L(own) > 0.8 && L(effective(el)) > 0.8) out.push(`${el.localName}${el.id ? "#" + el.id : ""} ${own}`);
          }
        };
        visit(document);
        return out;
      });
    await expect.poll(light, { timeout: 5000 }).toEqual([]);
    // The closed shadow root is out of reach of the query above: its card is checked in pixels (the surface, not the
    // text and border, is the median of the inner box).
    await expect.poll(async () => median(lightness(await page.locator("#closed-host").screenshot()))).toBeLessThanOrEqual(0.8);
  });
});
