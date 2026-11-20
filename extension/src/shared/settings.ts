import type { Mode, Settings, SiteRule, Stamped, ThemeId } from "./types";

export const SETTINGS_KEY = "settings";

export const DEFAULT_SETTINGS: Settings = {
  schemaVersion: 1,
  global: {
    enabled: { value: true, updatedAt: 0 },
    theme: { value: "dark", updatedAt: 0 },
    respectNativeDark: { value: true, updatedAt: 0 },
    dimImages: { value: false, updatedAt: 0 },
  },
  sites: {},
};

const THEMES: readonly string[] = ["dark", "midnight", "dim"];
const MODES: readonly string[] = ["full", "gentle", "filter", "off"];

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function isStamp(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

function stamped<T>(input: unknown, fallback: Stamped<T>, valid: (v: unknown) => v is T): Stamped<T> {
  if (isRecord(input) && valid(input["value"]) && isStamp(input["updatedAt"])) {
    return { value: input["value"], updatedAt: input["updatedAt"] };
  }
  return { ...fallback };
}

const isBool = (v: unknown): v is boolean => typeof v === "boolean";
const isTheme = (v: unknown): v is ThemeId => typeof v === "string" && THEMES.includes(v);
const isMode = (v: unknown): v is Mode => typeof v === "string" && MODES.includes(v);

function parseRule(input: unknown): SiteRule | null {
  if (!isRecord(input) || !isStamp(input["updatedAt"])) return null;
  const rule: SiteRule = { updatedAt: input["updatedAt"] };
  if (input["mode"] !== undefined) {
    if (!isMode(input["mode"])) return null;
    rule.mode = input["mode"];
  }
  if (input["theme"] !== undefined) {
    if (!isTheme(input["theme"])) return null;
    rule.theme = input["theme"];
  }
  if (input["nativeDark"] !== undefined) {
    if (input["nativeDark"] !== "ignore" && input["nativeDark"] !== "use") return null;
    rule.nativeDark = input["nativeDark"];
  }
  if (input["dimImages"] !== undefined) {
    if (typeof input["dimImages"] !== "boolean") return null;
    rule.dimImages = input["dimImages"];
  }
  if (input["deleted"] === true) rule.deleted = true;
  return rule;
}

/** Tolerant parser: never throws; invalid fields fall back to defaults, invalid site rules are dropped, unknown keys ignored. */
export function parseSettings(input: unknown): Settings {
  if (!isRecord(input)) return structuredClone(DEFAULT_SETTINGS);
  const g = isRecord(input["global"]) ? input["global"] : {};
  const d = DEFAULT_SETTINGS.global;
  const sites: Record<string, SiteRule> = {};
  if (isRecord(input["sites"])) {
    for (const [host, raw] of Object.entries(input["sites"])) {
      const rule = parseRule(raw);
      if (rule) sites[host] = rule;
    }
  }
  return {
    schemaVersion: 1,
    global: {
      enabled: stamped(g["enabled"], d.enabled, isBool),
      theme: stamped(g["theme"], d.theme, isTheme),
      respectNativeDark: stamped(g["respectNativeDark"], d.respectNativeDark, isBool),
      dimImages: stamped(g["dimImages"], d.dimImages, isBool),
    },
    sites,
  };
}

function sortKeys(x: unknown): unknown {
  if (Array.isArray(x)) return x.map(sortKeys);
  if (isRecord(x)) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(x).sort()) out[k] = sortKeys(x[k]);
    return out;
  }
  return x;
}

/** Keys sorted recursively, no whitespace. Matches Swift JSONEncoder .sortedKeys + .withoutEscapingSlashes. */
export function canonicalJson(x: unknown): string {
  return JSON.stringify(sortKeys(x));
}
