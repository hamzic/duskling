import type { Palette } from "../color/palettes";
import { parseColor } from "../color/parse";
import type { RGBA } from "../color/parse";
import type { Role } from "../color/transform";
import { paletteCss, transformColor, transformCssColor } from "../color/transform";
import type { VariableContext } from "./declarations";
import { propertyKind, roleFor } from "./roles";
import { closeParen, splitChannels, splitTop } from "./syntax";

const PREFIX: Record<Role, string> = { bg: "--dusk-bg--", text: "--dusk-text--", border: "--dusk-border--" };
const MAX_DEPTH = 10; // nested var() and fallbacks are resolved up to depth 10.

/**
 * How a variable is used: as a whole color (`plain`), or as the channel triple of `rgb(var(--x) / a)` or
 * `hsl(var(--x) / a)` (the Tailwind and shadcn/ui patterns, where the variable holds `255 255 255` or `0 0% 100%`).
 */
type Use = "plain" | "rgb" | "hsl";
const USES: readonly Use[] = ["plain", "rgb", "hsl"];
/**
 * `ld`: the var() targets of a `light-dark()` whose branches are colors or plain chains, with at least one chain; or of
 * `rgb()`/`hsl()` over a triple variable (`rgb(var(--x))`, `rgba(var(--x), .7)`), then with `wrap` the triple's use.
 */
interface ValueInfo { target: string | null; term: number; ld: string[] | null; wrap?: Use }
/**
 * Per defined name: values terminal per use; chain targets (any one resolving resolves the name); light-dark() and
 * rgb()/hsl() values with var() parts (resolving when all their parts do); and every edge to another name, for
 * invalidation and roles.
 */
interface NameInfo { count: number; term: [number, number, number]; targets: Map<string, number>; lds: Map<string, number>; edges: Map<string, number> }
/** Entries per value memo before it starts over, so a long-lived page's memory stays bounded. */
const MEMO_MAX = 20_000;
const NUM = String.raw`[+-]?(?:\d+\.?\d*|\.\d+)`;
const TRIPLE: Record<Exclude<Use, "plain">, RegExp> = {
  rgb: new RegExp(`^(${NUM})(\\s*,\\s*|\\s+)(${NUM})\\2(${NUM})$`),
  hsl: new RegExp(`^(${NUM})(?:deg)?(\\s*,\\s*|\\s+)(${NUM})%\\2(${NUM})%$`),
};
// Color functions other than rgb()/hsl(): var() inside them is left alone (their channels can't be redefined as a color).
const OTHER_COLOR_FN = new Set(["hwb", "lab", "lch", "oklab", "oklch", "color"]);
const CHAIN = /^var\(\s*(--[\w-]+)\s*(?:,[\s\S]*)?\)$/i;

/**
 * Selector for definitions reported from inline `style` attributes (InlineStyler). Such a definition makes the name
 * resolvable for stylesheet `var()`s, but its redefinitions are written on the element itself (`inlineDefinitions`),
 * so `definitionsCss` skips it. `:not(*)` matches no element.
 */
export const INLINE_SELECTOR = ":not(*)";

interface Def { selector: string; name: string; value: string; wrappers: readonly string[]; important: boolean; source: object | null; key: string }
type Uses = Map<Role, Set<Use>>;

const chainTarget = (v: string): string | null => CHAIN.exec(v)?.[1] ?? null;
// `var(--b)` and `var(--b, fb)` both start with "var(" and close at the end; anything longer isn't a plain chain.
const isChain = (v: string): boolean => chainTarget(v) !== null && closeParen(v, 3) === v.length - 1;

/** `[--x, use]` when the whole value is `rgb(var(--x))` / `hsl(var(--x) / a)`: a color once the triple resolves. */
// The channel part must be exactly one var() (isChain), so `rgb(var(--a)) rgb(var(--b))` doesn't match.
function wrapped(v: string): [string, Use] | null {
  const m = /^(rgb|hsl)a?\(([\s\S]*)\)$/i.exec(v);
  const c = m ? splitChannels(m[2]!).channels : "";
  return isChain(c) ? [chainTarget(c) as string, m![1]!.toLowerCase() as Use] : null;
}

