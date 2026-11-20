import { describe, expect, it } from "vitest";
import { hostPatterns, matchesPattern, planRegistrations, type PlannedScript } from "../../src/background/registrations";
import { normalizeHost, resolveSiteRule } from "../../src/shared/rules";
import { DEFAULT_SETTINGS } from "../../src/shared/settings";
import { effectiveMode, siteDefaultFor, type SiteDefault } from "../../src/shared/site-defaults";
import type { Mode, Settings, SiteRule, ThemeId } from "../../src/shared/types";

const FAMILIES = ["bridge", "prepaint", "engine"] as const;
type Family = (typeof FAMILIES)[number];

const withSites = (sites: Record<string, Omit<SiteRule, "updatedAt"> & { updatedAt?: number }>, base: Settings = DEFAULT_SETTINGS): Settings => ({
  ...base,
  sites: Object.fromEntries(Object.entries(sites).map(([h, r]) => [h, { updatedAt: 1, ...r }])),
});

const familyOf = (s: PlannedScript): Family => s.id.split("-")[0] as Family;
/** Excludes win over matches. */
const selects = (s: PlannedScript, url: string) => s.matches.some((p) => matchesPattern(p, url)) && !s.excludeMatches.some((p) => matchesPattern(p, url));
const selected = (plan: PlannedScript[], url: string, f: Family) => plan.filter((s) => familyOf(s) === f && selects(s, url));
const byId = (plan: PlannedScript[]) => Object.fromEntries(plan.map((s) => [s.id, s]));

/** Expected class per family, computed directly from the shared resolvers (independent of the planner). */
function expected(s: Settings, host: string | null, table: Record<string, SiteDefault>): Record<Family, string | null> {
  const r = resolveSiteRule(s, host);
  const d = siteDefaultFor(host, table);
  const m = effectiveMode(r, d);
  if (m === "off") return { bridge: null, prepaint: null, engine: null };
  return {
    bridge: m === "full" && r.respectNativeDark && !d.noNativePromotion ? "promote" : "plain",
    prepaint: m === "filter" ? null : r.theme,
    engine: `${m}-${r.theme}${r.dimImages ? "-dim" : ""}${!r.respectNativeDark && m !== "filter" ? "-ignore" : ""}`,
  };
}
/** Class from a script id: <family>-<class>-<level>. */
const classOf = (s: PlannedScript) => s.id.slice(s.id.indexOf("-") + 1, s.id.lastIndexOf("-"));

describe("matchesPattern (MDN match patterns)", () => {
  it("<all_urls> matches the supported schemes only", () => {
    expect(matchesPattern("<all_urls>", "https://example.com/a?b#c")).toBe(true);
    expect(matchesPattern("<all_urls>", "file:///tmp/x.html")).toBe(true);
    expect(matchesPattern("<all_urls>", "about:blank")).toBe(false);
  });
  it("*://host/* matches only that host, http(s), any path", () => {
    expect(matchesPattern("*://example.com/*", "http://example.com/")).toBe(true);
    expect(matchesPattern("*://example.com/*", "https://EXAMPLE.com/a/b?q")).toBe(true);
    expect(matchesPattern("*://example.com/*", "https://a.example.com/")).toBe(false);
    expect(matchesPattern("*://example.com/*", "https://notexample.com/")).toBe(false);
    expect(matchesPattern("*://example.com/*", "ftp://example.com/")).toBe(false);
  });
  it("*://*.host/* matches the host itself and every subdomain", () => {
    expect(matchesPattern("*://*.example.com/*", "https://example.com/")).toBe(true);
    expect(matchesPattern("*://*.example.com/*", "https://a.b.example.com/x")).toBe(true);
    expect(matchesPattern("*://*.example.com/*", "https://badexample.com/")).toBe(false);
  });
  it("IP hosts match exactly", () => {
    expect(matchesPattern("*://127.0.0.1/*", "http://127.0.0.1:8000/p")).toBe(true);
    expect(matchesPattern("*://127.0.0.1/*", "http://127.0.0.10/")).toBe(false);
  });
});

