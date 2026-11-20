import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../../src/shared/settings";
import {
  MAX_SITES,
  hostChain,
  normalizeHost,
  purgeAndLimit,
  resolveSiteRule,
  setGlobal,
  setSiteFields,
} from "../../src/shared/rules";
import type { EffectiveRule, Settings, SiteRule } from "../../src/shared/types";
import { loadShared } from "./shared-fixtures";

const DAY = 86_400_000;
const withSites = (sites: Record<string, SiteRule>): Settings => ({ ...DEFAULT_SETTINGS, sites });

describe("normalizeHost", () => {
  it("lowercases, strips one www. and a trailing dot", () => {
    expect(normalizeHost("WWW.Example.COM.")).toBe("example.com");
    expect(normalizeHost("www.www.x.com")).toBe("www.x.com");
  });
  it("returns IPs unchanged", () => {
    expect(normalizeHost("192.168.0.1")).toBe("192.168.0.1");
  });
  it("returns null for empty, slash, colon or whitespace", () => {
    for (const bad of ["", "a/b", "a.com:80", "a b.com", " ", "www.", "."]) expect(normalizeHost(bad)).toBeNull();
  });
});

describe("hostChain", () => {
  it("orders most to least specific", () => {
    expect(hostChain("a.b.example.com")).toEqual(["a.b.example.com", "b.example.com", "example.com", "com"]);
  });
  it("does not split IPv4 addresses", () => {
    expect(hostChain("192.168.0.1")).toEqual(["192.168.0.1"]);
  });
});

describe("resolveSiteRule", () => {
  it("subdomain inherits parent rule", () => {
    const r = resolveSiteRule(withSites({ "example.com": { mode: "gentle", updatedAt: 1 } }), "a.example.com");
    expect(r.mode).toBe("gentle");
    expect(r.matchedHost).toBe("example.com");
  });
  it("more specific rule wins", () => {
    const s = withSites({ "example.com": { mode: "gentle", updatedAt: 1 }, "a.example.com": { mode: "filter", updatedAt: 1 } });
    expect(resolveSiteRule(s, "a.example.com").mode).toBe("filter");
  });
  it("tombstone does not match", () => {
    const r = resolveSiteRule(withSites({ "example.com": { updatedAt: 1, deleted: true } }), "example.com");
    expect(r.matchedHost).toBeNull();
    expect(r.modeIsExplicit).toBe(false);
  });
  const cases = loadShared("settings/resolution-cases.json") as {
    name: string; settings: Settings; host: string | null; expected: EffectiveRule;
  }[];
  it("has at least 20 shared resolution cases", () => {
    expect(cases.length).toBeGreaterThanOrEqual(20);
  });
  for (const c of cases) {
    it(`resolution case: ${c.name}`, () => {
      expect(resolveSiteRule(c.settings, c.host)).toEqual(c.expected);
    });
  }
});

describe("setSiteFields", () => {
  it("sets fields immutably and stamps updatedAt", () => {
    const s = setSiteFields(DEFAULT_SETTINGS, "x.com", { mode: "gentle" }, 5);
    expect(s.sites["x.com"]).toEqual({ mode: "gentle", updatedAt: 5 });
    expect(DEFAULT_SETTINGS.sites).toEqual({});
  });
  it("null patch clears field and empty rule becomes tombstone", () => {
    let s = setSiteFields(DEFAULT_SETTINGS, "x.com", { mode: "gentle", theme: "dim" }, 5);
    s = setSiteFields(s, "x.com", { mode: null }, 6);
    expect(s.sites["x.com"]).toEqual({ theme: "dim", updatedAt: 6 });
    s = setSiteFields(s, "x.com", { theme: null }, 7);
    expect(s.sites["x.com"]).toEqual({ updatedAt: 7, deleted: true });
  });
  it("setting a field on a tombstone revives it without stale fields", () => {
    const s0 = withSites({ "x.com": { updatedAt: 1, deleted: true } });
    expect(setSiteFields(s0, "x.com", { nativeDark: "ignore" }, 9).sites["x.com"]).toEqual({ nativeDark: "ignore", updatedAt: 9 });
  });
  it("dimImages false is a value, not a cleared field; null clears it", () => {
    let s = setSiteFields(DEFAULT_SETTINGS, "x.com", { dimImages: false }, 4);
    expect(s.sites["x.com"]).toEqual({ dimImages: false, updatedAt: 4 });
    s = setSiteFields(s, "x.com", { theme: "dim" }, 5);
    expect(s.sites["x.com"]).toEqual({ theme: "dim", dimImages: false, updatedAt: 5 });
    s = setSiteFields(s, "x.com", { dimImages: null }, 6);
    expect(s.sites["x.com"]).toEqual({ theme: "dim", updatedAt: 6 });
  });
  it("clearing a field on a missing rule creates a tombstone", () => {
    expect(setSiteFields(DEFAULT_SETTINGS, "x.com", { mode: null }, 3).sites["x.com"]).toEqual({ updatedAt: 3, deleted: true });
  });
});

describe("setGlobal", () => {
  it("sets value and stamp immutably", () => {
    const s = setGlobal(DEFAULT_SETTINGS, "theme", "dim", 8);
    expect(s.global.theme).toEqual({ value: "dim", updatedAt: 8 });
    expect(DEFAULT_SETTINGS.global.theme.value).toBe("dark");
  });
});

describe("purgeAndLimit", () => {
  it("purge removes 31-day-old tombstone, keeps 29-day-old", () => {
    const now = 100 * DAY;
    const s = withSites({
      "old.com": { updatedAt: now - 31 * DAY, deleted: true },
      "new.com": { updatedAt: now - 29 * DAY, deleted: true },
      "live.com": { mode: "off", updatedAt: now - 90 * DAY },
    });
    expect(Object.keys(purgeAndLimit(s, now).sites).sort()).toEqual(["live.com", "new.com"]);
  });
  it("limit keeps newest 2000", () => {
    const sites: Record<string, SiteRule> = {};
    for (let i = 0; i < 2100; i++) sites[`h${i}.com`] = { mode: "off", updatedAt: 1000 + i };
    const out = purgeAndLimit(withSites(sites), 2000).sites;
    expect(Object.keys(out)).toHaveLength(MAX_SITES);
    expect(out["h99.com"]).toBeUndefined();
    expect(out["h100.com"]).toBeDefined();
    expect(out["h2099.com"]).toBeDefined();
  });
  it("limit drops tombstones before live rules", () => {
    const sites: Record<string, SiteRule> = {};
    for (let i = 0; i < 2000; i++) sites[`h${i}.com`] = { mode: "off", updatedAt: 1000 + i };
    sites["tomb.com"] = { updatedAt: 5000, deleted: true };
    const out = purgeAndLimit(withSites(sites), 6000).sites;
    expect(out["tomb.com"]).toBeUndefined();
    expect(out["h0.com"]).toBeDefined();
  });
});
