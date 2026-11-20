// Regenerates the binary fixture assets in pages/assets/ (deterministic). Run: node test/fixtures/make-assets.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const { PNG } = createRequire(import.meta.url)("pngjs");
const OUT = fileURLToPath(new URL("./pages/assets/", import.meta.url));
mkdirSync(OUT, { recursive: true });

function png(name, w, h, px) {
  const p = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b, a = 255] = px(x, y);
      const i = (y * w + x) * 4;
      p.data[i] = r;
      p.data[i + 1] = g;
      p.data[i + 2] = b;
      p.data[i + 3] = a;
    }
  }
  writeFileSync(OUT + name, PNG.sync.write(p));
}

// Seeded PRNG so the files are byte-stable.
let seed = 42;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

const CLEAR = [0, 0, 0, 0];
const INK = [24, 24, 28, 255];

// Dark monochrome wordmark on transparent (≥ 50 % transparent, dark, no chroma): the classifier should invert it.
png("logo-dark.png", 120, 40, (x, y) => {
  const bar = (x0, x1, y0, y1) => x >= x0 && x < x1 && y >= y0 && y < y1;
  const ring = (cx, cy, r0, r1) => { const d = Math.hypot(x - cx, y - cy); return d >= r0 && d < r1; };
  return bar(6, 12, 6, 34) || ring(12, 20, 8, 14) && x >= 12 || ring(48, 20, 8, 14) || bar(70, 76, 6, 34) || bar(70, 92, 6, 12) || bar(100, 106, 6, 34) || bar(100, 116, 28, 34) ? INK : CLEAR;
});

// Colored brand mark on transparent: chroma ≥ 0.05, must never be inverted.
png("logo-brand.png", 40, 40, (x, y) => (Math.hypot(x - 20, y - 20) < 16 ? [220, 60, 40, 255] : CLEAR));

// Photo-like: smooth multi-hue gradient with noise (far more than 64 colors).
png("photo.png", 320, 200, (x, y) => {
  const n = (rnd() - 0.5) * 30;
  const c = (v) => Math.max(0, Math.min(255, Math.round(v + n)));
  return [c(80 + 150 * (x / 320)), c(120 + 100 * Math.sin(y / 30)), c(200 - 120 * (y / 200))];
});

// Sprite sheet: four 16×16 dark glyphs on transparent (search, menu, close, plus).
png("sprite.png", 64, 16, (x, y) => {
  const cell = Math.floor(x / 16), lx = x % 16;
  let on = false;
  if (cell === 0) on = Math.abs(Math.hypot(lx - 6, y - 6) - 4) < 1.2 || (lx > 9 && y > 9 && Math.abs(lx - y) < 1.5);
  if (cell === 1) on = lx >= 2 && lx < 14 && (y === 3 || y === 4 || y === 7 || y === 8 || y === 11 || y === 12);
  if (cell === 2) on = lx >= 2 && lx < 14 && y >= 2 && y < 14 && (Math.abs(lx - y) < 1.2 || Math.abs(lx + y - 15) < 1.2);
  if (cell === 3) on = (lx >= 7 && lx < 9 && y >= 2 && y < 14) || (y >= 7 && y < 9 && lx >= 2 && lx < 14);
  return on ? INK : CLEAR;
});

// Light repeating texture tile (≥ 85 % of pixels L > 0.85, smaller than 128 px).
png("texture.png", 16, 16, (x, y) => ((x + y) % 8 === 0 ? [232, 232, 236] : [248, 248, 250]));

// Large light decorative image (wider than half the viewport when shown at 100 %).
png("light-banner.png", 800, 120, (x, y) => [246, 246 - (y % 5), 250]);

// Product shot on a white backdrop, the kind shops put under mix-blend-mode: multiply.
png("product.png", 200, 200, (x, y) => {
  const inBottle = Math.abs(x - 100) < 36 && y > 50 && y < 180;
  const inCap = Math.abs(x - 100) < 16 && y > 26 && y <= 50;
  if (inCap) return [30, 60, 140];
  if (inBottle) return [40 + Math.round(60 * (x - 64) / 72), 140, 90 + Math.round(y / 4)];
  return [255, 255, 255];
});

console.log(`assets written to ${OUT}`);
