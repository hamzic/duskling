import table from "./site-defaults.json";
import { hostChain, normalizeHost } from "./rules";
import type { EffectiveRule, Mode } from "./types";

export interface SiteDefault { mode?: "gentle" | "filter"; noNativePromotion?: true }

/** Most specific entry along the host chain; {} when none. */
export function siteDefaultFor(host: string | null, entries: Record<string, SiteDefault> = table as Record<string, SiteDefault>): SiteDefault {
  const h = host === null ? null : normalizeHost(host);
  if (h === null) return {};
  for (const c of hostChain(h)) {
    const e = entries[c];
    if (e) return e;
  }
  return {};
}

/** A user's explicit mode always wins over the last-resort host default. */
export function effectiveMode(rule: EffectiveRule, d: SiteDefault): Mode {
  return rule.modeIsExplicit ? rule.mode : (d.mode ?? rule.mode);
}
