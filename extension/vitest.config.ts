import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "happy-dom",
    // happy-dom 21 turns iframe page loading and CSS file loading off by default. The tests need both, as in a browser: an
    // about:blank iframe gets a document, and a fixture's `data:` stylesheet link loads. JavaScript evaluation stays off.
    // https://github.com/capricorn86/happy-dom/blob/master/packages/happy-dom/src/browser/types/IBrowserSettings.ts
    environmentOptions: { happyDOM: { settings: { enableIframePageLoading: true, enableCSSFileLoading: true } } },
    include: ["test/unit/**/*.test.ts"],
  },
});
