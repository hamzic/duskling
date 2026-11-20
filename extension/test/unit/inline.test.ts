import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PALETTES } from "../../src/engine/color/palettes";
import { parseColor } from "../../src/engine/color/parse";
import type { RGBA } from "../../src/engine/color/parse";
import type { Role } from "../../src/engine/color/transform";
import { transformCssColor } from "../../src/engine/color/transform";
import type { RewriteCtx } from "../../src/engine/css/declarations";
import { InlineStyler, isContentColor } from "../../src/engine/css/inline";
import { rewriteRuleList } from "../../src/engine/css/rules";
import { VariableRegistry } from "../../src/engine/css/variables";

const p = PALETTES.dark;
const T = (v: string, role: Role) => transformCssColor(v, role, p) as string;
const tick = () => new Promise((r) => setTimeout(r, 0));
const ctx: RewriteCtx = { palette: p, mode: "full", varRef: (v) => v };
const SVG = "http://www.w3.org/2000/svg";

// happy-dom has no layout: give test elements a box.
function box<E extends Element>(el: E, width: number, height: number): E {
  el.getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, left: 0, right: width, bottom: height, width, height, toJSON: () => ({}) }) as DOMRect;
  return el;
}

// A value as this environment serializes it inside a style declaration.
function norm(prop: string, value: string): string {
  const d = document.createElement("div");
  d.style.setProperty(prop, value);
  return d.style.getPropertyValue(prop);
}

const attrsCss = () => document.querySelector('style[data-dusk="attrs"]')?.textContent ?? "";
const attrRule = (attr: string, raw: string, prop: string, value: string) =>
  `:where(svg|*[${attr}="${raw}" i]:not([data-dusk-keep])){${prop}:${value}}`;

const $ = <E extends Element = HTMLElement>(sel: string) => document.querySelector(sel) as E;
const rgba = (v: string) => parseColor(v) as RGBA;

let s: InlineStyler | null = null;
beforeEach(() => {
  document.body.innerHTML = "";
});
afterEach(() => {
  s?.stop();
  s = null;
});

describe("isContentColor (content-color guard)", () => {
  it("a small, textless, chromatic box is content; with text, large or gray it isn't", () => {
    const span = box(document.createElement("span"), 24, 24);
    document.body.append(span);
    expect(isContentColor(span, rgba("#e53935"))).toBe(true);
    expect(isContentColor(span, rgba("#eeeeee"))).toBe(false);
    span.textContent = "  ";
    expect(isContentColor(span, rgba("#e53935"))).toBe(true);
    span.textContent = "Hi";
    expect(isContentColor(span, rgba("#e53935"))).toBe(false);
    const big = box(document.createElement("div"), 65, 24);
    document.body.append(big);
    expect(isContentColor(big, rgba("#e53935"))).toBe(false);
  });

  it("a shape with >= 3 sibling shapes using >= 3 distinct chromatic fills is content; gray shapes and non-siblings aren't", () => {
    document.body.innerHTML = `<svg><rect fill="#e53935"/><rect fill="#43a047"/><rect style="fill:#1e88e5"/><line stroke="#000"/></svg>`;
    const [a] = [...document.querySelectorAll("rect")];
    expect(isContentColor(box(a as Element, 300, 300), rgba("#e53935"))).toBe(true);
    expect(isContentColor(box($("line"), 300, 300), rgba("#000"))).toBe(false);
    // The guard counts sibling shapes: three colors spread over separate groups aren't a chart.
    document.body.innerHTML = `<svg><g><rect fill="#e53935"/></g><g><rect fill="#43a047"/></g><g><rect fill="#1e88e5"/></g></svg>`;
    expect(isContentColor(box($("rect"), 300, 300), rgba("#e53935"))).toBe(false);
    document.body.innerHTML = `<svg><rect fill="#e53935"/><rect fill="#e53935"/><rect fill="#000"/></svg>`;
    expect(isContentColor(box($("rect"), 300, 300), rgba("#e53935"))).toBe(false);
  });
});

