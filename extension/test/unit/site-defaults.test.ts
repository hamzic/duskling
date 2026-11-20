import { describe, expect, it } from "vitest";
import defaults from "../../src/shared/site-defaults.json";
import issues from "../../src/shared/site-defaults.issues.json";
import { effectiveMode, siteDefaultFor } from "../../src/shared/site-defaults";
import { validateSiteDefaults } from "./site-defaults-policy";
import type { EffectiveRule } from "../../src/shared/types";

const rule = (over: Partial<EffectiveRule> = {}): EffectiveRule => ({
  enabled: true, mode: "full", modeIsExplicit: false, theme: "dark", respectNativeDark: true, trustNativeDark: false, dimImages: false, matchedHost: null, ...over,
});

describe("siteDefaultFor", () => {
  it("matches the most specific entry along the host chain", () => {
    const table = { "example.com": { mode: "gentle" }, "a.example.com": { mode: "filter" } } as const;
    expect(siteDefaultFor("b.example.com", table)).toEqual({ mode: "gentle" });
    expect(siteDefaultFor("a.example.com", table)).toEqual({ mode: "filter" });
    expect(siteDefaultFor("x.a.example.com", table)).toEqual({ mode: "filter" });
  });
  it("normalizes the host (www., case)", () => {
    expect(siteDefaultFor("WWW.Example.com", { "example.com": { noNativePromotion: true } })).toEqual({ noNativePromotion: true });
  });
  it("returns {} for no match, null host, or the shipped empty file", () => {
    expect(siteDefaultFor("other.org", { "example.com": { mode: "gentle" } })).toEqual({});
    expect(siteDefaultFor(null, { "example.com": { mode: "gentle" } })).toEqual({});
    expect(siteDefaultFor("example.com")).toEqual({});
    expect(defaults).toEqual({});
  });
});

describe("effectiveMode", () => {
  it("uses the site default when the rule has no explicit mode", () => {
    expect(effectiveMode(rule(), { mode: "filter" })).toBe("filter");
  });
  it("keeps an explicit user mode over the site default", () => {
    expect(effectiveMode(rule({ mode: "full", modeIsExplicit: true }), { mode: "filter" })).toBe("full");
  });
  it("falls back to the rule mode when the default has none", () => {
    expect(effectiveMode(rule({ mode: "gentle" }), {})).toBe("gentle");
  });
});

describe("site-defaults.json policy", () => {
  it("shipped file and issue map satisfy the policy", () => {
    expect(validateSiteDefaults(defaults, issues)).toEqual([]);
  });
  it("rejects extra keys, bad values and missing or orphan issue links", () => {
    const bad = { "a.com": { mode: "gentle", css: "x" }, "b.com": { mode: "full" }, "c.com": { noNativePromotion: true } };
    const links = { "a.com": "https://github.com/o/r/issues/1", "orphan.com": "https://github.com/o/r/issues/2" };
    expect(validateSiteDefaults(bad, links)).toEqual([
      "a.com: unknown key css", "b.com: invalid mode", "b.com: missing issue link", "c.com: missing issue link", "orphan.com: issue link without entry",
    ]);
  });
});
