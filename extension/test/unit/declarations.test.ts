import { describe, expect, it } from "vitest";
import { rgbaToOklch } from "../../src/engine/color/oklch";
import { PALETTES } from "../../src/engine/color/palettes";
import { parseColor } from "../../src/engine/color/parse";
import type { Role } from "../../src/engine/color/transform";
import { transformCssColor } from "../../src/engine/color/transform";
import { rewriteDeclaration, ruleHasMask } from "../../src/engine/css/declarations";
import type { RewriteCtx } from "../../src/engine/css/declarations";
import { propertyKind } from "../../src/engine/css/roles";
import type { Mode } from "../../src/shared/types";

const p = PALETTES.dark;
const T = (v: string, role: Role) => transformCssColor(v, role, p) as string;
const calls: [string, Role][] = [];
const ctx = (mode: Mode = "full", extra: Partial<RewriteCtx> = {}): RewriteCtx => ({
  palette: p,
  mode,
  varRef: (value, role) => {
    calls.push([value, role]);
    return `R(${value},${role})`;
  },
  ...extra,
});

describe("propertyKind", () => {
  it.each([
    ["color", "text"], ["background-color", "bg"], ["border-top-color", "border"], ["border-color", "border"],
    ["outline-color", "text"], ["fill", "text"], ["stroke", "text"], ["caret-color", "text"], ["text-decoration-color", "text"],
    ["column-rule-color", "border"], ["stop-color", "bg"], ["accent-color", "text"],
    ["background", "background-shorthand"], ["border", "border-shorthand"], ["border-left", "border-shorthand"], ["outline", "border-shorthand"],
    ["box-shadow", "shadow"], ["text-shadow", "shadow"], ["background-image", "image"],
    ["mix-blend-mode", "blend"], ["background-blend-mode", "blend"],
    ["mask-image", null], ["width", null], ["--x", null],
  ])("%s → %s", (prop, kind) => expect(propertyKind(prop)).toBe(kind));
});

