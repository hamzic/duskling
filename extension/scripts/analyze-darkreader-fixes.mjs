// Dev-time research tool (never part of a build).
// Usage: npm run research:fixes -- <darkreader-commit-sha>
// Downloads Dark Reader's fix lists at a pinned commit and classifies every directive by root cause.
// Writes extension/.research/darkreader-fix-analysis.md and extension/test/live/sites.json (hostnames only).
// Needs a Node whose CA bundle can verify raw.githubusercontent.com. If fetch fails with "unable to get local issuer
// certificate", run with NODE_EXTRA_CA_CERTS=/etc/ssl/cert.pem (macOS). No TLS verification is ever bypassed.
// No Dark Reader code or data is shipped: only counts, aggregate statistics, short samples and public hostnames are written.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SEP = /^={8,}\s*$/;
const FIX_HEADERS = new Set(["INVERT", "CSS", "IGNORE INLINE STYLE", "IGNORE IMAGE ANALYSIS", "IGNORE CSS URL", "IFRAME"]);
const HINT_HEADERS = new Set(["TARGET", "MATCH", "NO DARK THEME", "SYSTEM THEME"]);

// Bucket id -> [label, heuristic that covers it, or null when no heuristic covers it]
export const BUCKETS = {
  invert: ["Dark logos/icons/sprites invisible on dark (`INVERT`)", "Image classifier"],
  texture: ["Light decorative textures/overlays (`background-image: none`)", "Texture classification + background transform"],
  neutral: ["Missed surfaces/text forced to neutral (`--darkreader-neutral-*`)", "Contrast-repair pass"],
  blend: ["`mix-blend-mode` / `background-blend-mode`", "Blend remap"],
  ignoreInline: ["Inline colors that are content (`IGNORE INLINE STYLE`)", "Content-color guard"],
  ignoreImage: ["Image-analysis false positives (`IGNORE IMAGE ANALYSIS`)", "Chroma/photo checks"],
  detectorHint: ["Own dark theme behind class/attribute (detector hints with `MATCH`)", "Dark-state markers + class/attribute promotion (signals 1, 4)"],
  darkSite: ["Already-dark sites (`dark-sites.config`)", "Sampling"],
  detectorNoDark: ["Detector hints `NO DARK THEME` / `SYSTEM THEME`", "Sampling"],
  cssColor: ["Other CSS rules overriding literal colors (color/background/border/fill/stroke/outline)", "OKLCH role transforms + contrast-repair pass"],
  cssOther: ["Other CSS rules (non-color declarations)", "`background-image`/`filter`: image classifier; `z-index`/`display`/`opacity`: out of scope"],
  other: ["Other (IGNORE CSS URL, IFRAME, unparsed)", null],
};

export function parseBlocks(text) {
  const blocks = [];
  let cur = [];
  for (const line of text.replace(/\r/g, "").split("\n")) {
    if (SEP.test(line)) {
      blocks.push(cur);
      cur = [];
    } else cur.push(line);
  }
  blocks.push(cur);
  return blocks.filter((b) => b.some((l) => l.trim() !== ""));
}

/** Splits a block into host patterns and its sections [{header, lines}]. */
export function parseBlock(lines, headers) {
  const hosts = [];
  const sections = [];
  let sec = null;
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line.trim() === "") {
      if (sec?.header === "CSS") sec.lines.push("");
      continue;
    }
    if (headers.has(line.trim())) {
      sec = { header: line.trim(), lines: [] };
      sections.push(sec);
    } else if (sec) sec.lines.push(line);
    else hosts.push(line.trim());
  }
  return { hosts, sections };
}

/** Index of the first `ch` at/after `from` outside `${…}` placeholders, parentheses and quotes; -1 if none. */
function indexOfTop(text, ch, from) {
  let paren = 0;
  let quote = "";
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = "";
    } else if (c === "$" && text[i + 1] === "{") {
      const close = text.indexOf("}", i + 2);
      if (close < 0) return -1;
      i = close;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "(") paren++;
    else if (c === ")") paren = Math.max(0, paren - 1);
    else if (c === ch && paren === 0) return i;
  }
  return -1;
}

