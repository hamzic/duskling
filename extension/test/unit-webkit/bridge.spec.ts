// Page-context bridge in real WebKit: matchMedia promotion needs real MediaQueryList evaluation and change
// events, which happy-dom doesn't emulate faithfully. The bundle is injected as an init script, so it runs before
// the page's own scripts like the registered MAIN-world script does in Safari.
import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const entry = fileURLToPath(new URL("../../src/bridge/index.ts", import.meta.url));
const bundles: Record<string, string> = {};

test.beforeAll(async () => {
  for (const promote of [false, true]) {
    const r = await build({ entryPoints: [entry], bundle: true, format: "iife", write: false, target: "safari16.4", define: { __PROMOTE__: String(promote) } });
    bundles[String(promote)] = r.outputFiles[0]?.text ?? "";
  }
});

// The page's first script records what matchMedia says before anything else on the page runs.
const PAGE = `<!doctype html><html><head><script>
  window.early = { dark: matchMedia("(prefers-color-scheme: dark)").matches, light: matchMedia("(prefers-color-scheme: light)").matches };
</script></head><body></body></html>`;

async function open(page: Page, promote: boolean, scheme: "light" | "dark") {
  await page.emulateMedia({ colorScheme: scheme });
  await page.addInitScript({ content: bundles[String(promote)] ?? "" });
  await page.route("http://dusk.test/", (r) => r.fulfill({ contentType: "text/html", body: PAGE }));
  await page.goto("http://dusk.test/");
}

test("promote bundle on a light system: dark queries match before page scripts run, toggling notifies listeners", async ({ page }) => {
  await open(page, true, "light");
  const r = await page.evaluate(async () => {
    const w = window as unknown as { early: { dark: boolean; light: boolean } };
    const promote = (v: "on" | "off") => document.dispatchEvent(new CustomEvent("dusk:native-promotion", { detail: v }));
    const m = matchMedia("(prefers-color-scheme: dark)");
    const calls: string[] = [];
    const viaAdd = (e: MediaQueryListEvent) => calls.push(`add:${e.matches}:${e.media}`);
    m.addEventListener("change", viaAdd);
    m.addListener((e) => calls.push(`legacy:${e.matches}`));
    m.onchange = (e) => calls.push(`on:${e.matches}:${e.type}`);
    m.addEventListener("change", { handleEvent: (e: Event) => calls.push(`obj:${(e as MediaQueryListEvent).matches}`) });
    const state = {
      early: w.early,
      light: matchMedia("(prefers-color-scheme: light)").matches,
      not: matchMedia("not all and (prefers-color-scheme: dark)").matches,
      combined: matchMedia("screen and (prefers-color-scheme: dark), print").matches,
      isMql: m instanceof MediaQueryList,
      media: m.media,
      other: Object.getPrototypeOf(matchMedia("(min-width: 1px)")) === MediaQueryList.prototype,
    };
    promote("off");
    const off = { matches: m.matches, light: matchMedia("(prefers-color-scheme: light)").matches, calls: [...calls] };
    promote("off"); // no change, no event
    m.removeEventListener("change", viaAdd);
    promote("on");
    return { state, off, on: { matches: m.matches, calls } };
  });
  expect(r.state).toEqual({ early: { dark: true, light: false }, light: false, not: false, combined: true, isMql: true, media: "(prefers-color-scheme: dark)", other: true });
  expect(r.off.matches).toBe(false);
  expect(r.off.light).toBe(true);
  expect(r.off.calls).toEqual(["add:false:(prefers-color-scheme: dark)", "legacy:false", "on:false:change", "obj:false"]);
  expect(r.on.matches).toBe(true);
  expect(r.on.calls.slice(4)).toEqual(["legacy:true", "on:true:change", "obj:true"]);
});

// Not checked at document start: Playwright WebKit applies color-scheme emulation only after init scripts and the first
// page script ran (a MediaQueryList made there reads light even with emulateMedia/colorScheme "dark").
test("promote bundle on a dark system reports the real (dark) values; turning it off changes nothing", async ({ page }) => {
  await open(page, true, "dark");
  const r = await page.evaluate(() => {
    const m = matchMedia("(prefers-color-scheme: dark)");
    let n = 0;
    m.addEventListener("change", () => n++);
    const light = matchMedia("(prefers-color-scheme: light)").matches;
    document.dispatchEvent(new CustomEvent("dusk:native-promotion", { detail: "off" }));
    return { matches: m.matches, light, n };
  });
  expect(r).toEqual({ matches: true, light: false, n: 0 });
});

