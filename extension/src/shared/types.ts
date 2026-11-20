export type ThemeId = "dark" | "midnight" | "dim";
export type Mode = "full" | "gentle" | "filter" | "off";
export interface Stamped<T> { value: T; updatedAt: number }
export interface SiteRule { mode?: Mode; theme?: ThemeId; nativeDark?: "ignore" | "use"; dimImages?: boolean; updatedAt: number; deleted?: boolean }
export interface Settings {
  schemaVersion: 1;
  global: { enabled: Stamped<boolean>; theme: Stamped<ThemeId>; respectNativeDark: Stamped<boolean>; dimImages: Stamped<boolean> };
  sites: Record<string, SiteRule>;
}
export interface EffectiveRule { enabled: boolean; mode: Mode; modeIsExplicit: boolean; theme: ThemeId; respectNativeDark: boolean; trustNativeDark: boolean; dimImages: boolean; matchedHost: string | null }
