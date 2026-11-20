// Image analysis in real WebKit (happy-dom has no canvas 2D): pixel transforms, rule-level replacement of a pseudo-element
// icon, <img> markers, inline SVG icons and teardown.
import { expect, test } from "@playwright/test";
import type { DuskGlobal } from "./engine-bundle";
import { engineBundle } from "./engine-bundle";

let bundle = "";
let BLACK = Buffer.alloc(0);
let RED = Buffer.alloc(0);
let BANNER = Buffer.alloc(0);
test.beforeAll(async ({ browser }) => {
  bundle = await engineBundle();
  // 24×24 PNGs drawn on a canvas: a 12×12 square of the color in the middle (75 % transparent around it).
  const page = await browser.newPage();
  const make = (color: string) =>
    page.evaluate((c) => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 24;
      const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
      ctx.fillStyle = c;
      ctx.fillRect(6, 6, 12, 12);
      return canvas.toDataURL("image/png").split(",")[1] as string;
    }, color);
  BLACK = Buffer.from(await make("#000"), "base64");
  RED = Buffer.from(await make("#dc0000"), "base64");
  // 800×120, opaque light grey (#f0f0f0), wider than 512: a light large image.
  BANNER = Buffer.from(
    await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 800;
      canvas.height = 120;
      const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
      ctx.fillStyle = "#f0f0f0";
      ctx.fillRect(0, 0, 800, 120);
      return canvas.toDataURL("image/png").split(",")[1] as string;
    }),
    "base64",
  );
  await page.close();
});

const dataUrl = (b: Buffer) => `data:image/png;base64,${b.toString("base64")}`;

async function served(page: import("@playwright/test").Page, body: string): Promise<void> {
  const files: Record<string, [string, string | Buffer]> = {
    "/": ["text/html", body],
    "/icon.png": ["image/png", BLACK],
    "/red.png": ["image/png", RED],
    "/banner.png": ["image/png", BANNER],
  };
  await page.route("http://dusk.test/**", (route) => {
    const f = files[new URL(route.request().url()).pathname];
    return f ? route.fulfill({ status: 200, contentType: f[0], body: f[1] }) : route.fulfill({ status: 404, body: "" });
  });
  await page.goto("http://dusk.test/");
  await page.addScriptTag({ content: bundle });
}

test("transformImageDataUrl inverts black-on-transparent to white-on-transparent", async ({ page }) => {
  await page.setContent("<!doctype html><html><body></body></html>");
  await page.addScriptTag({ content: bundle });
  const r = await page.evaluate(async (src) => {
    const D = (window as unknown as { Dusk: DuskGlobal }).Dusk;
    const out = await D.transformImageDataUrl(src, "invert", D.PALETTES.dark, async () => null);
    if (!out) return null;
    const img = new Image();
    img.src = out;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const ctx = c.getContext("2d") as CanvasRenderingContext2D;
    ctx.drawImage(img, 0, 0);
    const px = (x: number, y: number) => [...ctx.getImageData(x, y, 1, 1).data];
    return { prefix: out.slice(0, 22), size: [c.width, c.height], ink: px(12, 12), edge: px(1, 1) };
  }, dataUrl(BLACK));
  expect(r).not.toBeNull();
  expect(r?.prefix).toBe("data:image/png;base64,");
  expect(r?.size).toEqual([24, 24]);
  expect(r?.ink).toEqual([255, 255, 255, 255]);
  expect(r?.edge[3]).toBe(0);
});

test("a ::after dark icon is re-emitted with a data:image/png URL and the element gets no filter", async ({ page }) => {
  await served(page, `<!doctype html><html><head><style>
    .x::after{content:"";display:inline-block;width:24px;height:24px;background-image:url(icon.png)}
    </style></head><body><div class="x" id="x">text</div></body></html>`);
  const r = await page.evaluate(async () => {
    const D = (window as unknown as { Dusk: DuskGlobal }).Dusk;
    const p = D.PALETTES.dark;
    const vars = new D.VariableRegistry(p);
    let m: InstanceType<DuskGlobal["StyleManager"]> | null = null;
    const images = new D.ImageStyler(document, { fetchBlobUrl: async () => null, schedule: (fn) => setTimeout(fn, 0), palette: p, onImagesReady: (urls) => m?.imagesReady(urls) });
    m = new D.StyleManager(document, {
      ctx: { palette: p, mode: "full", varRef: (v, role) => vars.varRef(v, role), imageUrl: images.imageUrl },
      vars,
      fetchText: async () => null,
      schedule: (fn) => fn(),
    });
    images.start(); // Before the StyleManager: imageUrl only queues while running.
    m.start();
    const x = document.getElementById("x") as Element;
    const after = () => getComputedStyle(x, "::after").backgroundImage;
    for (let i = 0; i < 100 && !after().includes("data:image/png"); i++) await new Promise((res) => setTimeout(res, 20));
    const got = { after: after().slice(0, 27), filter: getComputedStyle(x).filter, marker: x.getAttribute("data-dusk-img") };
    images.stop();
    m.stop();
    return got;
  });
  expect(r.after).toBe('url("data:image/png;base64,');
  expect(r.filter).toBe("none");
  expect(r.marker).toBeNull();
});

