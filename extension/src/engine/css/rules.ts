import { rewriteDeclaration, ruleHasMask } from "./declarations";
import type { RewriteCtx } from "./declarations";
import { splitTop } from "./syntax";

export type Kind = "style" | "decls" | "media" | "supports" | "layer" | "container" | "scope" | "import" | "skip";

// Rule types are detected without relying on globals such as CSSLayerBlockRule, which happy-dom lacks.
// CSSRule.type is defined for the legacy rule types only; newer rules report 0 (CSSOM §6.4.2,
// https://drafts.csswg.org/cssom/#dom-cssrule-type), so those are told apart by constructor name with a cssText fallback.
const BY_NAME: Record<string, Kind> = {
  CSSLayerBlockRule: "layer",
  CSSContainerRule: "container",
  CSSScopeRule: "scope",
  CSSNestedDeclarations: "decls",
};
const BY_PREFIX: [string, Kind][] = [["@layer", "layer"], ["@container", "container"], ["@scope", "scope"]];

export function kindOf(rule: CSSRule): Kind {
  switch (rule.type) {
    case 1: return "style";
    case 3: return "import";
    case 4: return "media";
    case 12: return "supports";
    case 0: break;
    default: return "skip"; // @font-face, @keyframes, @page, @namespace, @counter-style, …
  }
  const name = rule.constructor?.name;
  if (name && Object.hasOwn(BY_NAME, name)) return BY_NAME[name] as Kind;
  const text = rule.cssText;
  for (const [prefix, kind] of BY_PREFIX) if (text.startsWith(prefix)) return "cssRules" in rule ? kind : "skip";
  return text[0] !== "@" && "style" in rule ? "decls" : "skip";
}

// `@media print` blocks are never touched. A media query list applies on screen unless every query in it is
// print-only (`print`, `only print`, `print and (…)`); `not print` and `print, (min-width: 900px)` still apply.
const PRINT_QUERY = /^\s*(?:only\s+)?print\b/i;
export const printOnly = (mediaText: string): boolean => mediaText.trim() !== "" && splitTop(mediaText, ",").every((q) => PRINT_QUERY.test(q));

// When a shorthand contains var(), its longhands serialize as "" (pending-substitution value, CSS Variables §3.2.1,
// https://drafts.csswg.org/css-variables/#variables-in-shorthands; verified in WebKit), so the color is only visible on
// the shorthand. Color-bearing longhands → shorthands to try, most specific first.
const SIDES = ["top", "right", "bottom", "left"];
const SHORTHANDS = new Map<string, string[]>([
  ["background-color", ["background"]],
  ["background-image", ["background"]],
  ["outline-color", ["outline"]],
  ...SIDES.map((s): [string, string[]] => [`border-${s}-color`, [`border-${s}`, "border-color", "border"]]),
]);

const preludeOf = (rule: CSSRule): string => rule.cssText.slice(0, rule.cssText.indexOf("{")).trim();

// CSS Nesting §3.1: a nested selector is relative to its parent; `&` stands for the parent as `:is(parent)`
// (https://drafts.csswg.org/css-nesting/#nest-selector), and a selector without `&` is a descendant of it.
function resolveSelector(selector: string, parent: string): string {
  if (!parent) return selector;
  return splitTop(selector, ",")
    .map((s) => (s.includes("&") ? s.trim().replaceAll("&", `:is(${parent})`) : `:is(${parent}) ${s.trim()}`))
    .join(", ");
}

interface Scope { selector: string; wrappers: readonly string[] }

function variables(style: CSSStyleDeclaration, scope: Scope, ctx: RewriteCtx): void {
  const report = ctx.onVariable;
  if (!report) return;
  for (let i = 0; i < style.length; i++) {
    const prop = style.item(i);
    if (!prop.startsWith("--")) continue;
    report(scope.selector, prop, style.getPropertyValue(prop), { wrappers: scope.wrappers, important: style.getPropertyPriority(prop) === "important" });
  }
}

/**
 * Calls `emit` for every color declaration in `style` that the rewrite changes (shorthands are used when a var() leaves
 * their longhands empty). Shared by the rule rewriter and the inline styler.
 */
