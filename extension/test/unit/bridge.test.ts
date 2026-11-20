// Page-context bridge, CSSOM and shadow-root parts that happy-dom models faithfully. In happy-dom 20.14.5 a
// <style>'s sheet has no ownerNode and deleteRule out of range doesn't throw, so `data-dusk` owners, shadow-host
// targets and native errors are covered in test/unit-webkit/bridge.spec.ts, together with matchMedia promotion.
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { installBridge } from "../../src/bridge/index";

const tick = () => new Promise<void>((r) => queueMicrotask(r));

function count(target: EventTarget, type: string): { n: number; targets: EventTarget[] } {
  const c = { n: 0, targets: [] as EventTarget[] };
  target.addEventListener(type, (e) => {
    c.n++;
    c.targets.push(e.target as EventTarget);
  });
  return c;
}

beforeAll(() => {
  installBridge(window, false);
});

beforeEach(async () => {
  document.head.replaceChildren();
  document.body.replaceChildren();
  document.adoptedStyleSheets = [];
  await tick(); // let events from the reset fire before the test counts
});

describe("bridge: CSSOM change events", () => {
  it("dispatches exactly one dusk:sheet-change per microtask for 10 insertRule calls", async () => {
    const style = document.createElement("style");
    document.head.append(style);
    const sheet = style.sheet as CSSStyleSheet;
    const c = count(document, "dusk:sheet-change");
    for (let i = 0; i < 10; i++) sheet.insertRule(`.r${i}{color:red}`, 0);
    expect(c.n).toBe(0);
    await tick();
    expect(c.n).toBe(1);
    expect(sheet.cssRules.length).toBe(10);
    sheet.deleteRule(0);
    await tick();
    expect(c.n).toBe(2);
  });

  it("dispatches for replaceSync, replace (after it settles) and adoptedStyleSheets", async () => {
    const sheet = new CSSStyleSheet();
    const c = count(document, "dusk:sheet-change");
    sheet.replaceSync("a{color:red}");
    await tick();
    expect(c.n).toBe(1);
    await sheet.replace("b{color:blue}");
    await tick();
    expect(c.n).toBe(2);
    document.adoptedStyleSheets = [sheet];
    await tick();
    expect(c.n).toBe(3);
    expect(document.adoptedStyleSheets).toEqual([sheet]);
  });

  it("ignores CSSOM calls on constructed sheets carrying Symbol.for(\"dusk.own\")", async () => {
    const constructed = new CSSStyleSheet() as CSSStyleSheet & Record<symbol, unknown>;
    constructed[Symbol.for("dusk.own")] = true;
    const c = count(document, "dusk:sheet-change");
    constructed.replaceSync("a{color:red}");
    constructed.insertRule("b{color:red}");
    document.adoptedStyleSheets = [constructed];
    document.adoptedStyleSheets = [];
    await tick();
    expect(c.n).toBe(0);
    expect(constructed.cssRules.length).toBe(2);
  });

  it("keeps name and length of patched functions", () => {
    const p = CSSStyleSheet.prototype;
    expect([p.insertRule.name, p.deleteRule.name, p.replace.name, p.replaceSync.name]).toEqual(["insertRule", "deleteRule", "replace", "replaceSync"]);
    expect(Element.prototype.attachShadow.name).toBe("attachShadow");
  });
});

describe("bridge: install guard", () => {
  it("a second install is a no-op (Symbol.for(\"dusk.bridge\") on window)", async () => {
    const before = CSSStyleSheet.prototype.insertRule;
    installBridge(window, true);
    expect(CSSStyleSheet.prototype.insertRule).toBe(before);
    expect((window as unknown as Record<symbol, unknown>)[Symbol.for("dusk.bridge")]).toBe(true);
    const c = count(document, "dusk:sheet-change");
    new CSSStyleSheet().insertRule("a{color:red}");
    await tick();
    expect(c.n).toBe(1);
  });
});

describe("bridge: shadow root discovery", () => {
  it("dispatches dusk:shadow-attached on the host (bubbles, composed) for open roots only", () => {
    const seen: Event[] = [];
    document.addEventListener("dusk:shadow-attached", (e) => seen.push(e));
    const open = document.createElement("div");
    const closed = document.createElement("div");
    document.body.append(open, closed);
    const root = open.attachShadow({ mode: "open" });
    closed.attachShadow({ mode: "closed" });
    expect(root).toBe(open.shadowRoot);
    expect(seen.length).toBe(1);
    expect(seen[0]?.target).toBe(open);
    expect(seen[0]?.bubbles && seen[0]?.composed).toBe(true);
  });
});
