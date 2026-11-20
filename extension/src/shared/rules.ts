import type { EffectiveRule, Mode, Settings, SiteRule } from "./types";

export const MAX_SITES = 2000;
const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/** Lowercase, strip one leading "www." and a trailing ".". Null for empty input or input containing "/", ":" or whitespace. */
export function normalizeHost(hostname: string): string | null {
  if (/[/:\s]/.test(hostname)) return null;
  let h = hostname.toLowerCase();
  if (IPV4.test(h)) return h;
  if (h.startsWith("www.")) h = h.slice(4);
  if (h.endsWith(".")) h = h.slice(0, -1);
  return h === "" ? null : h;
}

/** "a.b.example.com" → ["a.b.example.com","b.example.com","example.com","com"]. IPv4 addresses are not split. */
export function hostChain(host: string): string[] {
  if (IPV4.test(host)) return [host];
  const labels = host.split(".");
  const chain: string[] = [];
  for (let i = 0; i < labels.length; i++) chain.push(labels.slice(i).join("."));
  return chain;
}

export function resolveSiteRule(s: Settings, host: string | null): EffectiveRule {
  const g = s.global;
  const normalized = host === null ? null : normalizeHost(host);
  let mode: Mode | undefined;
  let theme = g.theme.value;
  let themeSet = false;
  let ignoreNative = false;
  let native: SiteRule["nativeDark"];
  let dimImages: boolean | undefined;
  let matchedHost: string | null = null;
  if (normalized !== null) {
    for (const h of hostChain(normalized)) {
      const rule = s.sites[h];
      if (!rule || rule.deleted) continue;
      matchedHost ??= h;
      mode ??= rule.mode;
      if (!themeSet && rule.theme !== undefined) {
        theme = rule.theme;
        themeSet = true;
      }
      if (rule.nativeDark === "ignore") ignoreNative = true;
      native ??= rule.nativeDark;
      dimImages ??= rule.dimImages;
    }
  }
  return {
    enabled: g.enabled.value,
    mode: mode ?? "full",
    modeIsExplicit: mode !== undefined,
    theme,
    respectNativeDark: g.respectNativeDark.value && !ignoreNative,
    // "use" (the popup, when the user overrules Duskling's light check): follow the declared dark theme even when it samples
    // light. A parent's "ignore" still wins, as above.
    trustNativeDark: g.respectNativeDark.value && !ignoreNative && native === "use",
    dimImages: dimImages ?? g.dimImages.value,
    matchedHost,
  };
}

type Field = "mode" | "theme" | "nativeDark" | "dimImages";
type Patch = Partial<Pick<SiteRule, Field>> | { [K in Field]?: null };

export function setSiteFields(s: Settings, host: string, patch: Patch, now: number): Settings {
  const existing = s.sites[host];
  const base: Partial<Record<Field, unknown>> = {};
  if (existing && !existing.deleted) {
    if (existing.mode !== undefined) base["mode"] = existing.mode;
    if (existing.theme !== undefined) base["theme"] = existing.theme;
    if (existing.nativeDark !== undefined) base["nativeDark"] = existing.nativeDark;
    if (existing.dimImages !== undefined) base["dimImages"] = existing.dimImages;
  }
  for (const k of ["mode", "theme", "nativeDark", "dimImages"] as const) {
    const v = patch[k];
    if (v === null) delete base[k];
    else if (v !== undefined) base[k] = v;
  }
  const rule: SiteRule = Object.keys(base).length === 0
    ? { updatedAt: now, deleted: true }
    : { ...(base as Pick<SiteRule, Field>), updatedAt: now };
  return { ...s, sites: { ...s.sites, [host]: rule } };
}

export function setGlobal<K extends keyof Settings["global"]>(
  s: Settings,
  key: K,
  value: Settings["global"][K]["value"],
  now: number,
): Settings {
  return { ...s, global: { ...s.global, [key]: { value, updatedAt: now } } };
}

/** Drops tombstones older than 30 days, then enforces MAX_SITES (oldest tombstones first, then oldest rules). */
export function purgeAndLimit(s: Settings, now: number): Settings {
  const entries = Object.entries(s.sites).filter(([, r]) => !(r.deleted && now - r.updatedAt > TOMBSTONE_TTL_MS));
  if (entries.length > MAX_SITES) {
    const rank = (r: SiteRule) => (r.deleted ? 0 : 1);
    const byDrop = [...entries].sort(
      ([ha, a], [hb, b]) => rank(a) - rank(b) || a.updatedAt - b.updatedAt || (ha < hb ? -1 : ha > hb ? 1 : 0),
    );
    const drop = new Set(byDrop.slice(0, entries.length - MAX_SITES).map(([h]) => h));
    return { ...s, sites: Object.fromEntries(entries.filter(([h]) => !drop.has(h))) };
  }
  return { ...s, sites: Object.fromEntries(entries) };
}
