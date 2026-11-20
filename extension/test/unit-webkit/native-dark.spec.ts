// Cases that need real WebKit: layout + elementsFromPoint, StyleSheet.disabled in the cascade, real MediaList on
// `<style media>`, @layer and CSS nesting (happy-dom lacks all of these).
import { expect, test } from "@playwright/test";
import type { DuskGlobal } from "./engine-bundle";
import { engineBundle } from "./engine-bundle";

let bundle = "";
test.beforeAll(async () => {
  bundle = await engineBundle();
});

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
});

// A white page with Duskling mid-flight: pre-paint CSS (verbatim selector), an engine override `<style data-dusk>`, an adopted
// constructed sheet marked Symbol.for("dusk.own") and an inline `!important` background override on a card.
const BG = "rgb(30, 32, 36)";
const PAGE = `<!doctype html><html><head>
<style>html,body{margin:0;background-color:#fff}.card{width:100vw;height:100vh;background-color:#fff}</style>
<style id="pre">@media screen {
  html:not([data-dusk-ready]):not([data-dusk-sampling]) { background-color: ${BG} !important; color-scheme: dark !important; }
  html:not([data-dusk-ready]):not([data-dusk-sampling]) body { background-color: ${BG} !important; color: #eee !important; }
}</style>
<style id="override" data-dusk="sheet" media="screen">html,body,.card{background-color:${BG} !important}:root{color-scheme:dark}</style>
</head><body><div class="card" id="card"></div></body></html>`;

test("sampling a white page with pre-paint, override sheets and inline overrides active reads light", async ({ page }) => {
  await page.setContent(PAGE);
  await page.addScriptTag({ content: bundle });
  const r = await page.evaluate((BG) => {
    const N = (window as unknown as { Dusk: DuskGlobal }).Dusk.NativeDark;
    const own = new CSSStyleSheet({ media: "screen" });
    own.replaceSync(`body,.card{background-color:${BG} !important}`);
    (own as unknown as Record<symbol, unknown>)[Symbol.for("dusk.own")] = true;
    document.adoptedStyleSheets = [own];
    const card = document.getElementById("card") as HTMLElement;
    card.style.setProperty("background-color", BG, "important");
    const bodyBg = () => getComputedStyle(document.body).backgroundColor;
    const before = [bodyBg(), getComputedStyle(card).backgroundColor];
    const naive = N.sampleBackground(document, window, { suspend: () => () => {}, originalBackground: () => null });
    let seenInside = "";
    const verdict = N.sampleBackground(document, window, {
      suspend: () => {
        const resume = N.suspendOwnSheets(document);
        seenInside = bodyBg();
        return resume;
      },
      originalBackground: (el) => (el === card ? "#fff" : null),
    });
    const override = (document.getElementById("override") as HTMLStyleElement).sheet as CSSStyleSheet;
    return {
      before,
      naive,
      verdict,
      seenInside,
      after: bodyBg(),
      attr: document.documentElement.hasAttribute("data-dusk-sampling"),
      disabled: [override.disabled, own.disabled],
      declared: N.declaredScheme(document),
    };
  }, BG);
  expect(r.before).toEqual([BG, BG]);
  expect(r.naive).toBe("dark");
  expect(r.seenInside).toBe("rgb(255, 255, 255)");
  expect(r.verdict).toBe("light");
  expect(r.after).toBe(BG);
  expect(r.attr).toBe(false);
  expect(r.disabled).toEqual([false, false]);
  expect(r.declared).toBe("unknown");
});

test("a genuinely dark page samples dark and a page :root color-scheme: dark is declared dark", async ({ page }) => {
  await page.setContent(`<!doctype html><html><head><style>:root{color-scheme:dark}html,body{margin:0;background:#111}</style></head><body><main style="height:100vh"></main></body></html>`);
  await page.addScriptTag({ content: bundle });
  const r = await page.evaluate(() => {
    const N = (window as unknown as { Dusk: DuskGlobal }).Dusk.NativeDark;
    return [N.sampleBackground(document, window, { suspend: () => N.suspendOwnSheets(document), originalBackground: () => null }), N.declaredScheme(document)];
  });
  expect(r).toEqual(["dark", "dark"]);
});

