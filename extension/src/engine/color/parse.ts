import { clamp255, fromLinear, oklabToRgba, oklchToRgba } from "./oklch";

export interface RGBA { r: number; g: number; b: number; a: number }

// CSS named colors (CSS Color 4 §6.1, 148 entries incl. gray/grey aliases), packed "name hex ..." to stay small.
const NAMED_PACKED =
  "aliceblue f0f8ff antiquewhite faebd7 aqua 00ffff aquamarine 7fffd4 azure f0ffff beige f5f5dc bisque " +
  "ffe4c4 black 000000 blanchedalmond ffebcd blue 0000ff blueviolet 8a2be2 brown a52a2a burlywood " +
  "deb887 cadetblue 5f9ea0 chartreuse 7fff00 chocolate d2691e coral ff7f50 cornflowerblue 6495ed " +
  "cornsilk fff8dc crimson dc143c cyan 00ffff darkblue 00008b darkcyan 008b8b darkgoldenrod b8860b " +
  "darkgray a9a9a9 darkgreen 006400 darkgrey a9a9a9 darkkhaki bdb76b darkmagenta 8b008b darkolivegreen " +
  "556b2f darkorange ff8c00 darkorchid 9932cc darkred 8b0000 darksalmon e9967a darkseagreen 8fbc8f " +
  "darkslateblue 483d8b darkslategray 2f4f4f darkslategrey 2f4f4f darkturquoise 00ced1 darkviolet " +
  "9400d3 deeppink ff1493 deepskyblue 00bfff dimgray 696969 dimgrey 696969 dodgerblue 1e90ff firebrick " +
  "b22222 floralwhite fffaf0 forestgreen 228b22 fuchsia ff00ff gainsboro dcdcdc ghostwhite f8f8ff gold " +
  "ffd700 goldenrod daa520 gray 808080 green 008000 greenyellow adff2f grey 808080 honeydew f0fff0 " +
  "hotpink ff69b4 indianred cd5c5c indigo 4b0082 ivory fffff0 khaki f0e68c lavender e6e6fa " +
  "lavenderblush fff0f5 lawngreen 7cfc00 lemonchiffon fffacd lightblue add8e6 lightcoral f08080 " +
  "lightcyan e0ffff lightgoldenrodyellow fafad2 lightgray d3d3d3 lightgreen 90ee90 lightgrey d3d3d3 " +
  "lightpink ffb6c1 lightsalmon ffa07a lightseagreen 20b2aa lightskyblue 87cefa lightslategray 778899 " +
  "lightslategrey 778899 lightsteelblue b0c4de lightyellow ffffe0 lime 00ff00 limegreen 32cd32 linen " +
  "faf0e6 magenta ff00ff maroon 800000 mediumaquamarine 66cdaa mediumblue 0000cd mediumorchid ba55d3 " +
  "mediumpurple 9370db mediumseagreen 3cb371 mediumslateblue 7b68ee mediumspringgreen 00fa9a " +
  "mediumturquoise 48d1cc mediumvioletred c71585 midnightblue 191970 mintcream f5fffa mistyrose ffe4e1 " +
  "moccasin ffe4b5 navajowhite ffdead navy 000080 oldlace fdf5e6 olive 808000 olivedrab 6b8e23 orange " +
  "ffa500 orangered ff4500 orchid da70d6 palegoldenrod eee8aa palegreen 98fb98 paleturquoise afeeee " +
  "palevioletred db7093 papayawhip ffefd5 peachpuff ffdab9 peru cd853f pink ffc0cb plum dda0dd " +
  "powderblue b0e0e6 purple 800080 rebeccapurple 663399 red ff0000 rosybrown bc8f8f royalblue 4169e1 " +
  "saddlebrown 8b4513 salmon fa8072 sandybrown f4a460 seagreen 2e8b57 seashell fff5ee sienna a0522d " +
  "silver c0c0c0 skyblue 87ceeb slateblue 6a5acd slategray 708090 slategrey 708090 snow fffafa " +
  "springgreen 00ff7f steelblue 4682b4 tan d2b48c teal 008080 thistle d8bfd8 tomato ff6347 turquoise " +
  "40e0d0 violet ee82ee wheat f5deb3 white ffffff whitesmoke f5f5f5 yellow ffff00 yellowgreen 9acd32";

let named: Map<string, string> | null = null;
function namedTable(): Map<string, string> {
  if (!named) {
    named = new Map();
    const t = NAMED_PACKED.split(" ");
    for (let i = 0; i < t.length; i += 2) named.set(t[i] ?? "", t[i + 1] ?? "");
  }
  return named;
}

