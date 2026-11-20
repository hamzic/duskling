import { afterEach, describe, expect, it, vi } from "vitest";
import { PALETTES } from "../../src/engine/color/palettes";
import { paletteCss } from "../../src/engine/color/transform";
import { OWN_SHEET } from "../../src/engine/css/style-manager";
import {
  applyClassThemeToggle,
  collectDarkSchemeRules,
  declaredScheme,
  findClassThemeToggle,
  hasRootDarkTheme,
  markerVerdict,
  pageSheets,
  parseLegacyColor,
  promote,
  sampleBackground,
  suspendOwnSheets,
} from "../../src/engine/detect/native-dark";

// happy-dom 20.14.5 exposes StyleSheet.media as a plain string and ignores the constructor's `media` option, so the
// MediaList is faked here; test/unit-webkit/native-dark.spec.ts covers real `<style media>` sheets.
const sheet = (css: string, media?: string): CSSStyleSheet => {
  const s = new CSSStyleSheet();
  s.replaceSync(css);
  if (media !== undefined) Object.defineProperty(s, "media", { value: { mediaText: media } });
  return s;
};

const root = () => document.documentElement;

afterEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  document.adoptedStyleSheets = [];
  for (const a of [...root().attributes]) if (a.name !== "lang") root().removeAttribute(a.name);
  for (const a of [...document.body.attributes]) document.body.removeAttribute(a.name);
  vi.restoreAllMocks();
});

const meta = (content: string) => {
  const m = document.createElement("meta");
  m.name = "color-scheme";
  m.content = content;
  document.head.append(m);
};

describe("declaredScheme", () => {
  it("meta color-scheme: dark → dark", () => {
    meta("dark");
    expect(declaredScheme(document)).toBe("dark");
  });
  it("meta `only dark` → dark", () => {
    meta("only dark");
    expect(declaredScheme(document)).toBe("dark");
  });
  it("meta `light dark` → unknown", () => {
    meta("light dark");
    expect(declaredScheme(document)).toBe("unknown");
  });
  it("no declaration → unknown", () => {
    expect(declaredScheme(document)).toBe("unknown");
  });
  it("computed :root color-scheme: dark from the page → dark", () => {
    const s = document.createElement("style");
    s.textContent = ":root{color-scheme:dark}";
    document.head.append(s);
    expect(declaredScheme(document)).toBe("dark");
  });
  // happy-dom ignores StyleSheet.disabled in the cascade, so suspension of the root sheet and adopted own sheets is covered
  // by test/unit-webkit/native-dark.spec.ts; the pre-paint exclusion (attribute selector) works here.
  it("ignores the pre-paint color-scheme and leaves no sampling attribute behind", () => {
    const pre = document.createElement("style");
    pre.textContent = "html:not([data-dusk-ready]):not([data-dusk-sampling]){color-scheme:dark !important}";
    document.head.append(pre);
    expect(getComputedStyle(root()).getPropertyValue("color-scheme")).toBe("dark");
    expect(declaredScheme(document)).toBe("unknown");
    expect(root().hasAttribute("data-dusk-sampling")).toBe(false);
  });
});

describe("markerVerdict", () => {
  it('<html class="dark"> → dark', () => {
    root().className = "js dark";
    expect(markerVerdict(document)).toBe("dark");
  });
  it('<html data-theme="dark"> → dark', () => {
    root().setAttribute("data-theme", "dark");
    expect(markerVerdict(document)).toBe("dark");
  });
  it('<body class="Night-Mode"> → dark (case-insensitive)', () => {
    document.body.className = "Night-Mode";
    expect(markerVerdict(document)).toBe("dark");
  });
  it('<html class="darken"> → unknown (whole-token match only)', () => {
    root().className = "darken";
    expect(markerVerdict(document)).toBe("unknown");
  });
  it('unlisted attribute or light value → unknown', () => {
    root().setAttribute("data-skin", "dark");
    document.body.setAttribute("data-theme", "light");
    expect(markerVerdict(document)).toBe("unknown");
  });
});

const rules = (n: number, prefix: string) =>
  Array.from({ length: n }, (_, i) => `${prefix} .c${i}{background-color:#111}`).join("\n");

