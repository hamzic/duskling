// Page-context bridge (MAIN world; CSS-in-JS and the media-query signal). Registered at document start, it runs
// before page scripts. It reports CSSOM changes and open shadow roots to the engine through DOM events
// (string details only), can make matchMedia report a dark color scheme for script-driven themes, and runs the
// contrast-repair pass inside closed shadow roots.
//
// Two bundles come from this file: build.mjs defines __PROMOTE__ false (bridge.js) or true (bridge-promote.js).
//
// Worlds: the engine runs in Safari's isolated content-script world, which gets "a separate copy of the environment"
// (https://developer.apple.com/documentation/webkit/wkcontentworld). Its writes never go through the prototype patches
// below, and expandos it sets on a CSSStyleSheet wrapper (Symbol.for("dusk.own")) are most likely not visible here.
// So recognizing Duskling's own sheets is best effort: `data-dusk` on the owner node is shared DOM state and always works,
// the Symbol only helps in the single-world Playwright harness. An unrecognized Duskling sheet costs at most one extra
// dusk:sheet-change, which the engine handles idempotently.
declare const __PROMOTE__: boolean;

type Win = Window & typeof globalThis;
type Listener = EventListenerOrEventListenerObject;

const SCHEME = /(prefers-color-scheme\s*:\s*)(dark|light)/gi;

