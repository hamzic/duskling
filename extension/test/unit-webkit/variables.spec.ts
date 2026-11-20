// End-to-end check of rule rewriting + VariableRegistry in real WebKit: var() in shorthands (pending-substitution
// longhands, which happy-dom doesn't model), role redefinitions and the Tailwind RGB-triple pattern.
import { expect, test } from "@playwright/test";
import type { DuskGlobal } from "./engine-bundle";
import { engineBundle } from "./engine-bundle";

let bundle = "";
test.beforeAll(async () => {
  bundle = await engineBundle();
});

test("variables used through shorthands and rgb() triples resolve to the transformed colors", async ({ page }) => {
  await page.setContent("<!doctype html><html><head></head><body></body></html>");
  await page.addScriptTag({ content: bundle });
  const r = await page.evaluate(() => {
    const D = (window as unknown as { Dusk: DuskGlobal }).Dusk;
    const p = D.PALETTES.dark;
    const reg = new D.VariableRegistry(p);
    const source = new CSSStyleSheet();
    source.replaceSync(`:root { --a: #fff; --t: #111; --c: 255 255 255; --o: 1; --w: 3px }
      .x { background: var(--a) no-repeat; border: var(--w) solid var(--t) }
      .y { color: var(--t); background-color: rgb(var(--c) / var(--o)) }`);
    const out: string[] = [];
    D.rewriteRuleList(source.cssRules, { palette: p, mode: "full", varRef: (v, role) => reg.varRef(v, role), onVariable: (s, n, v, o) => reg.observeDefinition(s, n, v, o) }, out);
    const override = new CSSStyleSheet();
    override.replaceSync(out.join("\n") + reg.definitionsCss(p));
    document.body.innerHTML = '<div id="x" class="x"></div><p id="y" class="y">y</p><i id="probe"></i>';
    document.adoptedStyleSheets = [source, override];
    const probe = document.getElementById("probe") as HTMLElement;
    const norm = (v: string) => ((probe.style.color = v), getComputedStyle(probe).color);
    const cs = (id: string, prop: string) => getComputedStyle(document.getElementById(id) as Element).getPropertyValue(prop);
    return {
      out,
      got: { xBg: cs("x", "background-color"), xBorder: cs("x", "border-top-color"), xWidth: cs("x", "border-top-width"), yColor: cs("y", "color"), yBg: cs("y", "background-color") },
      want: {
        xBg: norm(D.transformCssColor("#fff", "bg", p) as string),
        xBorder: norm(D.transformCssColor("#111", "border", p) as string),
        xWidth: "3px",
        yColor: norm(D.transformCssColor("#111", "text", p) as string),
        yBg: norm(D.transformCssColor("#fff", "bg", p) as string),
      },
    };
  });
  expect(r.got).toEqual(r.want);
});

test("definitions keep @media context and nesting-resolved selectors; hsl triples resolve", async ({ page }) => {
  await page.setViewportSize({ width: 500, height: 400 });
  await page.setContent("<!doctype html><html><head></head><body></body></html>");
  await page.addScriptTag({ content: bundle });
  const r = await page.evaluate(() => {
    const D = (window as unknown as { Dusk: DuskGlobal }).Dusk;
    const p = D.PALETTES.dark;
    const reg = new D.VariableRegistry(p);
    const source = new CSSStyleSheet();
    source.replaceSync(`.x { background-color: var(--a) } .title { color: var(--b) } .s { background-color: hsl(var(--h) / 1) }
      :root { --a: #fff; --h: 0 0% 100% } @media (max-width: 600px) { :root { --a: #000 } }
      .card { .title { --b: #eee } }`);
    const out: string[] = [];
    const defs: string[] = [];
    D.rewriteRuleList(source.cssRules, {
      palette: p, mode: "full", varRef: (v, role) => reg.varRef(v, role),
      onVariable: (s, n, v, o) => (defs.push(s), reg.observeDefinition(s, n, v, o)),
    }, out);
    const override = new CSSStyleSheet();
    override.replaceSync(out.join("\n") + reg.definitionsCss(p));
    document.body.innerHTML = '<div id="x" class="x"></div><div class="card"><p id="t" class="title">t</p></div><p id="o" class="title">o</p><div id="s" class="s"></div><i id="probe"></i>';
    document.adoptedStyleSheets = [source, override];
    const probe = document.getElementById("probe") as HTMLElement;
    const norm = (v: string) => ((probe.style.color = v), getComputedStyle(probe).color);
    const cs = (id: string, prop: string) => getComputedStyle(document.getElementById(id) as Element).getPropertyValue(prop);
    return {
      defs,
      got: { x: cs("x", "background-color"), t: cs("t", "color"), s: cs("s", "background-color") },
      want: {
        x: norm(D.transformCssColor("#000", "bg", p) as string),
        t: norm(D.transformCssColor("#eee", "text", p) as string),
        s: norm(D.transformCssColor("#fff", "bg", p) as string),
      },
      outside: cs("o", "color"),
    };
  });
  expect(r.defs).toContain(":is(.card) .title");
  expect(r.got.x).toBe(r.want.x);
  expect(r.got.t).toBe(r.want.t);
  // hsl() triple round-trips through HSL text, so allow ±1 per channel.
  const ch = (c: string) => c.match(/\d+/g)!.slice(0, 3).map(Number);
  ch(r.got.s).forEach((v, i) => expect(Math.abs(v - (ch(r.want.s)[i] as number))).toBeLessThanOrEqual(1));
});
