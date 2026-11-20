// Builds the extension into dist/ (and dist-test/harness.js with --test).
// Safari target: esbuild `safari16.4` matches the iOS 16.4 floor for registerContentScripts
// (@mdn/browser-compat-data, webextensions.api.scripting.RegisteredContentScript).
import { build } from "esbuild";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const XCCONFIG = join(root, "..", "apple", "Config", "Base.xcconfig");

export function readMarketingVersion(path = XCCONFIG) {
  const m = /^\s*MARKETING_VERSION\s*=\s*(\S+)\s*$/m.exec(readFileSync(path, "utf8"));
  if (!m) throw new Error(`MARKETING_VERSION not found in ${path}`);
  return m[1];
}

export function buildManifest(version) {
  const manifest = JSON.parse(readFileSync(join(root, "src", "manifest.json"), "utf8"));
  manifest.version = version;
  return manifest;
}

const common = {
  bundle: true,
  format: "iife",
  minify: true,
  target: "safari16.4",
  legalComments: "none",
  logLevel: "warning",
};

async function main() {
  const testMode = process.argv.includes("--test");
  rmSync(dist, { recursive: true, force: true });
  mkdirSync(join(dist, "popup"), { recursive: true });
  mkdirSync(join(dist, "prepaint"), { recursive: true });
  mkdirSync(join(dist, "boot"), { recursive: true });

  await Promise.all([
    build({ ...common, entryPoints: [join(root, "src/background/index.ts")], outfile: join(dist, "background.js") }),
    build({ ...common, entryPoints: [join(root, "src/content/index.ts")], outfile: join(dist, "content.js") }),
    // One bridge source, two bundles: bridge-promote.js reports a dark color scheme from document start.
    ...[false, true].map((promote) =>
      build({
        ...common,
        entryPoints: [join(root, "src/bridge/index.ts")],
        outfile: join(dist, promote ? "bridge-promote.js" : "bridge.js"),
        define: { __PROMOTE__: String(promote) },
      }),
    ),
    build({ ...common, entryPoints: [join(root, "src/popup/popup.ts")], outfile: join(dist, "popup/popup.js") }),
  ]);

  writeFileSync(join(dist, "manifest.json"), JSON.stringify(buildManifest(readMarketingVersion()), null, 2) + "\n");
  cpSync(join(root, "src/_locales"), join(dist, "_locales"), { recursive: true });
  cpSync(join(root, "src/icons"), join(dist, "icons"), { recursive: true });
  for (const f of ["popup.html", "popup.css"]) {
    const src = join(root, "src/popup", f);
    if (!existsSync(src)) throw new Error(`build: missing ${src}`);
    cpSync(src, join(dist, "popup", f));
  }

  // Pre-paint files (dist/prepaint/<theme>.css|js) and the 18 boot files (dist/boot/<class>.js):
  // bundle generate.ts to a temp ESM file, import it, write the result.
  const tmp = join(tmpdir(), `dusk-prepaint-${process.pid}.mjs`);
  await build({
    entryPoints: [join(root, "src/prepaint/generate.ts")],
    outfile: tmp,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node24",
    logLevel: "warning",
  });
  const { prepaintFiles, bootFiles } = await import(pathToFileURL(tmp).href);
  rmSync(tmp, { force: true });
  for (const [name, content] of Object.entries(prepaintFiles())) {
    writeFileSync(join(dist, "prepaint", name), content);
  }
  for (const [name, content] of Object.entries(bootFiles())) {
    writeFileSync(join(dist, "boot", name), content);
  }

  if (testMode) {
    const harness = join(root, "test/harness/harness.ts");
    await build({ ...common, minify: false, entryPoints: [harness], outfile: join(root, "dist-test/harness.js") });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