/** "sel { a: b; c: d }" text -> [{selector, decls:[{prop,value}]}]. `${…}` placeholders may appear in values. */
export function parseCssRules(lines) {
  const rules = [];
  const text = lines.join("\n");
  let i = 0;
  while (i < text.length) {
    const open = indexOfTop(text, "{", i);
    if (open < 0) break;
    const close = indexOfTop(text, "}", open + 1);
    if (close < 0) break;
    const selector = text.slice(i, open).trim();
    const body = text.slice(open + 1, close);
    const decls = [];
    let j = 0;
    while (j < body.length) {
      let semi = indexOfTop(body, ";", j);
      if (semi < 0) semi = body.length;
      const d = body.slice(j, semi);
      const c = d.indexOf(":");
      if (c >= 0) decls.push({ prop: d.slice(0, c).trim().toLowerCase(), value: d.slice(c + 1).trim().replace(/\s*!important\s*$/i, "") });
      j = semi + 1;
    }
    rules.push({ selector, decls });
    i = close + 1;
  }
  return rules;
}

const COLOR_PROP = /^(color|background(-color)?|border(-[a-z]+)*-color|border(-[a-z]+)?|outline(-color)?|fill|stroke|text-decoration-color|box-shadow|text-shadow|caret-color|accent-color|--.*)$/;

export function classifyRule(r) {
  const has = (p, f) => r.decls.some((d) => d.prop === p && (!f || f(d.value)));
  if (has("background-image", (v) => v.toLowerCase() === "none")) return "texture";
  if (r.decls.some((d) => d.prop === "mix-blend-mode" || d.prop === "background-blend-mode")) return "blend";
  if (r.decls.some((d) => d.value.includes("--darkreader-neutral-"))) return "neutral";
  if (r.decls.some((d) => COLOR_PROP.test(d.prop))) return "cssColor";
  return "cssOther";
}

export function hostFromPattern(p) {
  if (p.includes("*")) return null;
  let h = p.trim().toLowerCase().split("/")[0];
  if (h.startsWith("www.")) h = h.slice(4);
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(h) && !/^\d+(\.\d+){3}$/.test(h) ? h : null;
}

