import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  outputDir: "test-results",
  reporter: [["list"], ["html", { outputFolder: "playwright-report", open: "never" }]],
  // Fixture pages on two origins: 4100 is origin A, 4101 origin B (no CORS headers). The server opens 4100
  // only after 4101 listens, so waiting for 4100 covers both.
  webServer: { command: "node test/fixtures/server.mjs", url: "http://localhost:4100/basic-article.html", reuseExistingServer: !process.env.CI },
  projects: [
    // The real bundles against the fixture pages, through test/harness (run `npm run build:test` first).
    // iOS Safari is the product, so the gates use an iPhone WebKit descriptor: its viewport, DPR and mobile emulation.
    { name: "e2e", testDir: "test/e2e", use: { ...devices["iPhone 16"] } },
    // Engine unit cases that need real WebKit CSSOM (@layer, CSS nesting), which happy-dom lacks.
    { name: "unit-webkit", testDir: "test/unit-webkit", use: { ...devices["Desktop Safari"] } },
    // Live sites over the network, only when asked for (`npm run test:live`), never in a default run.
    ...(process.env["DUSK_LIVE"] ? [{ name: "live", testDir: "test/live", use: { ...devices["iPhone 16"] } }] : []),
  ],
});
