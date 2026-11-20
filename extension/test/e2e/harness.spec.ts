// Smoke tests for the e2e harness: the real bundles, injected the way Safari would, theme the fixtures; storage lives
// on the Node side; fetchResource goes through the real background handler; every http(s) frame gets its own script.
import { expect, test } from "@playwright/test";
import type { Frame, Page } from "@playwright/test";
import { makeSettings, openThemed, setSettings } from "./helpers";

/** Relative luminance of the computed body background (any CSS color syntax, painted onto a canvas). */
function bodyLuminance(target: Page | Frame): Promise<number> {
  return target.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = c.height = 1;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = getComputedStyle(document.body).backgroundColor;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b] = Array.from(ctx.getImageData(0, 0, 1, 1).data).map((v) => {
      const s = v / 255;
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  });
}

test("basic-article is themed: html[data-dusk-ready] and a dark body", async ({ page }) => {
  await openThemed(page, "basic-article");
  await expect(page.locator("html[data-dusk-ready]")).toHaveCount(1);
  expect(await bodyLuminance(page)).toBeLessThan(0.1);
});

test("setSettings reaches the open page through storage.onChanged and survives navigation", async ({ page }) => {
  await openThemed(page, "basic-article");
  const dark = await bodyLuminance(page);
  await setSettings(page, makeSettings({ theme: "midnight" }));
  await expect.poll(() => bodyLuminance(page)).toBeLessThan(dark);
  const midnight = await bodyLuminance(page);
  await page.reload();
  await page.waitForSelector("html[data-dusk-ready]", { state: "attached" });
  await expect.poll(() => bodyLuminance(page)).toBeCloseTo(midnight, 5);
  // Off for this host: the planner registers nothing for it, so a reload is unthemed.
  await setSettings(page, makeSettings({ sites: { localhost: { mode: "off" } } }));
  await page.reload();
  await expect.poll(() => bodyLuminance(page)).toBeGreaterThan(0.9);
});

test("cross-origin CSS is refetched through fetchResource", async ({ page }) => {
  await openThemed(page, "cross-origin-css");
  const cardBg = await page.locator(".card").first().evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(cardBg).not.toBe("rgb(248, 249, 250)");
  expect(await bodyLuminance(page)).toBeLessThan(0.1);
});

test("the cross-origin frame runs its own content script", async ({ page }) => {
  await openThemed(page, "iframes");
  const cross = page.frames().find((f) => f.url().startsWith("http://localhost:4101/"));
  expect(cross).toBeDefined();
  await expect.poll(() => cross!.evaluate(() => document.documentElement.hasAttribute("data-dusk-ready"))).toBe(true);
  expect(await bodyLuminance(cross!)).toBeLessThan(0.1);
});

test("a synchronous head script already sees the pre-paint style", async ({ page }) => {
  await openThemed(page, "slow-css", undefined, { waitUntil: "commit" });
  await page.waitForFunction(() => "__prepaintAtFirstScript" in window);
  expect(await page.evaluate(() => (window as { __prepaintAtFirstScript?: boolean }).__prepaintAtFirstScript)).toBe(true);
});

test("the fixture server answers a malformed path escape with 400", async ({ request }) => {
  expect((await request.get("http://localhost:4100/%E0%A4%A")).status()).toBe(400);
});