describe("hostPatterns", () => {
  it("covers the host and its subdomains", () => {
    expect(hostPatterns("example.com")).toEqual(["*://example.com/*", "*://*.example.com/*"]);
  });
  it("IPv4 has no subdomains", () => {
    expect(hostPatterns("10.0.0.1")).toEqual(["*://10.0.0.1/*"]);
  });
});

describe("planRegistrations", () => {
  it("disabled → nothing", () => {
    const s = { ...DEFAULT_SETTINGS, global: { ...DEFAULT_SETTINGS.global, enabled: { value: false, updatedAt: 1 } } };
    expect(planRegistrations(s)).toEqual([]);
  });

  it("defaults → bridge-promote-0, prepaint-dark-0, engine-full-dark-0, all <all_urls>, in family order", () => {
    const plan = planRegistrations(DEFAULT_SETTINGS);
    expect(plan.map((s) => s.id)).toEqual(["bridge-promote-0", "prepaint-dark-0", "engine-full-dark-0"]);
    for (const s of plan) {
      expect(s.matches).toEqual(["<all_urls>"]);
      expect(s.excludeMatches).toEqual([]);
      expect(s).toMatchObject({ runAt: "document_start", allFrames: true, persistAcrossSessions: true });
    }
    // Type-level: a plan is directly passable to browser.scripting.registerContentScripts.
    const asRegistered: DuskBrowser.RegisteredContentScript[] = plan;
    expect(asRegistered).toBe(plan);
    const ids = byId(plan);
    expect(ids["bridge-promote-0"]).toMatchObject({ js: ["bridge-promote.js"], world: "MAIN" });
    expect(ids["prepaint-dark-0"]).toMatchObject({ css: ["prepaint/dark.css"], js: ["prepaint/dark.js"] });
    expect(ids["engine-full-dark-0"]).toMatchObject({ js: ["boot/full-dark.js", "content.js"] });
    expect(ids["engine-full-dark-0"]?.world).toBeUndefined();
  });

  it("example.com off → excluded from all three", () => {
    const plan = planRegistrations(withSites({ "example.com": { mode: "off" } }));
    expect(plan.map((s) => s.id)).toEqual(["bridge-promote-0", "prepaint-dark-0", "engine-full-dark-0"]);
    for (const s of plan) expect(s.excludeMatches).toEqual(hostPatterns("example.com"));
    for (const f of FAMILIES) {
      expect(selected(plan, "https://example.com/", f)).toEqual([]);
      expect(selected(plan, "https://www.example.com/", f)).toEqual([]);
      expect(selected(plan, "https://other.org/", f)).toHaveLength(1);
    }
  });

  it("example.com off + app.example.com midnight → level-2 scripts for app.example.com", () => {
    const plan = planRegistrations(withSites({ "example.com": { mode: "off" }, "app.example.com": { theme: "midnight" } }));
    const ids = byId(plan);
    // app.example.com has no explicit mode, so it inherits off from example.com: everything stays off there.
    expect(selected(plan, "https://app.example.com/", "prepaint")).toEqual([]);
    const plan2 = planRegistrations(withSites({ "example.com": { mode: "off" }, "app.example.com": { mode: "full", theme: "midnight" } }));
    const ids2 = byId(plan2);
    // Level = number of switch points strictly above: root and example.com, so 2.
    expect(ids2["prepaint-midnight-2"]?.matches).toEqual(hostPatterns("app.example.com"));
    expect(ids2["prepaint-midnight-2"]?.excludeMatches).toEqual([]);
    expect(selected(plan2, "https://app.example.com/x", "prepaint").map((s) => s.id)).toEqual(["prepaint-midnight-2"]);
    expect(selected(plan2, "https://example.com/", "prepaint")).toEqual([]);
    expect(selected(plan2, "https://other.org/", "prepaint").map((s) => s.id)).toEqual(["prepaint-dark-0"]);
    expect(ids2["engine-full-midnight-2"]?.js).toEqual(["boot/full-midnight.js", "content.js"]);
    expect(selected(plan2, "https://deep.app.example.com/", "engine").map((s) => s.id)).toEqual(["engine-full-midnight-2"]);
    expect(Object.keys(ids)).not.toContain("prepaint-midnight-2");
  });

  it("orders deeper switch points before shallower ones within a family, families bridge → prepaint → engine", () => {
    const plan = planRegistrations(
      withSites({ "a.com": { mode: "gentle" }, "x.a.com": { mode: "full", theme: "dim" }, "p.x.a.com": { mode: "filter" }, "b.org": { theme: "midnight" } }),
    );
    const fam = plan.map(familyOf);
    expect(fam).toEqual([...fam].sort((x, y) => FAMILIES.indexOf(x) - FAMILIES.indexOf(y)));
    for (const f of FAMILIES) {
      const levels = plan.filter((s) => familyOf(s) === f).map((s) => Number(s.id.slice(s.id.lastIndexOf("-") + 1)));
      expect(levels).toEqual([...levels].sort((x, y) => y - x));
      expect(levels.at(-1)).toBe(0);
    }
    expect(plan.filter((s) => familyOf(s) === "engine").map((s) => s.id)).toEqual([
      "engine-filter-dim-3",
      "engine-full-dim-2",
      "engine-full-midnight-1",
      "engine-gentle-dark-1",
      "engine-full-dark-0",
    ]);
  });

  it("boot class: per-host (mode, theme, dimImages) picks exactly one engine registration with the right boot file", () => {
    const base = { ...DEFAULT_SETTINGS, global: { ...DEFAULT_SETTINGS.global, dimImages: { value: true, updatedAt: 1 } } };
    const s = withSites({ "127.0.0.1": { mode: "gentle", theme: "midnight" }, "dusk.localhost": { mode: "filter" }, "a.dusk.localhost": { theme: "dim" } }, base);
    const plan = planRegistrations(s);
    const engineFor = (url: string) => selected(plan, url, "engine").map((x) => x.js);
    expect(engineFor("http://127.0.0.1:8000/s3.html")).toEqual([["boot/gentle-midnight-dim.js", "content.js"]]);
    expect(engineFor("http://dusk.localhost/")).toEqual([["boot/filter-dark-dim.js", "content.js"]]);
    expect(engineFor("http://a.dusk.localhost/")).toEqual([["boot/filter-dim-dim.js", "content.js"]]);
    expect(engineFor("http://localhost/")).toEqual([["boot/full-dark-dim.js", "content.js"]]);
    // filter mode: no pre-paint, plain bridge.
    expect(selected(plan, "http://dusk.localhost/", "prepaint")).toEqual([]);
    expect(selected(plan, "http://dusk.localhost/", "bridge").map((x) => x.id)).toEqual(["bridge-plain-1"]);
  });

  it("a per-site dimImages override picks that host's dim boot file, either way", () => {
    const s = withSites({ "dim.example": { dimImages: true }, "nodim.example": { dimImages: false } });
    const plan = planRegistrations(s);
    const engineFor = (url: string) => selected(plan, url, "engine").map((x) => x.js);
    expect(engineFor("https://dim.example/")).toEqual([["boot/full-dark-dim.js", "content.js"]]);
    expect(engineFor("https://a.dim.example/")).toEqual([["boot/full-dark-dim.js", "content.js"]]);
    expect(engineFor("https://other.example/")).toEqual([["boot/full-dark.js", "content.js"]]);
    const on = planRegistrations(withSites({ "nodim.example": { dimImages: false } }, { ...DEFAULT_SETTINGS, global: { ...DEFAULT_SETTINGS.global, dimImages: { value: true, updatedAt: 1 } } }));
    expect(selected(on, "https://nodim.example/", "engine").map((x) => x.js)).toEqual([["boot/full-dark.js", "content.js"]]);
  });

  it("site-defaults.json hosts are switch points (gentle default, noNativePromotion)", () => {
    const table: Record<string, SiteDefault> = { "g.com": { mode: "gentle" }, "n.com": { noNativePromotion: true } };
    const plan = planRegistrations(DEFAULT_SETTINGS, table);
    expect(selected(plan, "https://g.com/", "engine").map(classOf)).toEqual(["gentle-dark"]);
    expect(selected(plan, "https://n.com/", "bridge").map(classOf)).toEqual(["plain"]);
    // An explicit user mode beats the host default.
    const plan2 = planRegistrations(withSites({ "g.com": { mode: "full" } }), table);
    expect(selected(plan2, "https://g.com/", "engine").map(classOf)).toEqual(["full-dark"]);
  });

  it("ignores tombstones", () => {
    const plan = planRegistrations(withSites({ "example.com": { deleted: true } }));
    expect(plan.map((s) => s.id)).toEqual(["bridge-promote-0", "prepaint-dark-0", "engine-full-dark-0"]);
    expect(plan.every((s) => s.excludeMatches.length === 0)).toBe(true);
  });
});

