import { describe, expect, it } from "vitest";
import { PALETTES } from "../../src/engine/color/palettes";
import { VariableRegistry } from "../../src/engine/css/variables";

// Wall-clock budget: vitest.config.ts runs `*.cost.test.ts` after every other test file has finished, so parallel
// workers don't eat into it.
describe("VariableRegistry cost on theme-heavy pages", () => {
  // github.com defines each of ~1,000 variables once per theme (about a dozen themes), with chains between them. Each new
  // definition used to clear every resolution memo, so the cost grew with definitions × variables (this case: ~860 ms
  // before, ~90 ms after, on an M-series Mac).
  it("observes 24 themes of 200 base colors and 1,000 semantic variables chained to them in well under a second", () => {
    const reg = new VariableRegistry(PALETTES.dark);
    const BASE = 200;
    const SEM = 1000;
    for (let i = 0; i < SEM; i++) reg.observeUsage(i % 2 ? "color" : "background-color", `var(--sem${i})`);
    const t = performance.now();
    for (let theme = 0; theme < 24; theme++) {
      const src = {};
      reg.replaceSource(src, () => {
        const sel = `[data-theme=t${theme}]`;
        for (let i = 0; i < SEM; i++) reg.observeDefinition(sel, `--sem${i}`, `var(--base${i % BASE})`, { source: src });
        for (let i = 0; i < BASE; i++) {
          reg.observeDefinition(sel, `--base${i}`, `rgb(${(theme * 7 + i) % 256}, ${(i * 3) % 256}, ${(theme * 11) % 256})`, { source: src });
        }
      });
      reg.sheetDefinitionsCss(src, PALETTES.dark);
    }
    const ms = performance.now() - t;
    expect(reg.size).toBe(24 * (BASE + SEM));
    expect(ms).toBeLessThan(400);
  });
});