describe("findClassThemeToggle", () => {
  it("25 html.dark rules setting backgrounds → html class dark", () => {
    const t = findClassThemeToggle([sheet(rules(25, "html.dark"))]);
    expect(t).toEqual({ target: "html", kind: "class", name: "dark", declarationCount: 25 });
  });
  it("5 rules → null", () => {
    expect(findClassThemeToggle([sheet(rules(5, "html.dark"))])).toBeNull();
  });
  it('[data-bs-theme="dark"] rules → attr toggle', () => {
    const t = findClassThemeToggle([sheet(rules(22, '[data-bs-theme="dark"]'))]);
    expect(t).toEqual({ target: "html", kind: "attr", name: "data-bs-theme", value: "dark", declarationCount: 22 });
  });
  it("body.dark-mode rules → body target; :root.dark and .dark count as html", () => {
    expect(findClassThemeToggle([sheet(rules(20, "body.dark-mode"))])).toMatchObject({ target: "body", name: "dark-mode" });
    const mixed = sheet(rules(10, ":root.dark") + "\n" + rules(10, ".dark"));
    expect(findClassThemeToggle([mixed])).toMatchObject({ target: "html", kind: "class", name: "dark", declarationCount: 20 });
  });
  it("counts custom properties, backgrounds and colors inside @media/@supports, but not other declarations or .darken", () => {
    const css = [
      ".dark{--bg:#000;--fg:#fff}",
      "@media screen{" + rules(10, ".dark") + "}",
      "@supports (display:grid){" + rules(4, ".dark") + "}",
      rules(4, ".dark").replaceAll("background-color", "color"),
      rules(30, ".dark").replaceAll("background-color:#111", "border-width:1px;padding:2px"),
      rules(30, ".darken"),
    ].join("\n");
    expect(findClassThemeToggle([sheet(css)])).toMatchObject({ name: "dark", declarationCount: 20 });
  });
  it("a Bootstrap 5.3-style theme: few rules setting many custom properties → attr toggle", () => {
    const vars = Array.from({ length: 40 }, (_, i) => `--bs-v${i}:#${String(i).padStart(3, "0")}`).join(";");
    const css = `[data-bs-theme=dark]{color-scheme:dark;${vars}}[data-bs-theme=dark] .navbar{--bs-navbar-color:#ddd}[data-bs-theme=dark] .btn-close{filter:invert(1)}`;
    expect(findClassThemeToggle([sheet(css)])).toEqual({ target: "html", kind: "attr", name: "data-bs-theme", value: "dark", declarationCount: 41 });
  });
  it("5 trivial rules → null", () => {
    expect(findClassThemeToggle([sheet(rules(5, '[data-bs-theme="dark"]'))])).toBeNull();
  });
  it("a background shorthand counts once", () => {
    expect(findClassThemeToggle([sheet(rules(19, "html.dark").replaceAll("background-color", "background"))])).toBeNull();
    expect(findClassThemeToggle([sheet(rules(20, "html.dark").replaceAll("background-color", "background"))])).toMatchObject({ declarationCount: 20 });
  });
  it("skips sheets whose rules can't be read", () => {
    const bad = { get cssRules(): CSSRuleList { throw new DOMException("x", "SecurityError"); } } as unknown as CSSStyleSheet;
    expect(findClassThemeToggle([bad, sheet(rules(20, "html.dark"))])).toMatchObject({ name: "dark" });
  });
});

describe("pageSheets", () => {
  // Safari 26 and earlier also list adopted sheets in document.styleSheets; Safari 27 doesn't (release notes, 174583340).
  const docWith = (listed: CSSStyleSheet[], adopted: CSSStyleSheet[]) => ({ styleSheets: listed, adoptedStyleSheets: adopted }) as unknown as Document;

  it("lists each sheet once when document.styleSheets also lists the adopted ones (Safari 26)", () => {
    const page = sheet("p{color:red}");
    const adopted = sheet(rules(12, "html.dark"));
    expect(pageSheets(docWith([page, adopted], [adopted]))).toEqual([page, adopted]);
    // Counted twice, 12 declarations would pass the 20-declaration threshold.
    expect(findClassThemeToggle(pageSheets(docWith([page, adopted], [adopted])))).toBeNull();
  });

  it("includes adopted sheets that document.styleSheets leaves out (Safari 27)", () => {
    const page = sheet("p{color:red}");
    const adopted = sheet(rules(20, "html.dark"));
    expect(pageSheets(docWith([page], [adopted]))).toEqual([page, adopted]);
    expect(findClassThemeToggle(pageSheets(docWith([page], [adopted])))).toMatchObject({ name: "dark" });
  });
});

