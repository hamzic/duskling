// themeSpecialFrames in real WebKit: srcdoc/about:blank same-origin documents, document.open() re-theming,
// removal, and cross-origin (opaque) frames, whose contentDocument is null (assumption: same-origin check = access).
import { expect, test } from "@playwright/test";
import type { DuskGlobal } from "./engine-bundle";
import { engineBundle } from "./engine-bundle";
import { readPng } from "../e2e/helpers";

let bundle = "";
test.beforeAll(async () => {
  bundle = await engineBundle();
});

test.beforeEach(async ({ page }) => {
  await page.setContent("<!doctype html><html><head></head><body></body></html>");
  await page.addScriptTag({ content: bundle });
  await page.evaluate(() => {
    const w = window as unknown as { calls: { doc: Document; stop: number }[]; D: DuskGlobal; stopAll?: () => void };
    w.calls = [];
    w.D = (window as unknown as { Dusk: DuskGlobal }).Dusk;
    w.stopAll = w.D.themeSpecialFrames(document, (d) => {
      const rec = { doc: d, stop: 0 };
      w.calls.push(rec);
      return () => void rec.stop++;
    });
  });
});

const settle = (page: import("@playwright/test").Page) => page.evaluate(() => new Promise((r) => setTimeout(r, 150)));

test("srcdoc iframe: final same-origin document is started; transient about:blank may also be started and is stopped", async ({ page }) => {
  const r = await page.evaluate(async () => {
    const w = window as unknown as { calls: { doc: Document; stop: number }[] };
    const f = document.createElement("iframe");
    f.setAttribute("srcdoc", "<p id=x>hi</p>");
    document.body.append(f);
    await new Promise((res) => f.addEventListener("load", res, { once: true }));
    await new Promise((res) => setTimeout(res, 100));
    const last = w.calls[w.calls.length - 1];
    return {
      count: w.calls.length,
      lastIsFinal: last?.doc === f.contentDocument,
      hasP: !!last?.doc.getElementById("x"),
      earlierStopped: w.calls.slice(0, -1).every((c) => c.stop === 1),
      lastStop: last?.stop,
    };
  });
  console.log("srcdoc start count:", r.count);
  expect(r.lastIsFinal).toBe(true);
  expect(r.hasP).toBe(true);
  expect(r.earlierStopped).toBe(true);
  expect(r.lastStop).toBe(0);
});

test("document.open()/write()/close() on an about:blank frame re-themes the same Document", async ({ page }) => {
  const r = await page.evaluate(async () => {
    const w = window as unknown as { calls: { doc: Document; stop: number }[] };
    const f = document.createElement("iframe");
    f.setAttribute("src", "about:blank");
    document.body.append(f);
    await new Promise((res) => setTimeout(res, 100));
    const before = w.calls.length;
    const d = f.contentDocument as Document;
    d.open();
    d.write("<!doctype html><html><head></head><body>x</body></html>");
    d.close();
    await new Promise((res) => setTimeout(res, 150));
    const last = w.calls[w.calls.length - 1];
    return { before, after: w.calls.length, sameDoc: last?.doc === d, lastStop: last?.stop, firstStopped: w.calls[before - 1]?.stop };
  });
  expect(r.after).toBe(r.before + 1);
  expect(r.sameDoc).toBe(true);
  expect(r.lastStop).toBe(0);
  expect(r.firstStopped).toBe(1);
});

test("removed iframe is stopped; changing src to a cross-origin URL stops theming without throwing", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  const r = await page.evaluate(async () => {
    const w = window as unknown as { calls: { doc: Document; stop: number }[] };
    const a = document.createElement("iframe");
    a.setAttribute("src", "about:blank");
    document.body.append(a);
    await new Promise((res) => setTimeout(res, 100));
    const aRec = w.calls[w.calls.length - 1];
    a.remove();
    await new Promise((res) => setTimeout(res, 50));
    const removedStop = aRec?.stop;

    const b = document.createElement("iframe");
    b.setAttribute("src", "about:blank");
    document.body.append(b);
    await new Promise((res) => setTimeout(res, 100));
    const bRec = w.calls[w.calls.length - 1];
    const startedBefore = w.calls.length;
    b.setAttribute("src", "data:text/html,<p>opaque</p>"); // opaque origin, not special
    await new Promise((res) => setTimeout(res, 200));
    const access = ((): string => {
      try {
        return b.contentDocument === null ? "null" : "doc";
      } catch {
        return "throws";
      }
    })();
    return { removedStop, bStop: bRec?.stop, noNewStart: w.calls.length === startedBefore, access };
  });
  expect(r.removedStop).toBe(1);
  expect(r.bStop).toBe(1);
  expect(r.noNewStart).toBe(true);
  expect(r.access).toBe("null");
  // WebKit itself reports every cross-origin contentDocument read as a pageerror (even a bare read, no throw reaches
  // our code: it returns null). Anything else would be our bug.
  expect(errors.filter((e) => !e.startsWith("Blocked a frame with origin"))).toEqual([]);
});

test("changing srcdoc stops the old document's theming and starts the new one; teardown stops all", async ({ page }) => {
  const r = await page.evaluate(async () => {
    const w = window as unknown as { calls: { doc: Document; stop: number }[]; stopAll: () => void };
    const f = document.createElement("iframe");
    f.setAttribute("srcdoc", "<p>one</p>");
    document.body.append(f);
    await new Promise((res) => setTimeout(res, 150));
    const n1 = w.calls.length;
    f.setAttribute("srcdoc", "<p>two</p>");
    await new Promise((res) => setTimeout(res, 150));
    const last = w.calls[w.calls.length - 1];
    const res = { grew: w.calls.length > n1, lastIsTwo: last?.doc.body.textContent === "two", prevStopped: w.calls[n1 - 1]?.stop };
    w.stopAll();
    return { ...res, allStoppedOnce: w.calls.every((c) => c.stop === 1) };
  });
  expect(r.grew).toBe(true);
  expect(r.lastIsTwo).toBe(true);
  expect(r.prevStopped).toBe(1);
  expect(r.allStoppedOnce).toBe(true);
  await settle(page);
});

// Seen on digi.no: an ad frame flashed white while it loaded. A frame whose page is still light gets an
// opaque Canvas when its color scheme differs from the iframe element's (CSS Color Adjust 1 §2.2); the root styles give
// iframes the default scheme, so the frame stays transparent over the dark page.
test("a light frame inside a themed page shows the page's dark background, not white", async ({ page }) => {
  await page.setContent('<!doctype html><html><head><style>html,body{margin:0}</style></head><body><iframe style="border:0;width:300px;height:300px" srcdoc="<p>ad</p>"></iframe></body></html>');
  await page.addScriptTag({ content: bundle });
  await page.evaluate(() => {
    const D = (window as unknown as { Dusk: DuskGlobal }).Dusk;
    D.applyRootStyles(document, D.PALETTES.dark, { nativeDark: false });
  });
  await page.waitForTimeout(100);
  const png = await page.screenshot({ clip: { x: 250, y: 250, width: 10, height: 10 } });
  const img = readPng(png);
  expect(Math.max(img.data[0]!, img.data[1]!, img.data[2]!)).toBeLessThan(60);
});