// ---- Property test -------------------------------------------------------------------------------------------------

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TOPS = ["a.com", "b.org", "c.net"];
const MIDS = ["x", "y", "z"];
const LEAVES = ["p", "q"];
const TREE = TOPS.flatMap((t) => [t, ...MIDS.flatMap((m) => [`${m}.${t}`, ...LEAVES.map((l) => `${l}.${m}.${t}`)])]);
const THEMES: ThemeId[] = ["dark", "midnight", "dim"];
const MODES: Mode[] = ["full", "gentle", "filter", "off"];

describe("planRegistrations property test", () => {
  it("500 seeded cases × 50 URLs: each family selects exactly the expected class (or nothing when null)", () => {
    const rnd = mulberry32(20261017);
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T;
    let checked = 0;
    for (let c = 0; c < 500; c++) {
      const sites: Record<string, SiteRule> = {};
      const n = Math.floor(rnd() * 13);
      for (let i = 0; i < n; i++) {
        const r: SiteRule = { updatedAt: 1 };
        if (rnd() < 0.6) r.mode = pick(MODES);
        if (rnd() < 0.5) r.theme = pick(THEMES);
        if (rnd() < 0.2) r.nativeDark = "ignore";
        if (r.mode === undefined && r.theme === undefined && r.nativeDark === undefined) r.deleted = true;
        if (rnd() < 0.1) r.deleted = true;
        sites[pick(TREE)] = r;
      }
      const table: Record<string, SiteDefault> = {};
      if (rnd() < 0.3) table[pick(TREE)] = rnd() < 0.5 ? { mode: pick(["gentle", "filter"] as const) } : { noNativePromotion: true };
      const s: Settings = {
        schemaVersion: 1,
        global: {
          enabled: { value: true, updatedAt: 1 },
          theme: { value: pick(THEMES), updatedAt: 1 },
          respectNativeDark: { value: rnd() < 0.7, updatedAt: 1 },
          dimImages: { value: rnd() < 0.3, updatedAt: 1 },
        },
        sites,
      };
      const plan = planRegistrations(s, table);
      expect(new Set(plan.map((x) => x.id)).size).toBe(plan.length);
      for (let u = 0; u < 50; u++) {
        const r = rnd();
        let host = r < 0.1 ? "unrelated.io" : pick(TREE);
        if (rnd() < 0.15) host = `deep.${host}`;
        if (rnd() < 0.15) host = `www.${host}`;
        const url = `${pick(["http", "https"])}://${host}/${pick(["", "a/b", "x?y=1"])}`;
        const want = expected(s, normalizeHost(new URL(url).hostname), table);
        for (const f of FAMILIES) {
          const got = selected(plan, url, f).map(classOf);
          expect(got, `case ${c} ${url} ${f} ${JSON.stringify(s.sites)} ${JSON.stringify(table)}`).toEqual(want[f] === null ? [] : [want[f]]);
          checked++;
        }
      }
    }
    expect(checked).toBe(500 * 50 * 3);
  });
});