describe("findClassThemeToggle: utility-framework class variants", () => {
  const many = (sel: (i: number) => string, n = 20) => Array.from({ length: n }, (_, i) => `${sel(i)}{background-color:#111}`).join("\n");
  it("v3 class strategy: `.dark .dark\\:bg-x`", () => {
    expect(findClassThemeToggle([sheet(many((i) => `.dark .dark\\:bg-c${i}`))])).toMatchObject({ target: "html", kind: "class", name: "dark", declarationCount: 20 });
  });
  it("v3.4 selector strategy: `:is(.dark .dark\\:bg-x)`", () => {
    expect(findClassThemeToggle([sheet(many((i) => `:is(.dark .dark\\:bg-c${i})`))])).toMatchObject({ kind: "class", name: "dark", declarationCount: 20 });
  });
  it("v4 custom variant: `.dark\\:bg-x:where(.dark, .dark *)`", () => {
    expect(findClassThemeToggle([sheet(many((i) => `.dark\\:bg-c${i}:where(.dark, .dark *)`))])).toMatchObject({ kind: "class", name: "dark", declarationCount: 20 });
  });
  it("v4 attribute variant: `:where([data-theme=dark], [data-theme=dark] *)`", () => {
    expect(findClassThemeToggle([sheet(many((i) => `.dark\\:bg-c${i}:where([data-theme=dark], [data-theme=dark] *)`))])).toMatchObject({
      target: "html",
      kind: "attr",
      name: "data-theme",
      value: "dark",
      declarationCount: 20,
    });
  });
  it("a marker that isn't the first compound, or a compound with more than the marker, doesn't count", () => {
    expect(findClassThemeToggle([sheet(many((i) => `.btn .dark .c${i}`, 30))])).toBeNull();
    expect(findClassThemeToggle([sheet(many((i) => `html.dark.c${i}`, 30))])).toBeNull();
    expect(findClassThemeToggle([sheet(many((i) => `.dark:hover .c${i}`, 30))])).toBeNull();
    expect(findClassThemeToggle([sheet(many((i) => `.dark\\:bg-c${i}`, 30))])).toBeNull();
  });
});

describe("applyClassThemeToggle", () => {
  it("an already-present marker is left alone by teardown, and the site removing it still reports", async () => {
    root().classList.add("dark");
    const removed = vi.fn();
    const stop = applyClassThemeToggle(document, { target: "html", kind: "class", name: "dark", declarationCount: 20 }, removed);
    stop();
    expect(root().classList.contains("dark")).toBe(true);
    const stop2 = applyClassThemeToggle(document, { target: "html", kind: "class", name: "dark", declarationCount: 20 }, removed);
    root().classList.remove("dark");
    await new Promise((r) => setTimeout(r, 0));
    expect(removed).toHaveBeenCalledTimes(1);
    stop2();
    expect(root().classList.contains("dark")).toBe(false);
  });
  it("adds the class and its teardown removes it", () => {
    const stop = applyClassThemeToggle(document, { target: "html", kind: "class", name: "dark", declarationCount: 20 }, () => {});
    expect(root().classList.contains("dark")).toBe(true);
    stop();
    expect(root().classList.contains("dark")).toBe(false);
  });
  it("sets and restores an attribute on body", () => {
    document.body.setAttribute("data-theme", "light");
    const stop = applyClassThemeToggle(document, { target: "body", kind: "attr", name: "data-theme", value: "dark", declarationCount: 20 }, () => {});
    expect(document.body.getAttribute("data-theme")).toBe("dark");
    stop();
    expect(document.body.getAttribute("data-theme")).toBe("light");
  });
  it("the site removing it calls onSiteRemoved once without re-adding it", async () => {
    const removed = vi.fn();
    const stop = applyClassThemeToggle(document, { target: "html", kind: "class", name: "dark", declarationCount: 20 }, removed);
    root().classList.remove("dark");
    await new Promise((r) => setTimeout(r, 0));
    expect(removed).toHaveBeenCalledTimes(1);
    expect(root().classList.contains("dark")).toBe(false);
    root().classList.add("other");
    await new Promise((r) => setTimeout(r, 0));
    expect(removed).toHaveBeenCalledTimes(1);
    stop();
    expect(root().classList.contains("dark")).toBe(false);
  });
});