test("<img> dark icons get the invert marker (cross-origin via fetchBlobUrl), brand marks don't; inline SVG icons get the text fill; stop() restores", async ({ page }) => {
  await served(page, `<!doctype html><html><head></head><body>
    <img id="a" src="icon.png"><img id="b" src="red.png"><img id="c" src="http://cdn.other.test/icon.png">
    <svg id="s" xmlns="http://www.w3.org/2000/svg" width="24" height="24"><path d="M0 0h24v24H0z"/></svg>
    </body></html>`);
  const r = await page.evaluate(async (blob) => {
    const D = (window as unknown as { Dusk: DuskGlobal }).Dusk;
    const p = D.PALETTES.dark;
    const ctx = { palette: p, mode: "full" as const, varRef: (v: string) => v };
    const inline = new D.InlineStyler(document, ctx);
    inline.start();
    const fetched: string[] = [];
    const images = new D.ImageStyler(document, {
      fetchBlobUrl: async (u) => (fetched.push(u), { dataUrl: blob }),
      schedule: (fn) => setTimeout(fn, 0),
      palette: p,
      inline,
    });
    images.start();
    const $ = (id: string) => document.getElementById(id) as Element;
    for (let i = 0; i < 100 && !($("a").hasAttribute("data-dusk-img") && $("c").hasAttribute("data-dusk-img")); i++) await new Promise((res) => setTimeout(res, 20));
    const probe = document.createElement("i");
    document.body.append(probe);
    probe.style.color = D.transformCssColor("rgb(0, 0, 0)", "text", p) as string;
    const before = {
      a: $("a").getAttribute("data-dusk-img"),
      b: $("b").getAttribute("data-dusk-img"),
      c: $("c").getAttribute("data-dusk-img"),
      filter: getComputedStyle($("a")).filter,
      fill: getComputedStyle($("s")).fill,
      want: getComputedStyle(probe).color,
      fetched,
    };
    images.stop();
    inline.stop();
    return { before, after: { markers: document.querySelectorAll("[data-dusk-img]").length, style: document.querySelectorAll('style[data-dusk="img"]').length, svgStyle: $("s").getAttribute("style"), filter: getComputedStyle($("a")).filter } };
  }, dataUrl(BLACK));
  expect(r.before.a).toBe("invert");
  expect(r.before.b).toBeNull();
  expect(r.before.c).toBe("invert");
  expect(r.before.fetched).toEqual(["http://cdn.other.test/icon.png"]);
  expect(r.before.filter).toBe("invert(1) hue-rotate(180deg)");
  expect(r.before.fill).toBe(r.before.want);
  expect(r.after).toEqual({ markers: 0, style: 0, svgStyle: null, filter: "none" });
});

for (const corsOk of [false, true]) {
  test(`a cross-origin ::after dark icon is ${corsOk ? "" : "not "}replaced when the fetch is ${corsOk ? "" : "not "}CORS-permissive`, async ({ page }) => {
    await served(page, `<!doctype html><html><head><style>
      .x::after{content:"";display:inline-block;width:24px;height:24px;background-image:url(http://cdn.other.test/icon.png)}
      </style></head><body><div class="x" id="x">text</div></body></html>`);
    const r = await page.evaluate(async ({ blob, corsOk }) => {
      const D = (window as unknown as { Dusk: DuskGlobal }).Dusk;
      const p = D.PALETTES.dark;
      const vars = new D.VariableRegistry(p);
      let m: InstanceType<DuskGlobal["StyleManager"]> | null = null;
      let fetched = 0;
      const images = new D.ImageStyler(document, {
        fetchBlobUrl: async () => (fetched++, { dataUrl: blob, corsOk }),
        schedule: (fn) => setTimeout(fn, 0),
        palette: p,
        onImagesReady: (urls) => m?.imagesReady(urls),
      });
      m = new D.StyleManager(document, {
        ctx: { palette: p, mode: "full", varRef: (v, role) => vars.varRef(v, role), imageUrl: images.imageUrl },
        vars,
        fetchText: async () => null,
        schedule: (fn) => fn(),
      });
      images.start();
      m.start();
      const x = document.getElementById("x") as Element;
      const after = () => getComputedStyle(x, "::after").backgroundImage;
      for (let i = 0; i < 50 && !after().includes("data:"); i++) await new Promise((res) => setTimeout(res, 20));
      const css = [...document.querySelectorAll('style[data-dusk="sheet"]')].map((n) => n.textContent).join("");
      const got = { after: after().slice(0, 27), emitted: css.includes("data:"), fetched };
      images.stop();
      m.stop();
      return got;
    }, { blob: dataUrl(BLACK), corsOk });
    expect(r.fetched).toBeGreaterThan(0);
    expect(r.emitted).toBe(corsOk);
    expect(r.after).toBe(corsOk ? 'url("data:image/png;base64,' : 'url("http://cdn.other.test/icon.png")'.slice(0, 27));
  });
}

