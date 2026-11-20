// Draws the app icon: a filled Ember circle on near-black.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BG = [0x0b, 0x0b, 0x0d];
const EMBER = [0xf0, 0xa8, 0x48];

// rgb: write without an alpha channel. App Store Connect rejects a 1024 icon that has one, even when every pixel is
// opaque (ITMS-90717: "can't be transparent nor contain an alpha channel").
function icon(size, rgb = false) {
  const png = new PNG({ width: size, height: size });
  const c = (size - 1) / 2;
  const r = size * 0.3;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // 4x4 supersampling for a smooth edge
      let hit = 0;
      for (let sy = 0; sy < 4; sy++)
        for (let sx = 0; sx < 4; sx++) {
          const dx = x + (sx + 0.5) / 4 - 0.5 - c;
          const dy = y + (sy + 0.5) / 4 - 0.5 - c;
          if (dx * dx + dy * dy <= r * r) hit++;
        }
      const t = hit / 16;
      const i = (y * size + x) * 4;
      for (let k = 0; k < 3; k++) png.data[i + k] = Math.round(BG[k] + (EMBER[k] - BG[k]) * t);
      png.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(png, rgb ? { colorType: 2 } : {});
}

const ext = join(root, "src/icons");
mkdirSync(ext, { recursive: true });
for (const s of [48, 96, 128, 256, 512]) writeFileSync(join(ext, `icon-${s}.png`), icon(s));

const set = join(root, "..", "apple/App/Assets.xcassets/AppIcon.appiconset");
mkdirSync(set, { recursive: true });
writeFileSync(join(set, "icon-1024.png"), icon(1024, true));
writeFileSync(
  join(set, "Contents.json"),
  JSON.stringify(
    { images: [{ filename: "icon-1024.png", idiom: "universal", platform: "ios", size: "1024x1024" }], info: { author: "xcode", version: 1 } },
    null,
    2,
  ) + "\n",
);
writeFileSync(
  join(root, "..", "apple/App/Assets.xcassets/Contents.json"),
  JSON.stringify({ info: { author: "xcode", version: 1 } }, null, 2) + "\n",
);
