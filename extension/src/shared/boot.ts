import type { Mode, ThemeId } from "./types";

// Boot files: the effective (mode, theme, dimImages, respectNativeDark) of a host is encoded by which registration
// matches it. Each `engine-<class>-<level>` registration lists ["boot/<class>.js", "content.js"];
// files in one registration's js array are injected in array order (MDN RegisteredContentScript `js`:
// https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/scripting/RegisteredContentScript) and share
// the ISOLATED world, so content.js reads the rule synchronously at document_start. `??=` makes the first boot file win
// if two registrations ever overlap (insurance for iOS 18 excludeMatches, measured in the iOS 18.6 Simulator).

export interface Boot { mode: Exclude<Mode, "off">; theme: ThemeId; dimImages: boolean; respectNativeDark: boolean }

const BOOT_MODES = ["full", "gentle", "filter"] as const;
const BOOT_THEMES: readonly ThemeId[] = ["dark", "midnight", "dim"];

/**
 * `-ignore` marks respectNativeDark off, so content.js never starts native-dark detection the
 * user turned off before the reconcile read lands. Filter mode doesn't detect native dark, so it has no such class.
 */
export function engineClass(mode: Mode, theme: ThemeId, dimImages: boolean, respectNativeDark = true): string | null {
  if (mode === "off") return null;
  return `${mode}-${theme}${dimImages ? "-dim" : ""}${!respectNativeDark && mode !== "filter" ? "-ignore" : ""}`;
}

export const BOOT_CLASSES: readonly string[] = [
  ...new Set(
    BOOT_MODES.flatMap((m) => BOOT_THEMES.flatMap((t) => [false, true].flatMap((d) => [true, false].map((r) => engineClass(m, t, d, r) as string)))),
  ),
];

export function parseEngineClass(cls: string): Boot {
  const [mode, theme, ...flags] = cls.split("-");
  const dimImages = flags[0] === "dim";
  const respectNativeDark = flags.at(-1) !== "ignore";
  const b = { mode: mode as Boot["mode"], theme: theme as ThemeId, dimImages, respectNativeDark };
  // Round trip: only the exact spelling engineClass produces is a class.
  if (!BOOT_MODES.includes(b.mode) || !BOOT_THEMES.includes(b.theme) || engineClass(b.mode, b.theme, dimImages, respectNativeDark) !== cls) {
    throw new Error(`unknown engine class: ${cls}`);
  }
  return b;
}

export function bootJs(cls: string): string {
  const b = parseEngineClass(cls);
  return `globalThis.__duskBoot ??= {mode:${JSON.stringify(b.mode)},theme:${JSON.stringify(b.theme)},dimImages:${b.dimImages}${b.respectNativeDark ? "" : ",respectNativeDark:false"}};`;
}

/** File name (relative to dist/boot/) → contents, for every class. */
export const bootFiles = (): Record<string, string> => Object.fromEntries(BOOT_CLASSES.map((c) => [`${c}.js`, bootJs(c)]));
