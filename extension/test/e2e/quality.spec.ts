// Quality gates (success criteria): every light fixture (L) in every theme reaches ≥ 98 % of visible
// text at WCAG ≥ 4.5:1 and ≥ 90 % of the viewport (image boxes left out) at relative luminance < 0.3. The audit has to
// measure something: at most 10 % of the candidate text may be skipped, and each fixture has a floor of measured
// elements (its text elements when themed, rounded down). Screenshots go into the report.
import { expect, test } from "@playwright/test";
import { contrastAudit, darknessReport, makeSettings, openThemed } from "./helpers";
import type { ThemeId } from "../../src/shared/types";

const LIGHT: Record<string, number> = {
  "basic-article": 15,
  "css-variables": 10,
  "inline-styles": 10,
  forms: 15,
  "gradients-shadows": 6,
  "fixed-position": 15,
  "spa-mutations": 8,
  "css-in-js": 6,
  "shadow-dom": 7,
  "cross-origin-css": 5,
  "dark-hero-sections": 11,
  "textures-overlays": 7,
  "missed-surfaces": 4,
  "channel-tokens": 9,
};
const THEMES: ThemeId[] = ["dark", "midnight", "dim"];

for (const [fixture, floor] of Object.entries(LIGHT)) {
  for (const theme of THEMES) {
    test(`${fixture} × ${theme}: contrast ≥ 98 %, darkness ≥ 90 %`, async ({ page }, info) => {
      await openThemed(page, fixture, makeSettings({ theme }));
      const c = await contrastAudit(page);
      const d = await darknessReport(page);
      await info.attach(`${fixture}-${theme}.png`, { body: d.png, contentType: "image/png" });
      info.annotations.push({
        type: "measured",
        description: `contrast ${c.passing}/${c.total} (skipped ${c.skipped} ${JSON.stringify(c.reasons)}), darkness ${d.darkness.toFixed(3)}, masked ${d.masked.toFixed(3)}`,
      });
      expect(c.total, "measured text elements").toBeGreaterThanOrEqual(floor);
      expect(c.skipped, "skipped text elements").toBeLessThanOrEqual(0.1 * (c.total + c.skipped));
      expect(c.passing / c.total, `contrast failures: ${c.failures.join("; ")}`).toBeGreaterThanOrEqual(0.98);
      expect(d.masked, "share of the viewport left out as image boxes").toBeLessThan(0.5);
      expect(d.darkness).toBeGreaterThanOrEqual(0.9);
    });
  }
}
