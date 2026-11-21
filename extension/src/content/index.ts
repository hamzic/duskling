// Content bootstrap.
//
// The effective (mode, theme, dimImages) of this host arrives synchronously: the matching engine registration lists
// ["boot/<class>.js", "content.js"], injected in array order into one shared ISOLATED world (MDN RegisteredContentScript
// `js`: https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/scripting/RegisteredContentScript),
// so the boot file's `globalThis.__duskBoot` is already set here. The engine starts from it at once; storage is read
// once afterwards only to reconcile (stale registration, iOS 18 overlap, respectNativeDark, a "use" native-dark rule).
// Without a boot global (old registration) a single storage read comes first.
//
// Re-registration (scripting.updateContentScripts) injects content.js again into open pages (measured in the iOS 26.5 and 18.6 Simulators), so
// the instance lives on a Symbol.for global in the isolated world and a second run only reconciles.
import { createEngine } from "../engine/index";
import type { Engine, EngineBridge } from "../engine/index";
import type { Boot } from "../shared/boot";
import type { FetchResult, PageStatus } from "../shared/messages";
import { normalizeHost, resolveSiteRule } from "../shared/rules";
import { SETTINGS_KEY, parseSettings } from "../shared/settings";
import { effectiveMode, siteDefaultFor } from "../shared/site-defaults";
import type { EffectiveRule, Mode } from "../shared/types";

export const CONTENT_KEY = Symbol.for("dusk.content");
export const STATUS_TIMEOUT_MS = 1000;

export interface ContentDeps {
  api: Pick<typeof browser, "storage" | "runtime">;
  win: Window & typeof globalThis;
  createEngine: typeof createEngine;
}

type Global = Record<symbol | string, unknown>;

function bootRule(b: unknown): EffectiveRule | null {
  if (typeof b !== "object" || b === null) return null;
  const { mode, theme, dimImages, respectNativeDark } = b as Partial<Boot>;
  if (mode !== "full" && mode !== "gentle" && mode !== "filter") return null;
  if (theme !== "dark" && theme !== "midnight" && theme !== "dim") return null;
  // The boot class already holds the effective mode (site default applied by the planner), hence modeIsExplicit.
  // respectNativeDark is encoded only when off (boot.ts engineClass), so a missing value means on.
  return { enabled: true, mode, modeIsExplicit: true, theme, respectNativeDark: respectNativeDark !== false, trustNativeDark: false, dimImages: dimImages === true, matchedHost: null };
}

/**
 * By design, an embedded frame follows the rule of the site it's on, so turning a site off turns its
 * embeds off too. The top page's origin is the last entry of `location.ancestorOrigins` (MDN Location.ancestorOrigins; BCD 8.1.6
 * `api.Location.ancestorOrigins` safari_ios 6). Registrations still match the frame's own URL, so its pre-paint and boot
 * class follow its own host until this rule is applied.
 */
function topHostname(win: Window): string {
  if (win === win.top) return win.location.hostname;
  const origins = win.location.ancestorOrigins;
  const top = origins?.[origins.length - 1];
  try {
    return top ? new URL(top).hostname : win.location.hostname;
  } catch {
    return win.location.hostname;
  }
}