export function rewriteStyle(style: CSSStyleDeclaration, ctx: RewriteCtx, emit: (prop: string, value: string, important: boolean) => void): void {
  const mask = ruleHasMask(style);
  const c = mask === Boolean(ctx.ruleHasMask) ? ctx : { ...ctx, ruleHasMask: mask };
  let done: Set<string> | null = null;
  for (let i = 0; i < style.length; i++) {
    let prop = style.item(i);
    if (prop.startsWith("--")) continue;
    let value = style.getPropertyValue(prop);
    if (value === "") {
      const sh = SHORTHANDS.get(prop)?.find((s) => !done?.has(s) && style.getPropertyValue(s) !== "");
      if (!sh) continue;
      (done ??= new Set()).add(sh);
      prop = sh;
      value = style.getPropertyValue(sh);
    }
    const next = rewriteDeclaration(prop, value, c);
    if (next !== null) emit(prop, next, style.getPropertyPriority(prop) === "important");
  }
}

const HAS_SCHEME = /^[a-z][a-z\d+.-]*:/i;
const IDENT_CHAR = /[\w-]/;

function absoluteUrl(u: string, base: string): string | null {
  if (u === "" || u.startsWith("#") || HAS_SCHEME.test(u)) return null; // data:, http:, … and fragments stay
  try {
    return `url("${new URL(u, base).href.replace(/["\\]/g, "\\$&")}")`;
  } catch {
    return null;
  }
}

/** Index after the string literal starting at `i` (a quote), honoring backslash escapes. */
function stringEnd(css: string, i: number): number {
  const q = css[i];
  let j = i + 1;
  while (j < css.length && css[j] !== q) j += css[j] === "\\" ? 2 : 1;
  return Math.min(j + 1, css.length);
}

/**
 * One pass over CSS text that leaves string literals alone: removes comments (`strip`) and/or makes relative `url()`s
 * absolute against `base` (CSS Values 4 §4.5.1: relative URLs resolve against the style sheet's URL,
 * https://drafts.csswg.org/css-values-4/#relative-urls). Fragment-only (`url(#grad)`) and `data:` URLs stay as they are.
 */
