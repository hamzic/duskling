// E2E helpers: load the real dist/ bundles into Playwright WebKit the way Safari injects them, open fixture
// pages themed, and measure contrast, darkness and white share.
//
// Injection model. Safari injects the registrations from planRegistrations at document start in every frame
// whose URL they match (`allFrames`, `runAt: document_start`), each registration's files in array order, in registration
// order (bridge, pre-paint, engine). Here all of that is one generated init script: it holds the plan's match
// patterns and file contents, and at document start each frame injects the registrations matching its own URL. Playwright
// runs init scripts "in all frames" before any page script (https://playwright.dev/docs/api/class-page#page-add-init-script),
// so a cross-origin frame gets its own content script just as with `<all_urls>`. Differences from Safari, kept small:
// - Everything runs in one world (Safari uses MAIN for the bridge and an isolated world for the rest); the bridge
//   recognizes Duskling-owned sheets for this reason.
// - Registered CSS (prepaint/<theme>.css) becomes `<style data-dusk="prepaint-css" media="screen">` instead of a user
//   stylesheet.
// - A settings change re-plans for later navigations (registration update); open pages get storage.onChanged only.
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { Disposable, Page } from "@playwright/test";
import { build } from "esbuild";
import type { PlannedScript } from "../../src/background/registrations";
import type { FetchResult, PageStatus, RuntimeMessage } from "../../src/shared/messages";
import type { Mode, Settings, SiteRule, ThemeId } from "../../src/shared/types";

// pngjs (devDependency) ships no types.
interface Png { width: number; height: number; data: Buffer }
const { PNG } = createRequire(import.meta.url)("pngjs") as { PNG: { sync: { read(b: Buffer): Png } } };

export const ORIGIN_A = "http://localhost:4100";
export const ORIGIN_B = "http://localhost:4101";

// The real planner and fetch handler. They are bundled with esbuild because registrations.ts imports JSON without an
// import attribute (fine for the extension build, refused by Node's ESM loader that Playwright uses).
const SRC = fileURLToPath(new URL("../../src/", import.meta.url));
const bundled = await build({
  stdin: {
    contents: [
      'export { planRegistrations, matchesPattern } from "./background/registrations";',
      'export { handleFetchResource } from "./background/fetch-resource";',
      'export { DEFAULT_SETTINGS, SETTINGS_KEY } from "./shared/settings";',
    ].join("\n"),
    resolveDir: SRC,
    loader: "ts",
  },
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node24",
  write: false,
});
const bg = (await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0]!.text).toString("base64")}`)) as {
  planRegistrations: typeof import("../../src/background/registrations").planRegistrations;
  matchesPattern: typeof import("../../src/background/registrations").matchesPattern;
  handleFetchResource: typeof import("../../src/background/fetch-resource").handleFetchResource;
  DEFAULT_SETTINGS: Settings;
  SETTINGS_KEY: string;
};
const { planRegistrations, matchesPattern, handleFetchResource, DEFAULT_SETTINGS, SETTINGS_KEY } = bg;

const DIST = fileURLToPath(new URL("../../dist/", import.meta.url));
const HARNESS = fileURLToPath(new URL("../../dist-test/harness.js", import.meta.url));

const files = new Map<string, string>();
function read(path: string): string {
  let text = files.get(path);
  if (text === undefined) {
    if (!existsSync(path)) throw new Error(`e2e: ${path} is missing; run \`npm run build:test\` first`);
    text = readFileSync(path, "utf8");
    files.set(path, text);
  }
  return text;
}

/** `basic-article` → origin A URL; a full URL is used as is. */
export function fixtureUrl(fixture: string): string {
  return /^https?:\/\//.test(fixture) ? fixture : `${ORIGIN_A}/${fixture.replace(/^\//, "")}${/\.[a-z]+($|\?)/.test(fixture) ? "" : ".html"}`;
}