const KEYWORDS = new Set(["transparent", "currentcolor", "inherit", "initial", "unset", "revert", "revert-layer"]);

export function isColorKeyword(v: string): boolean {
  return KEYWORDS.has(v.trim().toLowerCase());
}

const NUM = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/;
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

// One parsed channel: a number, or a percentage already divided by 100 (pct = true). "none" is 0.
interface Chan { v: number; pct: boolean }
function chan(t: string): Chan | null {
  if (t === "none") return { v: 0, pct: false };
  if (t.endsWith("%")) {
    const n = t.slice(0, -1);
    return NUM.test(n) ? { v: Number(n) / 100, pct: true } : null;
  }
  return NUM.test(t) ? { v: Number(t), pct: false } : null;
}

function map3(toks: string[], f: (x: Chan) => number): [number, number, number] | null {
  const [a, b, c] = toks.map(chan);
  return a && b && c ? [f(a), f(b), f(c)] : null;
}

function angle(t: string): number | null {
  if (t === "none") return 0;
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(deg|grad|rad|turn)?$/.exec(t);
  if (!m) return null;
  const n = Number(m[1]);
  const deg = m[2] === "rad" ? (n * 180) / Math.PI : m[2] === "grad" ? n * 0.9 : m[2] === "turn" ? n * 360 : n;
  return ((deg % 360) + 360) % 360;
}

function alphaOf(t: string | undefined): number | null {
  if (t === undefined) return 1;
  const c = chan(t);
  return c ? clamp01(c.v) : null;
}

function parseHex(h: string): RGBA | null {
  if (!/^[0-9a-f]+$/.test(h)) return null;
  let s = h;
  if (s.length === 3 || s.length === 4) s = s.replace(/./g, "$&$&");
  else if (s.length !== 6 && s.length !== 8) return null;
  const byte = (i: number) => parseInt(s.slice(i, i + 2), 16);
  return { r: byte(0), g: byte(2), b: byte(4), a: s.length === 8 ? byte(6) / 255 : 1 };
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return (l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1))) * 255;
  };
  return [f(0), f(8), f(4)];
}

// CIE Lab/LCH (D50) -> XYZ D50 -> Bradford -> XYZ D65 -> linear sRGB.
// Constants and matrices: CSS Color 4 sample code, https://www.w3.org/TR/css-color-4/#color-conversion-code
function labToRgba(L: number, a: number, b: number, alpha: number): RGBA {
  const k = 24389 / 27;
  const e = 216 / 24389;
  const f1 = (L + 16) / 116;
  const f0 = f1 + a / 500;
  const f2 = f1 - b / 200;
  const x = (f0 ** 3 > e ? f0 ** 3 : (116 * f0 - 16) / k) * (0.3457 / 0.3585);
  const y = L > k * e ? ((L + 16) / 116) ** 3 : L / k;
  const z = (f2 ** 3 > e ? f2 ** 3 : (116 * f2 - 16) / k) * ((1 - 0.3457 - 0.3585) / 0.3585);
  const X = 0.9554734527042182 * x - 0.023098536874261423 * y + 0.0632593086610217 * z;
  const Y = -0.028369706963208136 * x + 1.0099954580058226 * y + 0.021041398966943008 * z;
  const Z = 0.012314001688319899 * x - 0.020507696433477912 * y + 1.3303659366080753 * z;
  const lin: [number, number, number] = [
    3.2409699419045226 * X - 1.537383177570094 * Y - 0.4986107602930034 * Z,
    -0.9692436362808796 * X + 1.8759675015077202 * Y + 0.04155505740717559 * Z,
    0.05563007969699366 * X - 0.20397695888897652 * Y + 1.0569715142428786 * Z,
  ];
  return { r: clamp255(fromLinear(lin[0])), g: clamp255(fromLinear(lin[1])), b: clamp255(fromLinear(lin[2])), a: alpha };
}

// display-p3 (sRGB transfer function, P3 primaries, D65) -> linear P3 -> linear sRGB, clamped to the sRGB gamut. The
// matrix is lin_P3_to_XYZ followed by XYZ_to_lin_sRGB from the CSS Color 4 sample code,
// https://www.w3.org/TR/css-color-4/#color-conversion-code (both D65, so no adaptation).
function p3ToRgba([r, g, b]: [number, number, number], alpha: number): RGBA {
  const lin = (v: number): number => {
    const a = Math.abs(v);
    return a <= 0.04045 ? v / 12.92 : Math.sign(v) * ((a + 0.055) / 1.055) ** 2.4;
  };
  const [R, G, B] = [lin(r), lin(g), lin(b)];
  return {
    r: clamp255(fromLinear(1.2249401762805596 * R - 0.22494017628055993 * G)),
    g: clamp255(fromLinear(-0.04205695470968818 * R + 1.042056954709688 * G)),
    b: clamp255(fromLinear(-0.019637554590334436 * R - 0.0786360455506319 * G + 1.0982736001409663 * B)),
    a: alpha,
  };
}

