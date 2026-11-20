import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs dev script without type declarations
import { analyze, classifyRule, hostFromPattern, parseCssRules } from "../../scripts/analyze-darkreader-fixes.mjs";

describe("parseCssRules", () => {
  it("keeps ${…} placeholders inside declarations", () => {
    const rules = parseCssRules(["a { color: ${white}; background-image: none }"]);
    expect(rules).toEqual([{ selector: "a", decls: [{ prop: "color", value: "${white}" }, { prop: "background-image", value: "none" }] }]);
    expect(classifyRule(rules[0])).toBe("texture");
  });
  it("parses two rules without leaking leftovers into the next selector", () => {
    const rules = parseCssRules([".x,", ".y {", "    background-color: ${rgb(1, 2, 3)} !important;", "}", ".z { border: 1px solid ${#fff}; fill: url(data:image/svg+xml;base64,AA==) }"]);
    expect(rules.map((r: { selector: string }) => r.selector)).toEqual([".x,\n.y", ".z"]);
    expect(rules[0].decls).toEqual([{ prop: "background-color", value: "${rgb(1, 2, 3)}" }]);
    expect(rules[1].decls).toEqual([{ prop: "border", value: "1px solid ${#fff}" }, { prop: "fill", value: "url(data:image/svg+xml;base64,AA==)" }]);
  });
});

describe("hostFromPattern", () => {
  it("reduces patterns to hostnames and skips wildcards", () => {
    expect(hostFromPattern("www.example.com/path")).toBe("example.com");
    expect(hostFromPattern("google.*")).toBeNull();
    expect(hostFromPattern("*.example.com")).toBeNull();
    expect(hostFromPattern("example.com/*")).toBeNull();
    expect(hostFromPattern("*")).toBeNull();
  });
});

describe("analyze", () => {
  it("buckets a small corpus and ranks hosts by fix lines", () => {
    const fixes = ["a.com", "", "INVERT", ".l", ".m", "", "CSS", "p { color: ${white}; }", "q { mix-blend-mode: multiply; }", "", "================================", "", "*", "", "CSS", "r { z-index: 1; }"].join("\n");
    const a = analyze(fixes, "x.com\n\nNO DARK THEME\n", "d.com\n");
    expect(a.entries).toMatchObject({ invert: 2, cssColor: 1, blend: 1, cssOther: 1, detectorNoDark: 1, darkSite: 1 });
    expect(a.topHosts[0][0]).toBe("a.com");
  });
});
