// Small CSS value tokenizing helpers shared by the declaration rewriter and the variable registry.

export interface Part { text: string; tok: boolean }

const isSpace = (ch: string): boolean => ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f";

/** Splits a value into top-level tokens and separators (whitespace, commas), respecting parentheses, quotes and escapes. */
export function scan(s: string): Part[] {
  const out: Part[] = [];
  let cur = "";
  let sep = false;
  let depth = 0;
  let quote = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i] as string;
    if (quote || ch === "\\") {
      cur += ch;
      if (ch === "\\" && i + 1 < s.length) cur += s[++i];
      else if (ch === quote) quote = "";
      continue;
    }
    const isSep = depth === 0 && (ch === "," || isSpace(ch));
    if (isSep !== sep && cur) {
      out.push({ text: cur, tok: !sep });
      cur = "";
    }
    sep = isSep;
    cur += ch;
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")" && depth > 0) depth--;
  }
  if (cur) out.push({ text: cur, tok: !sep });
  return out;
}

/** Index of the parenthesis closing the one at `open`, or `s.length`. */
export function closeParen(s: string, open: number): number {
  let depth = 0;
  let quote = "";
  for (let i = open; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0) return i;
  }
  return s.length;
}

/** Splits `s` at top-level occurrences of `sep` (outside parentheses and quotes). */
export function splitTop(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = "";
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (depth === 0 && ch === sep) {
      out.push(s.slice(start, i));
      start = i + 1;
    }
  }
  out.push(s.slice(start));
  return out;
}

/**
 * Splits color-function arguments into the channel part and the alpha part:
 * `255 255 255 / var(--o)`, `255, 255, 255, .5` (legacy 4-argument form) and `var(--rgb), .5` (one channel argument).
 */
export function splitChannels(args: string): { channels: string; alpha?: string } {
  const slash = splitTop(args, "/");
  if (slash.length === 2) return { channels: (slash[0] as string).trim(), alpha: (slash[1] as string).trim() };
  const commas = splitTop(args, ",");
  if (commas.length === 4 || commas.length === 2) {
    return { channels: commas.slice(0, -1).join(",").trim(), alpha: (commas[commas.length - 1] as string).trim() };
  }
  return { channels: args.trim() };
}
