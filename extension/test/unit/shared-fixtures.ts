import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Reads a JSON fixture from the repo-level shared/ directory (also consumed by the Swift tests). */
export function loadShared(rel: string): unknown {
  return JSON.parse(readFileSync(resolve(__dirname, "../../../shared", rel), "utf8"));
}
