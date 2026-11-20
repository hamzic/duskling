import type { ThemeId } from "../../shared/types";
import type { Oklch } from "./oklch";

export interface Palette { id: ThemeId; bg: Oklch; fg: Oklch; neutralHue: number; neutralChroma: number }

// Theme anchors. neutralHue/neutralChroma is the tint applied to near-achromatic
// (C < 0.02) colors: the bg anchor's own C/h, so white maps exactly to the theme background.
// Midnight's bg anchor is pure black (C 0), but its surfaces use the cool 260 hue at fg chroma 0.004.
export const PALETTES: Record<ThemeId, Palette> = {
  dark: { id: "dark", bg: { l: 0.22, c: 0.005, h: 260, a: 1 }, fg: { l: 0.92, c: 0.005, h: 260, a: 1 }, neutralHue: 260, neutralChroma: 0.005 },
  midnight: { id: "midnight", bg: { l: 0, c: 0, h: 0, a: 1 }, fg: { l: 0.88, c: 0.004, h: 260, a: 1 }, neutralHue: 260, neutralChroma: 0.004 },
  dim: { id: "dim", bg: { l: 0.25, c: 0.012, h: 70, a: 1 }, fg: { l: 0.86, c: 0.03, h: 80, a: 1 }, neutralHue: 70, neutralChroma: 0.012 },
};