const FN_ARGS = /^([a-z-]+)\(\s*(.*?)\s*\)$/;

function parseFunction(name: string, inner: string): RGBA | null {
  let toks = inner.split(/[\s,/]+/).filter(Boolean);
  let space = "";
  if (name === "color") {
    space = toks[0] ?? "";
    if (space !== "srgb" && space !== "display-p3") return null;
    toks = toks.slice(1);
  }
  if (toks.length !== 3 && toks.length !== 4) return null;
  const alpha = alphaOf(toks[3]);
  if (alpha === null) return null;
  const t0 = toks[0] ?? "";
  const t1 = toks[1] ?? "";
  const t2 = toks[2] ?? "";
  switch (name) {
    case "rgb":
    case "rgba": {
      const c = map3([t0, t1, t2], (x) => clamp255(x.pct ? x.v * 255 : x.v));
      return c && { r: c[0], g: c[1], b: c[2], a: alpha };
    }
    case "color": {
      if (space === "display-p3") {
        const c = map3([t0, t1, t2], (x) => x.v);
        return c && p3ToRgba(c, alpha);
      }
      const c = map3([t0, t1, t2], (x) => clamp255(x.v * 255));
      return c && { r: c[0], g: c[1], b: c[2], a: alpha };
    }
    case "hsl":
    case "hsla": {
      const h = angle(t0);
      const s = chan(t1);
      const l = chan(t2);
      if (h === null || !s || !l) return null;
      const [r, g, b] = hslToRgb(h, clamp01(s.pct ? s.v : s.v / 100), clamp01(l.pct ? l.v : l.v / 100));
      return { r: clamp255(r), g: clamp255(g), b: clamp255(b), a: alpha };
    }
    case "oklch": {
      const l = chan(t0);
      const c = chan(t1);
      const h = angle(t2);
      if (!l || !c || h === null) return null;
      return oklchToRgba({ l: clamp01(l.v), c: Math.max(c.pct ? c.v * 0.4 : c.v, 0), h, a: alpha });
    }
    case "oklab": {
      const l = chan(t0);
      const a = chan(t1);
      const b = chan(t2);
      if (!l || !a || !b) return null;
      return oklabToRgba(clamp01(l.v), a.pct ? a.v * 0.4 : a.v, b.pct ? b.v * 0.4 : b.v, alpha);
    }
    case "lab": {
      const l = chan(t0);
      const a = chan(t1);
      const b = chan(t2);
      if (!l || !a || !b) return null;
      return labToRgba(Math.max(0, Math.min(100, l.pct ? l.v * 100 : l.v)), a.pct ? a.v * 125 : a.v, b.pct ? b.v * 125 : b.v, alpha);
    }
    case "lch": {
      const l = chan(t0);
      const c = chan(t1);
      const h = angle(t2);
      if (!l || !c || h === null) return null;
      const cc = Math.max(c.pct ? c.v * 150 : c.v, 0);
      const rad = (h * Math.PI) / 180;
      return labToRgba(Math.max(0, Math.min(100, l.pct ? l.v * 100 : l.v)), cc * Math.cos(rad), cc * Math.sin(rad), alpha);
    }
    default:
      return null;
  }
}

/** Parse a single CSS color. Returns null for keywords (except `transparent`), `var()`, `color-mix()` and unknown syntax. */
export function parseColor(input: string): RGBA | null {
  const s = input.trim().toLowerCase();
  if (s === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
  if (s[0] === "#") return parseHex(s.slice(1));
  const fn = FN_ARGS.exec(s);
  if (fn) return parseFunction(fn[1] ?? "", fn[2] ?? "");
  const hex = namedTable().get(s);
  return hex ? parseHex(hex) : null;
}

const hex2 = (v: number): string => Math.round(clamp255(v)).toString(16).padStart(2, "0");

export function formatColor(c: RGBA): string {
  if (c.a === 1) return `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`;
  const a = Math.round(clamp01(c.a) * 1000) / 1000;
  return `rgba(${Math.round(clamp255(c.r))}, ${Math.round(clamp255(c.g))}, ${Math.round(clamp255(c.b))}, ${a})`;
}