test("plain bundle leaves matchMedia native until promotion is switched on", async ({ page }) => {
  await open(page, false, "light");
  const r = await page.evaluate(() => {
    const before = matchMedia("(prefers-color-scheme: dark)");
    const native = Object.getPrototypeOf(before) === MediaQueryList.prototype;
    document.dispatchEvent(new CustomEvent("dusk:native-promotion", { detail: "on" }));
    return { early: (window as unknown as { early: unknown }).early, native, after: matchMedia("(prefers-color-scheme: dark)").matches };
  });
  expect(r).toEqual({ early: { dark: false, light: true }, native: true, after: true });
});

test("a promoted list forwards real system changes after promotion is off", async ({ page }) => {
  await open(page, true, "light");
  await page.evaluate(() => {
    const m = matchMedia("(prefers-color-scheme: dark)");
    (window as unknown as { seen: boolean[] }).seen = [];
    m.addEventListener("change", (e) => (window as unknown as { seen: boolean[] }).seen.push(e.matches));
    document.dispatchEvent(new CustomEvent("dusk:native-promotion", { detail: "off" }));
  });
  await page.emulateMedia({ colorScheme: "dark" });
  await expect.poll(() => page.evaluate(() => (window as unknown as { seen: boolean[] }).seen)).toEqual([false, true]);
});

test("CSSOM changes coalesce per microtask; Duskling-owned sheets are ignored", async ({ page }) => {
  await open(page, false, "light");
  const r = await page.evaluate(async () => {
    const tick = () => new Promise<void>((res) => queueMicrotask(res));
    let n = 0;
    document.addEventListener("dusk:sheet-change", () => n++);
    const style = document.head.appendChild(document.createElement("style"));
    for (let i = 0; i < 10; i++) (style.sheet as CSSStyleSheet).insertRule(`.r${i}{color:red}`);
    await tick();
    const coalesced = n;
    const own = document.head.appendChild(document.createElement("style"));
    own.setAttribute("data-dusk", "sheet");
    (own.sheet as CSSStyleSheet).insertRule("a{color:red}");
    const c = new CSSStyleSheet() as CSSStyleSheet & Record<symbol, unknown>;
    c[Symbol.for("dusk.own")] = true;
    c.replaceSync("a{color:red}");
    document.adoptedStyleSheets = [c];
    await tick();
    const ownIgnored = n === 1;
    let threw = false;
    try {
      (style.sheet as CSSStyleSheet).deleteRule(99);
    } catch {
      threw = true;
    }
    await tick();
    const afterThrow = n;
    const hostSeen: EventTarget[] = [];
    document.addEventListener("dusk:sheet-change", (e) => hostSeen.push(e.target as EventTarget));
    const host = document.body.appendChild(document.createElement("div"));
    const root = host.attachShadow({ mode: "open" });
    const inner = root.appendChild(document.createElement("style"));
    (inner.sheet as CSSStyleSheet).insertRule("a{color:red}");
    root.adoptedStyleSheets = [new CSSStyleSheet()];
    await tick();
    const d = Object.getOwnPropertyDescriptor(Document.prototype, "adoptedStyleSheets");
    return {
      coalesced,
      ownIgnored,
      threw,
      afterThrow,
      host: hostSeen.length === 1 && hostSeen[0] === host,
      fns: [CSSStyleSheet.prototype.insertRule, CSSStyleSheet.prototype.replace, Element.prototype.attachShadow, matchMedia, d?.set].map((f) => `${f?.name}/${f?.length}`),
    };
  });
  expect(r).toEqual({
    coalesced: 1,
    ownIgnored: true,
    threw: true,
    afterThrow: 1,
    host: true,
    fns: ["insertRule/1", "replace/1", "attachShadow/1", "matchMedia/1", "set adoptedStyleSheets/1"],
  });
});

test("grouping rules report their sheet; a listener's own change starts a new batch", async ({ page }) => {
  await open(page, false, "light");
  const r = await page.evaluate(async () => {
    const tick = () => new Promise<void>((res) => queueMicrotask(res));
    const style = document.head.appendChild(document.createElement("style"));
    style.textContent = "@media screen { .a { color: red } }";
    const own = document.head.appendChild(document.createElement("style"));
    own.setAttribute("data-dusk", "sheet");
    own.textContent = "@media screen { .a { color: red } }";
    await tick();
    let n = 0;
    let again = true;
    document.addEventListener("dusk:sheet-change", () => {
      n++;
      if (again) {
        again = false;
        (style.sheet as CSSStyleSheet).insertRule(".z{color:red}");
      }
    });
    const media = (style.sheet as CSSStyleSheet).cssRules[0] as CSSMediaRule;
    media.insertRule(".b{color:red}", 1);
    media.deleteRule(0);
    ((own.sheet as CSSStyleSheet).cssRules[0] as CSSMediaRule).insertRule(".b{color:red}");
    for (let i = 0; i < 4; i++) await tick();
    return { n, rules: media.cssRules.length, name: `${CSSGroupingRule.prototype.insertRule.name}/${CSSGroupingRule.prototype.deleteRule.length}` };
  });
  // One batch for the two grouping-rule calls (the Duskling-owned one is ignored), then one for the listener's insertRule.
  expect(r).toEqual({ n: 2, rules: 1, name: "insertRule/1" });
});

