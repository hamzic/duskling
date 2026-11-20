import type { Role } from "../color/transform";

export type PropKind = Role | "shadow" | "image" | "background-shorthand" | "border-shorthand" | "blend";

// Color-bearing properties. Foreground roles: text, fill, stroke, outline, caret,
// text-decoration; stop-color is a gradient stop, so it takes the background transform.
const KINDS = new Map<string, PropKind>(Object.entries({
  color: "text",
  fill: "text",
  stroke: "text",
  "outline-color": "text",
  "caret-color": "text",
  "text-decoration-color": "text",
  // The accent tints checked controls and sits on the page like foreground ink.
  "accent-color": "text",
  "background-color": "bg",
  "stop-color": "bg",
  "column-rule-color": "border",
  // Two colors (thumb, track); rewriteDeclaration maps them positionally to border and bg.
  "scrollbar-color": "border",
  background: "background-shorthand",
  "background-image": "image",
  border: "border-shorthand",
  "border-top": "border-shorthand",
  "border-right": "border-shorthand",
  "border-bottom": "border-shorthand",
  "border-left": "border-shorthand",
  outline: "border-shorthand",
  "box-shadow": "shadow",
  "text-shadow": "shadow",
  "mix-blend-mode": "blend",
  "background-blend-mode": "blend",
} satisfies Record<string, PropKind>));

// border-color, border-top-color, border-block-start-color, border-inline-end-color, …
const BORDER_COLOR = /^border(?:-[a-z]+){0,2}-color$/;

export function propertyKind(prop: string): PropKind | null {
  return KINDS.get(prop) ?? (BORDER_COLOR.test(prop) ? "border" : null);
}

/** Gentle mode rewrites only these properties' colors. */
export const isGentleProp = (prop: string): boolean => prop === "color" || prop === "background-color" || BORDER_COLOR.test(prop);

/**
 * The transform role for a color-bearing property kind. Shadows and gradients use the background transform;
 * the `outline` shorthand is foreground like `outline-color`. With `mask` (a mask-image icon rule) the
 * background color is the icon color, so it takes the text role.
 */
export function roleFor(prop: string, kind: Exclude<PropKind, "blend">, mask = false): Role {
  if (kind === "shadow" || kind === "image") return "bg";
  if (kind === "border-shorthand") return prop === "outline" ? "text" : "border";
  if (kind === "background-shorthand") return mask ? "text" : "bg";
  if (prop === "background-color" && mask) return "text";
  return kind;
}