/**
 * Whether a custom-property value can be redefined per role: a color (or light-dark() of two), an rgb/hsl channel triple,
 * rgb()/hsl() over a triple variable or a `var()` chain.
 */
export function canRedefine(value: string): boolean {
  const v = value.trim();
  return parseColor(v) !== null || lightDark(v) !== null || TRIPLE.rgb.test(v) || TRIPLE.hsl.test(v) || isChain(v) || wrapped(v) !== null;
}

/**
 * The two branches of `light-dark(a, b)` (CSS Color 5 §5.2, https://drafts.csswg.org/css-color-5/#light-dark; BCD
 * css.types.color.light-dark safari_ios 17.5).
 */
function lightDarkArgs(v: string): [string, string] | null {
  if (!/^light-dark\(/i.test(v) || closeParen(v, 10) !== v.length - 1) return null;
  const args = splitTop(v.slice(11, -1), ",").map((a) => a.trim());
  return args.length === 2 ? (args as [string, string]) : null;
}

/** Both branches of a `light-dark()` when both are colors without var(). */
function lightDark(v: string): [string, string] | null {
  const args = lightDarkArgs(v);
  return args && args.every((a) => parseColor(a) !== null) ? args : null;
}

function terminal(v: string, use: Use): boolean {
  return use === "plain" ? parseColor(v) !== null || lightDark(v) !== null : TRIPLE[use].test(v);
}

const round = (v: number, digits = 0): number => Math.round(v * 10 ** digits) / 10 ** digits;

function toHsl({ r, g, b }: RGBA): [number, number, number] {
  const [R, G, B] = [r / 255, g / 255, b / 255];
  const max = Math.max(R, G, B);
  const min = Math.min(R, G, B);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l * 100];
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === R ? ((G - B) / d) % 6 : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
  return [(h * 60 + 360) % 360, s * 100, l * 100];
}

/**
 * Infers each custom property's roles from where it is used and redefines it per role (CSS variables):
 * `--dusk-bg--x`, `--dusk-text--x`, `--dusk-border--x`, emitted with the original definition's selector, grouping-rule
 * wrappers, `!important` and source order, so the same definition wins the cascade.
 *
 * Invariant: no output ever references an undefined `--dusk-*` variable. A `var(--x)` is rewritten only when `--x` resolves,
 * within 10 `var()` hops, to a value that can be redefined for that use (a color, or a triple inside rgb()/hsl()). Unknown
 * variables (set only by script or inline style), non-colors (`10px`) and chains to them keep their `var()`; only a
 * fallback is transformed.
 *
 * Contract with the caller (one registry per document/theme): feed each sheet through `rewriteRuleList`, which reports
 * all of a sheet's definitions before rewriting it (tagged with `source`, inside `replaceSource` when re-emitting), then
 * write `sheetDefinitionsCss(source)` into that sheet's override and `definitionsCss()` into the shared node.
 * `onRolesChanged(names)` fires only when a later sheet makes earlier output stale:
 *  - a variable whose definitions were already written gains a role → rewrite the outputs that define or use `names`
 *    (the names include the variables they chain to);
 *  - a variable that earlier sheets used gains its first resolvable definition → re-emit the sheets that use it;
 *  - a variable defined inline (`INLINE_SELECTOR`) gains a role → the inline styler rewrites `inlineDefinitions()`.
 */
export class VariableRegistry {
  private readonly uses = new Map<string, Uses>();
  /** All definitions in observation order (a Set: replacing a source deletes in O(1)). */
  private readonly defs = new Set<Def>();
  private readonly bySource = new Map<object, Def[]>();
  /** While `replaceSource` runs: names whose emits are decided by comparing before and after the replacement. */
  private suppress: Set<string> | null = null;
  private readonly sourceIds = new WeakMap<object, number>();
  private nextSource = 1;
  private readonly defKeys = new Set<string>();
  /** Per defined name: how many of its values are terminal per use, and how many chain to each target. */
  private readonly byName = new Map<string, NameInfo>();
  private readonly chainedFrom = new Map<string, Set<string>>();
  private readonly hopsMemo = new Map<string, number>();
  /** Per definition value: its chain target and terminal uses, parsed once. */
  private readonly valueMemo = new Map<string, ValueInfo>();
  private readonly published = new Map<string, Set<Role>>();
  private readonly listeners: ((names: string[]) => void)[] = [];
  private readonly inlineNames = new Set<string>();
  private effMemo: Map<string, Uses> | null = null;