describe("rewriteDeclaration", () => {
  it("color: #000 → the text role", () => {
    expect(rewriteDeclaration("color", "#000", ctx())).toBe(T("#000", "text"));
  });

  it("background shorthand: only the color token changes", () => {
    expect(rewriteDeclaration("background", "#fff url(a.png) no-repeat", ctx())).toBe(`${T("#fff", "bg")} url(a.png) no-repeat`);
  });

  // Safari 27 adds alpha() and image(<color>) and keeps them in the specified value (Safari 27 release notes;
  // BCD css.types.color.alpha safari_ios 27).
  it("alpha(): the origin color is rewritten, the alpha is kept", () => {
    expect(rewriteDeclaration("background-color", "alpha(from white / .5)", ctx())).toBe(`alpha(from ${T("white", "bg")} / .5)`);
    expect(rewriteDeclaration("color", "alpha(from var(--x) / 50%)", ctx())).toBe("alpha(from R(var(--x),text) / 50%)");
  });

  it("image(<color>): the color is rewritten", () => {
    expect(rewriteDeclaration("background-image", "image(white)", ctx())).toBe(`image(${T("white", "bg")})`);
    expect(rewriteDeclaration("background-image", "image(url(a.png))", ctx())).toBeNull();
  });

  it("background-image gradient: both stops use the bg transform", () => {
    expect(rewriteDeclaration("background-image", "linear-gradient(#fff, #eee)", ctx())).toBe(
      `linear-gradient(${T("#fff", "bg")}, ${T("#eee", "bg")})`,
    );
  });

  it("gradient with direction and stop positions keeps the non-color tokens", () => {
    expect(rewriteDeclaration("background-image", "linear-gradient(to right, rgba(255,255,255,.5) 10%, white 90%)", ctx())).toBe(
      `linear-gradient(to right, ${T("rgba(255,255,255,.5)", "bg")} 10%, ${T("white", "bg")} 90%)`,
    );
  });

  it("border: 1px solid #ddd → the border transform", () => {
    expect(rewriteDeclaration("border", "1px solid #ddd", ctx())).toBe(`1px solid ${T("#ddd", "border")}`);
  });

  it("box-shadow: each color uses the bg transform", () => {
    expect(rewriteDeclaration("box-shadow", "0 1px 2px rgba(0,0,0,.2), inset 0 0 0 1px #ccc", ctx())).toBe(
      `0 1px 2px ${T("rgba(0,0,0,.2)", "bg")}, inset 0 0 0 1px ${T("#ccc", "bg")}`,
    );
  });

  it("var(--x) in color is passed to ctx.varRef(value, 'text')", () => {
    calls.length = 0;
    expect(rewriteDeclaration("color", "var(--x)", ctx())).toBe("R(var(--x),text)");
    expect(calls).toEqual([["var(--x)", "text"]]);
  });

  it("a color function with var() channels goes to varRef as a whole token", () => {
    calls.length = 0;
    expect(rewriteDeclaration("background-color", "rgb(var(--c) / 1)", ctx())).toBe("R(rgb(var(--c) / 1),bg)");
  });

  it("returns null when varRef leaves the value unchanged", () => {
    expect(rewriteDeclaration("color", "var(--x)", ctx("full", { varRef: (v) => v }))).toBeNull();
  });

  it.each(["inherit", "currentcolor", "transparent", "initial", "unset"])("color: %s → null", (v) => {
    expect(rewriteDeclaration("color", v, ctx())).toBeNull();
  });

  it("!important is not part of the value (the caller handles it)", () => {
    const out = rewriteDeclaration("color", "#000", ctx());
    expect(out).not.toContain("important");
  });

  it("returns null for unrelated properties, custom properties and unknown syntax", () => {
    expect(rewriteDeclaration("width", "10px", ctx())).toBeNull();
    expect(rewriteDeclaration("--x", "#fff", ctx())).toBeNull();
    expect(rewriteDeclaration("color", "light-dark(foo)", ctx())).toBeNull();
    expect(rewriteDeclaration("background", "url(a.png) no-repeat", ctx())).toBeNull();
  });

  it("gentle mode rewrites only background-color, color and border-*-color", () => {
    const g = ctx("gentle");
    expect(rewriteDeclaration("background-color", "#fff", g)).toBe(T("#fff", "bg"));
    expect(rewriteDeclaration("color", "#000", g)).toBe(T("#000", "text"));
    expect(rewriteDeclaration("border-top-color", "#ddd", g)).toBe(T("#ddd", "border"));
    expect(rewriteDeclaration("border-color", "#ddd", g)).toBe(T("#ddd", "border"));
    expect(rewriteDeclaration("background-image", "linear-gradient(#fff, #eee)", g)).toBeNull();
    expect(rewriteDeclaration("box-shadow", "0 1px 2px #000", g)).toBeNull();
    expect(rewriteDeclaration("fill", "#000", g)).toBeNull();
  });

  it.each(["filter", "off"] as Mode[])("%s mode rewrites nothing", (mode) => {
    expect(rewriteDeclaration("color", "#000", ctx(mode))).toBeNull();
    expect(rewriteDeclaration("mix-blend-mode", "multiply", ctx(mode))).toBeNull();
  });

  it("mask icons: background-color in a rule with a mask uses the text role (a light color)", () => {
    const out = rewriteDeclaration("background-color", "#222", ctx("full", { ruleHasMask: true })) as string;
    expect(out).toBe(T("#222", "text"));
    expect(rgbaToOklch(parseColor(out)!).l).toBeGreaterThan(0.7);
    // Without the mask it is a dark surface.
    expect(rgbaToOklch(parseColor(rewriteDeclaration("background-color", "#222", ctx()) as string)!).l).toBeLessThan(0.3);
  });

  it("ruleHasMask detects mask-image / -webkit-mask-image other than none", () => {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(".i{mask-image:url(a.svg);background-color:#222} .j{mask-image:none;background-color:#222} .k{color:red}");
    const has = Array.from(sheet.cssRules, (r) => ruleHasMask((r as CSSStyleRule).style));
    expect(has).toEqual([true, false, false]);
  });

  it("blend remap: multiply → normal, lists per item, difference kept", () => {
    expect(rewriteDeclaration("mix-blend-mode", "multiply", ctx())).toBe("normal");
    expect(rewriteDeclaration("background-blend-mode", "multiply, screen", ctx())).toBe("normal, normal");
    for (const v of ["darken", "color-burn", "lighten", "color-dodge"]) expect(rewriteDeclaration("mix-blend-mode", v, ctx())).toBe("normal");
    expect(rewriteDeclaration("mix-blend-mode", "difference", ctx())).toBeNull();
    expect(rewriteDeclaration("mix-blend-mode", "exclusion", ctx())).toBeNull();
    expect(rewriteDeclaration("background-blend-mode", "multiply, difference", ctx())).toBe("normal, difference");
    expect(rewriteDeclaration("mix-blend-mode", "multiply", ctx("gentle"))).toBe("normal");
  });

  it("tokenizing respects parentheses and quotes", () => {
    expect(rewriteDeclaration("background-image", 'url("a,b(#fff).png")', ctx())).toBeNull();
    expect(rewriteDeclaration("background", "url('x #fff (y).png') #fff", ctx())).toBe(`url('x #fff (y).png') ${T("#fff", "bg")}`);
  });

  it("outline shorthand uses the text (foreground) role, like outline-color", () => {
    expect(rewriteDeclaration("outline", "2px solid #06c", ctx())).toBe(`2px solid ${T("#06c", "text")}`);
  });

  it("literal channels with a var() alpha are transformed at alpha 1 and keep the alpha text", () => {
    calls.length = 0;
    const white = parseColor(T("#fff", "bg"))!;
    const rgb = `${white.r} ${white.g} ${white.b}`;
    expect(rewriteDeclaration("background-color", "rgb(255 255 255 / var(--tw-bg-opacity))", ctx())).toBe(`rgb(${rgb} / var(--tw-bg-opacity))`);
    expect(rewriteDeclaration("background-color", "hsl(0 0% 100% / var(--o, 1))", ctx())).toBe(`rgb(${rgb} / var(--o, 1))`);
    expect(rewriteDeclaration("background-color", "rgba(255, 255, 255, var(--o))", ctx())).toBe(`rgb(${rgb} / var(--o))`);
    expect(calls).toEqual([]);
  });

  it("gentle mode rewrites only the plain color tokens of background/border shorthands", () => {
    const g = ctx("gentle");
    expect(rewriteDeclaration("background", "#fff linear-gradient(#fff, #eee)", g)).toBe(`${T("#fff", "bg")} linear-gradient(#fff, #eee)`);
    expect(rewriteDeclaration("background", "var(--a) no-repeat", g)).toBe("R(var(--a),bg) no-repeat");
    expect(rewriteDeclaration("border-top", "1px solid #ddd", g)).toBe(`1px solid ${T("#ddd", "border")}`);
    expect(rewriteDeclaration("outline", "1px solid #000", g)).toBeNull();
    expect(rewriteDeclaration("background", "linear-gradient(#fff, #eee)", g)).toBeNull();
  });

  it("scrollbar-color: thumb uses the border transform, track the bg transform", () => {
    expect(rewriteDeclaration("scrollbar-color", "#c1c1c1 #f1f1f1", ctx())).toBe(`${T("#c1c1c1", "border")} ${T("#f1f1f1", "bg")}`);
  });
});
