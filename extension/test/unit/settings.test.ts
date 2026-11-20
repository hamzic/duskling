import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, SETTINGS_KEY, canonicalJson, parseSettings } from "../../src/shared/settings";
import { loadShared } from "./shared-fixtures";

describe("settings", () => {
  it("default.json equals DEFAULT_SETTINGS", () => {
    expect(loadShared("settings/default.json")).toEqual(DEFAULT_SETTINGS);
  });

  it("parseSettings(full.json) round-trips", () => {
    const full = loadShared("settings/full.json");
    expect(parseSettings(full)).toEqual(full);
  });

  it("parseSettings(invalid-theme.json) replaces global.theme with default and keeps other fields", () => {
    const parsed = parseSettings(loadShared("settings/invalid-theme.json"));
    expect(parsed.global.theme).toEqual(DEFAULT_SETTINGS.global.theme);
    expect(parsed.global.enabled).toEqual(DEFAULT_SETTINGS.global.enabled);
  });

  it("keeps other valid fields when one differs from default", () => {
    const input = {
      ...DEFAULT_SETTINGS,
      global: { ...DEFAULT_SETTINGS.global, theme: { value: "neon", updatedAt: 5 }, dimImages: { value: true, updatedAt: 7 } },
    };
    const parsed = parseSettings(input);
    expect(parsed.global.theme).toEqual({ value: "dark", updatedAt: 0 });
    expect(parsed.global.dimImages).toEqual({ value: true, updatedAt: 7 });
  });

  it("parseSettings(null) returns DEFAULT_SETTINGS", () => {
    expect(parseSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings("x")).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings([])).toEqual(DEFAULT_SETTINGS);
  });

  it('drops site rule with unknown mode "bogus"', () => {
    const input = {
      ...DEFAULT_SETTINGS,
      sites: { "a.com": { mode: "bogus", updatedAt: 1 }, "b.com": { mode: "full", updatedAt: 2 } },
    };
    const parsed = parseSettings(input);
    expect(Object.keys(parsed.sites)).toEqual(["b.com"]);
  });

  it("drops site rule with missing updatedAt or non-object value", () => {
    const parsed = parseSettings({ ...DEFAULT_SETTINGS, sites: { "a.com": { mode: "full" }, "b.com": 3 } });
    expect(parsed.sites).toEqual({});
  });

  it("drops a site rule whose dimImages isn't a boolean", () => {
    const s = parseSettings({ sites: { "a.com": { dimImages: "yes", updatedAt: 1 }, "b.com": { dimImages: false, updatedAt: 1 } } });
    expect(s.sites).toEqual({ "b.com": { dimImages: false, updatedAt: 1 } });
  });
  it('keeps nativeDark "ignore" and "use" and drops any other value', () => {
    const s = parseSettings({ sites: { "a.com": { nativeDark: "use", updatedAt: 1 }, "b.com": { nativeDark: "ignore", updatedAt: 1 }, "c.com": { nativeDark: "x", updatedAt: 1 } } });
    expect(s.sites).toEqual({ "a.com": { nativeDark: "use", updatedAt: 1 }, "b.com": { nativeDark: "ignore", updatedAt: 1 } });
  });

  it("keeps tombstoned rule {deleted:true}", () => {
    const parsed = parseSettings({ ...DEFAULT_SETTINGS, sites: { "a.com": { updatedAt: 9, deleted: true } } });
    expect(parsed.sites["a.com"]).toEqual({ updatedAt: 9, deleted: true });
  });

  it("ignores unknown keys", () => {
    const parsed = parseSettings({ ...DEFAULT_SETTINGS, extra: 1, sites: { "a.com": { mode: "off", updatedAt: 1, junk: true } } });
    expect(parsed).toEqual({ ...DEFAULT_SETTINGS, sites: { "a.com": { mode: "off", updatedAt: 1 } } });
  });

  it("canonicalJson sorts keys recursively without whitespace", () => {
    expect(canonicalJson({ b: 1, a: { d: 1, c: 2 } })).toBe('{"a":{"c":2,"d":1},"b":1}');
    expect(canonicalJson([{ b: 1, a: 2 }])).toBe('[{"a":2,"b":1}]');
  });

  it("exports SETTINGS_KEY", () => {
    expect(SETTINGS_KEY).toBe("settings");
  });
});

describe("merge-cases.json (asserted by Swift SettingsKit.merge; shape-checked here)", () => {
  const cases = loadShared("settings/merge-cases.json") as { name: string; a: unknown; b: unknown; expected: unknown }[];
  it("has at least 10 cases including ties", () => {
    expect(cases.length).toBeGreaterThanOrEqual(10);
    expect(cases.filter((c) => c.name.includes("tie")).length).toBeGreaterThanOrEqual(3);
  });
  for (const c of cases) {
    it(`parses: ${c.name}`, () => {
      for (const side of [c.a, c.b, c.expected]) expect(parseSettings(side)).toEqual(side);
    });
  }
});
