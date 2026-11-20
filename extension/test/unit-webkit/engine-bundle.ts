// Bundles engine modules into an IIFE (global `Dusk`) so Playwright WebKit specs can run them in a real page.
// Used for CSSOM features happy-dom lacks (@layer, CSS nesting).
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const src = fileURLToPath(new URL("../../src/", import.meta.url));

export async function engineBundle(): Promise<string> {
  const result = await build({
    stdin: {
      contents: [
        'export { rewriteRuleList } from "./engine/css/rules";',
        'export { PALETTES } from "./engine/color/palettes";',
        'export { transformCssColor } from "./engine/color/transform";',
        'export { VariableRegistry } from "./engine/css/variables";',
        'export { StyleManager } from "./engine/css/style-manager";',
        'export { applyRootStyles, themeSpecialFrames } from "./engine/css/root";',
        'export { InlineStyler, isContentColor } from "./engine/css/inline";',
        'export { ImageStyler, classifyPixels, transformImageDataUrl } from "./engine/media/images";',
        'export * as NativeDark from "./engine/detect/native-dark";',
        'export { ContrastRepair } from "./engine/repair/contrast-repair";',
        'export { createEngine, applyFilterMode } from "./engine/index";',
        'export { restoreStyleAttr } from "./engine/css/csp";',
      ].join("\n"),
      resolveDir: src,
      loader: "ts",
    },
    bundle: true,
    format: "iife",
    globalName: "Dusk",
    write: false,
    target: "safari18",
  });
  return result.outputFiles[0]?.text ?? "";
}

export interface DuskGlobal {
  rewriteRuleList: typeof import("../../src/engine/css/rules").rewriteRuleList;
  restoreStyleAttr: typeof import("../../src/engine/css/csp").restoreStyleAttr;
  PALETTES: typeof import("../../src/engine/color/palettes").PALETTES;
  transformCssColor: typeof import("../../src/engine/color/transform").transformCssColor;
  VariableRegistry: typeof import("../../src/engine/css/variables").VariableRegistry;
  StyleManager: typeof import("../../src/engine/css/style-manager").StyleManager;
  InlineStyler: typeof import("../../src/engine/css/inline").InlineStyler;
  applyRootStyles: typeof import("../../src/engine/css/root").applyRootStyles;
  themeSpecialFrames: typeof import("../../src/engine/css/root").themeSpecialFrames;
  isContentColor: typeof import("../../src/engine/css/inline").isContentColor;
  ImageStyler: typeof import("../../src/engine/media/images").ImageStyler;
  classifyPixels: typeof import("../../src/engine/media/images").classifyPixels;
  transformImageDataUrl: typeof import("../../src/engine/media/images").transformImageDataUrl;
  NativeDark: typeof import("../../src/engine/detect/native-dark");
  ContrastRepair: typeof import("../../src/engine/repair/contrast-repair").ContrastRepair;
  createEngine: typeof import("../../src/engine/index").createEngine;
  applyFilterMode: typeof import("../../src/engine/index").applyFilterMode;
}
