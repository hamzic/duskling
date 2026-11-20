// Size gate: content.js <= 35 KB gzip, bridge.js and bridge-promote.js <= 2.25 KB gzip each, each prepaint/*.css <= 1 KB raw,
// site-defaults.json <= 2 KB as bundled (minified JSON).
// A budgeted file that is missing fails the gate: a build that silently dropped it would pass otherwise.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { Buffer } from "node:buffer";

const dist = join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "dist");
const KB = 1024;
const rows = [];
let failed = false;

function check(name, file, measure, budget) {
  if (!existsSync(file)) {
    rows.push([name, "-", `${budget} B`, "MISSING (run npm run build)"]);
    failed = true;
    return;
  }
  const size = measure(file);
  const ok = size <= budget;
  if (!ok) failed = true;
  rows.push([name, `${size} B`, `${budget} B`, ok ? "ok" : "OVER"]);
}

const gz = (f) => gzipSync(readFileSync(f), { level: 9 }).length;
const raw = (f) => statSync(f).size;

check("content.js (gzip)", join(dist, "content.js"), gz, 35 * KB);
check("bridge.js (gzip)", join(dist, "bridge.js"), gz, 2.25 * KB);
check("bridge-promote.js (gzip)", join(dist, "bridge-promote.js"), gz, 2.25 * KB);
const siteDefaults = join(dist, "..", "src", "shared", "site-defaults.json");
check("site-defaults.json (minified raw)", siteDefaults, (f) => Buffer.byteLength(JSON.stringify(JSON.parse(readFileSync(f, "utf8")))), 2 * KB);
const prepaintDir = join(dist, "prepaint");
const css = existsSync(prepaintDir) ? readdirSync(prepaintDir).filter((f) => f.endsWith(".css")) : [];
if (css.length === 0) rows.push(["prepaint/*.css (raw)", "-", `${KB} B`, "skipped (not built yet)"]);
for (const f of css) check(`prepaint/${f} (raw)`, join(prepaintDir, f), raw, KB);

const w = [0, 1, 2, 3].map((i) => Math.max(...rows.map((r) => String(r[i]).length)));
for (const r of rows) console.log(r.map((c, i) => String(c).padEnd(w[i])).join("  "));
if (failed) {
  console.error("size gate failed: a budget is exceeded or a file is missing");
  process.exit(1);
}