  /** `palette` transforms `var()` fallbacks in `varRef`; `definitionsCss` takes its own. */
  constructor(private palette: Palette) {}

  /** Switches the palette used for `var()` fallbacks (engine theme change); callers then re-emit their outputs. */
  setPalette(p: Palette): void {
    this.palette = p;
  }

  observeUsage(prop: string, value: string): void {
    const kind = propertyKind(prop);
    if (kind === null || kind === "blend") return;
    this.walk(value, roleFor(prop, kind), 0, "plain", true, this.palette);
  }

  /**
   * `opts.source` (any object: a stylesheet entry, an element) groups definitions so they can be written next to their
   * origin (`sheetDefinitionsCss`) and replaced as a unit (`replaceSource`). Without it they go to `definitionsCss`.
   */
  observeDefinition(selector: string, name: string, value: string, opts?: Partial<VariableContext> & { source?: object }): void {
    const v = value.trim();
    const wrappers = opts?.wrappers ?? [];
    const important = opts?.important ?? false;
    const source = opts?.source ?? null;
    const key = `${this.sourceId(source)}\n${wrappers.join("\n")}\n${selector}\n${name}\n${v}\n${important}`;
    if (this.defKeys.has(key)) return;
    this.defKeys.add(key);
    const suppress = this.suppress;
    const affected = this.dependents(name).filter((n) => !suppress?.has(n));
    const before = affected.map((n) => this.resolvableUses(n));
    this.addDef({ selector, name, value: v, wrappers, important, source, key });
    const changed = affected.filter((n, i) => this.resolvableUses(n) > (before[i] ?? 0));
    if (changed.length) this.emit(changed);
  }

  /**
   * Replaces every definition of `source` with the ones `observe` reports (re-emitting a changed sheet, or an element's
   * new inline value), so stale values don't accumulate. Emits `onRolesChanged` only for names whose resolvability
   * differs between before and after, so an unchanged re-emission emits nothing.
   */
  replaceSource(source: object, observe: () => void): void {
    const old = this.bySource.get(source);
    if (!old?.length) {
      observe();
      return;
    }
    // Only names that depend on the old definitions can change resolvability through their removal; their emits are
    // decided by comparing before and after. Work is proportional to this source's definitions, not to all of them.
    const names = new Set<string>();
    for (const d of old) for (const n of this.dependents(d.name)) names.add(n);
    const before = new Map([...names].map((n) => [n, this.resolvableUses(n)]));
    for (const d of old) this.removeDef(d);
    this.bySource.delete(source);
    this.hopsMemo.clear();
    this.effMemo = null;
    const outer = this.suppress;
    this.suppress = names;
    try {
      observe();
    } finally {
      this.suppress = outer;
    }
    const changed = [...names].filter((n) => this.resolvableUses(n) !== before.get(n));
    if (changed.length) this.emit(changed);
  }

  /** Drops every definition of `source` (a removed sheet or element). */
  forgetSource(source: object): void {
    this.replaceSource(source, () => {});
    this.sourceIds.delete(source);
  }

  /** Number of stored definitions (diagnostics and tests). */
  get size(): number {
    return this.defs.size;
  }

  varRef(value: string, role: Role): string {
    return this.walk(value, role, 0, "plain", true, this.palette);
  }

  rolesOf(name: string): Set<Role> {
    return new Set(this.uses.get(name)?.keys());
  }

  onRolesChanged(cb: (names: string[]) => void): void {
    this.listeners.push(cb);
  }

