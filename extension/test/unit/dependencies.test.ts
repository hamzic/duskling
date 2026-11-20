import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// The build strips license comments (legalComments: "none"), so a runtime package would ship without its notice.
// Adding one means adding its license to THIRD_PARTY_NOTICES.md (the in-app Licenses screen) and updating this test.
const pkg = JSON.parse(readFileSync(resolve(__dirname, "../../package.json"), "utf8")) as Record<string, unknown>;

describe("package.json", () => {
  it.each(["dependencies", "optionalDependencies", "peerDependencies", "bundleDependencies", "bundledDependencies"])(
    "has no %s: everything is a devDependency that never ships",
    (field) => {
      expect(Object.keys((pkg[field] as object | undefined) ?? {})).toEqual([]);
    },
  );
});
