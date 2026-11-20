import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error build.mjs is plain JS without type declarations
import { buildManifest, readMarketingVersion } from "../../scripts/build.mjs";

const xcconfig = resolve(__dirname, "../../../apple/Config/Base.xcconfig");
const expected = /^MARKETING_VERSION\s*=\s*(\S+)$/m.exec(readFileSync(xcconfig, "utf8"))?.[1];

describe("version injection", () => {
  it("reads MARKETING_VERSION from Base.xcconfig", () => {
    expect(expected).toMatch(/^\d+\.\d+\.\d+$/);
    expect(readMarketingVersion()).toBe(expected);
  });

  it("injects it into the manifest", () => {
    expect(buildManifest(readMarketingVersion()).version).toBe(expected);
  });

  it("writes it to dist/manifest.json", () => {
    execFileSync(process.execPath, [resolve(__dirname, "../../scripts/build.mjs")], { stdio: "pipe" });
    const manifest = JSON.parse(readFileSync(resolve(__dirname, "../../dist/manifest.json"), "utf8"));
    expect(manifest.version).toBe(expected);
    expect(manifest.manifest_version).toBe(3);
  });
});