test("an inline SVG icon's override is dropped when a class change gives it a chromatic fill", async ({ page }) => {
  await served(page, `<!doctype html><html><head><style>.brand{fill:#e53935}</style></head><body>
    <svg id="s" xmlns="http://www.w3.org/2000/svg" width="24" height="24"><path d="M0 0h24v24H0z"/></svg></body></html>`);
  const r = await page.evaluate(async () => {
    const D = (window as unknown as { Dusk: DuskGlobal }).Dusk;
    const p = D.PALETTES.dark;
    const inline = new D.InlineStyler(document, { palette: p, mode: "full", varRef: (v: string) => v });
    inline.start();
    const images = new D.ImageStyler(document, { fetchBlobUrl: async () => null, schedule: (fn) => setTimeout(fn, 0), palette: p, inline });
    images.start();
    const svg = document.getElementById("s") as Element;
    const wait = async (ok: () => boolean) => {
      for (let i = 0; i < 100 && !ok(); i++) await new Promise((res) => setTimeout(res, 20));
    };
    await wait(() => svg.hasAttribute("style"));
    const styled = svg.getAttribute("style");
    // A second visit (e.g. a style mutation) must keep the override: it reads the page color, not ours.
    svg.setAttribute("data-x", "1");
    svg.classList.add("x");
    await new Promise((res) => setTimeout(res, 100));
    const kept = svg.getAttribute("style");
    svg.classList.add("brand");
    await wait(() => !svg.hasAttribute("style"));
    const out = { styled, kept, after: svg.getAttribute("style"), fill: getComputedStyle(svg).fill };
    images.stop();
    inline.stop();
    return out;
  });
  expect(r.styled).toContain("fill");
  expect(r.kept).toBe(r.styled);
  expect(r.after).toBeNull();
  expect(r.fill).toBe("rgb(229, 57, 53)");
});

test("a light large background image is replaced at rule level by a brightness(0.5) copy, the element gets no filter", async ({ page }) => {
  await served(page, `<!doctype html><html><head><style>
    body{margin:0} .banner{height:120px;background:url(banner.png) center / cover no-repeat}
    </style></head><body><div class="banner" id="b">text</div></body></html>`);
  const r = await page.evaluate(async () => {
    const D = (window as unknown as { Dusk: DuskGlobal }).Dusk;
    const p = D.PALETTES.dark;
    const vars = new D.VariableRegistry(p);
    let m: InstanceType<DuskGlobal["StyleManager"]> | null = null;
    const images = new D.ImageStyler(document, { fetchBlobUrl: async () => null, schedule: (fn) => setTimeout(fn, 0), palette: p, onImagesReady: (urls) => m?.imagesReady(urls) });
    m = new D.StyleManager(document, {
      ctx: { palette: p, mode: "full", varRef: (v, role) => vars.varRef(v, role), imageUrl: images.imageUrl },
      vars,
      fetchText: async () => null,
      schedule: (fn) => fn(),
    });
    images.start();
    m.start();
    const b = document.getElementById("b") as Element;
    const bg = () => getComputedStyle(b).backgroundImage;
    for (let i = 0; i < 100 && !bg().includes("data:image/png"); i++) await new Promise((res) => setTimeout(res, 20));
    const url = /url\("?([^")]*)"?\)/.exec(bg())?.[1] ?? "";
    let px: number[] = [];
    if (url.startsWith("data:")) {
      const img = new Image();
      img.src = url;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const ctx = c.getContext("2d") as CanvasRenderingContext2D;
      ctx.drawImage(img, 0, 0);
      px = [...ctx.getImageData(400, 60, 1, 1).data, c.width, c.height];
    }
    const got = { replaced: url.slice(0, 22), px, filter: getComputedStyle(b).filter };
    images.stop();
    m.stop();
    return got;
  });
  expect(r.replaced).toBe("data:image/png;base64,");
  expect(r.px).toEqual([120, 120, 120, 255, 800, 120]);
  expect(r.filter).toBe("none");
});