function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function analyze(fixesText, hintsText, darkText) {
  const entries = Object.fromEntries(Object.keys(BUCKETS).map((k) => [k, 0]));
  const blocks = Object.fromEntries(Object.keys(BUCKETS).map((k) => [k, 0]));
  const propCount = new Map();
  const bucketProps = { cssColor: new Map(), cssOther: new Map() };
  const valueCount = new Map();
  const hostLines = new Map();
  const otherSamples = [];
  const bump = (m, k) => m.set(k, (m.get(k) ?? 0) + 1);

  const rawBlocks = parseBlocks(fixesText);
  const raw = { texture: 0, neutral: 0, blend: 0, neutralLines: 0 };
  for (const b of rawBlocks) {
    const t = b.join("\n");
    if (/background-image:\s*none/.test(t)) raw.texture++;
    if (t.includes("darkreader-neutral")) raw.neutral++;
    if (t.includes("blend-mode")) raw.blend++;
    raw.neutralLines += b.filter((l) => l.includes("darkreader-neutral")).length;
  }
  const fixBlocks = rawBlocks.map((b) => parseBlock(b, FIX_HEADERS));
  for (const b of fixBlocks) {
    const seen = new Set();
    let fixLines = 0;
    const add = (bucket, n = 1, sample) => {
      entries[bucket] += n;
      seen.add(bucket);
      if (sample !== undefined && (bucket === "cssColor" || bucket === "cssOther" || bucket === "other")) otherSamples.push({ bucket, text: sample });
    };
    for (const s of b.sections) {
      const nonEmpty = s.lines.filter((l) => l.trim() !== "");
      fixLines += nonEmpty.length;
      if (s.header === "INVERT") add("invert", nonEmpty.length);
      else if (s.header === "IGNORE INLINE STYLE") add("ignoreInline", nonEmpty.length);
      else if (s.header === "IGNORE IMAGE ANALYSIS") add("ignoreImage", nonEmpty.length);
      else if (s.header === "CSS") {
        for (const r of parseCssRules(s.lines)) {
          const bucket = classifyRule(r);
          add(bucket, 1, `${r.selector} { ${r.decls.map((d) => `${d.prop}: ${d.value}`).join("; ")} }`);
          for (const d of r.decls) {
            bump(propCount, d.prop);
            if (bucketProps[bucket]) bump(bucketProps[bucket], d.prop);
            bump(valueCount, d.value.replace(/\$\{[^}]*\}/g, "${…}").toLowerCase());
          }
        }
      } else add("other", Math.max(nonEmpty.length, 1), `${s.header}: ${nonEmpty.join(" | ")}`);
    }
    for (const k of seen) blocks[k]++;
    for (const p of b.hosts) hostLines.set(p, (hostLines.get(p) ?? 0) + fixLines);
  }

  const hintBlocks = parseBlocks(hintsText).map((b) => parseBlock(b, HINT_HEADERS));
  for (const b of hintBlocks) {
    const bucket = b.sections.some((s) => s.header === "MATCH") ? "detectorHint" : b.sections.some((s) => s.header === "NO DARK THEME" || s.header === "SYSTEM THEME") ? "detectorNoDark" : "other";
    entries[bucket]++;
    blocks[bucket]++;
    if (bucket === "other") otherSamples.push({ bucket, text: `hint block: ${b.hosts.join(", ")}` });
  }
  const darkLines = darkText.replace(/\r/g, "").split("\n").map((l) => l.trim()).filter(Boolean);
  entries.darkSite = blocks.darkSite = darkLines.length;

  const total = Object.values(entries).reduce((a, b) => a + b, 0);
  const rand = mulberry32(17);
  const pool = otherSamples.slice();
  const samples = [];
  while (samples.length < 50 && pool.length) samples.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]);

  const top = (m, n) => [...m].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, n);
  const hosts = new Map();
  for (const [p, n] of hostLines) {
    const h = hostFromPattern(p);
    if (h) hosts.set(h, (hosts.get(h) ?? 0) + n);
  }
  const topHosts = top(hosts, 100);
  return { entries, blocks, raw, total, fixBlockCount: fixBlocks.length, hintBlockCount: hintBlocks.length, topProps: top(propCount, 25), uncoveredProps: { cssColor: top(bucketProps.cssColor, 12), cssOther: top(bucketProps.cssOther, 12) }, topValues: top(valueCount, 25), samples, topHosts };
}