describe("InlineStyler", () => {
  it('style="color:#000" becomes light, !important', () => {
    document.body.innerHTML = '<p style="color:#000">x</p>';
    s = new InlineStyler(document, ctx);
    s.start();
    const el = $("p");
    expect(el.style.getPropertyValue("color")).toBe(norm("color", T("#000", "text")));
    expect(el.style.getPropertyPriority("color")).toBe("important");
  });

  it("a 24×24 textless swatch keeps its color; the same color on a 300×40 element with text is transformed", () => {
    document.body.innerHTML = '<span id="sw" style="background:#e53935"></span><div id="bar" style="background:#e53935">Label</div>';
    box($("#sw"), 24, 24);
    box($("#bar"), 300, 40);
    const before = $("#sw").getAttribute("style");
    s = new InlineStyler(document, ctx);
    s.start();
    expect($("#sw").getAttribute("style")).toBe(before);
    expect($("#bar").style.getPropertyValue("background-color")).toBe(norm("background-color", T("#e53935", "bg")));
  });

  it("an SVG chart (4 distinct saturated fills) is unchanged; a single black <path> icon is transformed", () => {
    document.body.innerHTML = `<svg id="chart"><rect fill="#e53935"/><rect fill="#43a047"/><rect fill="#1e88e5"/><rect fill="#fdd835"/></svg>
      <svg id="icon"><path fill="#000" d="M0 0h1v1z"/></svg>`;
    for (const r of document.querySelectorAll("rect")) box(r, 40, 120);
    box($("path"), 24, 24);
    s = new InlineStyler(document, ctx);
    s.start();
    // Chart shapes are marked to be skipped by the value-keyed rules; no inline style is written.
    for (const r of document.querySelectorAll("rect")) {
      expect(r.hasAttribute("style")).toBe(false);
      expect(r.hasAttribute("data-dusk-keep")).toBe(true);
    }
    const path = $<SVGPathElement>("path");
    expect(path.getAttribute("fill")).toBe("#000");
    expect(path.hasAttribute("style")).toBe(false);
    expect(path.hasAttribute("data-dusk-keep")).toBe(false);
    expect(attrsCss()).toContain(attrRule("fill", "#000", "fill", T("#000", "text")));
    s.stop();
    s = null;
    expect(document.querySelectorAll("[data-dusk], [data-dusk-keep]")).toHaveLength(0);
  });

  it('<svg fill="#000"> gets a zero-specificity rule in a first-placed @layer, the attribute is untouched', () => {
    document.head.innerHTML = "<style>p{color:red}</style>";
    const svg = document.createElementNS(SVG, "svg");
    svg.setAttribute("fill", "#000");
    document.body.append(svg);
    s = new InlineStyler(document, ctx);
    s.start();
    expect(svg.getAttribute("fill")).toBe("#000");
    expect(svg.hasAttribute("style")).toBe(false);
    const node = document.head.firstElementChild as HTMLStyleElement;
    expect(node.getAttribute("data-dusk")).toBe("attrs");
    expect(node.getAttribute("media")).toBe("screen");
    expect(attrsCss()).toBe(`@namespace svg url(${SVG});@layer dusk-attrs{${attrRule("fill", "#000", "fill", T("#000", "text"))}}`);
    document.head.innerHTML = "";
  });

  it('bgcolor="white" on a <td> gets a rule scoped to table elements', () => {
    document.body.innerHTML = '<table><tr><td bgcolor="white">x</td></tr></table>';
    s = new InlineStyler(document, ctx);
    s.start();
    const td = $("td");
    expect(td.getAttribute("bgcolor")).toBe("white");
    expect(td.hasAttribute("style")).toBe(false);
    expect(attrsCss()).toContain(`:where(:is(body,table,thead,tbody,tfoot,tr,td,th)[bgcolor="white" i]:not([data-dusk-keep])){background-color:${T("white", "bg")}}`);
  });

  it("an inline style wins over a presentation attribute for the same property", () => {
    document.body.innerHTML = '<svg><path fill="#fff" style="fill:#000"/></svg>';
    s = new InlineStyler(document, ctx);
    s.start();
    expect($<SVGPathElement>("path").style.getPropertyValue("fill")).toBe(norm("fill", T("#000", "text")));
  });

  it("elements added later and style changes by the page are processed", async () => {
    document.body.innerHTML = '<p style="color:#000">x</p>';
    s = new InlineStyler(document, ctx);
    s.start();
    const el = $("p");
    el.setAttribute("style", "color:#333");
    await tick();
    expect(el.style.getPropertyValue("color")).toBe(norm("color", T("#333", "text")));
    const added = document.createElement("div");
    added.innerHTML = '<b style="background-color:#fff">y</b>';
    document.body.append(added);
    await tick();
    expect($("b").style.getPropertyValue("background-color")).toBe(norm("background-color", T("#fff", "bg")));
    const path = document.createElementNS(SVG, "path");
    document.createElementNS(SVG, "svg").append(path);
    document.body.append(path.parentNode as Node);
    await tick();
    expect(path.hasAttribute("style")).toBe(false);
    path.setAttribute("fill", "#123");
    await tick();
    expect(attrsCss()).toContain(attrRule("fill", "#123", "fill", T("#123", "text")));
    el.setAttribute("fill", "#456"); // not a presentation attribute on HTML elements
    await tick();
    expect(attrsCss()).not.toContain("#456");
  });

  it("its own writes don't loop: observer callbacks stay bounded", async () => {
    const Native = globalThis.MutationObserver;
    let callbacks = 0;
    globalThis.MutationObserver = class extends Native {
      constructor(cb: MutationCallback) {
        super((r, o) => {
          callbacks++;
          cb(r, o);
        });
      }
    };
    try {
      document.body.innerHTML = '<p style="color:#000">x</p>';
      s = new InlineStyler(document, ctx);
      s.start();
    } finally {
      globalThis.MutationObserver = Native;
    }
    const el = $("p");
    for (let i = 0; i < 5; i++) {
      el.setAttribute("style", `color:#${i}${i}${i}`);
      await tick();
      await tick();
    }
    expect(el.style.getPropertyValue("color")).toBe(norm("color", T("#444", "text")));
    expect(callbacks).toBeLessThanOrEqual(10);
  });

  it("stop() restores getAttribute('style') byte-for-byte, and removes a style attribute it added", async () => {
    const orig = "color:#000 ;  background : #fff;width:3px";
    document.body.innerHTML = `<p style="${orig}">x</p><svg><path fill="#000"/></svg><div style="color:#111">z</div>`;
    s = new InlineStyler(document, ctx);
    s.start();
    const div = $("div");
    div.setAttribute("style", "color:#222;  margin:0");
    await tick();
    expect(div.style.getPropertyPriority("color")).toBe("important");
    expect($("p").getAttribute("style")).not.toBe(orig);
    s.stop();
    s = null;
    expect($("p").getAttribute("style")).toBe(orig);
    expect($("path").hasAttribute("style")).toBe(false);
    expect(div.getAttribute("style")).toBe("color:#222;  margin:0");
  });

  it("stop() restores per property when the page edited an overridden style through the CSSOM", () => {
    document.body.innerHTML = '<p style="color:#000;background-color:#fff">x</p>';
    s = new InlineStyler(document, ctx);
    s.start();
    const el = $("p");
    el.style.setProperty("color", "#123456");
    s.stop();
    s = null;
    expect(el.style.getPropertyValue("color")).toBe(norm("color", "#123456"));
    expect(el.style.getPropertyPriority("color")).toBe("");
    expect(el.style.getPropertyValue("background-color")).toBe(norm("background-color", "#fff"));
    expect(el.style.getPropertyPriority("background-color")).toBe("");
  });

  it("gentle mode leaves SVG fills alone", () => {
    document.body.innerHTML = '<svg><path fill="#000"/></svg><p style="color:#000">x</p>';
    s = new InlineStyler(document, { ...ctx, mode: "gentle" });
    s.start();
    expect($("path").hasAttribute("style")).toBe(false);
    expect(attrsCss()).toBe("");
    expect($("p").style.getPropertyValue("color")).toBe(norm("color", T("#000", "text")));
  });

  it("inline custom properties are reported to the registry and redefined on the element", () => {
    const vars = new VariableRegistry(p);
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(".card{background-color:var(--surface)}");
    const sctx: RewriteCtx = { palette: p, mode: "full", varRef: (v, r) => vars.varRef(v, r) };
    // The sheet is seen first: --surface is unknown, so its var() is kept.
    const before: string[] = [];
    rewriteRuleList(sheet.cssRules, sctx, before);
    expect(before).toEqual([]);
    const changed: string[][] = [];
    vars.onRolesChanged((n) => changed.push(n));
    document.body.innerHTML = '<div class="card" style="--surface: #fff">x</div>';
    s = new InlineStyler(document, sctx, { vars });
    s.start();
    expect(changed).toContainEqual(["--surface"]);
    const el = $("div");
    expect(el.style.getPropertyValue("--dusk-bg--surface").trim()).toBe(T("#fff", "bg"));
    const after: string[] = [];
    rewriteRuleList(sheet.cssRules, sctx, after);
    expect(after).toEqual([".card{background-color:var(--dusk-bg--surface);}"]);
    // definitionsCss doesn't emit the inline definition under a selector.
    expect(vars.definitionsCss(p)).not.toContain("--dusk-bg--surface");
    s.stop();
    s = null;
    expect(el.getAttribute("style")).toBe("--surface: #fff");
  });

  it("an inline variable whose role appears later (a sheet loaded after) is redefined then", () => {
    const vars = new VariableRegistry(p);
    const sctx: RewriteCtx = { palette: p, mode: "full", varRef: (v, r) => vars.varRef(v, r) };
    document.body.innerHTML = '<div style="--ink: #000">x</div>';
    s = new InlineStyler(document, sctx, { vars });
    s.start();
    const el = $("div");
    expect(el.style.getPropertyValue("--dusk-text--ink")).toBe("");
    const sheet = new CSSStyleSheet();
    sheet.replaceSync("div{color:var(--ink)}");
    const out: string[] = [];
    rewriteRuleList(sheet.cssRules, sctx, out);
    expect(out).toEqual(["div{color:var(--dusk-text--ink);}"]);
    expect(el.style.getPropertyValue("--dusk-text--ink").trim()).toBe(T("#000", "text"));
  });

  it("an inline variable the page keeps changing keeps one definition; non-color values aren't reported", async () => {
    const vars = new VariableRegistry(p);
    document.body.innerHTML = '<div style="--x: #000; --w: 10px; --j: {&quot;a&quot;:1}">x</div>';
    s = new InlineStyler(document, ctx, { vars });
    s.start();
    expect(vars.size).toBe(1);
    const el = $("div");
    for (let i = 0; i < 50; i++) {
      el.setAttribute("style", `--x: #${(100 + i).toString()}; --w: ${i}px`);
      await tick();
    }
    expect(vars.size).toBe(1);
  });

  it("two instances on one page transform once and restore exactly", async () => {
    const orig = "background-color:#fff;color:#000";
    document.body.innerHTML = `<div style="${orig}">x</div>`;
    const el = $("div");
    box(el, 300, 40);
    const a = new InlineStyler(document, ctx);
    a.start();
    s = new InlineStyler(document, ctx);
    s.start();
    expect(el.style.getPropertyValue("background-color")).toBe(norm("background-color", T("#fff", "bg")));
    expect(el.style.getPropertyValue("color")).toBe(norm("color", T("#000", "text")));
    a.stop();
    expect(el.getAttribute("style")).toBe(orig);
    await tick();
    s.stop();
    s = null;
    expect(el.getAttribute("style")).toBe(orig);
  });

  it("with a scheduler, mutations wait for the frame; a zero-area element is re-checked on a later frame", () => {
    const frames: (() => void)[] = [];
    const run = () => frames.splice(0).forEach((f) => f());
    document.body.innerHTML = '<div id="z" style="background-color:#e53935"></div><div id="t" style="background-color:#e53935">Menu</div>';
    const el = $("#z");
    box(el, 0, 0);
    box($("#t"), 0, 0);
    s = new InlineStyler(document, ctx, { schedule: (fn) => frames.push(fn) });
    s.start();
    // A hidden element with text is never a swatch: transformed right away.
    expect($("#t").style.getPropertyValue("background-color")).toBe(norm("background-color", T("#e53935", "bg")));
    // A textless one without layout yet: the color is kept for now and re-checked.
    expect(el.style.getPropertyPriority("background-color")).toBe("");
    box(el, 300, 40);
    run();
    run();
    expect(el.style.getPropertyValue("background-color")).toBe(norm("background-color", T("#e53935", "bg")));
  });

  it("with a scheduler, page changes are processed on the next frame", async () => {
    const frames: (() => void)[] = [];
    document.body.innerHTML = '<p style="color:#000">x</p>';
    s = new InlineStyler(document, ctx, { schedule: (fn) => frames.push(fn) });
    s.start();
    const el = $("p");
    el.setAttribute("style", "color:#333");
    await tick();
    expect(el.style.getPropertyPriority("color")).toBe("");
    expect(frames).toHaveLength(1);
    frames.splice(0).forEach((f) => f());
    expect(el.style.getPropertyValue("color")).toBe(norm("color", T("#333", "text")));
  });

  it("rows with inline variables added and removed keep the registry bounded", async () => {
    const vars = new VariableRegistry(p);
    s = new InlineStyler(document, ctx, { vars });
    s.start();
    const t0 = performance.now();
    for (let round = 0; round < 5; round++) {
      const rows = document.createElement("div");
      for (let i = 0; i < 500; i++) {
        const row = document.createElement("div");
        row.setAttribute("style", `--x: #${(100 + ((i + round * 7) % 800)).toString()}`);
        rows.append(row);
      }
      document.body.append(rows);
      await tick();
      expect(vars.size).toBe(500);
      rows.remove();
      await tick();
      expect(vars.size).toBe(0);
    }
    expect(performance.now() - t0).toBeLessThan(2000);
  });
});
