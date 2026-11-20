// restoreStyleAttr (css/csp.ts) in real WebKit, which writes CSSOM changes into the style attribute lazily.
import { expect, test } from "@playwright/test";
import type { DuskGlobal } from "./engine-bundle";
import { engineBundle } from "./engine-bundle";

let bundle = "";
test.beforeAll(async () => {
  bundle = await engineBundle();
});

test("restoreStyleAttr leaves no style=\"\" behind on an element that had none, and restores an attribute byte-identical", async ({ page }) => {
  await page.setContent(`<div id="none"></div><div id="some" style="color:#333"></div>`);
  await page.addScriptTag({ content: bundle });
  const r = await page.evaluate(() => {
    const D = (window as unknown as { Dusk: DuskGlobal }).Dusk;
    const none = document.getElementById("none")!, some = document.getElementById("some")!;
    none.style.setProperty("background-color", "#111", "important");
    D.restoreStyleAttr(none, null, "");
    const css = some.style.cssText;
    some.style.setProperty("background-color", "#111", "important");
    D.restoreStyleAttr(some, "color:#333", css);
    return [none.outerHTML, some.outerHTML];
  });
  expect(r).toEqual(['<div id="none"></div>', '<div id="some" style="color:#333"></div>']);
});
