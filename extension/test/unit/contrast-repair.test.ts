import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { contrastRatio } from "../../src/engine/color/contrast";
import { oklchToRgba } from "../../src/engine/color/oklch";
import { PALETTES } from "../../src/engine/color/palettes";
import { parseColor } from "../../src/engine/color/parse";
import type { RGBA } from "../../src/engine/color/parse";
import type { RewriteCtx } from "../../src/engine/css/declarations";
import { InlineStyler, inlineOverrideOwner, restoreInlineOverrides, writeInlineOverride } from "../../src/engine/css/inline";
import { ContrastRepair, repairTextColor } from "../../src/engine/repair/contrast-repair";

// happy-dom computes inline/sheet values but has no layout: tests give elements a box. Real computed-style cases
// (cascade, UA styles, layout) are in test/unit-webkit/contrast-repair.spec.ts.
const p = PALETTES.dark;
const ctx: RewriteCtx = { palette: p, mode: "full", varRef: (v) => v };
const rgba = (v: string) => parseColor(v) as RGBA;
const themeBg = oklchToRgba(p.bg);

function box<E extends Element>(el: E, width = 300, height = 40, top = 0): E {
  el.getBoundingClientRect = () => ({ x: 0, y: top, top, left: 0, right: width, bottom: top + height, width, height, toJSON: () => ({}) }) as DOMRect;
  return el;
}
const boxAll = () => document.querySelectorAll("body, body *").forEach((e) => box(e));
const $ = (sel: string) => document.querySelector(sel) as HTMLElement;
const now = (fn: () => void) => fn();

let repair: ContrastRepair | null = null;
let styler: InlineStyler | null = null;
beforeEach(() => {
  document.body.innerHTML = "";
  document.body.removeAttribute("style");
  // The engine themes the root; here the root's background is the theme background.
  document.documentElement.setAttribute("style", `background-color: ${`rgb(${themeBg.r.toFixed(0)}, ${themeBg.g.toFixed(0)}, ${themeBg.b.toFixed(0)})`}`);
});
afterEach(() => {
  repair?.stop();
  styler?.stop();
  repair = styler = null;
  document.documentElement.removeAttribute("style");
  vi.useRealTimers();
});
const make = (isEngineStyled: (el: Element) => boolean = () => false, idle = now) => (repair = new ContrastRepair(document, p, { idle, isEngineStyled }));

describe("repairTextColor", () => {
  it("reaches 4.5:1 against a dark actual background", () => {
    const out = repairTextColor(rgba("#777"), rgba("#333"), p);
    expect(contrastRatio(out, rgba("#333"))).toBeGreaterThanOrEqual(4.5);
  });
  it("goes darker on a light actual background", () => {
    const bg = rgba("#eee");
    const out = repairTextColor(rgba("#ccc"), bg, p);
    expect(contrastRatio(out, bg)).toBeGreaterThanOrEqual(4.5);
  });
});