function scanCss(css: string, base: string | null, strip: boolean): string {
  let out = "";
  let i = 0;
  while (i < css.length) {
    const ch = css[i] as string;
    if (ch === '"' || ch === "'") {
      const end = stringEnd(css, i);
      out += css.slice(i, end);
      i = end;
    } else if (strip && ch === "/" && css[i + 1] === "*") {
      const end = css.indexOf("*/", i + 2);
      i = end === -1 ? css.length : end + 2;
    } else if (base && (ch === "u" || ch === "U") && /^url\(/i.test(css.slice(i, i + 4)) && !(i > 0 && IDENT_CHAR.test(css[i - 1] as string))) {
      let j = i + 4;
      while (/\s/.test(css[j] ?? "")) j++;
      let url: string;
      let close: number;
      if (css[j] === '"' || css[j] === "'") {
        const end = stringEnd(css, j);
        url = css.slice(j + 1, end - 1);
        close = css.indexOf(")", end);
      } else {
        close = css.indexOf(")", j);
        url = css.slice(j, close === -1 ? css.length : close).trim();
      }
      if (close === -1) {
        out += css.slice(i);
        break;
      }
      out += absoluteUrl(url.trim(), base) ?? css.slice(i, close + 1);
      i = close + 1;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

/** Makes relative `url()`s in `css` absolute against `base`, outside string literals (see scanCss). */
export function absolutizeUrls(css: string, base: string): string {
  return css.includes("url(") || /url\(/i.test(css) ? scanCss(css, base, false) : css;
}

/** Removes comments from CSS text, leaving string literals (which may contain comment markers) alone. */
export const stripCssComments = (css: string): string => (css.includes("/*") ? scanCss(css, null, true) : css);

function declarations(style: CSSStyleDeclaration, ctx: RewriteCtx): string {
  let out = "";
  const base = ctx.baseUrl;
  rewriteStyle(style, ctx, (prop, value, important) => {
    out += `${prop}:${base ? absolutizeUrls(value, base) : value}${important ? " !important" : ""};`;
  });
  return out;
}

function childRules(rule: CSSRule): CSSRuleList | null {
  const list = (rule as CSSRule & { cssRules?: CSSRuleList }).cssRules;
  return list && list.length > 0 ? list : null;
}

function importUrl(imp: CSSImportRule, ctx: RewriteCtx): string | null {
  const href = imp.styleSheet?.href ?? imp.href;
  try {
    // An @import in a <style> resolves against the document's base URL (CSS Values 4 §4.5.1).
    return new URL(href, ctx.baseUrl ?? globalThis.document?.baseURI).href;
  } catch {
    return null;
  }
}

function importedRules(imp: CSSImportRule, url: string | null, ctx: RewriteCtx): CSSRuleList | null {
  try {
    return imp.styleSheet?.cssRules ?? null; // Throws SecurityError for cross-origin sheets.
  } catch {
    return url && ctx.importRules ? ctx.importRules(url) : null;
  }
}

/** One pass over a rule list: `vars` reports custom properties only; otherwise it appends overrides to `out`. */
function walk(rules: CSSRuleList | readonly CSSRule[], ctx: RewriteCtx, out: string[], scope: Scope, vars: boolean): void {
  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i] as CSSRule;
    const kind = kindOf(rule);
    if (kind === "skip") continue;
    if (kind === "style") {
      const r = rule as CSSStyleRule;
      const inner: Scope = { selector: resolveSelector(r.selectorText, scope.selector), wrappers: scope.wrappers };
      const nested = childRules(r);
      if (vars) {
        variables(r.style, inner, ctx);
        if (nested) walk(nested, ctx, out, inner, true);
        continue;
      }
      let body = declarations(r.style, ctx);
      // CSS nesting: nested rules stay nested in the override, so relative selectors keep their meaning.
      if (nested) {
        const children: string[] = [];
        walk(nested, ctx, children, inner, false);
        body += children.join("");
      }
      if (body) out.push(`${r.selectorText}{${body}}`);
      continue;
    }
    if (kind === "decls") {
      const style = (rule as CSSStyleRule).style;
      if (vars) variables(style, scope, ctx);
      else {
        const body = declarations(style, ctx);
        if (body) out.push(body);
      }
      continue;
    }
    let prelude: string;
    let list: CSSRuleList | null;
    let c = ctx;
    if (kind === "import") {
      const mediaText = (rule as CSSImportRule).media?.mediaText ?? "";
      if (printOnly(mediaText)) continue;
      prelude = mediaText ? `@media ${mediaText}` : "";
      const url = importUrl(rule as CSSImportRule, ctx);
      list = importedRules(rule as CSSImportRule, url, ctx);
      if (url) c = { ...ctx, baseUrl: url };
    } else {
      if (kind === "media") {
        const mediaText = (rule as CSSMediaRule).media.mediaText;
        if (printOnly(mediaText)) continue;
        prelude = `@media ${mediaText}`;
      } else if (kind === "supports") prelude = `@supports ${(rule as CSSSupportsRule).conditionText}`;
      else if (kind === "layer") prelude = `@layer ${(rule as CSSRule & { name: string }).name}`.trimEnd();
      else prelude = preludeOf(rule); // @container, @scope
      list = childRules(rule);
    }
    if (!list) continue;
    const inner: string[] = [];
    walk(list, c, inner, prelude ? { selector: scope.selector, wrappers: [...scope.wrappers, prelude] } : scope, vars);
    if (inner.length) out.push(prelude ? `${prelude}{${inner.join("")}}` : inner.join(""));
  }
}

/**
 * Appends override CSS for every changed color declaration: style rules keep their selector and `!important`,
 * grouping rules (@media, @supports, @layer, @container, @scope) are kept around their rewritten children, print-only
 * media is skipped, @import is followed when readable, and @font-face/@keyframes/@page are left alone.
 *
 * Custom properties are not emitted. When `ctx.onVariable` is set, every definition in the list is reported first (with
 * its nesting-resolved selector and wrappers), so usages earlier in the list than their definition still resolve.
 */
export function rewriteRuleList(rules: CSSRuleList | readonly CSSRule[], ctx: RewriteCtx, out: string[]): void {
  const root: Scope = { selector: "", wrappers: [] };
  if (ctx.onVariable) walk(rules, ctx, [], root, true);
  walk(rules, ctx, out, root, false);
}