  /** `[property, value]` redefinitions for an inline `name: value` (see INLINE_SELECTOR), for the roles known now. */
  inlineDefinitions(name: string, value: string): [string, string][] {
    const out: [string, string][] = [];
    for (const [role, set] of this.effectiveUses().get(name) ?? []) {
      for (const use of set) {
        const v = this.resolves(name, use) ? this.redefine(value.trim(), role, use, this.palette) : null;
        if (v === null) continue;
        out.push([`${PREFIX[role]}${name.slice(2)}`, v]);
        break;
      }
    }
    return out;
  }

  /** The shared `:root` variables plus the redefinitions of definitions observed without a source. */
  definitionsCss(palette: Palette): string {
    const pc = paletteCss(palette);
    const shared = `:root{--dusk-neutral-bg:${pc.bg};--dusk-neutral-text:${pc.fg};--dusk-selection-bg:${pc.selectionBg};--dusk-selection-text:${pc.selectionText};}`;
    return shared + this.defsCss([...this.defs].filter((d) => d.source === null && d.selector !== INLINE_SELECTOR), palette);
  }

  /**
   * Redefinitions of `source`'s definitions, to be written in that source's own override (next to the
   * original definition), so they keep the source's cascade position.
   */
  sheetDefinitionsCss(source: object, palette: Palette): string {
    return this.defsCss((this.bySource.get(source) ?? []).filter((d) => d.selector !== INLINE_SELECTOR), palette);
  }

  private defsCss(defs: Def[], palette: Palette): string {
    let css = "";
    const uses = this.effectiveUses();
    // Consecutive definitions with the same selector and wrappers share a block; source order is kept.
    let key = "";
    let open: Def | null = null;
    let body = "";
    const flush = (): void => {
      if (open && body) css += open.wrappers.reduceRight((inner, w) => `${w}{${inner}}`, `${open.selector}{${body}}`);
      body = "";
    };
    for (const d of defs) {
      const u = uses.get(d.name);
      if (!u) continue;
      let decls = "";
      for (const [role, set] of u) {
        for (const use of set) {
          const v = this.resolves(d.name, use) ? this.redefine(d.value, role, use, palette) : null;
          if (v === null) continue;
          decls += `${PREFIX[role]}${d.name.slice(2)}:${v}${d.important ? " !important" : ""};`;
          break;
        }
      }
      if (!decls) continue;
      const k = `${d.wrappers.join("\n")}\n${d.selector}`;
      if (k !== key) {
        flush();
        key = k;
        open = d;
      }
      body += decls;
    }
    flush();
    for (const d of defs) this.published.set(d.name, new Set(uses.get(d.name)?.keys()));
    return css;
  }

  private emit(names: string[]): void {
    for (const cb of this.listeners) cb(names);
  }

  private sourceId(source: object | null): number {
    if (!source) return 0;
    let id = this.sourceIds.get(source);
    if (id === undefined) this.sourceIds.set(source, (id = this.nextSource++));
    return id;
  }

  private addDef(d: Def): void {
    this.defs.add(d);
    if (d.source) {
      const list = this.bySource.get(d.source);
      if (list) list.push(d);
      else this.bySource.set(d.source, [d]);
    }
    this.effMemo = null;
    // Only a value that gives `d.name` a new terminal use or chain target changes resolution, and only for names that
    // reach `d.name`; clearing every memo here made each definition re-resolve all others (github.com, whose themes
    // define each variable many times: ~0.7 s of its 1 s of rewriting).
    if (this.index(d)) for (const n of this.reaching(d.name)) for (const use of USES) this.hopsMemo.delete(`${n}|${use}`);
  }

  /** `name` plus every variable that chains to it, used or not (within MAX_DEPTH hops). */
  private reaching(name: string): Set<string> {
    const out = new Set<string>([name]);
    let frontier = [name];
    for (let d = 0; d < MAX_DEPTH && frontier.length; d++) {
      const next: string[] = [];
      for (const n of frontier) {
        for (const f of this.chainedFrom.get(n) ?? []) {
          if (out.has(f)) continue;
          out.add(f);
          next.push(f);
        }
      }
      frontier = next;
    }
    return out;
  }

