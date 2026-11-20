// Cases that need real WebKit CSSOM: happy-dom 20.x drops @layer blocks and nested rules.
import { expect, test } from "@playwright/test";
import type { DuskGlobal } from "./engine-bundle";
import { engineBundle } from "./engine-bundle";

let bundle = "";
test.beforeAll(async () => {
  bundle = await engineBundle();
});

test.beforeEach(async ({ page }) => {
  await page.setContent("<!doctype html><html><head></head><body></body></html>");
  await page.addScriptTag({ content: bundle });
});

interface Result { out: string[]; expected: Record<string, string>; computed: Record<string, string> }

// Rewrites `css`, applies source + override sheets to `html`, and reports the computed colors of the listed elements.
async function rewriteAndApply(page: import("@playwright/test").Page, css: string, html: string, colors: Record<string, [string, string, "text" | "bg"]>): Promise<Result> {
  return page.evaluate(({ css, html, colors }) => {
    const D = (window as unknown as { Dusk: DuskGlobal }).Dusk;
    const p = D.PALETTES.dark;
    const source = new CSSStyleSheet();
    source.replaceSync(css);
    const out: string[] = [];
    D.rewriteRuleList(source.cssRules, { palette: p, mode: "full", varRef: (v) => v }, out);
    const override = new CSSStyleSheet();
    override.replaceSync(out.join("\n"));
    document.body.innerHTML = html;
    document.adoptedStyleSheets = [source, override];
    const probe = document.createElement("i");
    document.body.append(probe);
    const norm = (v: string) => {
      probe.style.color = v;
      return getComputedStyle(probe).color;
    };
    const expected: Record<string, string> = {};
    const computed: Record<string, string> = {};
    for (const [id, [prop, input, role]] of Object.entries(colors)) {
      expected[id] = norm(D.transformCssColor(input, role, p) as string);
      computed[id] = getComputedStyle(document.getElementById(id) as Element).getPropertyValue(prop);
    }
    return { out, expected, computed };
  }, { css, html, colors });
}

test("@layer x is kept", async ({ page }) => {
  const r = await rewriteAndApply(
    page,
    "@layer a, x; @layer x { .a { color: #000 } } .b { color: #000 }",
    '<p id="a" class="a">a</p><p id="b" class="b">b</p>',
    { a: ["color", "#000", "text"], b: ["color", "#000", "text"] },
  );
  expect(r.out[0]).toMatch(/^@layer x\{\.a\{color:#[0-9a-f]{6};\}\}$/);
  expect(r.out).toHaveLength(2); // the @layer statement emits nothing
  expect(r.computed).toEqual(r.expected);
});

test("nested rule is handled", async ({ page }) => {
  const r = await rewriteAndApply(
    page,
    ".a { color: #000; .b { background-color: #fff } & > .c { color: #333 } @media (min-width: 1px) { border-top: 1px solid; border-top-color: #000 } }",
    '<div id="a" class="a"><p id="b" class="b">b</p><p id="c" class="c">c</p></div>',
    { a: ["color", "#000", "text"], b: ["background-color", "#fff", "bg"], c: ["color", "#333", "text"] },
  );
  expect(r.out).toHaveLength(1);
  expect(r.out[0]).toMatch(/^\.a\{color:#[0-9a-f]{6};.*\.b\{background-color:.*\.c\{color:.*@media \(min-width: 1px\)\{border-top-color:.*\}\}$/);
  expect(r.computed).toEqual(r.expected);
});
