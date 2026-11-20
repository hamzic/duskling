// Live-site regression report.
// Themes each site with the real bundles through the e2e harness, measures the contrast and darkness criteria,
// and writes live-report/report.html, worst first, with before/after screenshots. A site that errors or times out is
// listed with its error; it never fails the run.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "@playwright/test";
import { contrastAudit, darknessReport, openThemed } from "../e2e/helpers";
import corpus from "./sites.json" with { type: "json" };

/** Popular hosts added to the fixture corpus (the 100 hosts with the most Dark Reader fixes). */
const POPULAR = [
  "google.com", "youtube.com", "wikipedia.org", "reddit.com", "amazon.com", "github.com", "nytimes.com", "bbc.com",
  "stackoverflow.com", "apple.com", "x.com", "linkedin.com", "medium.com", "ebay.com", "imdb.com", "duckduckgo.com",
  "theguardian.com", "notion.so", "chatgpt.com", "booking.com",
];
const SITE_TIMEOUT_MS = 15_000;
// Outside Playwright's outputDir (test-results/): in a run where one site timed out, the files written there before it were gone.
const OUT = fileURLToPath(new URL("../../live-report/", import.meta.url));

const hostOf = (url: string) => new URL(url).hostname.replace(/^www\./, "");
const known = new Set(corpus.map(hostOf));
const SITES = [...corpus, ...POPULAR.filter((h) => !known.has(h)).map((h) => `https://${h}/`)];

interface Result {
  url: string;
  host: string;
  /** Share of measured text at WCAG ≥ 4.5:1, or null when the site didn't load. */
  contrast: number | null;
  darkness: number | null;
  /** The first failing text elements (selector, worst ratio, text), to see why a site scores low. */
  failures?: string[];
  error?: string;
}

const file = (host: string, kind: string) => `${host.replace(/[^a-z0-9.-]/gi, "_")}-${kind}`;

test.beforeAll(() => mkdirSync(OUT, { recursive: true }));

for (const url of SITES) {
  test(`live: ${hostOf(url)}`, async ({ page, context }) => {
    test.setTimeout(3 * SITE_TIMEOUT_MS + 10_000);
    const host = hostOf(url);
    const result: Result = { url, host, contrast: null, darkness: null };
    try {
      const before = await context.newPage();
      await before.goto(url, { waitUntil: "load", timeout: SITE_TIMEOUT_MS }).catch(() => undefined);
      await before.screenshot({ path: join(OUT, file(host, "before.png")), timeout: SITE_TIMEOUT_MS });
      await before.close();

      page.setDefaultTimeout(SITE_TIMEOUT_MS);
      await openThemed(page, url);
      const c = await contrastAudit(page);
      const d = await darknessReport(page);
      writeFileSync(join(OUT, file(host, "after.png")), d.png);
      result.contrast = c.total ? c.passing / c.total : 1;
      if (c.failures.length) result.failures = c.failures.slice(0, 10);
      result.darkness = d.darkness;
    } catch (e) {
      result.error = String(e instanceof Error ? e.message : e).split("\n")[0]!.slice(0, 300);
    }
    writeFileSync(join(OUT, file(host, "result.json")), JSON.stringify(result));
  });
}

// One JSON file per site, so a worker restarted after a crash still contributes to the report the last worker writes.
test.afterAll(() => {
  const results = readdirSync(OUT)
    .filter((f) => f.endsWith("-result.json"))
    .map((f) => JSON.parse(readFileSync(join(OUT, f), "utf8")) as Result);
  writeFileSync(join(OUT, "report.html"), report(results));
});

/** Worst first: sites that failed to load, then by the lower of the two scores. */
function report(results: Result[]): string {
  const score = (r: Result) => (r.contrast === null || r.darkness === null ? -1 : Math.min(r.contrast, r.darkness));
  const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => `&#${ch.charCodeAt(0)};`);
  const pct = (v: number | null, goal: number) =>
    v === null ? "–" : `<span class="${v >= goal ? "ok" : "bad"}">${(v * 100).toFixed(1)} %</span>`;
  const rows = [...results]
    .sort((a, b) => score(a) - score(b) || a.host.localeCompare(b.host))
    .map(
      (r) => `<section>
  <h2><a href="${esc(r.url)}">${esc(r.host)}</a></h2>
  <p>contrast ${pct(r.contrast, 0.98)} · darkness ${pct(r.darkness, 0.9)}${r.error ? ` · <span class="bad">${esc(r.error)}</span>` : ""}</p>${r.failures?.length ? `<details><summary>Failing text</summary><ul>${r.failures.map((f) => `<li><code>${esc(f)}</code></li>`).join("")}</ul></details>` : ""}
  <div class="shots"><img src="${file(r.host, "before.png")}" alt="before" loading="lazy"><img src="${file(r.host, "after.png")}" alt="after" loading="lazy"></div>
</section>`,
    )
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Live regression report</title>
<style>
  body { font: 14px/1.4 system-ui, sans-serif; margin: 16px; }
  section { border-top: 1px solid #ccc; padding: 8px 0; }
  h2 { font-size: 16px; margin: 0; }
  .shots { display: flex; gap: 8px; }
  .shots img { width: 200px; border: 1px solid #ccc; }
  .ok { color: #1a7f37; } .bad { color: #cf222e; }
</style>
</head>
<body>
<h1>Live regression report</h1>
<p>${results.length} sites, worst first. Goals: contrast ≥ 98 % of text at 4.5:1, darkness ≥ 90 % of pixels.</p>
${rows}
</body>
</html>
`;
}
