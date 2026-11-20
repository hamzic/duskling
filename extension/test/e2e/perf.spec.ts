// Perf gates: time to fully themed on heavy.html, and the white frame while CSS is delayed.
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { fixtureUrl, openThemed, setFetchDelay, waitForIdle, whiteShare } from "./helpers";

test("heavy: dusk:themed − domContentLoadedEventEnd ≤ 60 ms (median of 7 loads)", async ({ page }, info) => {
  // The engine's DOMContentLoaded work runs inside the event's dispatch (its listener resumes the awaiting start() in the
  // microtask checkpoint after the callback), so it ends before domContentLoadedEventEnd and this measures ~0 ms. The
  // time from domContentLoadedEventStart, which includes that work, is recorded too.
  const end: number[] = [];
  const start: number[] = [];
  for (let i = 0; i < 7; i++) {
    await openThemed(page, "heavy");
    const [e, s] = await page.evaluate(() => {
      const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming;
      const themed = performance.getEntriesByName("dusk:themed", "mark")[0]!;
      return [themed.startTime - nav.domContentLoadedEventEnd, themed.startTime - nav.domContentLoadedEventStart];
    });
    end.push(e!);
    start.push(s!);
  }
  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[3]!;
  info.annotations.push({
    type: "measured",
    description: `after DCL end ${end.map((d) => d.toFixed(1)).join(", ")} ms (median ${median(end).toFixed(1)}); after DCL start ${start.map((d) => d.toFixed(1)).join(", ")} ms (median ${median(start).toFixed(1)})`,
  });
  expect(median(end)).toBeLessThanOrEqual(60);
});

/** A screenshot as soon as slow.css has loaded and applied (the next animation frame after its `load`). */
async function arrival(p: Page): Promise<Buffer> {
  await p.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const poll = (): void => {
          const link = document.querySelector<HTMLLinkElement>('link[href*="slow.css"]');
          if (link?.sheet) requestAnimationFrame(() => resolve());
          else if (link) link.addEventListener("load", () => requestAnimationFrame(() => resolve()), { once: true });
          else requestAnimationFrame(poll);
        };
        poll();
      }),
  );
  const png = await p.screenshot();
  expect(await p.evaluate(() => getComputedStyle(document.querySelector(".panel")!).borderTopStyle)).not.toBe("none");
  return png;
}

test("slow-css: whiteShare ≤ 0.05 at 200 ms while the stylesheet is delayed 1 s, when it arrives, and settled", async ({ page }, info) => {
  /** A screenshot 200 ms after the navigation commits, with slow.css still pending (it gives .panel a border). */
  const at200 = async (p: Page): Promise<Buffer> => {
    const committed = Date.now();
    await p.waitForTimeout(Math.max(0, 200 - (Date.now() - committed)));
    const png = await p.screenshot();
    expect(Date.now() - committed, "the frame was taken well before the stylesheet arrives").toBeLessThan(600);
    expect(await p.evaluate(() => getComputedStyle(document.querySelector(".panel")!).borderTopStyle)).toBe("none");
    return png;
  };
  await openThemed(page, "slow-css", undefined, { waitUntil: "commit" });
  const png = await at200(page);
  await info.attach("slow-css-200ms.png", { body: png, contentType: "image/png" });
  // The same frame without Duskling is white, so the fixture does open the window this gate is about.
  const ref = await page.context().newPage();
  await ref.goto(fixtureUrl("slow-css"), { waitUntil: "commit" });
  const plain = await at200(ref);
  await ref.close();
  info.annotations.push({ type: "measured", description: `whiteShare ${whiteShare(png).toFixed(4)} themed, ${whiteShare(plain).toFixed(4)} unthemed` });
  expect(whiteShare(plain)).toBeGreaterThan(0.5);
  expect(whiteShare(png)).toBeLessThanOrEqual(0.05);

  // The frame where the white sheet arrives: pre-paint is gone by then (ready is set at DOMContentLoaded), so only the
  // engine rewriting the new sheet keeps it dark. Screenshot as soon as the link has loaded, then once the engine is idle.
  const arrived = await arrival(page);
  await waitForIdle(page);
  const settled = await page.screenshot();
  // Without Duskling the same moment is white, so this frame is one where a flash would show.
  const ref2 = await page.context().newPage();
  await ref2.goto(fixtureUrl("slow-css"), { waitUntil: "commit" });
  const plainArrived = await arrival(ref2);
  await ref2.close();
  expect(whiteShare(plainArrived)).toBeGreaterThan(0.5);
  await info.attach("slow-css-arrived.png", { body: arrived, contentType: "image/png" });
  info.annotations.push({ type: "measured", description: `whiteShare ${whiteShare(arrived).toFixed(4)} on arrival, ${whiteShare(settled).toFixed(4)} settled` });
  expect(whiteShare(arrived)).toBeLessThanOrEqual(0.05);
  expect(whiteShare(settled)).toBeLessThanOrEqual(0.05);
});

// Seen on nrk.no: a light frame between pages. A cross-origin sheet applies to the page as soon as it
// loads, while its rewrite waits for the background fetch, so the pre-paint is held until that rewrite is written.
test("cross-origin css: no light frame when ready is set while the background fetch is slow", async ({ page }) => {
  setFetchDelay(page, 400);
  await openThemed(page, "cross-origin-css", undefined, { waitUntil: "commit" });
  await page.waitForSelector("html[data-dusk-ready]", { state: "attached" });
  expect(whiteShare(await page.screenshot())).toBeLessThanOrEqual(0.05);
});

test("cross-origin css: the pre-paint hold ends after 1 s when the fetch doesn't come back", async ({ page }) => {
  setFetchDelay(page, 5000);
  await openThemed(page, "cross-origin-css", undefined, { waitUntil: "commit" });
  await page.waitForSelector("html[data-dusk-ready]", { state: "attached", timeout: 4000 });
  const held = await page.evaluate(() => performance.now() - (performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming).domContentLoadedEventStart);
  expect(held).toBeLessThan(1500);
});

// Seen on nrk.no article pages: boxes styled by a cross-origin sheet painted light until the background
// fetch returned. Until ready the pre-paint gives the content plain dark defaults.
test("cross-origin head css: no light frame while the background fetch is slow, and content shows once themed", async ({ page }) => {
  setFetchDelay(page, 400);
  await openThemed(page, "cross-origin-boxes", undefined, { waitUntil: "commit" });
  const frames: number[] = [];
  const t0 = Date.now();
  while (Date.now() - t0 < 1200) frames.push(whiteShare(await page.screenshot()));
  expect(Math.max(...frames)).toBeLessThanOrEqual(0.05);
  await page.waitForSelector("html[data-dusk-ready]", { state: "attached" });
  expect(await page.evaluate(() => getComputedStyle(document.body).opacity)).toBe("1");
});
