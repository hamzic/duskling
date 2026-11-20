// Test helper: validates site-defaults.json against its policy (CONTRIBUTING.md, "Fixing a broken site"). Returns a list of problems.
export function validateSiteDefaults(table: Record<string, unknown>, issues: Record<string, unknown>): string[] {
  const problems: string[] = [];
  for (const [host, raw] of Object.entries(table)) {
    const entry = (raw ?? {}) as Record<string, unknown>;
    for (const k of Object.keys(entry)) if (k !== "mode" && k !== "noNativePromotion") problems.push(`${host}: unknown key ${k}`);
    if (entry.mode !== undefined && entry.mode !== "gentle" && entry.mode !== "filter") problems.push(`${host}: invalid mode`);
    if (entry.noNativePromotion !== undefined && entry.noNativePromotion !== true) problems.push(`${host}: invalid noNativePromotion`);
    const link = issues[host];
    if (typeof link !== "string" || !/^https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/\d+$/.test(link)) problems.push(`${host}: missing issue link`);
  }
  for (const host of Object.keys(issues)) if (!(host in table)) problems.push(`${host}: issue link without entry`);
  return problems;
}