  private valueInfo(v: string): ValueInfo {
    let i = this.valueMemo.get(v);
    if (!i) {
      if (this.valueMemo.size >= MEMO_MAX) this.valueMemo.clear();
      let term = 0;
      for (let k = 0; k < USES.length; k++) if (terminal(v, USES[k] as Use)) term |= 1 << k;
      let ld: string[] | null = null;
      const args = term & 1 ? null : lightDarkArgs(v);
      if (args) {
        const ts = args.map((a) => (parseColor(a) !== null ? "" : isChain(a) ? chainTarget(a) : null));
        if (ts.every((t) => t !== null)) ld = (ts as string[]).filter(Boolean);
      }
      const w = term & 1 ? null : wrapped(v);
      this.valueMemo.set(v, (i = { target: isChain(v) ? chainTarget(v) : null, term, ld: w ? [w[0]] : ld, wrap: w?.[1] }));
    }
    return i;
  }

  /** Undoes `addDef` + `index` for one definition (memos are cleared by the caller). */
  private removeDef(d: Def): void {
    this.defs.delete(d);
    this.defKeys.delete(d.key);
    const info = this.byName.get(d.name);
    if (!info) return;
    const { target, term, ld } = this.valueInfo(d.value);
    for (let k = 0; k < USES.length; k++) if (term & (1 << k)) info.term[k]!--;
    if (target) {
      const n = (info.targets.get(target) ?? 1) - 1;
      if (n > 0) info.targets.set(target, n);
      else info.targets.delete(target);
    }
    if (ld) {
      const n = (info.lds.get(d.value) ?? 1) - 1;
      if (n > 0) info.lds.set(d.value, n);
      else info.lds.delete(d.value);
    }
    for (const t of target ? [target] : ld ?? []) {
      const n = (info.edges.get(t) ?? 1) - 1;
      if (n > 0) info.edges.set(t, n);
      else {
        info.edges.delete(t);
        const from = this.chainedFrom.get(t);
        from?.delete(d.name);
        if (from?.size === 0) this.chainedFrom.delete(t);
      }
    }
    if (--info.count === 0) this.byName.delete(d.name);
  }

  /** Indexes `d` by name; true when it gives the name a new terminal use or chain target. */
  private index(d: Def): boolean {
    if (d.selector === INLINE_SELECTOR) this.inlineNames.add(d.name);
    let info = this.byName.get(d.name);
    if (!info) this.byName.set(d.name, (info = { count: 0, term: [0, 0, 0], targets: new Map(), lds: new Map(), edges: new Map() }));
    let changed = info.count++ === 0;
    const { target, term, ld } = this.valueInfo(d.value);
    for (let k = 0; k < USES.length; k++) if (term & (1 << k) && info.term[k]!++ === 0) changed = true;
    if (target) {
      const n = info.targets.get(target) ?? 0;
      info.targets.set(target, n + 1);
      if (n === 0) changed = true;
    }
    if (ld) {
      const n = info.lds.get(d.value) ?? 0;
      info.lds.set(d.value, n + 1);
      if (n === 0) changed = true;
    }
    for (const t of target ? [target] : ld ?? []) {
      const n = info.edges.get(t) ?? 0;
      info.edges.set(t, n + 1);
      if (n === 0) {
        const from = this.chainedFrom.get(t);
        if (from) from.add(d.name);
        else this.chainedFrom.set(t, new Set([d.name]));
      }
    }
    return changed;
  }

  /** `name` plus the variables its definitions chain to (their effective roles follow `name`'s). */
  private chainClosure(name: string): string[] {
    const out = new Set<string>([name]);
    let frontier = [name];
    for (let d = 0; d < MAX_DEPTH && frontier.length; d++) {
      const next: string[] = [];
      for (const n of frontier) {
        for (const t of this.byName.get(n)?.edges.keys() ?? []) {
          if (!out.has(t)) {
            out.add(t);
            next.push(t);
          }
        }
      }
      frontier = next;
    }
    return [...out];
  }

  private record(name: string, role: Role, use: Use): void {
    let u = this.uses.get(name);
    if (!u) this.uses.set(name, (u = new Map()));
    let set = u.get(role);
    const newRole = !set;
    if (!set) u.set(role, (set = new Set()));
    if (!set.has(use)) {
      set.add(use);
      this.effMemo = null;
    }
    if (!newRole) return;
    const pub = this.published.get(name);
    if ((pub ? !pub.has(role) : this.inlineNames.has(name)) && this.resolves(name, use)) this.emit(this.chainClosure(name));
  }