test("replace() resolves to the sheet, and a rejection the page ignores still reaches unhandledrejection", async ({ page }) => {
  await open(page, false, "light");
  const r = await page.evaluate(async () => {
    const reasons: string[] = [];
    window.addEventListener("unhandledrejection", (e) => (reasons.push(String((e.reason as DOMException).name)), e.preventDefault()));
    const sheet = new CSSStyleSheet();
    const same = (await sheet.replace("a{color:red}")) === sheet;
    const style = document.head.appendChild(document.createElement("style"));
    void (style.sheet as CSSStyleSheet).replace("a{color:red}"); // non-constructed sheet: rejects with NotAllowedError
    for (let i = 0; i < 20 && reasons.length === 0; i++) await new Promise((res) => setTimeout(res, 10));
    return { same, reasons };
  });
  expect(r).toEqual({ same: true, reasons: ["NotAllowedError"] });
});

test("wrappers stop watching native lists when their last listener is removed; methods are writable like native", async ({ page }) => {
  await open(page, true, "light");
  const r = await page.evaluate(() => {
    const P = MediaQueryList.prototype;
    const add = P.addEventListener, remove = P.removeEventListener;
    let adds = 0, removes = 0;
    P.addEventListener = function (this: MediaQueryList, ...a: Parameters<typeof add>) { adds++; return add.apply(this, a); };
    P.removeEventListener = function (this: MediaQueryList, ...a: Parameters<typeof remove>) { removes++; return remove.apply(this, a); };
    const toggle = (v: "on" | "off") => document.dispatchEvent(new CustomEvent("dusk:native-promotion", { detail: v }));
    const m = matchMedia("(prefers-color-scheme: dark)");
    const d = Object.getOwnPropertyDescriptor(m, "addEventListener");
    const desc = { writable: d?.writable, configurable: d?.configurable, name: m.addEventListener.name, len: m.addEventListener.length };
    const seen: string[] = [];
    const f = (e: Event) => seen.push(`f:${(e as MediaQueryListEvent).matches}`);
    m.addEventListener("change", f);
    m.addEventListener("change", f, true); // a second registration (capture) of the same function
    const watched = [adds, removes];
    m.removeEventListener("change", f);
    toggle("off"); // still registered with capture
    const afterOne = [adds, removes, seen.length];
    m.removeEventListener("change", f, { capture: true });
    const afterAll = [adds, removes];
    toggle("on");
    m.onchange = (e) => seen.push(`on:${e.matches}`);
    toggle("off");
    m.onchange = null;
    const afterHandler = [adds, removes];
    toggle("on");
    P.addEventListener = add;
    P.removeEventListener = remove;
    return { desc, watched, afterOne, afterAll, afterHandler, seen };
  });
  expect(r.desc).toEqual({ writable: true, configurable: true, name: "addEventListener", len: 2 });
  expect(r.watched).toEqual([3, 0]);
  expect(r.afterOne).toEqual([3, 0, 1]); // the capture registration alone keeps it watched
  expect(r.afterAll).toEqual([3, 3]);
  expect(r.afterHandler).toEqual([6, 6]);
  expect(r.seen).toEqual(["f:false", "on:false"]);
});