export function installBridge(w: Win, promote: boolean): void {
  // Installing twice (e.g. both bundles registered by mistake) would double-wrap every patch.
  const mark = Symbol.for("dusk.bridge");
  if ((w as unknown as Record<symbol, unknown>)[mark]) return;
  Object.defineProperty(w, mark, { value: true });
  const doc = w.document;
  const own = (s: CSSStyleSheet | null | undefined) =>
    !!s && (!!(s as unknown as Record<symbol, unknown>)[Symbol.for("dusk.own")] || !!(s.ownerNode as Element | null)?.hasAttribute?.("data-dusk"));

  // Same name and length as the native function (toString masking is out of scope).
  const keep = <F extends (...a: never[]) => unknown>(fn: F, orig: (...a: never[]) => unknown): F => {
    Object.defineProperty(fn, "name", { value: orig.name });
    Object.defineProperty(fn, "length", { value: orig.length });
    return fn;
  };
  const fire = (t: EventTarget, type: string, bubbles: boolean, detail = "") =>
    t.dispatchEvent(new w.CustomEvent(type, { bubbles, composed: bubbles, detail }));

  // dusk:sheet-change, coalesced per microtask and per target (document, or the shadow host).
  const pending = new Set<EventTarget>();
  const changed = (root: Node | null | undefined) => {
    const t = root instanceof w.ShadowRoot ? root.host : doc;
    if (!pending.size) queueMicrotask(() => {
      // Snapshot first: a listener that changes a sheet again starts a fresh batch instead of being dropped.
      const batch = [...pending];
      pending.clear();
      for (const p of batch) fire(p, "dusk:sheet-change", p !== doc);
    });
    pending.add(t);
  };
  const sheetChanged = (s: CSSStyleSheet) => own(s) || changed(s.ownerNode?.getRootNode());

  // Grouping rules (@media, @supports, ...) are where JSS-style libraries insert nested rules; report their sheet.
  let depth = 0; // a native method calling another patched one (happy-dom's replace calls replaceSync) reports once
  const targets: [object | undefined, string[], (t: never) => CSSStyleSheet | null][] = [
    [w.CSSStyleSheet?.prototype, ["insertRule", "deleteRule", "replaceSync", "replace"], (t: CSSStyleSheet) => t],
    [w.CSSGroupingRule?.prototype, ["insertRule", "deleteRule"], (t: CSSRule) => t.parentStyleSheet],
  ];
  for (const [P, keys, sheetOf] of targets) {
    const proto = P as Record<string, (...a: unknown[]) => unknown> | undefined;
    for (const k of proto ? keys : []) {
      const orig = proto![k];
      if (typeof orig !== "function") continue;
      proto![k] = keep(function (this: never, ...a: unknown[]) {
        let r;
        depth++;
        try {
          r = orig.apply(this, a);
        } finally {
          depth--;
        }
        if (depth) return r;
        const s = sheetOf(this);
        if (!(r instanceof w.Promise)) return s && sheetChanged(s), r;
        // Hand the page a promise chained on the native one, so a rejection it ignores still reaches
        // unhandledrejection (a separate .then(ok, () => {}) branch would mark the native promise handled).
        return r.then((v) => (s && sheetChanged(s), v));
      }, orig);
    }
  }

  for (const P of [w.Document.prototype, w.ShadowRoot.prototype]) {
    // Patch where the accessor lives (in happy-dom that's a base class behind the global constructor).
    let d: PropertyDescriptor | undefined, p: object | null = P;
    for (; p && !(d = Object.getOwnPropertyDescriptor(p, "adoptedStyleSheets")); p = Object.getPrototypeOf(p));
    const get = d?.get, set = d?.set;
    if (!p || !get || !set) continue;
    Object.defineProperty(p, "adoptedStyleSheets", {
      ...d,
      set: keep(function (this: Document | ShadowRoot, v: CSSStyleSheet[]) {
        const before = [...(get.call(this) as CSSStyleSheet[])];
        set.call(this, v);
        const after = [...(get.call(this) as CSSStyleSheet[])];
        // Only Duskling's own sheets added or removed: nothing for the engine to do.
        const b = before.filter((s) => !own(s)), a = after.filter((s) => !own(s));
        if (a.length !== b.length || a.some((s, i) => s !== b[i])) changed(this);
      }, set),
    });
  }

  // Closed shadow roots are unreachable from the engine's isolated world (`host.shadowRoot` is null there), so the
  // contrast-repair pass for them runs here, switched by dusk:closed-repair "on"/"off": a light opaque surface
  // (sRGB luma > 190, about OKLCH L 0.8, no background image, not media) gets var(--dusk-neutral-bg), and var(--dusk-
  // neutral-text) when its text is dark (luma < 100, about OKLCH L 0.5; descendants inherit it). Both !important inline.
  // "Off" puts a touched `style` attribute back byte-for-byte when it is still what Duskling wrote; if the page changed it
  // since, only Duskling's two properties go back to their earlier values, so the page's change stays. One observer re-runs
  // the pass on their changes, and on scroll. Like ContrastRepair, a pass reads at most 300 elements within the
  // viewport ± 1 screen height, skipping those it already repaired.
  // Roots are held weakly (an observer holds no reference to its targets), so dropped hosts are freed.
  const closed: WeakRef<ShadowRoot>[] = [];
  const saved = new Map<HTMLElement, [string | null, string | null, string]>(); // the original style attribute, Duskling's last write, the original declarations
  let repairing = false;
  let timer: ReturnType<typeof setTimeout> | 0 = 0;
  const luma = (c: string) => {
    const [r = -1, g = 0, b = 0, a = 1] = (/^rgba?\((.*)\)$/.exec(c)?.[1] ?? "").split(/[\s,/]+/).map(Number);
    return a < 1 ? -1 : (2 * r + 7 * g + b) / 10; // Rec. 709 luma weights, rounded
  };
  const put = (el: HTMLElement, p: string, v: string) => {
    const e = saved.get(el) ?? [el.getAttribute("style"), null, el.style.cssText];
    el.style.setProperty(p, v, "important");
    e[1] = el.getAttribute("style");
    saved.set(el, e);
  };
  const repairAll = () => {
    timer = 0;
    let n = 300;
    const vh = w.innerHeight;
    for (const ref of repairing ? closed : []) {
      // SVG shapes have a transparent background-color, so only HTML boxes qualify.
      for (const el of ref.deref()?.querySelectorAll<HTMLElement>("*") ?? []) {
        if (saved.has(el)) continue;
        const b = el.getBoundingClientRect();
        if (!b.width || b.bottom < -vh || b.top > 2 * vh) continue;
        if (!n--) break;
        const cs = w.getComputedStyle(el);
        if (!el.matches("img,video,canvas") && luma(cs.backgroundColor) > 190 && cs.backgroundImage === "none") {
          put(el, "background-color", "var(--dusk-neutral-bg)");
          if (luma(cs.color) < 100) put(el, "color", "var(--dusk-neutral-text)");
        }
      }
    }
    mo.takeRecords(); // our own writes
  };
  const later = () => repairing && !timer && (timer = setTimeout(repairAll, 50));
  const mo = new w.MutationObserver(later);
  w.addEventListener("scroll", later, { passive: true, capture: true });
  doc.addEventListener("dusk:closed-repair", (e) => {
    if ((repairing = (e as CustomEvent).detail === "on")) return repairAll();
    for (const [el, [v, last, css]] of saved) {
      if (el.getAttribute("style") !== last) {
        const t = doc.createElement("i").style;
        t.cssText = v ?? "";
        for (const p of ["background-color", "color"])
          if (el.style.getPropertyValue(p).startsWith("var(--dusk-")) el.style.setProperty(p, t.getPropertyValue(p), t.getPropertyPriority(p));
      } else {
        // CSSOM first: a strict CSP style-src refuses to re-parse the changed attribute (css/csp.ts).
        if (el.style.cssText !== css) el.style.cssText = css;
        // The read also flushes that write into the attribute (WebKit syncs it lazily; see css/csp.ts).
        if (el.getAttribute("style") === v) continue;
        if (v === null) el.removeAttribute("style");
        else el.setAttribute("style", v);
      }
    }
    saved.clear();
    mo.takeRecords();
  });

  // dusk:shadow-attached on the host for open roots.
  const attach = w.Element.prototype.attachShadow;
  w.Element.prototype.attachShadow = keep(function (this: Element, init: ShadowRootInit) {
    const root = attach.call(this, init);
    if (init.mode === "open") fire(this, "dusk:shadow-attached", true);
    else {
      mo.observe(root, { subtree: true, childList: true, attributes: true });
      closed.push(new WeakRef(root));
    }
    return root;
  }, attach);

  // matchMedia promotion. While on, a query mentioning prefers-color-scheme gets a wrapper. On a light system it evaluates
  // the query with dark and light swapped, which is exact for any query (not/and/or) because the system can only be one
  // of the two. Wrappers stay live after promotion turns off and then report real values, notifying their listeners.
  // `matches` is evaluated fresh on every read rather than through lists created at document start: in Playwright
  // WebKit, a MediaQueryList created by an init script keeps its first value and never fires "change" (checked while
  // writing test/unit-webkit/bridge.spec.ts), so a cached list is not something to rely on that early.
  const mm = w.matchMedia;
  const native = (q: string) => mm.call(w, q);
  const DARK = "(prefers-color-scheme: dark)";
  const live = new Map<() => void, MediaQueryList[]>(); // also keeps the watched native lists alive
  w.matchMedia = keep(function (q: string) {
    const real = native(q);
    if (!promote || !/prefers-color-scheme/i.test(q)) return real;
    const sq = String(q).replace(SCHEME, (_, p: string, v: string) => p + (/dark/i.test(v) ? "light" : "dark"));
    const matches = () => native(promote && !native(DARK).matches ? sq : q).matches;
    const m = Object.setPrototypeOf(new w.EventTarget(), w.MediaQueryList.prototype) as MediaQueryList;
    const add = w.EventTarget.prototype.addEventListener.bind(m);
    const remove = w.EventTarget.prototype.removeEventListener.bind(m);
    let last = false, hooked = false, handler: MediaQueryList["onchange"] = null, lists: MediaQueryList[] | null = null;
    // "change" registrations by capture flag, as EventTarget keys them. A wrapper is watched (and held in `live`) only
    // while it has one, so lists the page drops are collectable. `once` and `signal` removals aren't seen: such a
    // wrapper stays watched (an over-retention, never a missed event).
    const regs = [new Set<Listener>(), new Set<Listener>()];
    const sync = () => {
      const v = matches();
      if (v !== last) m.dispatchEvent(new w.MediaQueryListEvent("change", { matches: (last = v), media: real.media }));
    };
    const update = () => {
      const want = !!handler || regs.some((r) => r.size > 0);
      if (want === !!lists) return;
      if (want) {
        last = matches();
        lists = [q, sq, DARK].map(native);
        live.set(sync, lists);
      } else live.delete(sync);
      for (const l of lists!) (want ? l.addEventListener : l.removeEventListener).call(l, "change", sync);
      if (!want) lists = null;
    };
    const reg = (on: boolean) => (t: string, l: Listener | null, o?: EventListenerOptions | boolean) => {
      (on ? add : remove)(t, l, o);
      if (t === "change" && l) {
        const r = regs[+(typeof o === "boolean" ? o : !!o?.capture)]!;
        if (on) r.add(l);
        else r.delete(l);
        update();
      }
    };
    const on = reg(true), off = reg(false), ET = w.EventTarget.prototype;
    const method = (value: unknown) => ({ value, writable: true, configurable: true, enumerable: true });
    Object.defineProperties(m, {
      matches: { get: matches, configurable: true, enumerable: true },
      media: { value: real.media, configurable: true, enumerable: true },
      onchange: {
        get: () => handler,
        set(f: MediaQueryList["onchange"]) {
          if (!hooked) {
            hooked = true;
            add("change", (e) => handler?.call(m, e as MediaQueryListEvent));
          }
          handler = typeof f === "function" ? f : null;
          update();
        },
        configurable: true,
        enumerable: true,
      },
      addEventListener: method(keep((t: string, l: Listener | null, o?: AddEventListenerOptions | boolean) => on(t, l, o), ET.addEventListener)),
      removeEventListener: method(keep((t: string, l: Listener | null, o?: EventListenerOptions | boolean) => off(t, l, o), ET.removeEventListener)),
      addListener: method((l: Listener | null) => on("change", l)),
      removeListener: method((l: Listener | null) => off("change", l)),
    });
    return m;
  }, mm);

  doc.addEventListener("dusk:native-promotion", (e) => {
    const d = (e as CustomEvent).detail;
    if (d === "on" || d === "off") {
      promote = d === "on";
      for (const s of live.keys()) s();
    }
  });
}

if (typeof __PROMOTE__ !== "undefined") installBridge(window, __PROMOTE__);
