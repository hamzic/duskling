import { afterEach, describe, expect, it, vi } from "vitest";
import { PALETTES } from "../../src/engine/color/palettes";
import { oklchToRgba } from "../../src/engine/color/oklch";
import { formatColor } from "../../src/engine/color/parse";
import { paletteCss } from "../../src/engine/color/transform";
import { applyRootStyles, themeSpecialFrames } from "../../src/engine/css/root";

const p = PALETTES.dark;
const css = paletteCss(p);
const rootStyle = () => document.head.querySelector('style[data-dusk="root"]') as HTMLStyleElement | null;
const metas = () => [...document.head.querySelectorAll('meta[name="theme-color"]')];

afterEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
});

describe("applyRootStyles", () => {
  it("inserts the root style with screen media and root/selection/placeholder/scrollbar rules", () => {
    const stop = applyRootStyles(document, p, { nativeDark: false });
    const s = rootStyle()!;
    expect(s.getAttribute("media")).toBe("screen");
    const t = s.textContent!;
    expect(t).toContain(":root{color-scheme:dark}");
    expect(t).toContain(`html{background-color:${css.bg};color:${css.fg}}`);
    expect(t).toContain("::selection{");
    expect(t).toContain(css.selectionBg);
    expect(t).toContain(`::placeholder{color:${formatColor({ ...oklchToRgba(p.fg), a: 0.6 })}}`);
    expect(t).toMatch(/::placeholder\{color:rgba\(\d+, \d+, \d+, 0\.6\)\}/);
    expect(t).toContain(`scrollbar-color:${css.border} ${css.bg}`);
    expect(t).not.toContain("!important");
    stop();
    expect(rootStyle()).toBeNull();
  });

  it("omits the color-scheme override, html colors, placeholder and scrollbar rules when nativeDark", () => {
    applyRootStyles(document, p, { nativeDark: true });
    const t = rootStyle()!.textContent!;
    expect(t).not.toContain("color-scheme");
    expect(t).not.toContain("html{");
    expect(t).not.toContain("::placeholder");
    expect(t).not.toContain("scrollbar-color");
    expect(t).toContain("::selection");
  });

  it("inserts a theme-color meta with the transformed bg and removes it on teardown", () => {
    const stop = applyRootStyles(document, p, { nativeDark: false });
    expect(metas()).toHaveLength(1);
    expect(metas()[0]?.getAttribute("content")).toBe(css.bg);
    stop();
    expect(metas()).toHaveLength(0);
  });

  it("updates every existing theme-color meta (media variants) and restores them exactly", () => {
    document.head.innerHTML =
      '<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)"><meta name="theme-color" media="(prefers-color-scheme: dark)">';
    const before = document.head.innerHTML;
    const stop = applyRootStyles(document, p, { nativeDark: false });
    expect(metas()).toHaveLength(2);
    for (const m of metas()) expect(m.getAttribute("content")).toBe(css.bg);
    expect(metas()[0]?.getAttribute("media")).toBe("(prefers-color-scheme: light)");
    stop();
    expect(document.head.innerHTML).toBe(before);
  });

  // Read on the next frame: right after the engine removes its sheets a synchronous read forced a full style recalc
  // (github.com in WebKit: ~0.5 s) that the frame's own recalc repeats.
  it("uses the site's own computed html background for the meta when nativeDark, read on the next frame", async () => {
    document.documentElement.style.backgroundColor = "rgb(10, 20, 30)";
    const stop = applyRootStyles(document, p, { nativeDark: true });
    expect(metas()).toHaveLength(0);
    await new Promise((r) => requestAnimationFrame(r));
    expect(metas()[0]?.getAttribute("content")).toBe("rgb(10, 20, 30)");
    stop();
    expect(metas()).toHaveLength(0);
    document.documentElement.style.backgroundColor = "";
  });

  it("a teardown before that frame leaves the metas untouched", async () => {
    document.head.innerHTML = '<meta name="theme-color" content="#abcdef">';
    const before = document.head.innerHTML;
    const stop = applyRootStyles(document, p, { nativeDark: true });
    stop();
    await new Promise((r) => requestAnimationFrame(r));
    expect(document.head.innerHTML).toBe(before);
  });

  it("re-registration replaces the root node and keeps the true meta originals", () => {
    document.head.innerHTML = '<meta name="theme-color" content="#abcdef">';
    const before = document.head.innerHTML;
    const stop1 = applyRootStyles(document, p, { nativeDark: false });
    const stop2 = applyRootStyles(document, PALETTES.dim, { nativeDark: false });
    expect(document.head.querySelectorAll('style[data-dusk="root"]')).toHaveLength(1);
    expect(rootStyle()!.textContent).toContain(paletteCss(PALETTES.dim).bg);
    stop1();
    stop2();
    expect(document.head.innerHTML).toBe(before);
  });

  it("re-registration with no original meta leaves exactly one inserted meta and removes it", () => {
    const stop1 = applyRootStyles(document, p, { nativeDark: false });
    const stop2 = applyRootStyles(document, p, { nativeDark: false });
    expect(metas()).toHaveLength(1);
    stop2();
    stop1();
    expect(metas()).toHaveLength(0);
  });
});