// Mocks the five sample points: happy-dom has no layout or elementsFromPoint.
function mockPoints(stacks: Element[][]): ReturnType<typeof vi.fn> {
  let i = 0;
  const fn = vi.fn(() => stacks[i++ % stacks.length] ?? []);
  (document as unknown as { elementsFromPoint: unknown }).elementsFromPoint = fn;
  return fn;
}

const noSuspend = { suspend: () => () => {}, originalBackground: () => null };

describe("sampleBackground", () => {
  it("samples five points (center + 25 % insets) and reads a dark median as dark", () => {
    document.body.innerHTML = '<div id="a" style="background-color:#111"></div><div id="b" style="background-color:#fff"></div>';
    const a = document.getElementById("a")!;
    const b = document.getElementById("b")!;
    const fn = mockPoints([[a, document.body, root()], [a], [b], [a], [b]]);
    expect(sampleBackground(document, window, noSuspend)).toBe("dark");
    const w = window.innerWidth;
    const h = window.innerHeight;
    expect(fn.mock.calls).toEqual([[w / 2, h / 2], [w / 4, h / 4], [w * 0.75, h / 4], [w / 4, h * 0.75], [w * 0.75, h * 0.75]]);
  });
  it("walks past transparent elements to the first background, and falls back to white", () => {
    document.body.innerHTML = '<p id="t">x</p>';
    document.body.style.backgroundColor = "#fafafa";
    const t = document.getElementById("t")!;
    mockPoints([[t, document.body, root()]]);
    expect(sampleBackground(document, window, noSuspend)).toBe("light");
    document.body.style.backgroundColor = "";
    mockPoints([[t, document.body, root()]]);
    expect(sampleBackground(document, window, noSuspend)).toBe("light");
  });
  it("body's background paints the canvas when html's is transparent (stack [html], body dark → dark)", () => {
    document.body.style.backgroundColor = "#111";
    mockPoints([[root()]]);
    expect(sampleBackground(document, window, noSuspend)).toBe("dark");
    root().style.backgroundColor = "#fff"; // an opaque root background paints the canvas instead
    mockPoints([[root()]]);
    expect(sampleBackground(document, window, noSuspend)).toBe("light");
    root().removeAttribute("style");
  });
  it("a translucent layer over a dark body canvas still composites to dark", () => {
    document.body.style.backgroundColor = "#111";
    document.body.innerHTML = '<div id="o" style="background-color:rgba(255,255,255,0.05)"></div>';
    mockPoints([[document.getElementById("o")!, document.body, root()]]);
    expect(sampleBackground(document, window, noSuspend)).toBe("dark");
  });
  it("mid-gray median → unknown", () => {
    document.body.style.backgroundColor = "#777";
    mockPoints([[document.body]]);
    expect(sampleBackground(document, window, noSuspend)).toBe("unknown");
  });

  it("pre-paint immunity: a white page with pre-paint CSS, an override sheet, an adopted own sheet and an inline override samples light", () => {
    const bg = paletteCss(PALETTES.dark).bg;
    const page = document.createElement("style");
    page.textContent = "html,body{background-color:#fff}";
    // Pre-paint CSS verbatim (registered as a user sheet in Safari, so it can't be disabled: only the attribute excludes it).
    const pre = document.createElement("style");
    pre.textContent =
      `@media screen {\n  html:not([data-dusk-ready]):not([data-dusk-sampling]) { background-color: ${bg} !important; color-scheme: dark !important; }\n` +
      `  html:not([data-dusk-ready]):not([data-dusk-sampling]) body { background-color: ${bg} !important; color: #eee !important; }\n}`;
    const override = document.createElement("style");
    override.setAttribute("data-dusk", "sheet");
    override.setAttribute("media", "screen");
    override.textContent = `html,body,.card{background-color:${bg} !important}`;
    document.head.append(page, pre, override);
    const own = new CSSStyleSheet({ media: "screen" });
    own.replaceSync(`body,.card{background-color:${bg} !important}`);
    (own as unknown as Record<symbol, unknown>)[OWN_SHEET] = true;
    document.adoptedStyleSheets = [own];
    document.body.innerHTML = '<div class="card" id="card"></div>';
    const card = document.getElementById("card")!;
    card.style.setProperty("background-color", bg, "important"); // engine's inline override; original was #fff
    const stacks = [[card, document.body, root()], [document.body, root()], [root()], [card], [document.body]];

    // Without suspension the sampler would see Duskling's colors.
    mockPoints(stacks);
    expect(sampleBackground(document, window, noSuspend)).toBe("dark");

    // The engine's suspend is suspendOwnSheets plus shadow roots. happy-dom ignores StyleSheet.disabled in the
    // cascade, so this fake also takes the own sheets out of the cascade the way happy-dom honors: detached / un-adopted.
    // test/unit-webkit/native-dark.spec.ts runs the same page with the real suspendOwnSheets in WebKit.
    let suspended = 0;
    let restored = 0;
    mockPoints(stacks);
    const verdict = sampleBackground(document, window, {
      suspend: () => {
        suspended++;
        expect(root().hasAttribute("data-dusk-sampling")).toBe(true);
        const resume = suspendOwnSheets(document);
        expect([override.sheet!.disabled, own.disabled]).toEqual([true, true]);
        override.remove();
        document.adoptedStyleSheets = [];
        return () => {
          restored++;
          document.head.append(override);
          document.adoptedStyleSheets = [own];
          resume();
        };
      },
      originalBackground: (el) => (el === card ? "#fff" : null),
    });
    expect(verdict).toBe("light");
    expect([suspended, restored]).toEqual([1, 1]);
    expect(root().hasAttribute("data-dusk-sampling")).toBe(false);
    expect(override.sheet!.disabled).toBe(false);
    expect(own.disabled).toBe(false);
    expect(getComputedStyle(document.body).backgroundColor).not.toBe("rgb(255, 255, 255)");
  });

  describe("originalBackground contract", () => {
    const BG = "rgb(30, 32, 36)";
    const withOverride = (html: string) => {
      document.body.innerHTML = html;
      const el = document.getElementById("e")!;
      el.style.setProperty("background-color", BG, "important");
      return el;
    };
    const verdict = (el: Element, orig: string | null) => {
      mockPoints([[el, document.body, root()]]);
      return sampleBackground(document, window, { suspend: () => () => {}, originalBackground: (x) => (x === el ? orig : null) });
    };
    it("null → the computed background (no engine override)", () => {
      expect(verdict(withOverride('<div id="e"></div>'), null)).toBe("dark");
    });
    it("a color → that color", () => {
      expect(verdict(withOverride('<div id="e"></div>'), "#fff")).toBe("light");
    });
    it("a background shorthand → its color component", () => {
      expect(verdict(withOverride('<div id="e"></div>'), 'url("a.png") no-repeat center / cover, linear-gradient(red, blue) #fafafa')).toBe("light");
    });
    it("no color (var()) → transparent, so the canvas shows through", () => {
      document.body.style.backgroundColor = "#101010";
      expect(verdict(withOverride('<div id="e"></div>'), "var(--bg)")).toBe("dark");
    });
    it('"" with a bgcolor attribute → HTML legacy color parsing', () => {
      expect(verdict(withOverride('<table id="e" bgcolor="white"></table>'), "")).toBe("light");
      expect(verdict(withOverride('<table id="e" bgcolor="fff"></table>'), "")).toBe("dark"); // legacy "fff" is #0f0f0f
    });
    it('"" without bgcolor → the computed background with the inline override taken out; style is restored byte-identical', () => {
      const st = document.createElement("style");
      st.textContent = ".w{background-color:#fff}";
      document.head.append(st);
      const el = withOverride('<div id="e" class="w" style="padding: 1px"></div>');
      const before = el.getAttribute("style");
      expect(getComputedStyle(el).backgroundColor).toBe(BG);
      expect(verdict(el, "")).toBe("light");
      expect(el.getAttribute("style")).toBe(before);
      expect(getComputedStyle(el).backgroundColor).toBe(BG);
    });
  });

  it("restores and removes the attribute even when reading throws", () => {
    const resume = vi.fn();
    (document as unknown as { elementsFromPoint: unknown }).elementsFromPoint = () => {
      throw new Error("boom");
    };
    expect(() => sampleBackground(document, window, { suspend: () => resume, originalBackground: () => null })).toThrow("boom");
    expect(resume).toHaveBeenCalledTimes(1);
    expect(root().hasAttribute("data-dusk-sampling")).toBe(false);
  });
});

