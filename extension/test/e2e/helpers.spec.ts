// The measurement helpers on hand-written pages without Duskling, so a gate can't pass because the measurement is vacuous.
import { expect, test } from "@playwright/test";
import { contrastAudit, darknessReport } from "./helpers";

const PNG_1PX = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=";

test("contrastAudit: gradients count at their worst stop, url() layers fall back to an opaque color", async ({ page }) => {
  await page.setContent(`<body style="margin:0;background:#fff;color:#000">
    <p id="grad" style="background:linear-gradient(#000,#fff);color:#fff">worst stop is white on white</p>
    <p id="ok-grad" style="background:linear-gradient(#fff,#eee)">dark on light stops</p>
    <p id="url-color" style="background:#000 url(${PNG_1PX});color:#fff">opaque color under the image</p>
    <div style="background:url(${PNG_1PX})"><p id="url-body">body color below</p></div>
  </body>`);
  const r = await contrastAudit(page);
  expect(r.total).toBe(4);
  expect(r.skipped).toBe(0);
  expect(r.passing).toBe(3);
  expect(r.failures[0]).toContain("p#grad");
});

test("contrastAudit: with no opaque background the canvas counts, dark under color-scheme: dark", async ({ page }) => {
  // CSS Color Adjust 1 §2.2: the root's used color scheme sets the canvas color (the Canvas system color).
  await page.setContent(`<html style="color-scheme:dark"><body style="margin:0;color:#ddd"><p>light on the dark canvas</p></body></html>`);
  const dark = await contrastAudit(page);
  expect(dark.passing).toBe(dark.total);
  expect(await page.evaluate(() => document.documentElement.getAttribute("style"))).toBe("color-scheme:dark");
  await page.setContent(`<body style="margin:0;color:#ddd"><p>light on the white canvas</p></body>`);
  const light = await contrastAudit(page);
  expect(light.passing).toBe(0);
  expect(await page.evaluate(() => document.documentElement.hasAttribute("style"))).toBe(false);
});

test("contrastAudit: a url() image with no opaque color anywhere below is skipped with a reason", async ({ page }) => {
  await page.setContent(`<html style="background:url(${PNG_1PX})"><body style="margin:0"><p>over an image only</p></body></html>`);
  const r = await contrastAudit(page);
  expect(r).toMatchObject({ total: 0, skipped: 1, reasons: { "url-image": 1 } });
});

test("contrastAudit: sr-only text is no candidate; shadow roots and same-origin frames are measured", async ({ page }) => {
  await page.setContent(`<body style="margin:0;background:#fff;color:#000">
    <span style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);color:#fff">hidden label</span>
    <span style="position:absolute;width:2px;height:2px;overflow:hidden;clip-path:inset(50%);color:#fff">hidden label 2</span>
    <div id="host"></div>
    <iframe srcdoc="<body style='background:#fff'><p style='color:#fefefe'>frame text</p></body>"></iframe>
  </body>`);
  await page.evaluate(() => {
    const root = document.getElementById("host")!.attachShadow({ mode: "open" });
    root.innerHTML = "<p>shadow text</p>";
    root.append("direct shadow text");
  });
  await page.frames()[1]!.waitForLoadState();
  const r = await contrastAudit(page);
  expect(r.total).toBe(3);
  expect(r.passing).toBe(2);
  expect(r.failures[0]).toContain("frame text");
});

test("darknessReport leaves image boxes out of the denominator and reports their share", async ({ page }) => {
  await page.setContent(`<body style="margin:0;background:#000">
    <div style="width:100vw;height:50vh;background:#fff url(${PNG_1PX})"></div></body>`);
  const r = await darknessReport(page);
  expect(r.darkness).toBe(1);
  expect(r.masked).toBeCloseTo(0.5, 1);
});
