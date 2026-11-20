// Does happy-dom support the CSSOM features the engine unit tests rely on?
// Each capability is its own test so the suite shows which ones pass. The test results are the record.
import { describe, expect, it } from "vitest";

describe("happy-dom capabilities", () => {
  it("CSSStyleSheet constructor + replaceSync", () => {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync("a { color: red } b { color: blue }");
    expect(sheet.cssRules.length).toBe(2);
  });

  it("cssRules include CSSMediaRule", () => {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync("@media screen { a { color: red } }");
    const rule = sheet.cssRules[0] as CSSMediaRule;
    expect(rule).toBeInstanceOf(CSSMediaRule);
    expect(rule.cssRules.length).toBe(1);
  });

  it("cssRules include CSSSupportsRule", () => {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync("@supports (display: grid) { a { color: red } }");
    const rule = sheet.cssRules[0] as CSSSupportsRule;
    expect(rule).toBeInstanceOf(CSSSupportsRule);
    expect(rule.cssRules.length).toBe(1);
  });

  // FAILS in happy-dom 20.14.5: @layer rules are dropped by the parser (cssRules.length === 0) and
  // CSSLayerBlockRule is not a global. `it.fails` keeps the suite green while recording the gap.
  it.fails("cssRules include CSSLayerBlockRule", () => {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync("@layer base { a { color: red } }");
    const rule = sheet.cssRules[0] as CSSLayerBlockRule;
    expect(rule).toBeInstanceOf(CSSLayerBlockRule);
    expect(rule.cssRules.length).toBe(1);
  });

  // FAILS in happy-dom 20.14.5: the parent rule parses but its declarations are lost (`.a { }`) and no nested rule is exposed.
  it.fails("nested style rules (CSS nesting)", () => {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(".a { color: red; .b { color: blue } }");
    const rule = sheet.cssRules[0] as CSSStyleRule & { cssRules: CSSRuleList };
    expect(rule.cssRules?.length).toBe(1);
    expect((rule.cssRules[0] as CSSStyleRule).selectorText).toContain(".b");
  });

  it("document.adoptedStyleSheets", () => {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync("a { color: red }");
    document.adoptedStyleSheets = [sheet];
    expect(document.adoptedStyleSheets.length).toBe(1);
    expect(document.adoptedStyleSheets[0]).toBe(sheet);
  });

  it("attachShadow with adoptedStyleSheets", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const shadow = host.attachShadow({ mode: "open" });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync("a { color: red }");
    shadow.adoptedStyleSheets = [sheet];
    expect(shadow.adoptedStyleSheets.length).toBe(1);
    expect(shadow.adoptedStyleSheets[0]).toBe(sheet);
  });

  it("MutationObserver on <style> text", async () => {
    const style = document.createElement("style");
    style.textContent = "a { color: red }";
    document.head.append(style);
    const records: MutationRecord[] = [];
    const observer = new MutationObserver((r) => records.push(...r));
    observer.observe(style, { childList: true, characterData: true, subtree: true });
    style.textContent = "a { color: blue }";
    await new Promise((resolve) => setTimeout(resolve, 0));
    observer.disconnect();
    expect(records.length).toBeGreaterThan(0);
  });
});