/** Settings built from the defaults; `sites` entries get `updatedAt: 1` unless given. */
export function makeSettings(o: {
  enabled?: boolean;
  theme?: ThemeId;
  respectNativeDark?: boolean;
  dimImages?: boolean;
  sites?: Record<string, Partial<SiteRule> & { mode?: Mode }>;
} = {}): Settings {
  const s = structuredClone(DEFAULT_SETTINGS);
  if (o.enabled !== undefined) s.global.enabled = { value: o.enabled, updatedAt: 1 };
  if (o.theme !== undefined) s.global.theme = { value: o.theme, updatedAt: 1 };
  if (o.respectNativeDark !== undefined) s.global.respectNativeDark = { value: o.respectNativeDark, updatedAt: 1 };
  if (o.dimImages !== undefined) s.global.dimImages = { value: o.dimImages, updatedAt: 1 };
  for (const [h, r] of Object.entries(o.sites ?? {})) s.sites[h] = { updatedAt: 1, ...r };
  return s;
}

// --- injection --------------------------------------------------------------------------------------------------------

const PATTERN = /^(<all_urls>|\*:\/\/(\*\.)?[^/*]+\/\*)$/;

// In-page matcher for the pattern shapes planRegistrations emits (`<all_urls>`, `*://host/*`, `*://*.host/*`), with the
// MDN semantics that registrations.ts `matchesPattern` documents. about:blank and about:srcdoc frames match nothing,
// like Safari without matchAboutBlank; the engine themes them from the parent.
const MATCHER = `const U=new URL(location.href);
const mp=(p)=>{if(p==="<all_urls>")return["http:","https:","ws:","wss:","ftp:","data:","file:"].includes(U.protocol);
const m=/^\\*:\\/\\/([^/]+)\\/\\*$/.exec(p);if(!m||!/^https?:$/.test(U.protocol))return false;
const h=U.hostname.toLowerCase(),ph=m[1].toLowerCase();
return ph.startsWith("*.")?(h===ph.slice(2)||h.endsWith(ph.slice(1))):h===ph};`;

const CSS = `const css=(t)=>{const s=document.createElement("style");s.setAttribute("data-dusk","prepaint-css");
s.media="screen";s.textContent=t;document.documentElement.appendChild(s)};`;

// Safari runs document_start scripts once the document element exists ("after the creation of the webpage's document
// element", developer.apple.com/documentation/webkit/wkuserscriptinjectiontime/atdocumentstart; see prepaint/generate.ts),
// but Playwright WebKit runs init scripts before it exists (seen in this harness: documentElement is null). So the
// isolated-world files wait for it with a MutationObserver. Its callback is a microtask, and the HTML parser performs a
// microtask checkpoint before running a parser-inserted script (HTML §13.2.6.4.8, "An end tag whose tag name is
// 'script'"), so they still run before any page script and before first paint. MAIN-world files (the bridge) need no
// document element and run immediately.
const WHEN_ROOT = `const whenRoot=(f)=>{if(document.documentElement)return f();
new MutationObserver((_,o)=>{if(document.documentElement){o.disconnect();f()}}).observe(document,{childList:true})};`;

// In Safari the isolated world has its own copy of the JavaScript environment (developer.apple.com/documentation/webkit/
// wkcontentworld), so the MAIN-world bridge's matchMedia patch (bridge-promote.js) is invisible to the engine, which relies
// on reading the real system scheme there (engine/index.ts canPromote). Here both share one window, so matchMedia gets a
// wrapper that hands the native function to callers in an init script (Playwright WebKit reports their frames as
// `web-inspector://bootstrap.js`; the bridge itself keeps its own native reference) and the bridge's to page code.
const ISOLATE = `const NMM=window.matchMedia;const isoMM=()=>{const pm=window.matchMedia;if(pm===NMM||pm.__duskIso)return;
const w=function(q){const c=(new Error().stack||"").split("\\n")[1]||"";return(c.includes("web-inspector://")?NMM:pm).call(window,q)};
w.__duskIso=true;window.matchMedia=w};`;

/** The init script for one plan. Each file runs in its own try block, as Safari runs each injected file separately. */
export function initScript(plan: PlannedScript[]): string {
  for (const s of plan) for (const p of [...s.matches, ...s.excludeMatches]) if (!PATTERN.test(p)) throw new Error(`e2e: unsupported pattern ${p}`);
  const guard = (code: string) => `try{${code}\n}catch(e){console.error("dusk harness:",e)}`;
  const blocks = plan.map((s, i) => {
    const parts: string[] = [];
    for (const f of s.css ?? []) parts.push(guard(`css(${JSON.stringify(read(DIST + f))})`));
    // The browser shim goes in front of the engine family (boot + content.js); it is idempotent.
    const main = s.world === "MAIN";
    if (s.js?.includes("content.js")) parts.push(guard(read(HARNESS)));
    for (const f of s.js ?? []) parts.push(guard(read(DIST + f)));
    const body = parts.join("\n");
    return `if(hit[${i}]){${main ? body : `whenRoot(()=>{isoMM();${body}})`}}`;
  });
  return `(()=>{${MATCHER}${CSS}${WHEN_ROOT}${ISOLATE}
const S=${JSON.stringify(plan.map((s) => [s.matches, s.excludeMatches]))};
const hit=S.map(([m,x])=>m.some(mp)&&!x.some(mp));if(!hit.some(Boolean))return;
${blocks.join("\n")}})();`;
}

interface State { settings: Settings; script: Disposable | null }
const states = new WeakMap<Page, State>();

async function replan(page: Page, st: State): Promise<void> {
  await st.script?.dispose();
  st.script = await page.addInitScript({ content: initScript(planRegistrations(st.settings)) });
}

/** Installs the storage and fetch bindings and the init script for `settings`. Later calls only change the settings. */
export async function installDusk(page: Page, settings: Settings = DEFAULT_SETTINGS): Promise<void> {
  const existing = states.get(page);
  if (existing) {
    await setSettings(page, settings);
    return;
  }
  const st: State = { settings: structuredClone(settings), script: null };
  states.set(page, st);
  await page.exposeBinding("__duskStorage", async (_source, op: "get" | "set", arg: unknown) => {
    const all: Record<string, unknown> = { [SETTINGS_KEY]: st.settings };
    if (op === "set") {
      const items = arg as Record<string, unknown>;
      if (SETTINGS_KEY in items) await setSettings(page, items[SETTINGS_KEY] as Settings);
      return {};
    }
    if (arg === null || arg === undefined) return structuredClone(all);
    const keys = typeof arg === "string" ? [arg] : Array.isArray(arg) ? (arg as string[]) : Object.keys(arg as object);
    const out: Record<string, unknown> = typeof arg === "object" && !Array.isArray(arg) ? { ...(arg as object) } : {};
    for (const k of keys) if (k in all) out[k] = structuredClone(all[k]);
    return out;
  });
  // The background's real handler, with the same sender URLs Safari reports (tab and frame).
  await page.exposeBinding("__duskFetch", async (source, message: Extract<RuntimeMessage, { type: "fetchResource" }>): Promise<FetchResult> => {
    const delay = fetchDelays.get(page) ?? 0;
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    return handleFetchResource(message, { tabUrl: page.url(), frameUrl: source.frame.url() });
  });
  await replan(page, st);
}

const fetchDelays = new WeakMap<Page, number>();
/** Delays every background fetchResource reply on `page`, as a slow extension round trip on a device would. */
export function setFetchDelay(page: Page, ms: number): void {
  fetchDelays.set(page, ms);
}

/** Replaces the stored settings, re-plans the registrations and fires storage.onChanged in every frame. */
export async function setSettings(page: Page, settings: Settings): Promise<void> {
  const st = states.get(page);
  if (!st) throw new Error("e2e: setSettings before installDusk/openThemed");
  const oldValue = st.settings;
  st.settings = structuredClone(settings);
  await replan(page, st);
  const changes = { [SETTINGS_KEY]: { oldValue, newValue: st.settings } };
  await Promise.all(
    page.frames().map((f) =>
      f
        .evaluate((c) => (globalThis as { __duskHarness?: { fireChanged(c: unknown): void } }).__duskHarness?.fireChanged(c), changes)
        .catch(() => {}),
    ),
  );
}

/** The content script's answer to a `pageStatus` message (top frame). */
export async function pageStatus(page: Page): Promise<PageStatus | undefined> {
  return page.evaluate(
    () => (globalThis as { __duskHarness?: { sendToContent(m: unknown): Promise<unknown> } }).__duskHarness?.sendToContent({ type: "pageStatus" }) as Promise<PageStatus | undefined>,
  );
}

/**
 * Waits until the page has been quiet: two frames, then no DOM mutation (childList, attributes, text) in the document or
 * its open shadow roots for `quietMs`, polled instead of a fixed sleep. Batched DOM work, image analysis and the
 * contrast-repair pass all end in DOM writes, so a quiet window longer than their debounce means they are done. Gives up after `timeoutMs` (pages
 * with endless animation) without failing; the gate's own assertions decide then.
 */
export async function waitForIdle(page: Page, quietMs = 200, timeoutMs = 5_000): Promise<void> {
  await page.evaluate(
    ([quiet, timeout]) =>
      new Promise<void>((resolve) => {
        let last = performance.now();
        const opts = { subtree: true, childList: true, attributes: true, characterData: true };
        const mo = new MutationObserver(() => void (last = performance.now()));
        const watch = (root: Document | ShadowRoot): void => {
          mo.observe(root, opts);
          for (const el of root.querySelectorAll("*")) if (el.shadowRoot) watch(el.shadowRoot);
        };
        watch(document);
        const start = performance.now();
        const tick = (): void => {
          const now = performance.now();
          if (now - last >= quiet || now - start >= timeout) {
            mo.disconnect();
            resolve();
          } else setTimeout(tick, 25);
        };
        requestAnimationFrame(() => requestAnimationFrame(tick));
      }),
    [quietMs, timeoutMs] as const,
  );
}

/**
 * The idle wait with a minimum quiet window of `ms`. The default outlasts the contrast repair's mutation debounce
 * (300 ms, `MUTATION_DEBOUNCE` in engine/repair/contrast-repair.ts): a shorter window can end before a late element's
 * repair pass has run, so a measurement would see the page before the contrast repair (seen on youtube.com).
 */
export async function settle(page: Page, ms = 500): Promise<void> {
  await waitForIdle(page, ms);
}

/**
 * Opens a fixture (name or URL) with Duskling installed and waits until it is themed: `html[data-dusk-ready]` when any
 * registration matches the URL, then `settle`. The system color scheme is light unless `colorScheme` says otherwise.
 */
export async function openThemed(
  page: Page,
  fixture: string,
  settings: Settings = DEFAULT_SETTINGS,
  opts: { colorScheme?: "light" | "dark"; waitUntil?: "load" | "domcontentloaded" | "commit" } = {},
): Promise<void> {
  await page.emulateMedia({ colorScheme: opts.colorScheme ?? "light" });
  await installDusk(page, settings);
  const url = fixtureUrl(fixture);
  await page.goto(url, { waitUntil: opts.waitUntil ?? "load" });
  if (opts.waitUntil === "commit") return;
  const hits = (p: string) => matchesPattern(p, url);
  const planned = planRegistrations(settings).some((s) => s.js?.includes("content.js") && s.matches.some(hits) && !s.excludeMatches.some(hits));
  if (planned) await page.waitForSelector("html[data-dusk-ready]", { state: "attached", timeout: 10_000 });
  await settle(page);
}


// --- measurements -----------------------------------------------------------------------------------------------------

export interface ContrastResult {
  /** Visible text elements measured. */
  total: number;
  passing: number;
  /** Visible text elements not measured (counted per reason in `reasons`). */
  skipped: number;
  reasons: Record<string, number>;
  /** The first 50 failing elements: selector, worst-case ratio, text. */
  failures: string[];
}

/**
 * WCAG 2.x contrast audit of visible text: for each element that directly holds non-blank text (the document, open shadow
 * roots and same-origin frames), compares its computed `color` (`fill` for SVG text) with the background behind it.
 *
 * The background walks up the ancestors (through shadow hosts and frame elements) to the first opaque background-color,
 * compositing translucent layers over the white canvas. A gradient layer is tested at every color stop and the worst ratio
 * counts. A `url()` image layer is unknown content: the element is skipped only when no opaque background-color is found on
 * that element or above it (otherwise the color it sits on is used). Text drawn over an `<img>`, `<video>`, `<canvas>` or
 * `<picture>` is skipped. Invisible text (box under 1 px, `visibility`, `opacity: 0`, a zero-area `clip` or
 * `clip-path: inset(50%)` on the way up, closed `<details>`) is not a candidate. Passing means a ratio ≥ 4.5.
 */
export async function contrastAudit(page: Page): Promise<ContrastResult> {
  return page.evaluate(() => {
    type C4 = [number, number, number, number];
    type C3 = [number, number, number];
    // The canvas under all-transparent backgrounds is the Canvas system color of the root's used color scheme, dark
    // with `color-scheme: dark` (CSS Color Adjust 1 §2.2, https://drafts.csswg.org/css-color-adjust-1/#color-scheme-effect),
    // not always white. Read in the page: html gets `background-color: Canvas` through the CSSOM and loses it again in the
    // same task, so observers see their last write unchanged and a strict CSP doesn't matter.
    const canvas = ((): [number, number, number] => {
      const st = document.documentElement.style;
      const had = document.documentElement.getAttribute("style");
      const [v, pr] = [st.getPropertyValue("background-color"), st.getPropertyPriority("background-color")];
      st.setProperty("background-color", "Canvas", "important");
      const c = getComputedStyle(document.documentElement).backgroundColor;
      if (v) st.setProperty("background-color", v, pr);
      else st.removeProperty("background-color");
      // Declarations first, then the exact attribute (a strict CSP may refuse to re-parse it, which keeps them). The read
      // also flushes the CSSOM change into the attribute first: WebKit writes it lazily, which would leave style="".
      if (document.documentElement.getAttribute("style") !== had) {
        if (had === null) document.documentElement.removeAttribute("style");
        else document.documentElement.setAttribute("style", had);
      }
      const [r = 255, g = 255, b = 255] = (/\d+(\.\d+)?/g[Symbol.match](c) ?? []).map(Number);
      return [r, g, b];
    })();
    const cv = document.createElement("canvas");
    cv.width = cv.height = 1;
    const ctx = cv.getContext("2d", { willReadFrequently: true })!;
    const cache = new Map<string, C4>();
    // Any CSS color syntax (rgb, oklch, color(), ...) → sRGB 0..255 plus alpha 0..1, by painting it.
    const rgba = (c: string): C4 => {
      let v = cache.get(c);
      if (!v) {
        ctx.clearRect(0, 0, 1, 1);
        ctx.fillStyle = "rgba(0,0,0,0)";
        ctx.fillStyle = c;
        ctx.fillRect(0, 0, 1, 1);
        const d = ctx.getImageData(0, 0, 1, 1).data;
        v = [d[0]!, d[1]!, d[2]!, d[3]! / 255];
        cache.set(c, v);
      }
      return v;
    };
    const over = (top: C4, under: C3): C3 => [
      top[0] * top[3] + under[0] * (1 - top[3]),
      top[1] * top[3] + under[1] * (1 - top[3]),
      top[2] * top[3] + under[2] * (1 - top[3]),
    ];
    const lum = ([r, g, b]: C3) => {
      const f = (x: number) => ((x /= 255) <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4);
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const ratio = (a: C3, b: C3) => {
      const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
      return (hi + 0.05) / (lo + 0.05);
    };
    const style = (e: Element) => (e.ownerDocument.defaultView ?? window).getComputedStyle(e);
    // Up through shadow roots (host) and frame documents (the frame element).
    const parentOf = (e: Element): Element | null => {
      if (e.parentElement) return e.parentElement;
      const p = e.parentNode;
      if (p && p.nodeType === 11) return (p as ShadowRoot).host;
      if (p && p.nodeType === 9) return ((p as Document).defaultView?.frameElement as Element | null) ?? null;
      return null;
    };
    const COLOR = /(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([^()]*\)|#[0-9a-f]{3,8}\b|\btransparent\b/gi;
    const GRADIENT = /(?:repeating-)?(?:linear|radial|conic)-gradient\(/i;
    const layersOf = (bgImage: string): { url: boolean; stops: C4[] } => {
      if (bgImage === "none") return { url: false, stops: [] };
      const stops = GRADIENT.test(bgImage) ? (bgImage.replace(/url\([^)]*\)/gi, "").match(COLOR) ?? []).map(rgba) : [];
      return { url: /url\(/i.test(bgImage), stops };
    };
    const clipped = (s: CSSStyleDeclaration): boolean => {
      const m = /^rect\(([^)]*)\)$/.exec(s.clip);
      if (m) {
        const [t, r, b, l] = m[1]!.split(/[\s,]+/).map((x) => parseFloat(x));
        if (t !== undefined && r !== undefined && b !== undefined && l !== undefined && (b <= t || r <= l)) return true;
      }
      return /^inset\(\s*(50|100)%/.test(s.clipPath);
    };
    const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "TITLE", "OPTION", "TEXTAREA"]);
    const mediaOf = new Map<Document, (readonly [Element, DOMRect])[]>();
    const media = (d: Document) => {
      let m = mediaOf.get(d);
      if (!m) mediaOf.set(d, (m = [...d.querySelectorAll("img, video, canvas, picture")].map((x) => [x, x.getBoundingClientRect()] as const)));
      return m;
    };

    const elements = new Set<Element>();
    const walk = (root: Document | ShadowRoot) => {
      const d = root.nodeType === 9 ? (root as Document) : (root.ownerDocument as Document);
      const tw = d.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
      for (let n: Node | null = tw.nextNode(); n; n = tw.nextNode()) {
        if (n.nodeType === 1) {
          const el = n as Element;
          if (el.shadowRoot) walk(el.shadowRoot);
          if (el.localName === "iframe" || el.localName === "frame") {
            let cd: Document | null;
            try {
              cd = (el as HTMLIFrameElement).contentDocument; // null for a cross-origin frame
            } catch {
              cd = null;
            }
            if (cd?.documentElement) walk(cd);
          }
          continue;
        }
        if (!n.textContent?.trim()) continue;
        const p = n.parentNode;
        // Text directly in a shadow root renders with its host's style.
        const owner = n.parentElement ?? (p && p.nodeType === 11 ? (p as ShadowRoot).host : null);
        if (owner && !SKIP.has(owner.tagName)) elements.add(owner);
      }
    };
    walk(document);

    let total = 0, passing = 0, skipped = 0;
    const reasons: Record<string, number> = {};
    const skip = (why: string) => {
      skipped++;
      reasons[why] = (reasons[why] ?? 0) + 1;
    };
    const failures: string[] = [];
    outer: for (const el of elements) {
      const cs = style(el);
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1 || cs.visibility !== "visible" || Number(cs.opacity) === 0) continue;
      if (el.closest("details:not([open]) > :not(summary)")) continue;
      for (let a: Element | null = el; a; a = parentOf(a)) {
        const s = style(a);
        if (clipped(s) || Number(s.opacity) === 0) continue outer;
      }
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      for (const [m, mr] of media(el.ownerDocument)) {
        if (!el.contains(m) && cx >= mr.left && cx <= mr.right && cy >= mr.top && cy <= mr.bottom) {
          skip("over-media");
          continue outer;
        }
      }
      // From `el` up to the first opaque background-color: [color, gradient stops].
      const chain: [C4, C4[]][] = [];
      let url = false, opaque = false;
      for (let a: Element | null = el; a; a = parentOf(a)) {
        const s = style(a);
        const bg = rgba(s.backgroundColor);
        const img = layersOf(s.backgroundImage);
        url ||= img.url;
        chain.push([bg, img.stops]);
        if (bg[3] >= 1) {
          opaque = true;
          break;
        }
      }
      if (url && !opaque) {
        skip("url-image");
        continue;
      }
      // Every background the text can sit on: the canvas, then each layer upward (color, then its gradient's stops).
      let bases: C3[] = [canvas];
      for (const [bg, stops] of chain.reverse()) {
        bases = bases.map((b) => over(bg, b));
        if (stops.length) bases = bases.flatMap((b) => stops.map((st) => over(st, b))).slice(0, 256);
      }
      const fg4 = rgba(el instanceof SVGElement ? cs.fill : cs.color);
      let worst = Infinity;
      for (const b of bases) worst = Math.min(worst, ratio(over(fg4, b), b));
      total++;
      if (worst >= 4.5) passing++;
      else if (failures.length < 50) failures.push(`${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""}${el.className && typeof el.className === "string" ? "." + el.className.trim().split(/\s+/).join(".") : ""} ${worst.toFixed(2)} "${(el.textContent ?? "").trim().slice(0, 30)}"`);
    }
    return { total, passing, skipped, reasons, failures };
  });
}

const linear = (v: number) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const LIN = Array.from({ length: 256 }, (_, i) => linear(i));

/** A rectangle in CSS px of the viewport, excluded from a luminance share. */
export interface Rect { x: number; y: number; width: number; height: number }

/**
 * Share of pixels whose relative luminance satisfies `test` (alpha ignored; screenshots are opaque). `mask` rectangles are
 * in CSS px; `scale` is device pixels per CSS px of the screenshot, and `scaleY` the vertical one when it differs.
 * Masked pixels are left out of the denominator too.
 */
export function luminanceShare(png: Buffer, test: (l: number) => boolean, mask: Rect[] = [], scale = 1, scaleY = scale): number {
  return luminanceStats(png, test, mask, scale, scaleY).share;
}

function luminanceStats(png: Buffer, test: (l: number) => boolean, mask: Rect[], sx: number, sy: number): { share: number; masked: number } {
  const { data, width, height } = PNG.sync.read(png);
  const skip = new Uint8Array(width * height);
  for (const m of mask) {
    const x0 = Math.max(0, Math.floor(m.x * sx)), x1 = Math.min(width, Math.ceil((m.x + m.width) * sx));
    const y0 = Math.max(0, Math.floor(m.y * sy)), y1 = Math.min(height, Math.ceil((m.y + m.height) * sy));
    for (let y = y0; y < y1; y++) skip.fill(1, y * width + x0, y * width + Math.max(x0, x1));
  }
  let hits = 0, counted = 0;
  for (let p = 0, i = 0; p < width * height; p++, i += 4) {
    if (skip[p]) continue;
    counted++;
    if (test(0.2126 * LIN[data[i]!]! + 0.7152 * LIN[data[i + 1]!]! + 0.0722 * LIN[data[i + 2]!]!)) hits++;
  }
  return { share: counted ? hits / counted : 0, masked: 1 - counted / (width * height) };
}

/**
 * The image boxes in the viewport, in CSS px: `<img>`, `<picture>`, `<video>`, `<canvas>`, SVG `<image>`, and elements
 * other than html and body (whose background paints the whole canvas) with a `background-image: url()` layer. Searched in
 * the document and its open shadow roots.
 */
export async function imageBoxes(page: Page): Promise<Rect[]> {
  return page.evaluate(() => {
    const out: { x: number; y: number; width: number; height: number }[] = [];
    const vw = innerWidth, vh = innerHeight;
    const visit = (root: Document | ShadowRoot) => {
      for (const el of root.querySelectorAll("*")) {
        if (el.shadowRoot) visit(el.shadowRoot);
        const media = /^(img|picture|video|canvas)$/.test(el.localName) || (el.localName === "image" && el instanceof SVGElement);
        if (!media && (el === document.documentElement || el === document.body || !getComputedStyle(el).backgroundImage.includes("url("))) continue;
        const r = el.getBoundingClientRect();
        const x = Math.max(0, r.left), y = Math.max(0, r.top);
        const w = Math.min(vw, r.right) - x, h = Math.min(vh, r.bottom) - y;
        if (w > 0 && h > 0) out.push({ x, y, width: w, height: h });
      }
    };
    visit(document);
    return out;
  });
}

/**
 * Darkness: the share of viewport pixels with relative luminance < 0.3, with image boxes (`imageBoxes`) left out
 * of the count. `masked` is the share of the viewport they cover, reported so a mostly-masked page can't pass unnoticed.
 */
export async function darknessReport(page: Page): Promise<{ darkness: number; masked: number; png: Buffer }> {
  const mask = await imageBoxes(page);
  const [vw, vh] = await page.evaluate(() => [innerWidth, innerHeight]);
  const png = await page.screenshot();
  // Per axis: the screenshot's height need not map to innerHeight by the width's factor (seen with Linux WebKit's mobile emulation).
  const { width, height } = PNG.sync.read(png);
  const { share, masked } = luminanceStats(png, (l) => l < 0.3, mask, width / vw!, height / vh!);
  return { darkness: share, masked, png };
}

/** `darknessReport(page).darkness`. */
export async function darkness(page: Page): Promise<number> {
  return (await darknessReport(page)).darkness;
}

/** Share of pixels with relative luminance > 0.8 (white-frame criterion). */
export function whiteShare(png: Buffer): number {
  return luminanceShare(png, (l) => l > 0.8);
}

/** Decoded RGBA pixels of a PNG screenshot. */
export function readPng(png: Buffer): Png {
  return PNG.sync.read(png);
}

/** OKLCH lightness L (0..1) of an sRGB color, the "L" of the design's thresholds (Björn Ottosson's OKLab matrices). */
export function oklchL(r: number, g: number, b: number): number {
  const R = LIN[Math.round(r)]!, G = LIN[Math.round(g)]!, B = LIN[Math.round(b)]!;
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995457 * G + 0.1073969561 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
}

/** OKLCH L of every pixel of a PNG, row-major. */
export function lightness(png: Buffer): number[] {
  const { data } = PNG.sync.read(png);
  const out: number[] = [];
  for (let i = 0; i < data.length; i += 4) out.push(oklchL(data[i]!, data[i + 1]!, data[i + 2]!));
  return out;
}

/**
 * Largest per-channel difference between two same-sized PNGs (RGB only), leaving out an `inset`-pixel frame (an element
 * at a fractional position shares its edge pixels with whatever is behind it).
 */
export function maxChannelDiff(a: Buffer, b: Buffer, inset = 0): number {
  const x = PNG.sync.read(a), y = PNG.sync.read(b);
  if (x.width !== y.width || x.height !== y.height) return Infinity;
  let max = 0;
  for (let r = inset; r < x.height - inset; r++) {
    for (let c = inset; c < x.width - inset; c++) {
      const i = (r * x.width + c) * 4;
      for (let k = 0; k < 3; k++) max = Math.max(max, Math.abs(x.data[i + k]! - y.data[i + k]!));
    }
  }
  return max;
}

/** The OKLCH L of a CSS color as the page resolves it (any syntax). */
export async function cssLightness(page: Page | import("@playwright/test").Frame, color: string): Promise<number> {
  const [r, g, b] = await page.evaluate((c) => {
    const cv = document.createElement("canvas");
    cv.width = cv.height = 1;
    const ctx = cv.getContext("2d")!;
    ctx.fillStyle = c;
    ctx.fillRect(0, 0, 1, 1);
    return [...ctx.getImageData(0, 0, 1, 1).data];
  }, color);
  return oklchL(r!, g!, b!);
}