test("closed shadow roots get the contrast-repair pass while it is on, restored exactly when it is off", async ({ page }) => {
  await open(page, false, "light");
  const r = await page.evaluate(async () => {
    const wait = (ms: number) => new Promise((res) => setTimeout(res, ms));
    document.documentElement.style.setProperty("--dusk-neutral-bg", "rgb(20, 20, 20)");
    document.documentElement.style.setProperty("--dusk-neutral-text", "rgb(230, 230, 230)");
    const repair = (v: "on" | "off") => document.dispatchEvent(new CustomEvent("dusk:closed-repair", { detail: v }));
    const host = document.createElement("div");
    document.body.append(host);
    const root = host.attachShadow({ mode: "closed" });
    root.innerHTML = `<div id="card" style="padding:4px" class="c"><p id="t">dark text</p><span id="mid" style="background:#808080;color:#111">mid</span>
      <img id="img" style="background:#fff" alt=""></div><style>.c{background:#fff;color:#222}</style>`;
    const $ = (id: string) => root.getElementById(id) as HTMLElement;
    const read = () => ({
      card: getComputedStyle($("card")).backgroundColor,
      text: getComputedStyle($("t")).color,
      mid: getComputedStyle($("mid")).backgroundColor,
      midText: getComputedStyle($("mid")).color,
      img: getComputedStyle($("img")).backgroundColor,
      cardStyle: $("card").getAttribute("style"),
      tStyle: $("t").getAttribute("style"),
    });
    const before = read();
    repair("on");
    await wait(250);
    const on = read();
    // Content added later is repaired too.
    const late = document.createElement("div");
    late.style.background = "white";
    late.textContent = "late";
    root.append(late);
    await wait(250);
    const lateBg = getComputedStyle(late).backgroundColor;
    repair("off");
    const off = read();
    return { before, on, lateBg, off, lateStyle: late.getAttribute("style") };
  });
  expect(r.on.card).toBe("rgb(20, 20, 20)");
  expect(r.on.text).toBe("rgb(230, 230, 230)");
  expect(r.on.mid).toBe("rgb(128, 128, 128)"); // a mid-tone surface is no light surface
  expect(r.on.midText).toBe("rgb(17, 17, 17)"); // and dark text on it keeps its contrast
  expect(r.on.img).toBe("rgb(255, 255, 255)"); // media are never repaired
  expect(r.lateBg).toBe("rgb(20, 20, 20)");
  expect(r.off).toEqual(r.before);
  expect(r.lateStyle).toBe("background: white;");
});

test("closed-root repair reads at most 300 elements per pass, near the viewport, and catches up on scroll", async ({ page }) => {
  await open(page, false, "light");
  const r = await page.evaluate(async () => {
    const wait = (ms: number) => new Promise((res) => setTimeout(res, ms));
    document.documentElement.style.setProperty("--dusk-neutral-bg", "rgb(20, 20, 20)");
    const repair = (v: "on" | "off") => document.dispatchEvent(new CustomEvent("dusk:closed-repair", { detail: v }));
    const host = document.createElement("div");
    document.body.append(host);
    const root = host.attachShadow({ mode: "closed" });
    root.innerHTML =
      '<style>.s{background:#fff;height:1px}.far{background:#fff;height:50px;margin-top:20000px}</style>' +
      Array.from({ length: 400 }, () => '<div class="s"></div>').join("") +
      '<div class="far" id="far"></div>';
    const repaired = () => [...root.querySelectorAll(".s")].filter((e) => getComputedStyle(e).backgroundColor === "rgb(20, 20, 20)").length;
    const farBg = () => getComputedStyle(root.getElementById("far")!).backgroundColor;
    repair("on");
    await wait(100);
    const first = repaired();
    const farBefore = farBg();
    root.getElementById("far")!.scrollIntoView();
    await wait(250);
    const farAfter = farBg();
    repair("off");
    return { first, farBefore, farAfter };
  });
  expect(r.first).toBe(300);
  expect(r.farBefore).toBe("rgb(255, 255, 255)");
  expect(r.farAfter).toBe("rgb(20, 20, 20)");
});

test("closed-root repair off keeps style changes the page made while it was on", async ({ page }) => {
  await open(page, false, "light");
  const r = await page.evaluate(async () => {
    const wait = (ms: number) => new Promise((res) => setTimeout(res, ms));
    document.documentElement.style.setProperty("--dusk-neutral-bg", "rgb(20, 20, 20)");
    const repair = (v: "on" | "off") => document.dispatchEvent(new CustomEvent("dusk:closed-repair", { detail: v }));
    const host = document.createElement("div");
    document.body.append(host);
    const root = host.attachShadow({ mode: "closed" });
    root.innerHTML = `<div id="card" style="padding:4px;background-color:#fafafa">card</div>`;
    const card = root.getElementById("card") as HTMLElement;
    repair("on");
    await wait(250);
    const on = getComputedStyle(card).backgroundColor;
    card.style.borderTopWidth = "3px"; // the page's own change while repair is on
    await wait(250);
    repair("off");
    return { on, bg: getComputedStyle(card).backgroundColor, border: card.style.borderTopWidth, padding: card.style.padding };
  });
  expect(r.on).toBe("rgb(20, 20, 20)");
  expect(r).toEqual({ on: "rgb(20, 20, 20)", bg: "rgb(250, 250, 250)", border: "3px", padding: "4px" });
});