test("collectDarkSchemeRules handles @layer, nesting and <style media>, and the promoted CSS turns the page dark", async ({ page }) => {
  await page.setContent(`<!doctype html><html><head>
<style>
@layer base { body { background-color: #fff } @media (prefers-color-scheme: dark) { body { background-color: rgb(10, 10, 10) } } }
.card { color: rgb(0, 0, 0); @media (prefers-color-scheme: dark) { color: rgb(250, 250, 250); & .t { color: rgb(200, 200, 200) } } }
@media (prefers-color-scheme: light) { .card { border-color: red } }
</style>
<style media="(prefers-color-scheme: dark)">:root { --accent: rgb(1, 2, 3) }</style>
<style media="print">@media (prefers-color-scheme: dark) { .p { color: white } }</style>
</head><body><div class="card" id="card"><span class="t" id="t">x</span></div><i id="i" style="color: var(--accent)">i</i></body></html>`);
  await page.addScriptTag({ content: bundle });
  const r = await page.evaluate(async () => {
    const N = (window as unknown as { Dusk: DuskGlobal }).Dusk.NativeDark;
    const css = N.collectDarkSchemeRules(Array.from(document.styleSheets));
    const cs = (id: string) => getComputedStyle(document.getElementById(id) as Element).color;
    const before = [getComputedStyle(document.body).backgroundColor, cs("card"), cs("t"), cs("i")];
    const calls: boolean[] = [];
    const stop = await N.promote(document, css, { setPromotion: (on) => calls.push(on) });
    const after = [getComputedStyle(document.body).backgroundColor, cs("card"), cs("t"), cs("i")];
    stop();
    const reverted = [getComputedStyle(document.body).backgroundColor, cs("card")];
    return { css, root: N.hasRootDarkTheme(css), before, after, reverted, calls };
  });
  expect(r.css).not.toContain("red");
  expect(r.css).not.toContain(".p");
  expect(r.css).toContain("@layer base");
  expect(r.root).toBe(true);
  expect(r.before).toEqual(["rgb(255, 255, 255)", "rgb(0, 0, 0)", "rgb(0, 0, 0)", "rgb(0, 0, 0)"]);
  expect(r.after).toEqual(["rgb(10, 10, 10)", "rgb(250, 250, 250)", "rgb(200, 200, 200)", "rgb(1, 2, 3)"]);
  expect(r.reverted).toEqual(["rgb(255, 255, 255)", "rgb(0, 0, 0)"]);
  expect(r.calls).toEqual([true, false]);
});

test("findClassThemeToggle counts declarations inside @layer and nested under a marker", async ({ page }) => {
  await page.setContent("<!doctype html><html><head></head><body></body></html>");
  await page.addScriptTag({ content: bundle });
  const t = await page.evaluate(() => {
    const N = (window as unknown as { Dusk: DuskGlobal }).Dusk.NativeDark;
    const s = new CSSStyleSheet();
    const layered = Array.from({ length: 12 }, (_, i) => `html.dark .a${i}{background-color:#111}`).join("");
    const nested = Array.from({ length: 8 }, (_, i) => `.n${i}{background:#222}`).join("");
    s.replaceSync(`@layer components{${layered}} .dark{${nested}}`);
    return N.findClassThemeToggle([s]);
  });
  // 12 layered + the `.dark{}` parent (no own background, not counted) + 8 nested children = 20.
  expect(t).toEqual({ target: "html", kind: "class", name: "dark", declarationCount: 20 });
});

test("promoted CSS from a linked sheet in a subdirectory keeps its relative url()s; @import rules are inlined, not copied", async ({ page }) => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
  const files: Record<string, [string, string | Buffer]> = {
    "/index.html": ["text/html", '<!doctype html><html><head><link rel="stylesheet" href="css/theme.css"></head><body><div id="d" style="height:10px"></div></body></html>'],
    "/css/theme.css": ["text/css", '@import url("sub/more.css") (prefers-color-scheme: dark);\n@media (prefers-color-scheme: dark) { body { background-image: url(img/bg.png) } }'],
    "/css/sub/more.css": ["text/css", "#d { background-image: url('x.png') }"],
    "/css/img/bg.png": ["image/png", png],
    "/css/sub/x.png": ["image/png", png],
  };
  await page.route("http://dusk.test/**", (route) => {
    const f = files[new URL(route.request().url()).pathname];
    return f ? route.fulfill({ contentType: f[0], body: f[1] }) : route.fulfill({ status: 404 });
  });
  await page.goto("http://dusk.test/index.html");
  await page.addScriptTag({ content: bundle });
  const r = await page.evaluate(async () => {
    const N = (window as unknown as { Dusk: DuskGlobal }).Dusk.NativeDark;
    const css = N.collectDarkSchemeRules(Array.from(document.styleSheets));
    await N.promote(document, css, { setPromotion: () => {} });
    return { css, body: getComputedStyle(document.body).backgroundImage, d: getComputedStyle(document.getElementById("d") as Element).backgroundImage };
  });
  expect(r.css).not.toContain("@import");
  expect(r.css).toContain('url("http://dusk.test/css/img/bg.png")');
  expect(r.css).toContain('url("http://dusk.test/css/sub/x.png")');
  expect(r.body).toBe('url("http://dusk.test/css/img/bg.png")');
  expect(r.d).toBe('url("http://dusk.test/css/sub/x.png")');
});