export function runContent(d: ContentDeps): void {
  const { api, win } = d;
  const g = win as unknown as Global;
  const existing = g[CONTENT_KEY] as { reconcile(): Promise<void> } | undefined;
  if (existing) {
    void existing.reconcile();
    return;
  }
  const doc = win.document;
  const host = normalizeHost(topHostname(win));
  const siteDefault = siteDefaultFor(host);
  const modeOf = (r: EffectiveRule): Mode => (r.enabled ? effectiveMode(r, siteDefault) : "off");

  let engine: Engine | null = null;
  let rule: EffectiveRule | null = null;
  let seq = 0;
  let ready!: () => void;
  const started = new Promise<void>((r) => (ready = r));

  const fetchResource = async (url: string, as: "text" | "blob"): Promise<FetchResult> => {
    try {
      const r = await api.runtime.sendMessage({ type: "fetchResource", url, as });
      return typeof r === "object" && r !== null && (r as FetchResult).ok === true ? (r as FetchResult) : { ok: false };
    } catch {
      return { ok: false };
    }
  };

  // The bridge (MAIN world) and this script share only the DOM, so they talk through CustomEvents with string details.
  // A sheet change on a shadow host nested in another shadow root is retargeted on its way to document, so the original
  // target comes from composedPath() (DOM §2.9 retargeting, https://dom.spec.whatwg.org/#retarget).
  const origin = (e: Event): EventTarget | null => e.composedPath()[0] ?? e.target;
  const bridge: EngineBridge = {
    setPromotion: (on) => void doc.dispatchEvent(new win.CustomEvent("dusk:native-promotion", { detail: on ? "on" : "off" })),
    setClosedRepair: (on) => void doc.dispatchEvent(new win.CustomEvent("dusk:closed-repair", { detail: on ? "on" : "off" })),
    onSheetChange: (cb) =>
      doc.addEventListener("dusk:sheet-change", (e) => {
        const t = origin(e);
        if (t === doc) cb(doc);
        else if ((t as Element | null)?.shadowRoot) cb((t as Element).shadowRoot!);
      }),
    onShadowAttached: (cb) =>
      doc.addEventListener("dusk:shadow-attached", (e) => {
        const t = origin(e) as Element | null;
        if (t?.nodeType === 1) cb(t);
      }),
  };

  const setReady = (): void => {
    if (!doc.documentElement.hasAttribute("data-dusk-ready")) doc.documentElement.setAttribute("data-dusk-ready", "");
  };

  // Failsafe: whatever goes wrong while starting, data-dusk-ready must end up set, or the pre-paint CSS would stay on.
  const apply = (next: EffectiveRule): void => {
    rule = next;
    try {
      if (engine) engine.update(next).catch(setReady); // the engine itself no-ops on an equal rule
      else if (modeOf(next) === "off") setReady();
      else {
        engine = d.createEngine({ doc, win, rule: next, siteDefault, fetchResource, bridge });
        engine.start().catch(setReady);
      }
    } catch {
      setReady();
    }
    ready();
  };

  const resolve = (raw: unknown): EffectiveRule => resolveSiteRule(parseSettings(raw), host);

  /** One storage read; dropped if a newer onChanged value arrived meanwhile. */
  const reconcile = async (): Promise<void> => {
    const mine = ++seq;
    let raw: unknown;
    try {
      raw = (await api.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY];
    } catch {
      // A failed read must not replace a rule already in force (the boot class) with the defaults.
      if (rule) return;
      raw = undefined;
    }
    if (mine === seq) apply(resolve(raw));
  };

  Object.defineProperty(g, CONTENT_KEY, { value: { reconcile }, configurable: true });

  // Theming first: the boot rule is applied before anything else can throw.
  const boot = bootRule(g["__duskBoot"]);
  if (boot) apply(boot);
  void reconcile();

  try {
    api.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !(SETTINGS_KEY in changes)) return;
      seq++;
      apply(resolve(changes[SETTINGS_KEY]!.newValue));
    });

    // A page restored from the back/forward cache missed every onChanged while frozen (HTML §7.4.6.4 pageshow `persisted`:
    // https://html.spec.whatwg.org/multipage/nav-history-apis.html#pagetransitionevent).
    win.addEventListener("pageshow", (e) => {
      if ((e as PageTransitionEvent).persisted) void reconcile();
    });

    // Settings changed in the app reach the extension only when it asks (an iOS app can't message its extension), and the
    // user comes back from the app to a page becoming visible. The top frame asks; the background throttles.
    if (win === win.top) {
      // Safari runs content scripts only on websites the user allowed, so this reaching the app is how its setup check
      // knows the extension has website access. The background throttles; nothing about the page is sent.
      api.runtime.sendMessage({ type: "pageSeen" }).catch(() => undefined);
      doc.addEventListener("visibilitychange", () => {
        if (doc.visibilityState === "visible") api.runtime.sendMessage({ type: "syncSettings" }).catch(() => undefined);
      });
    }

    api.runtime.onMessage.addListener((message, sender) => {
      if (sender.id !== api.runtime.id) return undefined;
      if ((message as { type?: unknown } | null)?.type !== "pageStatus") return undefined;
      // tabs.sendMessage without frameId reaches every frame; only the top frame answers.
      if (win !== win.top) return undefined;
      // Answers within STATUS_TIMEOUT_MS even if the first storage read hangs (current or off status then).
      return Promise.race([started, new Promise<void>((r) => win.setTimeout(r, STATUS_TIMEOUT_MS))]).then((): PageStatus =>
        engine?.status() ?? { host, mode: rule ? modeOf(rule) : "off", theme: rule?.theme ?? "dark", nativeDark: "none", active: false },
      );
    });
  } catch {
    // A missing API leaves the page themed by its first rule; nothing else to do.
  }
}

if (typeof browser !== "undefined") runContent({ api: browser, win: window, createEngine });
