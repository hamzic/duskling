import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/", "dist-test/", "test-results/", "playwright-report/", "node_modules/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: { globals: { process: "readonly", console: "readonly" } },
  },
  {
    // Node scripts of the e2e fixtures (server, asset generator).
    files: ["test/**/*.mjs"],
    languageOptions: { globals: { process: "readonly", console: "readonly", URL: "readonly", setTimeout: "readonly" } },
  },
);
