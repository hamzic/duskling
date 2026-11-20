import type { Palette } from "../color/palettes";
import { isColorKeyword, parseColor } from "../color/parse";
import type { Role } from "../color/transform";
import { transformCssColor } from "../color/transform";
import type { Mode } from "../../shared/types";
import { isGentleProp, propertyKind, roleFor } from "./roles";
import { scan, splitChannels } from "./syntax";

export interface VariableContext { wrappers: readonly string[]; important: boolean }

export interface RewriteCtx {
  palette: Palette;
  mode: Mode;
  varRef: (value: string, role: Role) => string;
  imageHint?: (url: string) => "invert" | "dim" | "none";
  /**
   * Synchronous lookup of analyzed background images: the replacement `data:` URL for a dark icon or
   * light texture, else null. Called with the absolute URL; unanalyzed URLs are queued by the provider.
   */
  imageUrl?: (url: string) => string | null;
  /**
   * Custom-property declarations (`--*`) seen by the rule rewriter. `selector` is resolved through CSS nesting;
   * `opts.wrappers` are the enclosing grouping-rule preludes (outermost first, e.g. `@media (max-width: 600px)`).
   * rewriteRuleList reports all of a rule list's definitions before it rewrites any declaration.
   */
  onVariable?: (selector: string, name: string, value: string, opts: VariableContext) => void;
  /**
   * Set per rule by the rule rewriter when the rule has a `mask-image` / `-webkit-mask-image` other than `none`.
   * The mask turns the background color into the icon color, so `background-color` (and the color in `background`)
   * then takes the text role (mask icons).
   */
  ruleHasMask?: boolean;
  /**
   * Base URL of the sheet being rewritten. Overrides live in a different sheet (whose base is the document), so relative
   * `url()`s in emitted declarations are made absolute against it (rules.ts).
   */
  baseUrl?: string;
  /** Rules of an `@import` whose sheet can't be read (cross-origin); the style manager fetches them. */
  importRules?: (url: string) => CSSRuleList | null;
}

// Functions whose whole token is one color (CSS Color 4/5). With var() inside they go to ctx.varRef as a unit.
const COLOR_FN = new Set(["rgb", "rgba", "hsl", "hsla", "hwb", "lab", "lch", "oklab", "oklch", "color"]);
// Functions whose arguments may contain colors: gradients (incl. legacy -webkit-gradient and its stop functions),
// color-mix(), light-dark(), alpha() and image() (Safari 27 release notes). Anything else (url(), image-set(), calc(), …) is
// opaque.
const NESTED_FN = /^(?:-webkit-)?(?:repeating-)?(?:linear|radial|conic)-gradient$|^-webkit-gradient$|^(?:from|to|color-stop|color-mix|light-dark|alpha|image)$/;
// Blend remap.
const BLEND_TO_NORMAL = new Set(["multiply", "darken", "color-burn", "screen", "lighten", "color-dodge"]);
const MAX_DEPTH = 10;
// Gentle mode rewrites background-color, color and border-*-color. These shorthands carry those colors (e.g. when
// a var() in the shorthand leaves the longhands empty), so in gentle mode only their plain color tokens are rewritten.
const GENTLE_SHORTHAND = new Set(["background", "border", "border-top", "border-right", "border-bottom", "border-left"]);

const changed = (out: string, input: string): string | null => (out === input ? null : out);