describe("parseLegacyColor", () => {
  it("follows the HTML legacy color rules", () => {
    expect(parseLegacyColor("chucknorris")).toEqual({ r: 0xc0, g: 0, b: 0, a: 1 });
    expect(parseLegacyColor("#abc")).toEqual({ r: 0xaa, g: 0xbb, b: 0xcc, a: 1 });
    expect(parseLegacyColor("fff")).toEqual({ r: 0x0f, g: 0x0f, b: 0x0f, a: 1 });
    expect(parseLegacyColor(" Navy ")).toEqual({ r: 0, g: 0, b: 0x80, a: 1 });
    expect(parseLegacyColor("#1234567890ab")).toEqual({ r: 0x12, g: 0x56, b: 0x90, a: 1 });
    expect(parseLegacyColor("")).toBeNull();
    expect(parseLegacyColor("transparent")).toBeNull();
  });
});

describe("suspendOwnSheets", () => {
  it("disables [data-dusk] and adopted own sheets but keeps the promoted native sheet and page sheets; resume re-enables", () => {
    const mk = (attr: string | null) => {
      const el = document.createElement("style");
      if (attr) el.setAttribute("data-dusk", attr);
      el.textContent = "p{color:red}";
      document.head.append(el);
      return el.sheet!;
    };
    const [page, own, native] = [mk(null), mk("sheet"), mk("native")];
    const adopted = sheet("p{color:red}");
    (adopted as unknown as Record<symbol, unknown>)[OWN_SHEET] = true;
    const pageAdopted = sheet("p{color:red}");
    document.adoptedStyleSheets = [pageAdopted, adopted];
    const resume = suspendOwnSheets(document);
    expect([page, own, native, pageAdopted, adopted].map((s) => s.disabled)).toEqual([false, true, false, false, true]);
    resume();
    expect([page, own, native, pageAdopted, adopted].map((s) => s.disabled)).toEqual([false, false, false, false, false]);
  });
});

