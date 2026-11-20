import { describe, expect, it } from "vitest";
import { PALETTES } from "../../src/engine/color/palettes";
import { parseColor } from "../../src/engine/color/parse";
import type { Role } from "../../src/engine/color/transform";
import { paletteCss, transformColor, transformCssColor } from "../../src/engine/color/transform";
import { rewriteDeclaration } from "../../src/engine/css/declarations";
import { rewriteRuleList } from "../../src/engine/css/rules";
import { VariableRegistry } from "../../src/engine/css/variables";

const p = PALETTES.dark;
const T = (v: string, role: Role) => transformCssColor(v, role, p) as string;

// Feeds a sheet through the real rule rewriter, wiring the registry the way the style manager will.
function feed(reg: VariableRegistry, css: string): string[] {
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(css);
  const out: string[] = [];
  rewriteRuleList(sheet.cssRules, {
    palette: p,
    mode: "full",
    varRef: (v, r) => reg.varRef(v, r),
    onVariable: (s, n, v, o) => reg.observeDefinition(s, n, v, o),
  }, out);
  return out;
}

function expectAllDefined(out: string[], css: string): void {
  const text = out.join("") + css;
  const refs = new Set([...text.matchAll(/var\((--dusk-[\w-]+)/g)].map((m) => m[1]));
  const defined = new Set([...css.matchAll(/(--dusk-[\w-]+):/g)].map((m) => m[1]));
  expect([...refs].filter((r) => !defined.has(r))).toEqual([]);
}

describe("VariableRegistry", () => {
  it("--a:#fff used in background → --dusk-bg--a is defined with the dark value", () => {
    const reg = new VariableRegistry(p);
    const out = feed(reg, ":root{--a:#fff} .x{background-color:var(--a)}");
    expect(out).toEqual([".x{background-color:var(--dusk-bg--a);}"]);
    expect(reg.rolesOf("--a")).toEqual(new Set(["bg"]));
    expect(reg.definitionsCss(p)).toContain(`:root{--dusk-bg--a:${T("#fff", "bg")};}`);
  });

  it("used in both color and background → both are defined", () => {
    const reg = new VariableRegistry(p);
    feed(reg, ":root{--a:#fff} .x{background-color:var(--a)} .y{color:var(--a)}");
    const css = reg.definitionsCss(p);
    expect(css).toContain(`--dusk-bg--a:${T("#fff", "bg")};`);
    expect(css).toContain(`--dusk-text--a:${T("#fff", "text")};`);
    expect(css).not.toContain("--dusk-border--a");
  });

  it("fallback: var(--a, #fff) → var(--dusk-bg--a, <transformed #fff>)", () => {
    const reg = new VariableRegistry(p);
    reg.observeDefinition(":root", "--a", "#eee");
    expect(reg.varRef("var(--a, #fff)", "bg")).toBe(`var(--dusk-bg--a, ${T("#fff", "bg")})`);
    expect(reg.varRef("var(--a, var(--a, #000))", "text")).toBe(`var(--dusk-text--a, var(--dusk-text--a, ${T("#000", "text")}))`);
  });

  it("a chain: --a: var(--b) → --dusk-<role>--a: var(--dusk-<role>--b), and --b gets the role", () => {
    const reg = new VariableRegistry(p);
    feed(reg, ":root{--b:#000;--a:var(--b)} .x{color:var(--a)}");
    const css = reg.definitionsCss(p);
    expect(css).toContain("--dusk-text--a:var(--dusk-text--b);");
    expect(css).toContain(`--dusk-text--b:${T("#000", "text")};`);
  });

  it("chains end at depth 10: usages resolving past it are not rewritten, and nothing references an undefined var", () => {
    const reg = new VariableRegistry(p);
    for (let i = 0; i < 14; i++) reg.observeDefinition(":root", `--v${i}`, `var(--v${i + 1})`);
    reg.observeDefinition(":root", "--v14", "#fff");
    expect(reg.varRef("var(--v0)", "text")).toBe("var(--v0)"); // 14 hops
    expect(reg.varRef("var(--v4)", "text")).toBe("var(--dusk-text--v4)"); // 10 hops
    expect(reg.varRef("var(--v3)", "text")).toBe("var(--v3)"); // 11 hops
    const css = reg.definitionsCss(p);
    expect(css).toContain("--dusk-text--v4:var(--dusk-text--v5);");
    expect(css).toContain(`--dusk-text--v14:${T("#fff", "text")};`);
    expect(css).not.toContain("--dusk-text--v3:");
    expectAllDefined([], css);
  });

  it("a chain to a variable set only by script is not rewritten", () => {
    const reg = new VariableRegistry(p);
    const out = feed(reg, ":root{--a:var(--b)} .x{color:var(--a)}");
    expect(out).toEqual([]);
    expect(reg.definitionsCss(p)).not.toContain("--dusk-text--a");
  });

  it("unknown variable with a fallback: the fallback is still transformed", () => {
    const reg = new VariableRegistry(p);
    expect(reg.varRef("var(--text, #333)", "text")).toBe(`var(--text, ${T("#333", "text")})`);
    const out = feed(reg, ".x{color:var(--text, #333)}");
    expect(out).toEqual([`.x{color:var(--text, ${T("#333", "text")});}`]);
  });

  it("Tailwind: --tw-bg-opacity is ignored and rgb(var(--c) / …) with --c: 255 255 255 is handled", () => {
    const reg = new VariableRegistry(p);
    const out = feed(reg, ":root{--c:255 255 255;--tw-bg-opacity:1} .x{background-color:rgb(var(--c) / var(--tw-bg-opacity))}");
    expect(out).toEqual([".x{background-color:rgb(var(--dusk-bg--c) / var(--tw-bg-opacity));}"]);
    expect(reg.rolesOf("--tw-bg-opacity").size).toBe(0);
    const t = transformColor({ r: 255, g: 255, b: 255, a: 1 }, "bg", p);
    const css = reg.definitionsCss(p);
    expect(css).toContain(`--dusk-bg--c:${Math.round(t.r)} ${Math.round(t.g)} ${Math.round(t.b)};`);
    expect(css).not.toContain("tw-bg-opacity");
  });

  it("comma-separated RGB triples keep their separator", () => {
    const reg = new VariableRegistry(p);
    feed(reg, ":root{--c:33, 37, 41} .x{color:rgba(var(--c), .5)}");
    expect(reg.definitionsCss(p)).toMatch(/--dusk-text--c:\d+, \d+, \d+;/);
  });

  it("a non-color variable isn't redefined and its var() is left alone", () => {
    const reg = new VariableRegistry(p);
    feed(reg, ":root{--w:10px;--h:0 0% 100%} .x{border-top-color:var(--w)} .y{background-color:var(--h)}");
    expect(rewriteDeclaration("border", "var(--w) solid #ccc", { palette: p, mode: "full", varRef: (v, r) => reg.varRef(v, r) })).toBe(
      `var(--w) solid ${T("#ccc", "border")}`,
    );
    expect(reg.varRef("var(--h)", "bg")).toBe("var(--h)"); // an HSL triple is not a color on its own
    expect(reg.varRef("rgb(var(--h))", "bg")).toBe("rgb(var(--h))"); // nor an RGB triple
    const css = reg.definitionsCss(p);
    expect(css).not.toContain("--dusk-border--w");
    expect(css).not.toContain("--h");
  });

  it("shadcn/ui: hsl(var(--x)) and hsl(var(--x) / a) with --x: 0 0% 100% emit the transformed HSL triple", () => {
    const reg = new VariableRegistry(p);
    const out = feed(reg, ":root{--background:0 0% 100%;--fg:222.2 84% 4.9%} .x{background-color:hsl(var(--background))} .y{color:hsl(var(--fg) / .8)}");
    expect(out).toEqual([".x{background-color:hsl(var(--dusk-bg--background));}", ".y{color:hsl(var(--dusk-text--fg) / .8);}"]);
    const css = reg.definitionsCss(p);
    const bg = /--dusk-bg--background:([\d.]+) ([\d.]+)% ([\d.]+)%;/.exec(css);
    const fg = /--dusk-text--fg:([\d.]+) ([\d.]+)% ([\d.]+)%;/.exec(css);
    expect(bg).not.toBeNull();
    expect(fg).not.toBeNull();
    const near = (a: string, b: string) => {
      const x = parseColor(a)!;
      const y = parseColor(b)!;
      return Math.max(Math.abs(x.r - y.r), Math.abs(x.g - y.g), Math.abs(x.b - y.b));
    };
    expect(near(`hsl(${bg![1]} ${bg![2]}% ${bg![3]}%)`, T("#fff", "bg"))).toBeLessThanOrEqual(1);
    expect(near(`hsl(${fg![1]} ${fg![2]}% ${fg![3]}%)`, T("hsl(222.2 84% 4.9%)", "text"))).toBeLessThanOrEqual(1);
  });

  // A design-token pattern: the color variable is itself rgb()/hsl() over a channel-triple variable, and the text uses the
  // color variable plainly. Neither --fg nor --fg-light was redefinable, so the text kept the light theme's dark gray on
  // Duskling's dark background. The display-p3 twin under @media yields no redefinition, so the sRGB one stays in effect.
  it("a variable defined as rgb()/hsl() over a triple variable is redefined for plain uses", () => {
    const reg = new VariableRegistry(p);
    const out = feed(reg, `:root{--gray-700-rgb:54,55,55;--white-rgb:255 255 255;--gray-h:0 0% 96%;
      --fg-light:rgb(var(--gray-700-rgb));--fg:var(--fg-light);--bg:rgb(var(--white-rgb) / 1);--muted:rgba(var(--gray-700-rgb),.7);
      --soft:hsl(var(--gray-h))}
      @media (dynamic-range:high){:root{--fg-light:color(display-p3 var(--gray-700-p3))}}
      h1{color:var(--fg)} .page{background-color:var(--bg)} .m{color:var(--muted)} .s{background-color:var(--soft)}`);
    expect(out).toEqual([
      "h1{color:var(--dusk-text--fg);}",
      ".page{background-color:var(--dusk-bg--bg);}",
      ".m{color:var(--dusk-text--muted);}",
      ".s{background-color:var(--dusk-bg--soft);}",
    ]);
    const css = reg.definitionsCss(p);
    expectAllDefined(out, css);
    expect(css).toContain("--dusk-text--fg:var(--dusk-text--fg-light);");
    expect(css).toContain("--dusk-text--fg-light:rgb(var(--dusk-text--gray-700-rgb));");
    expect(css).toContain("--dusk-text--muted:rgba(var(--dusk-text--gray-700-rgb),.7);");
    expect(css).toContain("--dusk-bg--bg:rgb(var(--dusk-bg--white-rgb) / 1);");
    expect(css).toContain("--dusk-bg--soft:hsl(var(--dusk-bg--gray-h));");
    const t = transformColor({ r: 54, g: 55, b: 55, a: 1 }, "text", p);
    expect(css).toContain(`--dusk-text--gray-700-rgb:${[t.r, t.g, t.b].map(Math.round).join(", ")};`);
    expect(css).not.toContain("p3");
  });

  it("a triple defined in a later sheet notifies for the rgb() variables that wrap it", () => {
    const reg = new VariableRegistry(p);
    feed(reg, ":root{--fg-light:rgb(var(--late-rgb));--fg:var(--fg-light)} h1{color:var(--fg)}");
    reg.definitionsCss(p);
    const seen: string[][] = [];
    reg.onRolesChanged((n) => seen.push(n));
    feed(reg, ":root{--late-rgb:54 55 55}");
    expect(seen).toEqual([["--fg"]]);
    expect(reg.varRef("var(--fg)", "text")).toBe("var(--dusk-text--fg)");
    expect(reg.definitionsCss(p)).toMatch(/--dusk-text--late-rgb:\d+ \d+ \d+;/);
  });

  it("usage before definition in the same sheet resolves without a notification", () => {
    const reg = new VariableRegistry(p);
    const seen: string[][] = [];
    reg.onRolesChanged((n) => seen.push(n));
    const out = feed(reg, ".x{color:var(--a)} .y{background-color:var(--b)} :root{--a:#000;--b:var(--a)}");
    expect(out).toEqual([".x{color:var(--dusk-text--a);}", ".y{background-color:var(--dusk-bg--b);}"]);
    reg.definitionsCss(p);
    expect(seen).toEqual([]);
  });

  it("a definition in a later sheet notifies for variables earlier sheets used (also through chains)", () => {
    const reg = new VariableRegistry(p);
    feed(reg, ":root{--a:var(--late)} .x{color:var(--a)} .y{color:var(--late)}");
    reg.definitionsCss(p);
    const seen: string[][] = [];
    reg.onRolesChanged((n) => seen.push(n));
    feed(reg, ":root{--late:#fff}");
    expect(seen).toEqual([["--late", "--a"]]);
    expect(reg.varRef("var(--a)", "text")).toBe("var(--dusk-text--a)");
  });

  it("onRolesChanged fires when a second sheet uses --a in color", () => {
    const reg = new VariableRegistry(p);
    feed(reg, ":root{--a:#fff} .x{background-color:var(--a)}");
    reg.definitionsCss(p);
    const seen: string[][] = [];
    reg.onRolesChanged((n) => seen.push(n));
    feed(reg, ".z{background-color:var(--a)}");
    expect(seen).toEqual([]);
    feed(reg, ".y{color:var(--a)}");
    expect(seen).toEqual([["--a"]]);
  });

  it("observeUsage records roles from property usage without rewriting", () => {
    const reg = new VariableRegistry(p);
    reg.observeUsage("border", "1px solid var(--b)");
    reg.observeUsage("box-shadow", "0 0 1px var(--s)");
    reg.observeUsage("width", "var(--w)");
    expect(reg.rolesOf("--b")).toEqual(new Set(["border"]));
    expect(reg.rolesOf("--s")).toEqual(new Set(["bg"]));
    expect(reg.rolesOf("--w").size).toBe(0);
  });

  it("defines the shared :root variables from paletteCss", () => {
    const css = new VariableRegistry(p).definitionsCss(p);
    const pc = paletteCss(p);
    expect(css).toContain(
      `:root{--dusk-neutral-bg:${pc.bg};--dusk-neutral-text:${pc.fg};--dusk-selection-bg:${pc.selectionBg};--dusk-selection-text:${pc.selectionText};}`,
    );
    expect(parseColor(pc.bg)).not.toBeNull();
  });

  it("keeps definitions per selector, in source order", () => {
    const reg = new VariableRegistry(p);
    feed(reg, ":root{--a:#fff} .dark{--a:#111} :root{--b:#eee} .x{background-color:var(--a);color:var(--b)}");
    const css = reg.definitionsCss(p);
    expect(css).toContain(
      `:root{--dusk-bg--a:${T("#fff", "bg")};}.dark{--dusk-bg--a:${T("#111", "bg")};}:root{--dusk-text--b:${T("#eee", "text")};}`,
    );
  });

  it("keeps grouping wrappers, nesting-resolved selectors and !important on definitions", () => {
    const reg = new VariableRegistry(p);
    reg.observeDefinition(":root", "--a", "#fff");
    reg.observeDefinition(":root", "--a", "#000", { wrappers: ["@layer base", "@media (max-width: 600px)"], important: true });
    reg.observeDefinition(":is(.card) .title", "--a", "#eee", { wrappers: [], important: false });
    reg.varRef("var(--a)", "bg");
    expect(reg.definitionsCss(p)).toContain(
      `:root{--dusk-bg--a:${T("#fff", "bg")};}@layer base{@media (max-width: 600px){:root{--dusk-bg--a:${T("#000", "bg")} !important;}}}:is(.card) .title{--dusk-bg--a:${T("#eee", "bg")};}`,
    );
  });

  it("rewriteRuleList reports wrappers, resolved selectors and importance to the registry", () => {
    const reg = new VariableRegistry(p);
    feed(reg, ":root{--a:#fff} @media (max-width:600px){:root{--a:#000 !important}} .x{background-color:var(--a)}");
    const css = reg.definitionsCss(p);
    expect(css).toMatch(new RegExp(`@media \\(max-width: ?600px\\)\\{:root\\{--dusk-bg--a:${T("#000", "bg")} !important;\\}\\}`));
  });

  it("invariant: every --dusk-* variable referenced in the output is defined", () => {
    const reg = new VariableRegistry(p);
    const out = [
      ...feed(reg, `:root{--c:#fff;--chain:var(--c);--js:var(--set-by-script);--w:2px;--t:255 255 255;--h:0 0% 100%;--loop:var(--loop2);--loop2:var(--loop)}
        .a{color:var(--c);background:var(--chain) no-repeat;border:var(--w) solid var(--js);box-shadow:0 0 1px var(--unknown, #000)}
        .b{background-color:rgb(var(--t) / .5);color:hsl(var(--h));outline-color:var(--loop);fill:var(--c, var(--chain, red))}
        .c{background-image:linear-gradient(var(--chain), var(--nope))}`),
    ];
    expectAllDefined(out, reg.definitionsCss(p));
  });
});

describe("VariableRegistry and light-dark()", () => {
  // linkedin.com: a variable defined as a color on some classes and as light-dark() on others. Only the plain colors were
  // redefined, so where the light-dark() definition applied the role variable was undefined and the text inherited the
  // page's black onto Duskling's dark background (1.2:1).
  it("a light-dark() of two colors is redefined with both branches transformed", () => {
    const reg = new VariableRegistry(p);
    const out = feed(reg, ".a{--x:#333} .b{--x:light-dark(rgb(0 0 0 / 0.75), rgb(255 255 255 / 0.75))} p{color:var(--x)}");
    const css = reg.definitionsCss(p);
    expect(css).toContain(`.b{--dusk-text--x:light-dark(${T("rgb(0 0 0 / 0.75)", "text")}, ${T("rgb(255 255 255 / 0.75)", "text")});}`);
    expectAllDefined(out, css);
  });

  it("a light-dark() alone makes the variable rewritable", () => {
    const reg = new VariableRegistry(p);
    const out = feed(reg, ":root{--x:light-dark(#fff, #111)} .y{background-color:var(--x)}");
    expect(out).toEqual([".y{background-color:var(--dusk-bg--x);}"]);
    expect(reg.definitionsCss(p)).toContain(`:root{--dusk-bg--x:light-dark(${T("#fff", "bg")}, ${T("#111", "bg")});}`);
  });

  it("a light-dark() of var() branches resolves through them, and they get the role", () => {
    const reg = new VariableRegistry(p);
    const out = feed(reg, ":root{--a:#000;--b:#fff;--x:light-dark(var(--a), var(--b))} p{color:var(--x)}");
    expect(out).toEqual(["p{color:var(--dusk-text--x);}"]);
    const css = reg.definitionsCss(p);
    expect(css).toContain("--dusk-text--x:light-dark(var(--dusk-text--a), var(--dusk-text--b));");
    expect(css).toContain(`--dusk-text--a:${T("#000", "text")};`);
    expect(css).toContain(`--dusk-text--b:${T("#fff", "text")};`);
    expectAllDefined(out, css);
  });

  it("a light-dark() whose var() branch is undefined stays unredefined", () => {
    const reg = new VariableRegistry(p);
    const out = feed(reg, ":root{--x:light-dark(var(--y), #111)} .y{background-color:var(--x)}");
    expect(out).toEqual([]);
  });
});

describe("VariableRegistry cost on theme-heavy pages", () => {
  // github.com defines each of ~1,000 variables once per theme (about a dozen themes), with chains between them. Each new
  // definition used to clear every resolution memo, so the cost grew with definitions × variables (this case: ~860 ms
  // before, ~90 ms after, on an M-series Mac).
  it("observes 24 themes of 200 base colors and 1,000 semantic variables chained to them in well under a second", () => {
    const reg = new VariableRegistry(PALETTES.dark);
    const BASE = 200;
    const SEM = 1000;
    for (let i = 0; i < SEM; i++) reg.observeUsage(i % 2 ? "color" : "background-color", `var(--sem${i})`);
    const t = performance.now();
    for (let theme = 0; theme < 24; theme++) {
      const src = {};
      reg.replaceSource(src, () => {
        const sel = `[data-theme=t${theme}]`;
        for (let i = 0; i < SEM; i++) reg.observeDefinition(sel, `--sem${i}`, `var(--base${i % BASE})`, { source: src });
        for (let i = 0; i < BASE; i++) {
          reg.observeDefinition(sel, `--base${i}`, `rgb(${(theme * 7 + i) % 256}, ${(i * 3) % 256}, ${(theme * 11) % 256})`, { source: src });
        }
      });
      reg.sheetDefinitionsCss(src, PALETTES.dark);
    }
    const ms = performance.now() - t;
    expect(reg.size).toBe(24 * (BASE + SEM));
    expect(ms).toBeLessThan(400);
  });
});