  /** `var()` hops from `name` to a value redefinable for `use`, or Infinity past MAX_DEPTH, unknown names and cycles. */
  private hops(name: string, use: Use, budget = MAX_DEPTH): number {
    const info = this.byName.get(name);
    if (!info) return Infinity;
    if (info.term[USES.indexOf(use)]! > 0) return 0;
    if (budget === 0) return Infinity;
    let best = Infinity;
    for (const t of info.targets.keys()) best = Math.min(best, 1 + this.hops(t, use, budget - 1));
    // light-dark() and rgb(var(--triple)) are whole colors: they resolve for plain uses once each of their var() parts
    // does (a triple for its own use).
    if (use === "plain") {
      for (const v of info.lds.keys()) {
        let worst = 0;
        const { ld, wrap } = this.valueInfo(v);
        for (const t of ld ?? []) worst = Math.max(worst, this.hops(t, wrap ?? use, budget - 1));
        best = Math.min(best, 1 + worst);
      }
    }
    return best;
  }

  private resolves(name: string, use: Use): boolean {
    const key = `${name}|${use}`;
    let h = this.hopsMemo.get(key);
    if (h === undefined) this.hopsMemo.set(key, (h = this.hops(name, use)));
    return h <= MAX_DEPTH;
  }

  /** Number of this name's recorded uses that resolve (to detect a definition that newly makes it rewritable). */
  private resolvableUses(name: string): number {
    let n = 0;
    for (const set of this.uses.get(name)?.values() ?? []) for (const use of set) if (this.resolves(name, use)) n++;
    return n;
  }

  /** `name` plus every used variable that chains to it (within MAX_DEPTH hops). */
  private dependents(name: string): string[] {
    return [...this.reaching(name)].filter((n) => this.uses.has(n));
  }

  /** Recorded uses propagated along `--a: var(--b)` chains. */
  private effectiveUses(): Map<string, Uses> {
    if (this.effMemo) return this.effMemo;
    const eff = new Map<string, Uses>();
    for (const [n, u] of this.uses) eff.set(n, new Map([...u].map(([r, s]) => [r, new Set(s)])));
    for (let grew = true, pass = 0; grew && pass <= MAX_DEPTH; pass++) {
      grew = false;
      // Per chaining name rather than per definition: a theme-heavy page defines each variable many times.
      for (const [name, info] of this.byName) {
        if (info.edges.size === 0) continue;
        const from = eff.get(name);
        if (!from) continue;
        // A plain use of `rgb(var(--t))` is an rgb use of --t.
        const wraps = new Map<string, Use>();
        for (const v of info.lds.keys()) {
          const { ld, wrap } = this.valueInfo(v);
          if (wrap) wraps.set(ld![0]!, wrap);
        }
        for (const target of info.edges.keys()) {
          let to = eff.get(target);
          if (!to) eff.set(target, (to = new Map()));
          for (const [role, set] of from) {
            let t = to.get(role);
            if (!t) to.set(role, (t = new Set()));
            for (const use of set) {
              const u = use === "plain" ? (wraps.get(target) ?? use) : use;
              if (t.has(u)) continue;
              t.add(u);
              grew = true;
            }
          }
        }
      }
    }
    this.effMemo = eff;
    return eff;
  }