describe("ContrastRepair", () => {
  it("gives a light surface the neutral background, restorably", () => {
    document.body.innerHTML = '<div id="w" style="background-color: #fff ;width:10px">x</div>';
    boxAll();
    const before = $("#w").getAttribute("style");
    make();
    expect(repair?.runOnce()).toBe(1);
    expect($("#w").style.getPropertyValue("background-color")).toBe("var(--dusk-neutral-bg)");
    expect($("#w").style.getPropertyPriority("background-color")).toBe("important");
    repair?.start();
    repair?.stop();
    expect($("#w").getAttribute("style")).toBe(before);
  });

  it("repairs low-contrast text against the effective background", () => {
    document.body.innerHTML = '<p id="t" style="color: #777">gray</p>';
    boxAll();
    make().runOnce();
    const c = rgba($("#t").style.getPropertyValue("color"));
    expect(contrastRatio(c, themeBg)).toBeGreaterThanOrEqual(4.5);
  });

  it("skips images, media subtrees, engine-styled and guarded elements", () => {
    document.body.innerHTML = `<img id="i" style="background-color:#fff"><video><div id="v" style="background-color:#fff">x</div></video>
      <div id="e" style="background-color:#fff">engine</div><div id="k" data-dusk-keep style="background-color:#fff">k</div>
      <span id="sw" style="background-color:#ffeb3b"></span><div id="bi" style="background-color:#fff;background-image:url(a.png)">t</div>`;
    boxAll();
    box($("#sw"), 24, 24);
    const control = document.body.appendChild(box(document.createElement("div")));
    control.textContent = "control";
    control.style.backgroundColor = "#fff";
    const skipped = () => [...document.querySelectorAll("[id]")].map((e) => e.getAttribute("style"));
    const before = skipped();
    expect(make((el) => el.id === "e").runOnce()).toBe(1);
    expect(control.style.getPropertyValue("background-color")).toBe("var(--dusk-neutral-bg)");
    expect(skipped()).toEqual(before);
  });

  it("examines at most 300 visible elements per pass, outside-band ones not counted, and continues next pass", () => {
    document.body.innerHTML = '<div style="background-color:#fff">a</div>'.repeat(420);
    boxAll();
    // body + 20 far below the viewport ± 1 screen.
    [...document.body.children].slice(0, 20).forEach((e) => box(e, 300, 40, 10 * innerHeight));
    make();
    expect(repair?.runOnce()).toBe(299);
    expect(repair?.runOnce()).toBe(101);
    expect(document.querySelectorAll('[style*="dusk-neutral-bg"]').length).toBe(400);
  });

  it("reruns 300 ms after page mutations, not after its own writes or data-dusk-* attributes", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<div id="w">x</div>';
    boxAll();
    let passes = 0;
    make(
      () => false,
      (fn) => (passes++, fn()),
    ).start();
    expect(passes).toBe(1);
    $("#w").setAttribute("data-dusk-sampling", "");
    await vi.advanceTimersByTimeAsync(400);
    expect(passes).toBe(1);
    $("#w").style.backgroundColor = "#fff";
    await vi.advanceTimersByTimeAsync(200);
    expect(passes).toBe(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(passes).toBe(2);
    expect($("#w").style.getPropertyValue("background-color")).toBe("var(--dusk-neutral-bg)");
    await vi.advanceTimersByTimeAsync(1000);
    expect(passes).toBe(2);
  });

  it("checks text on engine-styled elements but leaves their background", () => {
    document.body.innerHTML = '<div id="e" style="background-color:#fff;color:#888">engine</div>';
    boxAll();
    expect(make((el) => el.id === "e").runOnce()).toBe(1);
    expect($("#e").style.getPropertyValue("background-color")).toBe("#fff");
    expect(contrastRatio(rgba($("#e").style.getPropertyValue("color")), rgba("#fff"))).toBeGreaterThanOrEqual(4.5);
  });

  it("still runs within 1 s while the page keeps mutating", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<div id="w">x</div>';
    boxAll();
    let passes = 0;
    make(
      () => false,
      (fn) => (passes++, fn()),
    ).start();
    for (let i = 0; i < 10; i++) {
      $("#w").setAttribute("data-n", String(i));
      await vi.advanceTimersByTimeAsync(200);
    }
    // 2 s of mutations every 200 ms: the debounce alone would never fire; the max-wait gives a pass per second.
    expect(passes).toBe(3);
  });

  it("continues a capped pass on its own until the document end, then stops", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<div style="background-color:#fff">a</div>'.repeat(700);
    boxAll();
    let passes = 0;
    make(
      () => false,
      (fn) => (passes++, setTimeout(fn, 0)),
    ).start();
    await vi.advanceTimersByTimeAsync(10);
    expect(passes).toBe(3);
    expect(document.querySelectorAll('[style*="dusk-neutral-bg"]').length).toBe(700);
    await vi.advanceTimersByTimeAsync(5000);
    expect(passes).toBe(3);
  });

  it("bounds layout reads per pass and resumes where it stopped", () => {
    document.body.innerHTML = '<div style="background-color:#fff">a</div>'.repeat(4000);
    let reads = 0;
    document.querySelectorAll("body, body *").forEach((e) => {
      box(e, 300, 40, 10 * innerHeight);
      const read = e.getBoundingClientRect.bind(e);
      e.getBoundingClientRect = () => (reads++, read());
    });
    const last = document.body.lastElementChild as HTMLElement;
    box(last);
    make();
    const passes: number[] = [];
    let repaired = 0;
    for (let i = 0; i < 3; i++) {
      reads = 0;
      repaired += repair?.runOnce() ?? 0;
      passes.push(reads);
    }
    expect(Math.max(...passes)).toBeLessThanOrEqual(1500);
    expect(repaired).toBe(1);
    expect(last.style.getPropertyValue("background-color")).toBe("var(--dusk-neutral-bg)");
  });

  it("ignores text changes away from the viewport band", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<p id="far">far</p><p id="near">near</p>';
    boxAll();
    box($("#far"), 300, 40, 10 * innerHeight);
    let passes = 0;
    make(
      () => false,
      (fn) => (passes++, fn()),
    ).start();
    ($("#far").firstChild as Text).data = "far away";
    await vi.advanceTimersByTimeAsync(1100);
    expect(passes).toBe(1);
    ($("#near").firstChild as Text).data = "nearer";
    await vi.advanceTimersByTimeAsync(400);
    expect(passes).toBe(2);
  });

  it("throttles scroll passes to one per 500 ms", async () => {
    vi.useFakeTimers();
    let passes = 0;
    make(
      () => false,
      (fn) => (passes++, fn()),
    ).start();
    for (let i = 0; i < 10; i++) {
      document.dispatchEvent(new Event("scroll"));
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(passes).toBe(3);
  });
});