const HAS_VAR = /var\(/i;

/**
 * A color function with literal channels and a var() alpha (Tailwind's `rgb(255 255 255 / var(--tw-bg-opacity))`):
 * the channels are transformed at alpha 1 and the alpha text is kept.
 */
function literalChannels(name: string, args: string, role: Role, ctx: RewriteCtx): string | null {
  const { channels, alpha } = splitChannels(args);
  if (alpha === undefined || HAS_VAR.test(channels) || !HAS_VAR.test(alpha)) return null;
  const t = transformCssColor(`${name}(${channels})`, role, ctx.palette);
  const c = t === null ? null : parseColor(t);
  if (!c) return null;
  return `rgb(${Math.round(c.r)} ${Math.round(c.g)} ${Math.round(c.b)} / ${alpha})`;
}

function rewriteToken(tok: string, role: Role, ctx: RewriteCtx, depth: number, gentle: boolean): string | null {
  const open = tok.indexOf("(");
  if (open > 0 && tok.endsWith(")")) {
    const name = tok.slice(0, open).toLowerCase();
    if (name === "var") return changed(ctx.varRef(tok, role), tok);
    if (COLOR_FN.has(name)) {
      if (!HAS_VAR.test(tok)) return transformCssColor(tok, role, ctx.palette);
      return literalChannels(name, tok.slice(open + 1, -1), role, ctx) ?? changed(ctx.varRef(tok, role), tok);
    }
    if (gentle || !NESTED_FN.test(name) || depth >= MAX_DEPTH) return null;
    const inner = rewriteValue(tok.slice(open + 1, -1), () => role, ctx, depth + 1, false);
    return inner === null ? null : `${tok.slice(0, open + 1)}${inner})`;
  }
  // `transparent` and other keywords stay as they are; hex and named colors are transformed.
  if (open !== -1 || isColorKeyword(tok)) return null;
  return transformCssColor(tok, role, ctx.palette);
}

function rewriteValue(value: string, roleAt: (i: number) => Role, ctx: RewriteCtx, depth: number, gentle: boolean): string | null {
  const parts = scan(value);
  let any = false;
  let i = 0;
  for (const part of parts) {
    if (!part.tok) continue;
    const out = rewriteToken(part.text, roleAt(i++), ctx, depth, gentle);
    if (out !== null) {
      part.text = out;
      any = true;
    }
  }
  return any ? parts.map((x) => x.text).join("") : null;
}

function remapBlend(value: string): string | null {
  const items = value.split(",").map((v) => v.trim());
  if (!items.some((v) => BLEND_TO_NORMAL.has(v.toLowerCase()))) return null;
  return items.map((v) => (BLEND_TO_NORMAL.has(v.toLowerCase()) ? "normal" : v)).join(", ");
}

const URL_TOK = /^url\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^)\s]*))\s*\)$/i;

/** Top-level `url()` tokens whose image analysis has a replacement are swapped for it. */
function replaceImages(value: string, ctx: RewriteCtx, lookup: (url: string) => string | null): string | null {
  if (!/url\(/i.test(value)) return null;
  const parts = scan(value);
  let any = false;
  for (const part of parts) {
    const m = part.tok ? URL_TOK.exec(part.text) : null;
    if (!m) continue;
    const raw = (m[1] ?? m[2] ?? m[3] ?? "").replace(/\\(.)/g, "$1");
    let abs: string;
    try {
      abs = new URL(raw, ctx.baseUrl ?? globalThis.document?.baseURI).href;
    } catch {
      continue;
    }
    const next = raw && !raw.startsWith("#") ? lookup(abs) : null;
    if (next === null) continue;
    part.text = `url("${next.replace(/["\\]/g, "\\$&")}")`;
    any = true;
  }
  return any ? parts.map((x) => x.text).join("") : null;
}

/**
 * Rewrites one declaration value (without `!important`, which the caller keeps). Returns the new value, or null
 * when nothing changes. Full mode rewrites every color-bearing property; gentle mode only background-color,
 * color and border-*-color, including those colors inside the background/border shorthands. Both remap blend modes.
 */
export function rewriteDeclaration(prop: string, value: string, ctx: RewriteCtx): string | null {
  if (ctx.mode !== "full" && ctx.mode !== "gentle") return null;
  const kind = propertyKind(prop);
  if (kind === null) return null;
  if (kind === "blend") return remapBlend(value);
  const gentle = ctx.mode === "gentle";
  if (gentle && !isGentleProp(prop) && !GENTLE_SHORTHAND.has(prop)) return null;
  if (prop === "scrollbar-color") return rewriteValue(value, (i) => (i === 0 ? "border" : "bg"), ctx, 0, gentle);
  const role = roleFor(prop, kind, ctx.ruleHasMask);
  const images = !gentle && ctx.imageUrl && (kind === "image" || kind === "background-shorthand") ? replaceImages(value, ctx, ctx.imageUrl) : null;
  return rewriteValue(images ?? value, () => role, ctx, 0, gentle) ?? images;
}

const hasMaskValue = (v: string): boolean => v !== "" && v.trim().toLowerCase() !== "none";

/** True when the declaration block sets `mask-image` or `-webkit-mask-image` to anything but `none`. */
export function ruleHasMask(style: CSSStyleDeclaration): boolean {
  return hasMaskValue(style.getPropertyValue("mask-image")) || hasMaskValue(style.getPropertyValue("-webkit-mask-image"));
}
