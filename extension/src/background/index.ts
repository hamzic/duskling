// Background: keeps the dynamic content-script registrations in step with the settings, proxies
// resource fetches for the engine, and syncs settings with the native handler.
//
// Platform facts (@mdn/browser-compat-data 8.1.6, safari_ios): runtime.onMessage 15, returning a Promise from the
// listener ("return_promise") 15.4; runtime.sendNativeMessage 15, and Safari ignores its application-id argument
// (Apple, "Messaging between the app and JavaScript in a Safari web extension"). scripting.* 16.4.
// Measured in the iOS Simulator: re-registration injects into open pages and unregister-all + register leaves a gap, so changed
// registrations go through updateContentScripts; Safari injects across registrations in call order, so new
// registrations keep the planner's order (specific classes before the default).
import { handleFetchResource } from "./fetch-resource";
import { NativeSync } from "./native-sync";
import { planRegistrations, type PlannedScript } from "./registrations";
import type { RuntimeMessage } from "../shared/messages";
import { canonicalJson, parseSettings, SETTINGS_KEY } from "../shared/settings";

type Script = DuskBrowser.RegisteredContentScript;
type Browser = typeof browser;
export type BackgroundApi = {
  storage: Pick<Browser["storage"], "local" | "onChanged">;
  scripting: Pick<Browser["scripting"], "registerContentScripts" | "updateContentScripts" | "unregisterContentScripts" | "getRegisteredContentScripts">;
  runtime: Pick<Browser["runtime"], "id" | "sendNativeMessage" | "onMessage" | "onStartup" | "onInstalled" | "getManifest">;
  tabs: Pick<Browser["tabs"], "onActivated">;
};

const NATIVE_APP_ID = "application.id"; // ignored by Safari
export const CHANGE_DEBOUNCE_MS = 250;
export const TAB_SYNC_THROTTLE_MS = 60_000;
export const VISIBLE_SYNC_THROTTLE_MS = 2_000;
export const HEARTBEAT_THROTTLE_MS = 60 * 60_000;

/** Comparable form: Safari may omit defaults or empty arrays when it returns registrations. */
function comparable(s: Script): string {
  return canonicalJson({
    id: s.id,
    matches: s.matches ?? [],
    excludeMatches: s.excludeMatches ?? [],
    js: (s.js ?? []).map((p) => p.replace(/^\//, "")),
    css: (s.css ?? []).map((p) => p.replace(/^\//, "")),
    allFrames: s.allFrames ?? false,
    runAt: s.runAt ?? "document_idle",
    world: s.world ?? "ISOLATED",
    persistAcrossSessions: s.persistAcrossSessions ?? true,
  });
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}

export function createBackground(api: BackgroundApi) {
  const local = api.storage.local;
  const nativeSync = new NativeSync({
    storage: { get: (k) => local.get(k), set: (i) => local.set(i) },
    send: (msg) => api.runtime.sendNativeMessage(NATIVE_APP_ID, msg),
    version: () => api.runtime.getManifest().version,
  });

  let regChain: Promise<void> = Promise.resolve();
  async function applyNow(): Promise<void> {
    const settings = parseSettings((await local.get(SETTINGS_KEY))[SETTINGS_KEY]);
    const plan: PlannedScript[] = planRegistrations(settings);
    const current = new Map((await api.scripting.getRegisteredContentScripts()).map((s) => [s.id, s]));
    const planned = new Set(plan.map((s) => s.id));
    const removed = [...current.keys()].filter((id) => !planned.has(id));
    const changed = plan.filter((s) => current.has(s.id) && comparable(current.get(s.id) as Script) !== comparable(s));
    const added = plan.filter((s) => !current.has(s.id));
    if (removed.length) await api.scripting.unregisterContentScripts({ ids: removed });
    if (changed.length) await api.scripting.updateContentScripts(changed);
    if (added.length) await api.scripting.registerContentScripts(added);
  }
  /** Diff the planned registrations against the registered ones by id. Calls are serialized. */
  function applyRegistrations(): Promise<void> {
    const run = regChain.then(applyNow).catch((e: unknown) => console.warn("Duskling: applying registrations failed", e));
    regChain = run;
    return run;
  }

  function boot(reason: string): void {
    void applyRegistrations();
    void nativeSync.sync(reason);
    lastHeartbeat = Date.now();
    void nativeSync.heartbeat();
  }

  let lastHeartbeat = -Infinity;
  let lastTabSync = -Infinity;
  let lastVisibleSync = -Infinity;
  // In-memory only: if Safari unloads the non-persistent background inside the 250 ms window, the pending
  // re-registration and change-sync are lost. Storage keeps the change, so the next startup, popup open or tab
  // activation applies and syncs it.
  let debounce: ReturnType<typeof setTimeout> | undefined;
  let syncAfterDebounce = false;

  api.runtime.onInstalled.addListener(() => boot("install"));
  api.runtime.onStartup.addListener(() => boot("startup"));

  api.storage.onChanged.addListener((changes, area) => {
    const change = changes[SETTINGS_KEY];
    if (area !== "local" || !change) return;
    if (!nativeSync.takeRemoteChange(change.newValue)) syncAfterDebounce = true;
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      const doSync = syncAfterDebounce;
      syncAfterDebounce = false;
      void applyRegistrations().then(() => (doSync ? nativeSync.sync("change") : undefined));
    }, CHANGE_DEBOUNCE_MS);
  });

  api.tabs.onActivated.addListener(() => {
    const now = Date.now();
    if (now - lastTabSync < TAB_SYNC_THROTTLE_MS) return;
    lastTabSync = now;
    void nativeSync.sync("tab");
  });

  api.runtime.onMessage.addListener((message, sender) => {
    // Only this extension's own scripts (MessageSender.id, safari_ios 15).
    if (sender.id !== api.runtime.id || !isRecord(message)) return undefined;
    const msg = message as RuntimeMessage;
    switch (msg.type) {
      case "fetchResource": {
        if (typeof msg.url !== "string" || (msg.as !== "text" && msg.as !== "blob")) return Promise.resolve({ ok: false });
        return handleFetchResource(msg, { tabUrl: sender.tab?.url, frameUrl: sender.url });
      }
      case "popupOpened": {
        const jobs = [nativeSync.sync("popup")];
        const now = Date.now();
        if (now - lastHeartbeat >= HEARTBEAT_THROTTLE_MS) {
          lastHeartbeat = now;
          jobs.push(nativeSync.heartbeat());
        }
        return Promise.all(jobs).then(() => undefined);
      }
      case "syncSettings": {
        // An iOS app can't message its extension, so app changes are pulled when Safari comes back to the front.
        const now = Date.now();
        if (now - lastVisibleSync < VISIBLE_SYNC_THROTTLE_MS) return Promise.resolve(undefined);
        lastVisibleSync = now;
        return nativeSync.sync("visible").then(() => undefined);
      }
      case "deviceInfo":
        return nativeSync.deviceInfo();
      default:
        return undefined;
    }
  });

  return { applyRegistrations, nativeSync };
}

if (typeof browser !== "undefined") createBackground(browser);
