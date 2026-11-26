import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "happy-dom",
    // happy-dom 21 turns iframe page loading and CSS file loading off by default. The tests need both, as in a browser: an
    // about:blank iframe gets a document, and a fixture's `data:` stylesheet link loads. JavaScript evaluation stays off.
    // https://github.com/capricorn86/happy-dom/blob/master/packages/happy-dom/src/browser/types/IBrowserSettings.ts
    environmentOptions: { happyDOM: { settings: { enableIframePageLoading: true, enableCSSFileLoading: true } } },
    // Wall-clock budgets (`*.cost.test.ts`) run in a later group, alone: next to the other files' parallel workers they
    // measured 520–1,080 ms against a 400 ms budget they meet in about 90 ms on their own.
    // groupOrder: "groups are run from lowest to highest" (vitest/dist/chunks/plugin.d.*.ts, SequenceOptions.groupOrder).
    projects: [
      { extends: true, test: { name: "unit", include: ["test/unit/**/*.test.ts"], exclude: ["test/unit/**/*.cost.test.ts"] } },
      { extends: true, test: { name: "cost", include: ["test/unit/**/*.cost.test.ts"], sequence: { groupOrder: 1 } } },
    ],
  },
});