describe("collectDarkSchemeRules", () => {
  it("extracts top-level and nested dark blocks and ignores prefers-color-scheme: light", () => {
    const css = sheet(
      [
        ".a{color:red}",
        "@media (prefers-color-scheme: dark){:root{--bg:#000}}",
        "@media (prefers-color-scheme: light){.light{color:blue}}",
        "@supports (display:grid){@media (prefers-color-scheme: dark){.b{color:white}}}",
        "@media screen and (min-width: 600px){@media (prefers-color-scheme: dark){.c{color:gray}}}",
        "@media print{@media (prefers-color-scheme: dark){.p{color:white}}}",
      ].join("\n"),
    );
    const out = collectDarkSchemeRules([css]);
    const parsed = sheet(out);
    expect(parsed.cssRules.length).toBe(3);
    expect(out).toMatch(/:root\s*\{\s*--bg:\s*#000;?\s*\}/);
    expect(out).toMatch(/@supports \(display: ?grid\)\s*\{\s*\.b\s*\{\s*color: white;?\s*\}\s*\}/);
    expect(out).toMatch(/@media screen and \(min-width: 600px\)\s*\{\s*\.c\s*\{/);
    expect(out).not.toContain("light");
    expect(out).not.toContain(".p");
    expect(out).not.toContain(".a");
  });
  it("keeps the remaining media condition of a combined query", () => {
    const out = collectDarkSchemeRules([sheet("@media (prefers-color-scheme: dark) and (min-width: 600px){.d{color:white}}")]);
    expect(out).toMatch(/^@media \(min-width: 600px\)\s*\{\s*\.d\s*\{/);
  });
  it("ignores negated and `or` dark queries", () => {
    const out = collectDarkSchemeRules([
      sheet("@media not (prefers-color-scheme: dark){.n{color:red}}"),
      sheet("@media (prefers-color-scheme: dark) or (min-width: 1px){.o{color:red}}"),
      sheet("@media not all and (prefers-color-scheme: dark){.m{color:red}}"),
    ]);
    expect(out).toBe("");
  });
  it("takes whole sheets whose own media is dark (<link|style media=…dark>)", () => {
    const out = collectDarkSchemeRules([sheet("body{background:#000}", "(prefers-color-scheme: dark)"), sheet("body{background:#fff}", "screen")]);
    expect(out).toMatch(/^body\s*\{\s*background/);
    expect(out).not.toContain("#fff");
  });
  it("skips Duskling's own sheets", () => {
    const own = sheet("@media (prefers-color-scheme: dark){html{background:#000}}");
    (own as unknown as Record<symbol, unknown>)[OWN_SHEET] = true;
    expect(collectDarkSchemeRules([own])).toBe("");
  });
});

describe("hasRootDarkTheme", () => {
  it("true for :root custom properties and html/body backgrounds", () => {
    expect(hasRootDarkTheme(":root{--bg:#000}")).toBe(true);
    expect(hasRootDarkTheme("html, body{background:#111}")).toBe(true);
    expect(hasRootDarkTheme("@supports (color:red){body{background-color:#111}}")).toBe(true);
  });
  it("false for component-only rules", () => {
    expect(hasRootDarkTheme(".btn{color:red}")).toBe(false);
    expect(hasRootDarkTheme("body .btn{background:#000}")).toBe(false);
    expect(hasRootDarkTheme(":root{color:white}")).toBe(false);
    expect(hasRootDarkTheme("")).toBe(false);
  });
  it("with a document: a class selector that matches html or body counts like html/body (CSS-in-JS atomic classes)", () => {
    document.documentElement.className = "x108lcm5";
    document.body.className = "xbody";
    try {
      expect(hasRootDarkTheme(".x108lcm5{--lightningcss-light: ;--lightningcss-dark:initial}", document)).toBe(true);
      expect(hasRootDarkTheme(".xbody{background-color:#111}", document)).toBe(true);
      // Custom properties count on the root element only, as for selector text.
      expect(hasRootDarkTheme(".xbody{--bg:#111}", document)).toBe(false);
      expect(hasRootDarkTheme(".other{--bg:#111}", document)).toBe(false);
      expect(hasRootDarkTheme(".x108lcm5{--bg:#111}")).toBe(false);
      // Broad selectors that happen to match html aren't a root theme (and aren't tried with matches()).
      expect(hasRootDarkTheme("*{--bg:#111}", document)).toBe(false);
      expect(hasRootDarkTheme("[lang]{--bg:#111}", document)).toBe(false);
      expect(hasRootDarkTheme(".x108lcm5 .child{--bg:#111}", document)).toBe(false);
    } finally {
      document.documentElement.className = document.body.className = "";
    }
  });
});

describe("promote", () => {
  it('inserts <style data-dusk="native" media="screen"> and calls setPromotion(true); teardown reverses both', async () => {
    const setPromotion = vi.fn();
    const stop = await promote(document, "body{background:#000}", { setPromotion });
    const s = document.querySelector('style[data-dusk="native"]')!;
    expect(s.getAttribute("media")).toBe("screen");
    expect(s.textContent).toBe("body{background:#000}");
    expect(setPromotion.mock.calls).toEqual([[true]]);
    stop();
    expect(document.querySelector('style[data-dusk="native"]')).toBeNull();
    expect(setPromotion.mock.calls).toEqual([[true], [false]]);
    stop();
    expect(setPromotion).toHaveBeenCalledTimes(2);
  });
});