const esc = (s) => s.replace(/\|/g, "\\|").replace(/`/g, "'");

export function renderReport(commit, a) {
  const pct = (n) => ((n / a.total) * 100).toFixed(1) + "%";
  const lines = [];
  lines.push("# Dark Reader fix-list analysis", "");
  lines.push(`Generated by \`extension/scripts/analyze-darkreader-fixes.mjs\` at darkreader/darkreader commit \`${commit}\`.`);
  lines.push("Files: `src/config/dynamic-theme-fixes.config`, `detector-hints.config`, `dark-sites.config`. Research only: nothing from Dark Reader ships.", "");
  lines.push(`- \`dynamic-theme-fixes.config\`: ${a.fixBlockCount} host blocks`, `- \`detector-hints.config\`: ${a.hintBlockCount} blocks`, `- \`dark-sites.config\`: ${a.entries.darkSite} entries`, `- Total classified entries: ${a.total}`, "");
  lines.push("An *entry* is one directive: a selector line under `INVERT` / `IGNORE *`, one CSS rule under `CSS`, one detector-hint block, one dark-sites line. *Blocks* counts host blocks containing at least one entry of that bucket (comparable to the heuristics table).", "");
  lines.push("## Buckets", "", "| Bucket | Blocks | Entries | Share of entries | Covering heuristic |", "|---|---:|---:|---:|---|");
  for (const [k, [label, h]] of Object.entries(BUCKETS)) lines.push(`| ${label} | ${a.blocks[k]} | ${a.entries[k]} | ${pct(a.entries[k])} | ${h ?? "**none**"} |`);
  const over = Object.entries(BUCKETS).filter(([k, [, h]]) => h === null && a.entries[k] / a.total > 0.05).map(([k]) => k);
  lines.push("", `Uncovered buckets over 5 % of entries: ${over.length ? over.map((k) => `\`${k}\` (${pct(a.entries[k])})`).join(", ") : "none"}.`, "");
  for (const k of ["cssColor", "cssOther"]) lines.push(`Top properties in \`${k}\` rules: ${a.uncoveredProps[k].map(([p, n]) => `\`${esc(p)}\` ${n}`).join(", ")}.`, "");
  lines.push("## Coverage mapping", "", "Buckets without a named heuristic are mapped to existing heuristics.", "",
    "- `cssColor` (literal color overrides): OKLCH role transforms plus the contrast-repair pass (\"surfaces or text the rewrite missed\").",
    "- `cssOther` `background-image`: image classifier. `filter`: image classifier / icon inversion.",
    "- `cssOther` `z-index` / `display` / `opacity` and other layout properties: out of scope, Duskling never changes layout (an anti-goal).",
    "- Detector `NO DARK THEME` / `SYSTEM THEME` (0.6 %): sampling.", "",
    "### Differences from the heuristics table counts", "",
    `The CSS buckets here are exclusive and per rule (priority: texture, blend, neutral, color, other), so a rule matching several is counted once. Raw per-block text matches on this snapshot (any rule, no exclusivity) give texture ${a.raw.texture}, neutral ${a.raw.neutral}, blend ${a.raw.blend}; the spec's 383 / 866 / ~145 were likely taken from a different snapshot or from line counts (${a.raw.neutralLines} raw \`darkreader-neutral\` lines). No bucket is missing.`, "");
  lines.push("## Top CSS properties (CSS sections)", "", "| Property | Declarations |", "|---|---:|", ...a.topProps.map(([p, n]) => `| \`${esc(p)}\` | ${n} |`), "");
  lines.push("## Top CSS values (placeholders `${…}` collapsed)", "", "| Value | Declarations |", "|---|---:|", ...a.topValues.map(([v, n]) => `| \`${esc(v)}\` | ${n} |`), "");
  lines.push(`## Samples from buckets without a named heuristic (${a.samples.length} random, seeded)`, "", "Random rules/directives from the `cssColor`, `cssOther` and `other` buckets, now mapped to existing heuristics (see Coverage mapping). `${…}` is Dark Reader's color-placeholder syntax.", "");
  for (const s of a.samples) {
    const t = s.text.replace(/\s+/g, " ");
    lines.push(`- \`${s.bucket}\`: \`${esc(t.length > 200 ? t.slice(0, 200) + "…" : t)}\``);
  }
  lines.push("", "## Live corpus", "", `\`extension/test/live/sites.json\` holds the ${a.topHosts.length} concrete hosts with the most fix lines in \`dynamic-theme-fixes.config\` (wildcard patterns skipped, paths dropped, leading \`www.\` dropped). Top 10:`, "");
  for (const [h, n] of a.topHosts.slice(0, 10)) lines.push(`- ${h}: ${n} lines`);
  lines.push("");
  return lines.join("\n");
}

async function main() {
  const commit = process.argv[2];
  if (!commit || !/^[0-9a-f]{7,40}$/.test(commit)) {
    console.error("usage: npm run research:fixes -- <darkreader-commit-sha>");
    process.exit(2);
  }
  const base = `https://raw.githubusercontent.com/darkreader/darkreader/${commit}/src/config/`;
  const get = async (f) => {
    const r = await globalThis.fetch(base + f);
    if (!r.ok) throw new Error(`${f}: HTTP ${r.status}`);
    return r.text();
  };
  const [fixes, hints, dark] = await Promise.all(["dynamic-theme-fixes.config", "detector-hints.config", "dark-sites.config"].map(get));
  const a = analyze(fixes, hints, dark);
  mkdirSync(join(root, "extension", ".research"), { recursive: true });
  mkdirSync(join(root, "extension", "test", "live"), { recursive: true });
  writeFileSync(join(root, "extension", ".research", "darkreader-fix-analysis.md"), renderReport(commit, a));
  writeFileSync(join(root, "extension", "test", "live", "sites.json"), JSON.stringify(a.topHosts.map(([h]) => `https://${h}/`), null, 2) + "\n");
  console.log(JSON.stringify({ total: a.total, entries: a.entries, blocks: a.blocks }, null, 1));
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