  private redefine(value: string, role: Role, use: Use, palette: Palette): string | null {
    if (isChain(value)) {
      if (!this.resolves(chainTarget(value) as string, use)) return null;
      return this.walk(value, role, 0, use, false, palette);
    }
    const { ld, wrap } = use === "plain" ? this.valueInfo(value) : { ld: null };
    if (ld) {
      if (!ld.every((t) => this.resolves(t, wrap ?? use))) return null;
      if (wrap) return this.walk(value, role, 0, use, false, palette);
      const [a, b] = (lightDarkArgs(value) as [string, string]).map((x) => (isChain(x) ? this.walk(x, role, 0, use, false, palette) : transformCssColor(x, role, palette)));
      return a && b ? `light-dark(${a}, ${b})` : null;
    }
    if (!terminal(value, use)) return null;
    if (use === "plain") {
      const ld = lightDark(value);
      if (!ld) return transformCssColor(value, role, palette);
      // Both branches: an element whose own color-scheme stays light still picks the first one.
      const [a, b] = ld.map((c) => transformCssColor(c, role, palette));
      return a && b ? `light-dark(${a}, ${b})` : null;
    }
    const sep = (TRIPLE[use].exec(value)?.[2] ?? " ").includes(",") ? ", " : " ";
    const parsed = parseColor(`${use}(${value})`);
    if (!parsed) return null;
    const t = transformColor({ ...parsed, a: 1 }, role, palette);
    if (use === "rgb") return [t.r, t.g, t.b].map((c) => round(Math.min(255, Math.max(0, c)))).join(sep);
    const [h, s, l] = toHsl({ r: round(t.r), g: round(t.g), b: round(t.b), a: 1 });
    return `${round(h, 1)}${sep}${round(s, 1)}%${sep}${round(l, 1)}%`;
  }

  /** Rewrites every var() in `s` for `role` (`use` applies to a top-level var()); records uses when `record` is set. */
  private walk(s: string, role: Role, depth: number, use: Use, record: boolean, palette: Palette): string {
    if (depth > MAX_DEPTH) return s;
    let out = "";
    for (let i = 0; i < s.length; ) {
      const ch = s[i] as string;
      if (ch === '"' || ch === "'") {
        let j = i + 1;
        while (j < s.length && s[j] !== ch) j += s[j] === "\\" ? 2 : 1;
        out += s.slice(i, j + 1);
        i = j + 1;
        continue;
      }
      const m = /^[a-zA-Z-][\w-]*\(/.exec(s.slice(i, i + 40));
      if (!m || (i > 0 && /[\w-]/.test(s[i - 1] as string))) {
        out += ch;
        i++;
        continue;
      }
      const open = i + m[0].length - 1;
      const close = closeParen(s, open);
      out += this.fn(m[0].slice(0, -1).toLowerCase(), s.slice(i, open + 1), s.slice(open + 1, close), role, depth, use, record, palette);
      i = close + 1;
    }
    return out;
  }

  private fn(name: string, head: string, args: string, role: Role, depth: number, use: Use, record: boolean, palette: Palette): string {
    const original = `${head}${args})`;
    if (name === "var") {
      const comma = args.indexOf(",");
      const varName = (comma === -1 ? args : args.slice(0, comma)).trim();
      const fallback = comma === -1 ? undefined : args.slice(comma + 1).trim();
      if (record) this.record(varName, role, use);
      const fb = fallback === undefined ? "" : `, ${this.fallback(fallback, role, depth + 1, use, record, palette)}`;
      if (this.resolves(varName, use)) return `var(${PREFIX[role]}${varName.slice(2)}${fb})`;
      return fallback === undefined ? original : `var(${varName}${fb})`;
    }
    const triple: Use | null = name === "rgb" || name === "rgba" ? "rgb" : name === "hsl" || name === "hsla" ? "hsl" : null;
    if (triple) {
      // Only a single var() in the channel position is a redefinable triple; an alpha var() is kept as is.
      const { channels } = splitChannels(args);
      if (!isChain(channels)) return original;
      const start = args.indexOf(channels);
      const rewritten = this.fn("var", "var(", channels.slice(4, -1), role, depth + 1, triple, record, palette);
      return `${head}${args.slice(0, start)}${rewritten}${args.slice(start + channels.length)})`;
    }
    if (name === "url" || OTHER_COLOR_FN.has(name)) return original;
    return `${head}${this.walk(args, role, depth + 1, "plain", record, palette)})`;
  }

  private fallback(fb: string, role: Role, depth: number, use: Use, record: boolean, palette: Palette): string {
    if (depth > MAX_DEPTH) return fb;
    if (/var\(/i.test(fb)) return this.walk(fb, role, depth, use, record, palette);
    if (use !== "plain") return fb;
    return transformCssColor(fb, role, palette) ?? fb;
  }
}
