import { describe, expect, it } from "vitest";
import { PALETTES } from "../../src/engine/color/palettes";
import type { Role } from "../../src/engine/color/transform";
import { transformCssColor } from "../../src/engine/color/transform";
import type { RewriteCtx } from "../../src/engine/css/declarations";
import { rewriteRuleList } from "../../src/engine/css/rules";

const p = PALETTES.dark;
const T = (v: string, role: Role) => transformCssColor(v, role, p) as string;

function run(css: string, extra: Partial<RewriteCtx> = {}): string[] {
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(css);
  const out: string[] = [];
  rewriteRuleList(sheet.cssRules, { palette: p, mode: "full", varRef: (v) => v, ...extra }, out);
  return out;
}

describe("rewriteRuleList", () => {
  it("a simple rule produces an override", () => {
    expect(run(".a{color:#000}")).toEqual([`.a{color:${T("#000", "text")};}`]);
  });

  it("unchanged rules produce nothing", () => {
    expect(run(".a{width:10px;color:inherit} .b{margin:0}")).toEqual([]);
  });

  it("@media (min-width:600px) wrapping is kept", () => {
    const out = run("@media (min-width:600px){.a{color:#000}}");
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/^@media \(min-width: ?600px\)\{\.a\{color:#[0-9a-f]{6};\}\}$/);
  });

  it("@media print produces nothing; print together with screen or all is kept", () => {
    expect(run("@media print{.a{color:#000}}")).toEqual([]);
    expect(run("@media print and (orientation:landscape){.a{color:#000}}")).toEqual([]);
    expect(run("@media print, screen{.a{color:#000}}")).toHaveLength(1);
    expect(run("@media all{.a{color:#000}}")).toHaveLength(1);
  });

  it("print detection works per query: only lists whose every query is print-only are skipped", () => {
    expect(run("@media not print{.a{color:#000}}")).toHaveLength(1);
    expect(run("@media print, (min-width:900px){.a{color:#000}}")).toHaveLength(1);
    expect(run("@media only print{.a{color:#000}}")).toEqual([]);
    expect(run("@media print, print and (color){.a{color:#000}}")).toEqual([]);
  });

  it("an empty grouping rule produces nothing", () => {
    expect(run("@media (min-width:600px){.a{width:1px}}")).toEqual([]);
  });

  it("@supports is kept", () => {
    const out = run("@supports (display:grid){.a{background-color:#fff}}");
    expect(out).toEqual([`@supports (display:grid){.a{background-color:${T("#fff", "bg")};}}`]);
  });

  it("!important is kept", () => {
    expect(run(".a{color:#000 !important}")).toEqual([`.a{color:${T("#000", "text")} !important;}`]);
  });

  it("a rule with 3 color declarations and 5 other declarations emits only the 3", () => {
    const out = run(".a{color:#000;width:1px;background-color:#fff;height:2px;margin:0;border-top-color:#ddd;padding:0;display:block}");
    expect(out).toEqual([`.a{color:${T("#000", "text")};background-color:${T("#fff", "bg")};border-top-color:${T("#ddd", "border")};}`]);
  });

  it("delegates custom properties to ctx.onVariable and does not emit them", () => {
    const seen: string[][] = [];
    const out = run(":root{--x:#fff;--y:10px} .a{color:#000}", { onVariable: (s, n, v) => seen.push([s, n, v.trim()]) });
    expect(seen).toEqual([[":root", "--x", "#fff"], [":root", "--y", "10px"]]);
    expect(out).toEqual([`.a{color:${T("#000", "text")};}`]);
  });

  it("reports every definition before rewriting, with grouping wrappers and !important", () => {
    const events: string[] = [];
    run(".a{color:var(--x)} @supports (display:grid){@media (max-width:600px){:root{--x:#000 !important}}}", {
      varRef: (v) => (events.push(`use ${v}`), v),
      onVariable: (s, n, v, o) => events.push(`def ${o.wrappers.join(" > ")} ${s} ${n}:${v.trim()}${o.important ? "!" : ""}`),
    });
    expect(events).toHaveLength(2);
    expect(events[0]).toMatch(/^def @supports \(display: ?grid\) > @media \(max-width: ?600px\) :root --x:#000!$/);
    expect(events[1]).toBe("use var(--x)");
  });

  it("mask icons: background-color in a rule with mask-image takes the text role", () => {
    expect(run(".i{mask-image:url(a.svg);background-color:#222}")).toEqual([`.i{background-color:${T("#222", "text")};}`]);
    expect(run(".i{background-color:#222}")).toEqual([`.i{background-color:${T("#222", "bg")};}`]);
  });

  it("@font-face, @keyframes and @page are skipped", () => {
    expect(run("@font-face{font-family:x;color:red} @keyframes k{from{color:#000}to{color:#fff}} @page{color:#000}")).toEqual([]);
  });

  it("@import recurses into an accessible styleSheet, honours its media, and skips inaccessible ones", () => {
    const inner = new CSSStyleSheet();
    inner.replaceSync(".a{color:#000}");
    const imp = (mediaText: string, sheet: () => unknown) =>
      ({ type: 3, cssText: "@import url(x.css);", media: { mediaText }, get styleSheet() { return sheet(); } }) as unknown as CSSRule;
    const ctx: RewriteCtx = { palette: p, mode: "full", varRef: (v) => v };
    const out: string[] = [];
    rewriteRuleList([imp("", () => inner)], ctx, out);
    expect(out).toEqual([`.a{color:${T("#000", "text")};}`]);
    out.length = 0;
    rewriteRuleList([imp("(min-width: 600px)", () => inner)], ctx, out);
    expect(out).toEqual([`@media (min-width: 600px){.a{color:${T("#000", "text")};}}`]);
    out.length = 0;
    rewriteRuleList([imp("print", () => inner)], ctx, out);
    rewriteRuleList([imp("", () => ({ get cssRules() { throw new DOMException("x", "SecurityError"); } }))], ctx, out);
    rewriteRuleList([imp("", () => null)], ctx, out);
    expect(out).toEqual([]);
  });

  it("var() in a shorthand: empty (pending-substitution) longhands fall back to the shorthand once", () => {
    // WebKit leaves longhands empty when a shorthand contains var() (CSS Variables §3.2.1 pending-substitution value,
    // https://drafts.csswg.org/css-variables/#variables-in-shorthands); happy-dom doesn't, so the declaration block is faked.
    const decls: Record<string, string> = {
      "background-image": "", "background-color": "", "border-top-color": "", "border-right-color": "", color: "red",
      background: "var(--a) url(a.png)", border: "1px solid var(--b)",
    };
    const longhands = ["background-image", "background-color", "border-top-color", "border-right-color", "color"];
    const style = {
      length: longhands.length,
      item: (i: number) => longhands[i] ?? "",
      getPropertyValue: (prop: string) => decls[prop] ?? "",
      getPropertyPriority: (prop: string) => (prop === "border" ? "important" : ""),
    };
    const rule = { type: 1, selectorText: ".x", style, cssText: ".x{}" } as unknown as CSSRule;
    const out: string[] = [];
    rewriteRuleList([rule], { palette: p, mode: "full", varRef: (v, r) => `R(${v},${r})` }, out);
    expect(out).toEqual([`.x{background:R(var(--a),bg) url(a.png);border:1px solid R(var(--b),border) !important;color:${T("red", "text")};}`]);
  });

  it("gentle mode: an empty longhand falls back to its shorthand with the longhand's eligibility", () => {
    const decls: Record<string, string> = { "background-color": "", "outline-color": "", background: "var(--a) #fff", outline: "1px solid #000" };
    const longhands = ["background-color", "outline-color"];
    const style = {
      length: longhands.length,
      item: (i: number) => longhands[i] ?? "",
      getPropertyValue: (prop: string) => decls[prop] ?? "",
      getPropertyPriority: () => "",
    };
    const rule = { type: 1, selectorText: ".x", style, cssText: ".x{}" } as unknown as CSSRule;
    const out: string[] = [];
    rewriteRuleList([rule], { palette: p, mode: "gentle", varRef: (v, r) => `R(${v},${r})` }, out);
    expect(out).toEqual([`.x{background:R(var(--a),bg) ${T("#fff", "bg")};}`]);
  });

  it("gentle mode emits only the gentle properties", () => {
    expect(run(".a{color:#000;box-shadow:0 0 1px #000}", { mode: "gentle" })).toEqual([`.a{color:${T("#000", "text")};}`]);
  });
});

describe("absolutizeUrls / stripCssComments", () => {
  it("resolves relative url()s outside strings; data:, fragments and strings stay", async () => {
    const { absolutizeUrls, stripCssComments } = await import("../../src/engine/css/rules");
    const base = "https://site.example/css/a.css";
    expect(absolutizeUrls('url(../i.png) url( "b.png" ) url(#g) url(data:image/png;base64,AA) content:"url(x.png)"', base))
      .toBe('url("https://site.example/i.png") url("https://site.example/css/b.png") url(#g) url(data:image/png;base64,AA) content:"url(x.png)"');
    expect(stripCssComments('a{content:"/* keep */"}/* drop { */b{}')).toBe('a{content:"/* keep */"}b{}');
  });
});
