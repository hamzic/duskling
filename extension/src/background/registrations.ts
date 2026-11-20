// Nested-host content-script registration planner.
//
// Safari registrations have no globs (`include_globs`/`exclude_globs` unsupported) and `excludeMatches`
// wins over `matches` (MDN scripting.RegisteredContentScript). So each family's per-host class is expressed as a tree
// of "switch points" (hosts whose class differs from their nearest rule ancestor): every (class, level) group becomes one
// registration that matches its switch points and excludes their switch-point children one level down.
//
// Field support (@mdn/browser-compat-data 8.1.6, webextensions.api.scripting, safari_ios): registerContentScripts,
// updateContentScripts, getRegisteredContentScripts, unregisterContentScripts and RegisteredContentScript (id, matches,
// excludeMatches, js, css, allFrames, runAt) 16.4; persistAcrossSessions 16.4; world 16.4.
import table from "../shared/site-defaults.json";
import { engineClass } from "../shared/boot";
import { hostChain, normalizeHost, resolveSiteRule } from "../shared/rules";
import { effectiveMode, siteDefaultFor, type SiteDefault } from "../shared/site-defaults";
import type { Settings } from "../shared/types";

export interface PlannedScript {
  id: string;
  matches: string[];
  excludeMatches: string[];
  css?: string[];
  js?: string[];
  runAt: "document_start";
  allFrames: true;
  persistAcrossSessions: true;
  world?: "MAIN" | "ISOLATED";
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const ROOT = "";

/**
 * Patterns for a host and all its subdomains. MDN match patterns: host `*.example.com` matches "the given host and any
 * of its subdomains" (https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Match_patterns, mdn/content
 * 32eceacf42b6). The exact pattern is listed too. IPv4 hosts have no subdomains.
 */
export function hostPatterns(host: string): string[] {
  return IPV4.test(host) ? [`*://${host}/*`] : [`*://${host}/*`, `*://*.${host}/*`];
}

const ALL_URLS_SCHEMES = new Set(["http:", "https:", "ws:", "wss:", "ftp:", "data:", "file:"]);

/**
 * Test helper: MDN match-pattern semantics for the shapes the planner emits (`<all_urls>`, `*://host/*`,
 * `*://*.host/*`). `<all_urls>` covers http, https, ws, wss, ftp, data and file; scheme `*` covers http and https
 * (MDN: "in some browsers also ws and wss", irrelevant for documents). A pattern without a port matches any port
 * (Chrome semantics; MDN marks ports Chrome-only).
 */
export function matchesPattern(pattern: string, url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (pattern === "<all_urls>") return ALL_URLS_SCHEMES.has(u.protocol);
  const m = /^(\*|https?|wss?|ftp|file):\/\/([^/]*)(\/.*)$/.exec(pattern);
  if (!m) throw new Error(`unsupported match pattern: ${pattern}`);
  const [, scheme, host = "", path = ""] = m;
  if (scheme === "*" ? u.protocol !== "http:" && u.protocol !== "https:" : u.protocol !== `${scheme}:`) return false;
  const h = u.hostname.toLowerCase();
  const ph = host.toLowerCase();
  if (ph !== "*") {
    if (ph.startsWith("*.")) {
      const base = ph.slice(2);
      if (h !== base && !h.endsWith(`.${base}`)) return false;
    } else if (h !== ph) return false;
  }
  const glob = new RegExp(`^${path.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
  return glob.test(u.pathname + u.search);
}

type Family = "bridge" | "prepaint" | "engine";
// Registration order: bridge (MAIN world) first, then pre-paint, then the engine. Safari injects overlapping
// registrations in call order (measured in the iOS Simulator).
const FAMILIES: readonly Family[] = ["bridge", "prepaint", "engine"];

function classes(s: Settings, host: string | null, defaults: Record<string, SiteDefault>): Record<Family, string | null> {
  const rule = resolveSiteRule(s, host);
  const d = siteDefaultFor(host, defaults);
  const m = effectiveMode(rule, d);
  if (m === "off") return { bridge: null, prepaint: null, engine: null };
  return {
    bridge: m === "full" && rule.respectNativeDark && !d.noNativePromotion ? "promote" : "plain",
    // Filter mode doesn't use pre-paint; the html filter handles it.
    prepaint: m === "filter" ? null : rule.theme,
    engine: engineClass(m, rule.theme, rule.dimImages, rule.respectNativeDark),
  };
}

function files(f: Family, cls: string): Pick<PlannedScript, "css" | "js" | "world"> {
  if (f === "prepaint") return { css: [`prepaint/${cls}.css`], js: [`prepaint/${cls}.js`] };
  if (f === "engine") return { js: [`boot/${cls}.js`, "content.js"] };
  return { js: [cls === "promote" ? "bridge-promote.js" : "bridge.js"], world: "MAIN" };
}

export function planRegistrations(s: Settings, defaults: Record<string, SiteDefault> = table as Record<string, SiteDefault>): PlannedScript[] {
  if (!s.global.enabled.value) return [];

  // Rule hosts: non-deleted site rules plus site-defaults hosts. Keys that aren't normalized never resolve, so skip them.
  const hosts = new Set<string>();
  for (const [h, r] of Object.entries(s.sites)) if (!r.deleted && normalizeHost(h) === h) hosts.add(h);
  for (const h of Object.keys(defaults)) if (normalizeHost(h) === h) hosts.add(h);
  const parentOf = (h: string): string => hostChain(h).slice(1).find((a) => hosts.has(a)) ?? ROOT;
  // Ancestors before descendants, so a parent's switch-point info exists when its children are visited.
  const ordered = [...hosts].sort((a, b) => hostChain(a).length - hostChain(b).length || (a < b ? -1 : a > b ? 1 : 0));
  const cls = new Map<string, Record<Family, string | null>>([[ROOT, classes(s, null, defaults)]]);
  for (const h of ordered) cls.set(h, classes(s, h, defaults));

  const plan: PlannedScript[] = [];
  for (const f of FAMILIES) {
    // Nearest switch point at or above each node, and each switch point's level.
    const sp = new Map<string, string>([[ROOT, ROOT]]);
    const level = new Map<string, number>([[ROOT, 0]]);
    const points: string[] = [ROOT];
    for (const h of ordered) {
      const p = parentOf(h);
      if (cls.get(h)?.[f] !== cls.get(p)?.[f]) {
        const above = sp.get(p) as string;
        sp.set(h, h);
        level.set(h, (level.get(above) as number) + 1);
        points.push(h);
      } else {
        sp.set(h, sp.get(p) as string);
      }
    }
    const spParent = (h: string) => sp.get(parentOf(h)) as string;
    const groups = new Map<string, { cls: string; level: number; members: string[] }>();
    const groupOf = new Map<string, string>();
    for (const h of points) {
      const c = cls.get(h)?.[f];
      if (c === null || c === undefined) continue;
      const key = `${c}-${level.get(h)}`;
      const g = groups.get(key) ?? { cls: c, level: level.get(h) as number, members: [] };
      g.members.push(h);
      groups.set(key, g);
      groupOf.set(h, key);
    }
    const patterns = (h: string) => (h === ROOT ? ["<all_urls>"] : hostPatterns(h));
    const scripts = [...groups.entries()].map(([key, g]) => {
      const excluded = points.filter((h) => h !== ROOT && level.get(h) === g.level + 1 && groupOf.get(spParent(h)) === key);
      return {
        level: g.level,
        script: {
          id: `${f}-${key}`,
          matches: g.members.flatMap(patterns),
          excludeMatches: excluded.flatMap(patterns),
          ...files(f, g.cls),
          runAt: "document_start",
          allFrames: true,
          persistAcrossSessions: true,
        } satisfies PlannedScript,
      };
    });
    // Specific (deeper) switch points before the level-0 default (Safari runs them in call order, so the first boot wins on overlap).
    scripts.sort((a, b) => b.level - a.level || (a.script.id < b.script.id ? -1 : 1));
    plan.push(...scripts.map((x) => x.script));
  }
  return plan;
}
