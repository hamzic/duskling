// StyleManager in real WebKit: override placement keeps cascade order, constructed sheets carry media "screen",
// a <style> text change (which replaces the sheet object in browsers) is re-emitted, and rAF batching settles.
import { expect, test } from "@playwright/test";
import type { DuskGlobal } from "./engine-bundle";
import { engineBundle } from "./engine-bundle";

let bundle = "";
test.beforeAll(async () => {
  bundle = await engineBundle();
});

test.beforeEach(async ({ page }) => {
  await page.setContent('<!doctype html><html><head><style>.a{color:#000}</style><style>.a{color:#c00}</style></head><body><p id="a" class="a">a</p><i id="probe"></i></body></html>');
  await page.addScriptTag({ content: bundle });
});

test("overrides follow their source, so the later source still wins; adopted overrides use media screen", async ({ page }) => {
  const r = await page.evaluate(async () => {
    const D = (window as unknown as { Dusk: DuskGlobal }).Dusk;
    const p = D.PALETTES.dark;
    const vars = new D.VariableRegistry(p);
    const adopted = new CSSStyleSheet();
    adopted.replaceSync(".b{background-color:#fff}");
    document.adoptedStyleSheets = [adopted];
    const m = new D.StyleManager(document, {
      ctx: { palette: p, mode: "full", varRef: (v, role) => vars.varRef(v, role) },
      vars,
      fetchText: async () => null,
      schedule: (fn) => requestAnimationFrame(fn),
    });
    m.start();
    const probe = document.getElementById("probe") as HTMLElement;
    const norm = (v: string) => ((probe.style.color = v), getComputedStyle(probe).color);
    const color = () => getComputedStyle(document.getElementById("a") as Element).color;
    const first = { got: color(), want: norm(D.transformCssColor("#c00", "text", p) as string) };
    const own = document.adoptedStyleSheets[1] as CSSStyleSheet;
    const media = own.media.mediaText;
    const style = document.querySelectorAll("style")[2] as HTMLStyleElement; // the second source
    const before = style.sheet;
    style.textContent = ".a{color:#00c}";
    const replaced = style.sheet !== before;
    const want2 = norm(D.transformCssColor("#00c", "text", p) as string);
    let frames = 0;
    while (color() !== want2 && frames++ < 60) await new Promise((res) => requestAnimationFrame(res));
    const second = { got: color(), want: want2, frames, text: (style.nextElementSibling as Element).textContent };
    const counts = [...document.head.querySelectorAll("style")].map((n) => n.getAttribute("data-dusk") ?? "src");
    m.stop();
    return { first, second, media, replaced, counts, after: document.querySelectorAll("[data-dusk]").length, adopted: document.adoptedStyleSheets.length };
  });
  expect(r.first.got).toBe(r.first.want);
  expect(r.media).toBe("screen");
  expect(r.replaced).toBe(true);
  expect(r.second.got).toBe(r.second.want);
  expect(r.counts).toEqual(["src", "sheet", "src", "sheet", "vars"]);
  expect(r.after).toBe(0);
  expect(r.adopted).toBe(1);
});

// A served origin, so <link> sheets have real URLs (and relative url()s resolve against them).
async function served(page: import("@playwright/test").Page, files: Record<string, [string, string]>): Promise<void> {
  await page.route("http://dusk.test/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    const f = files[path];
    return f ? route.fulfill({ status: 200, contentType: f[0], body: f[1] }) : route.fulfill({ status: 404, body: "" });
  });
}

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64").toString("latin1");

test("variable redefinitions follow source cascade order; relative url()s resolve against the <link>", async ({ page }) => {
  await served(page, {
    "/": ["text/html", `<!doctype html><html><head>
      <style id="first"></style><style>:root{--x:#000} body{color:var(--x)}</style>
      <link rel="stylesheet" href="/css/theme/site.css"><style>:root{--y:#000}</style>
      </head><body><p id="p">p</p><div id="img" class="img">i</div><i id="probe"></i></body></html>`],
    "/css/theme/site.css": ["text/css", `:root{--y:#fff} #p{background-color:var(--y)} .img{background-image:linear-gradient(#fff, #eee), url("../img/a.png")}`],
    "/css/img/a.png": ["image/png", PNG],
  });
  await page.goto("http://dusk.test/");
  await page.addScriptTag({ content: bundle });
  const r = await page.evaluate(async () => {
    const D = (window as unknown as { Dusk: DuskGlobal }).Dusk;
    const p = D.PALETTES.dark;
    const vars = new D.VariableRegistry(p);
    const m = new D.StyleManager(document, {
      ctx: { palette: p, mode: "full", varRef: (v, role) => vars.varRef(v, role) },
      vars,
      fetchText: async () => null,
      schedule: (fn) => fn(),
    });
    m.start();
    (document.getElementById("first") as HTMLStyleElement).textContent = ":root{--x:#fff}";
    await new Promise((res) => setTimeout(res, 50));
    const probe = document.getElementById("probe") as HTMLElement;
    const norm = (v: string) => ((probe.style.color = v), getComputedStyle(probe).color);
    const cs = (el: Element, prop: string) => getComputedStyle(el).getPropertyValue(prop);
    const got = { color: cs(document.body, "color"), bg: cs(document.getElementById("p") as Element, "background-color"), image: cs(document.getElementById("img") as Element, "background-image") };
    m.stop();
    return { got, want: { color: norm(D.transformCssColor("#000", "text", p) as string), bg: norm(D.transformCssColor("#000", "bg", p) as string) } };
  });
  expect(r.got.color).toBe(r.want.color);
  expect(r.got.bg).toBe(r.want.bg);
  expect(r.got.image).toContain('url("http://dusk.test/css/img/a.png")');
});

test("two managers on one root keep one override per adopted sheet", async ({ page }) => {
  const r = await page.evaluate(() => {
    const D = (window as unknown as { Dusk: DuskGlobal }).Dusk;
    const p = D.PALETTES.dark;
    const make = () => {
      const vars = new D.VariableRegistry(p);
      return new D.StyleManager(document, { ctx: { palette: p, mode: "full", varRef: (v, role) => vars.varRef(v, role) }, vars, fetchText: async () => null, schedule: (fn) => fn() });
    };
    const src = new CSSStyleSheet();
    src.replaceSync(".a{color:#000}");
    document.adoptedStyleSheets = [src];
    const a = make();
    const b = make();
    a.start();
    b.start();
    const lengths = [document.adoptedStyleSheets.length];
    for (let i = 0; i < 3; i++) {
      a.rescan();
      b.rescan();
      lengths.push(document.adoptedStyleSheets.length);
    }
    a.stop();
    b.stop();
    return { lengths, after: document.adoptedStyleSheets.length };
  });
  expect(r.lengths).toEqual([2, 2, 2, 2]);
  expect(r.after).toBe(1);
});