describe("themeSpecialFrames", () => {
  function harness() {
    const stops: ReturnType<typeof vi.fn>[] = [];
    const start = vi.fn((d: Document) => {
      void d;
      const s = vi.fn();
      stops.push(s);
      return s;
    });
    return { start, stops };
  }
  const frame = (attrs: Record<string, string>) => {
    const f = document.createElement("iframe");
    for (const [k, v] of Object.entries(attrs)) f.setAttribute(k, v);
    document.body.append(f);
    return f;
  };

  it("starts a srcdoc iframe with its current document and stops it on teardown", async () => {
    const { start, stops } = harness();
    const f = frame({ srcdoc: "<p>hi</p>" });
    const stop = themeSpecialFrames(document, start);
    await vi.waitFor(() => expect(start).toHaveBeenCalled());
    expect(start.mock.calls.at(-1)?.[0]).toBe(f.contentDocument);
    const live = start.mock.calls.length - 1;
    stop();
    expect(stops[live]).toHaveBeenCalledTimes(1);
  });

  it("themes an about:blank iframe added later exactly once", async () => {
    const { start } = harness();
    const stop = themeSpecialFrames(document, start);
    const blank = frame({ src: "about:blank" });
    await vi.waitFor(() => expect(start).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(start).toHaveBeenCalledTimes(1);
    expect(start.mock.calls[0]?.[0]).toBe(blank.contentDocument);
    stop();
  });

  it("never reads contentDocument of a frame that isn't about:blank/srcdoc, or of an opaque-origin sandbox", async () => {
    // WebKit logs "Blocked a frame ... from accessing a frame" for a cross-origin contentDocument read, even though it
    // returns null; a sandbox without allow-same-origin gives the frame an opaque origin (HTML §4.8.5 sandbox).
    const { start } = harness();
    const reads: string[] = [];
    const spy = (f: HTMLIFrameElement, name: string) =>
      Object.defineProperty(f, "contentDocument", { get: () => (reads.push(name), null), configurable: true });
    const cross = document.createElement("iframe");
    cross.setAttribute("src", "data:text/html,<p>other</p>"); // any non-about:blank URL (data: needs no network here)
    spy(cross, "cross");
    const sandboxed = document.createElement("iframe");
    sandboxed.setAttribute("srcdoc", "<p>s</p>");
    sandboxed.setAttribute("sandbox", "allow-scripts");
    spy(sandboxed, "sandboxed");
    document.body.append(cross, sandboxed);
    const stop = themeSpecialFrames(document, start);
    cross.dispatchEvent(new Event("load"));
    sandboxed.dispatchEvent(new Event("load"));
    await new Promise((r) => setTimeout(r, 20));
    expect(reads).toEqual([]);
    expect(start).not.toHaveBeenCalled();
    stop();
  });

  it("stops a frame's theming when the iframe is removed, including nested in a removed subtree", async () => {
    const { start, stops } = harness();
    const stop = themeSpecialFrames(document, start);
    const wrap = document.createElement("div");
    const inner = document.createElement("iframe");
    inner.setAttribute("src", "about:blank");
    wrap.append(inner);
    document.body.append(wrap);
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    wrap.remove();
    await vi.waitFor(() => expect(stops[0]).toHaveBeenCalledTimes(1));
    stop();
    expect(stops[0]).toHaveBeenCalledTimes(1);
  });

  it("teardown stops every active frame once", async () => {
    const { start, stops } = harness();
    frame({ src: "about:blank" });
    frame({ srcdoc: "<p>b</p>" });
    const stop = themeSpecialFrames(document, start);
    await vi.waitFor(() => expect(start).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    const n = start.mock.calls.length;
    stop();
    expect(stops.slice(0, n).filter((s) => s.mock.calls.length === 1).length).toBeGreaterThanOrEqual(2);
    for (const s of stops) expect(s.mock.calls.length).toBeLessThanOrEqual(1);
  });
});