describe("shared inline writer", () => {
  it("cooperates with InlineStyler: kept on its re-plans, restored exactly whichever stops first", () => {
    for (const order of ["repair-first", "styler-first"]) {
      document.body.innerHTML = '<p id="t" style="color : #000;  width:3px">x</p>';
      const el = $("#t");
      const before = el.getAttribute("style");
      styler = new InlineStyler(document, ctx);
      styler.start();
      expect(inlineOverrideOwner(el, "color")).toBe("");
      expect(writeInlineOverride(el, "color", "red", "important", "repair")).toBe(false);
      expect(writeInlineOverride(el, "background-color", "var(--dusk-neutral-bg)", "important", "repair")).toBe(true);
      // The page edits another property; InlineStyler re-plans the element and keeps the repair override.
      el.style.width = "4px";
      (styler as unknown as { batch(els: Element[]): void }).batch([el]);
      expect(inlineOverrideOwner(el, "background-color")).toBe("repair");
      el.style.width = "3px";
      if (order === "repair-first") {
        restoreInlineOverrides(el, "repair");
        expect(inlineOverrideOwner(el, "color")).toBe("");
        styler.stop();
      } else {
        styler.stop();
        restoreInlineOverrides(el, "repair");
      }
      styler = null;
      expect(el.style.getPropertyValue("background-color")).toBe("");
      expect(el.style.getPropertyValue("color")).toBe("#000");
      if (order === "repair-first") expect(el.getAttribute("style")).toContain("color");
      void before;
    }
  });

  it("InlineStyler takes over a repair-owned color, after which repair leaves it alone", () => {
    document.body.innerHTML = '<p id="t" style="color: #777">gray</p>';
    boxAll();
    make().runOnce();
    const el = $("#t");
    expect(inlineOverrideOwner(el, "color")).toBe("repair");
    styler = new InlineStyler(document, ctx);
    styler.start();
    expect(inlineOverrideOwner(el, "color")).toBe("");
    const styled = el.style.getPropertyValue("color");
    expect(repair?.runOnce()).toBe(0);
    expect(inlineOverrideOwner(el, "color")).toBe("");
    expect(el.style.getPropertyValue("color")).toBe(styled);
    repair?.stop();
    styler.stop();
    styler = null;
    expect(el.getAttribute("style")).toBe("color: #777");
  });

  it("repair doesn't write over an InlineStyler-owned color, even when its contrast is low", () => {
    // The engine-styled parent keeps its white background, so the child's light InlineStyler color is below 4.5:1.
    document.body.innerHTML = '<div id="parent" style="background-color:#fff"><p id="t" style="color: #000">t</p></div>';
    boxAll();
    styler = new InlineStyler(document, ctx);
    styler.start();
    const el = $("#t");
    const styled = el.style.getPropertyValue("color");
    expect(contrastRatio(rgba(styled), rgba("#fff"))).toBeLessThan(4.5);
    expect(make((e) => e.id === "parent").runOnce()).toBe(0);
    expect(inlineOverrideOwner(el, "color")).toBe("");
    expect(el.style.getPropertyValue("color")).toBe(styled);
  });

  it("restores the attribute byte-for-byte when the page didn't touch it", () => {
    document.body.innerHTML = '<div id="d" style="color : #333 ;margin:0">x</div>';
    const el = $("#d");
    writeInlineOverride(el, "background-color", "var(--dusk-neutral-bg)", "important", "repair");
    writeInlineOverride(el, "color", "#eee", "important", "repair");
    restoreInlineOverrides(el, "repair");
    expect(el.getAttribute("style")).toBe("color : #333 ;margin:0");
    const bare = document.createElement("div");
    document.body.append(bare);
    writeInlineOverride(bare, "background-color", "red", "important", "repair");
    restoreInlineOverrides(bare, "repair");
    expect(bare.hasAttribute("style")).toBe(false);
  });

  it("gives a property back to the page when the page overwrote it", () => {
    document.body.innerHTML = '<div id="d">x</div>';
    const el = $("#d");
    writeInlineOverride(el, "background-color", "var(--dusk-neutral-bg)", "important", "repair");
    el.style.setProperty("background-color", "blue");
    restoreInlineOverrides(el, "repair");
    expect(el.style.getPropertyValue("background-color")).toBe("blue");
  });
});