test("body's background propagated to the canvas is sampled where only html is under the point", async ({ page }) => {
  await page.setContent('<!doctype html><html><head><style>html{margin:0}body{margin:0;height:10px;background:#111}</style></head><body></body></html>');
  await page.addScriptTag({ content: bundle });
  const r = await page.evaluate(() => {
    const N = (window as unknown as { Dusk: DuskGlobal }).Dusk.NativeDark;
    const stack = document.elementsFromPoint(innerWidth / 2, innerHeight / 2).map((e) => e.tagName);
    return { stack, verdict: N.sampleBackground(document, window, { suspend: () => N.suspendOwnSheets(document), originalBackground: () => null }) };
  });
  expect(r.stack).toEqual(["HTML"]);
  expect(r.verdict).toBe("dark");
});

// A light page with a big dark dialog on load (a consent dialog, or an address dialog whose body background arrives with
// a sheet still loading): a fixed overlay isn't the page's theme while the canvas as painted is light, which with no
// background set is white unless a dark scheme is declared. Over a dark canvas a fixed app shell still decides.
const DIALOG = '<div style="position:fixed;inset:5vh 5vw;background:#000"><p style="margin:0;height:100%">Cookies</p></div>';
for (const [name, canvas, expected] of [
  ["a dark fixed dialog over a page with a white canvas samples light", "body{background:#fff}", "light"],
  ["a dark fixed dialog over a page with no canvas color samples light", "", "light"],
  ["a dark fixed layer over a page with a dark canvas samples dark", "body{background:#111}", "dark"],
  ["a dark fixed layer over a page declaring only a dark scheme and no canvas color samples dark", ":root{color-scheme:dark}", "dark"],
] as const) {
  test(name, async ({ page }) => {
    await page.setContent(`<!doctype html><html><head><style>html,body{margin:0}${canvas}</style></head><body><main style="height:200vh"></main>${DIALOG}</body></html>`);
    await page.addScriptTag({ content: bundle });
    const v = await page.evaluate(() => {
      const N = (window as unknown as { Dusk: DuskGlobal }).Dusk.NativeDark;
      return N.sampleBackground(document, window, { suspend: () => N.suspendOwnSheets(document), originalBackground: () => null });
    });
    expect(v).toBe(expected);
  });
}

// Seen on digi.no: a big dark-green lead story under three of the five sample points made a white page
// sample dark, so Duskling used the "site's own dark theme" and showed the white page. Dark boxes on a light page background
// don't make the page dark.
for (const [name, ground, expected] of [
  ["dark cards over a white body sample light", "body{background:#fff}", "light"],
  ["dark cards over a white html with a transparent body sample light", "html{background:#fff}", "light"],
  ["dark cards over a dark body sample dark", "body{background:#111}", "dark"],
] as const) {
  test(name, async ({ page }) => {
    await page.setContent(`<!doctype html><html><head><style>html,body{margin:0}${ground}</style></head><body><div style="height:100vh;display:grid;grid-template-rows:1fr 1fr"><div style="background:#1d302e;margin:8px"></div><div style="background:#1d302e;margin:8px"></div></div></body></html>`);
    await page.addScriptTag({ content: bundle });
    const v = await page.evaluate(() => {
      const N = (window as unknown as { Dusk: DuskGlobal }).Dusk.NativeDark;
      return N.sampleBackground(document, window, { suspend: () => N.suspendOwnSheets(document), originalBackground: () => null });
    });
    expect(v).toBe(expected);
  });
}
