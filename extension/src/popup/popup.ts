// Safari popup. Every visible string comes from _locales via i18n.getMessage.
//
// Platform facts (@mdn/browser-compat-data 8.1.6, safari_ios): tabs.query / tabs.sendMessage / tabs.create 15,
// i18n.getMessage 15, `<input type="checkbox" switch>` (html.elements.input.switch) 17.4, so the system switch is
// available on the iOS 18 floor. In the Simulator `tabs.create({url: "mailto:…"})` resolved and opened
// an empty tab (no Mail app there), so the hand-off to Mail is checked on a device; when it rejects we
// fall back to navigating the popup to the mailto URL.
import { BRAND } from "../shared/brand";
import type { PageStatus, RuntimeMessage } from "../shared/messages";
import { hostChain, normalizeHost, purgeAndLimit, resolveSiteRule, setGlobal, setSiteFields } from "../shared/rules";
import { parseSettings, SETTINGS_KEY } from "../shared/settings";
import { effectiveMode, siteDefaultFor } from "../shared/site-defaults";
import type { Mode, Settings, ThemeId } from "../shared/types";

type Browser = typeof browser;
export type PopupApi = {
  storage: { local: Pick<Browser["storage"]["local"], "get" | "set">; onChanged: Browser["storage"]["onChanged"] };
  runtime: Pick<Browser["runtime"], "sendMessage" | "getManifest">;
  tabs: Pick<Browser["tabs"], "query" | "sendMessage" | "create">;
  i18n: Browser["i18n"];
};

/** Fallback when tabs.create rejects for a mailto URL. A seam so tests can observe it. */
export const mailtoFallback = {
  open(url: string): void {
    location.href = url;
  },
};

type Device = { model: string; osVersion: string };

function readDevice(x: unknown): Device {
  const d = typeof x === "object" && x !== null ? (x as Record<string, unknown>) : {};
  return {
    model: typeof d["model"] === "string" ? d["model"] : "unknown",
    osVersion: typeof d["osVersion"] === "string" ? d["osVersion"] : "unknown",
  };
}

/** The report mail. Only the host goes in, never the URL, path or query. Line breaks are CRLF and every component is
 *  percent-encoded (RFC 6068 §2 and §5: spaces as %20, line breaks as %0D%0A). */
export function reportMailto(r: { host: string; mode: Mode; theme: ThemeId; nativeDark: PageStatus["nativeDark"]; version: string; device: Device }): string {
  const body = [
    `Site: ${r.host}`,
    `Mode: ${r.mode}`,
    `Theme: ${r.theme}`,
    `Site's own dark theme: ${r.nativeDark}`,
    `${BRAND.name} ${r.version} · iOS ${r.device.osVersion} · ${r.device.model}`,
    "",
    "What looks wrong? (A screenshot helps.)",
  ].join("\r\n");
  const subject = `Site problem: ${r.host}`;
  return `mailto:${BRAND.reportEmail}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

function isPageStatus(x: unknown): x is PageStatus {
  if (typeof x !== "object" || x === null) return false;
  const s = x as Record<string, unknown>;
  return typeof s["mode"] === "string" && typeof s["theme"] === "string" && typeof s["nativeDark"] === "string";
}

export async function initPopup(api: PopupApi, doc: Document = document): Promise<void> {
  const t = (key: string, subs?: string[]) => api.i18n.getMessage(key, subs);
  const el = <T extends HTMLElement = HTMLElement>(id: string) => doc.getElementById(id) as T;
  const send = (m: RuntimeMessage) => api.runtime.sendMessage(m);

  for (const node of doc.querySelectorAll<HTMLElement>("[data-i18n]")) node.textContent = t(node.dataset["i18n"] ?? "");
  for (const node of doc.querySelectorAll<HTMLElement>("[data-i18n-label]")) {
    node.setAttribute("aria-label", t(node.dataset["i18nLabel"] ?? ""));
  }

  void send({ type: "popupOpened" }).catch(() => undefined);

  let settings: Settings = parseSettings((await api.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY]);
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });

  const footer = el("footer");
  const pauseToggle = el<HTMLInputElement>("pause-toggle");
  const banner = el("paused-banner");
  footer.hidden = false;

  let warned = false;
  const save = async (next: Settings) => {
    // Swift's sync purges too, but without native messaging this is the only writer.
    settings = purgeAndLimit(next, Date.now());
    pageReport = null;
    render();
    try {
      await api.storage.local.set({ [SETTINGS_KEY]: settings });
    } catch (e) {
      if (!warned) console.warn("Duskling popup: saving settings failed", e);
      warned = true;
    }
  };

  // Page state; host is null for the no-access and unsupported states.
  let host: string | null = null;
  let mode: Mode = "full";
  let theme: ThemeId = settings.global.theme.value;
  let nativeDark: PageStatus["nativeDark"] = "none";
  // The first paint shows what the page reports; once settings change, mode and theme derive from them.
  let pageReport: { mode: Mode; theme: ThemeId } | null = null;

  const derive = () => {
    if (host === null) return;
    if (pageReport) {
      ({ mode, theme } = pageReport);
      return;
    }
    const rule = resolveSiteRule(settings, host);
    mode = effectiveMode(rule, siteDefaultFor(host));
    theme = rule.theme;
  };

  const setSwitch = (input: HTMLInputElement, on: boolean) => {
    input.checked = on;
    input.setAttribute("aria-checked", String(on));
  };

  function render() {
    const paused = !settings.global.enabled.value;
    banner.hidden = !paused;
    setSwitch(pauseToggle, paused);
    if (host === null) return;
    derive();
    const own = settings.sites[host];
    const ownRule = own && !own.deleted ? own : undefined;
    setSwitch(el<HTMLInputElement>("site-toggle"), mode !== "off");
    for (const radio of doc.querySelectorAll<HTMLInputElement>('input[name="theme"]')) radio.checked = radio.value === theme;
    el("theme-caption").hidden = ownRule?.theme === undefined;
    el("theme-only-on").textContent = t("popupThemeOnlyOn", [host]);
    // "Dim images" per site, overriding the global setting either way.
    // Simple (filter) mode never dims (engine run()), so the switch would do nothing there.
    el("dim-row").hidden = mode === "off" || mode === "filter";
    setSwitch(el<HTMLInputElement>("dim-toggle"), resolveSiteRule(settings, host).dimImages);
    // "ignored" from the global setting can't be undone per site, so the notice only offers what it can change.
    // A per-site switch, shown whenever the global "respect sites' own dark themes" is on and the
    // site isn't off (otherwise there's nothing to override). It reflects this host's rule, whether or not the page was
    // detected as natively dark; the status line says what the page reported.
    el("native-group").hidden = !settings.global.respectNativeDark.value || mode === "off";
    // A parent domain's "ignore" applies along the chain (rules.ts) and this host's rule can't undo it (the schema has
    // only "ignore"), so the switch shows it off and disabled, naming where it's set.
    const ignoredBy = hostChain(host).find((h) => h !== host && settings.sites[h]?.nativeDark === "ignore" && !settings.sites[h]?.deleted);
    const nativeToggle = el<HTMLInputElement>("native-toggle");
    // "overridden": the site declares a dark theme that paints light, so Duskling themes it; the switch shows that, and
    // turning it on writes "use" to follow the site's theme anyway.
    setSwitch(nativeToggle, ownRule?.nativeDark !== "ignore" && !ignoredBy && nativeDark !== "overridden");
    el("native-overridden").hidden = nativeDark !== "overridden";
    nativeToggle.disabled = !!ignoredBy && ownRule?.nativeDark !== "ignore";
    const nativeCaption = el("native-caption");
    nativeCaption.hidden = !nativeToggle.disabled;
    nativeCaption.textContent = ignoredBy && nativeToggle.disabled ? t("popupNativeSetOn", [ignoredBy]) : "";
    const nativeText = el("native-text");
    nativeText.hidden = nativeDark === "none" || nativeDark === "overridden";
    nativeText.textContent = nativeDark === "none" || nativeDark === "overridden" ? "" : t(nativeDark === "used" ? "popupNativeUsed" : "popupNativeIgnored");
  }

  pauseToggle.addEventListener("change", () => void save(setGlobal(settings, "enabled", !pauseToggle.checked, Date.now())));
  el("resume").addEventListener("click", () => void save(setGlobal(settings, "enabled", true, Date.now())));
  api.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes[SETTINGS_KEY]) return;
    settings = parseSettings(changes[SETTINGS_KEY].newValue);
    pageReport = null;
    render();
  });

  const url = tab?.url;
  let protocol: string | null = null;
  let hostname = "";
  if (url !== undefined) {
    try {
      const u = new URL(url);
      protocol = u.protocol;
      hostname = u.hostname;
    } catch {
      protocol = null;
    }
  }
  if (url === undefined || tab?.id === undefined) {
    el("state-no-access").hidden = false;
    render();
    return;
  }
  host = protocol === "http:" || protocol === "https:" ? normalizeHost(hostname) : null;
  if (host === null) {
    el("state-unsupported").hidden = false;
    render();
    return;
  }
  const siteHost: string = host;

  // No content script (not injected yet, or the site is off) rejects: fall back to the stored rule, nativeDark "none".
  const status: unknown = await api.tabs
    .sendMessage(tab.id, { type: "pageStatus" } satisfies RuntimeMessage)
    .catch(() => null);
  if (isPageStatus(status)) {
    pageReport = { mode: status.mode, theme: status.theme };
    nativeDark = status.nativeDark;
  }
  render();

  el("host").textContent = siteHost;
  el("state-normal").hidden = false;
  el("report").hidden = false;

  const writeSite = (patch: Parameters<typeof setSiteFields>[2]) => save(setSiteFields(settings, siteHost, patch, Date.now()));

  el<HTMLInputElement>("site-toggle").addEventListener("change", (e) => {
    if (!(e.target as HTMLInputElement).checked) {
      void writeSite({ mode: "off" });
      return;
    }
    // Back on: drop this host's override, unless an inherited rule (a parent host) would keep it off.
    const cleared = setSiteFields(settings, siteHost, { mode: null }, Date.now());
    const inherited = effectiveMode(resolveSiteRule(cleared, siteHost), siteDefaultFor(siteHost));
    void save(inherited === "off" ? setSiteFields(settings, siteHost, { mode: "full" }, Date.now()) : cleared);
  });

  for (const radio of doc.querySelectorAll<HTMLInputElement>('input[name="theme"]')) {
    radio.addEventListener("change", () => {
      if (!radio.checked) return;
      const picked = radio.value as ThemeId;
      // Picking the global theme is the same as having no override.
      void writeSite({ theme: picked === settings.global.theme.value ? null : picked });
    });
  }
  el("theme-default").addEventListener("click", () => void writeSite({ theme: null }));

  el<HTMLInputElement>("dim-toggle").addEventListener("change", (e) => {
    const on = (e.target as HTMLInputElement).checked;
    // No override when what's left (the global setting or a parent host's rule) already gives the choice.
    const cleared = setSiteFields(settings, siteHost, { dimImages: null }, Date.now());
    void save(resolveSiteRule(cleared, siteHost).dimImages === on ? cleared : setSiteFields(settings, siteHost, { dimImages: on }, Date.now()));
  });

  // Whether "on" needs the "use" rule: the page overrode its light "dark" theme, or the rule is already "use". Decided
  // from the state before the first change, so off then on in one popup session keeps it.
  let needsUse: boolean | null = null;
  el<HTMLInputElement>("native-toggle").addEventListener("change", (e) => {
    const follow = (e.target as HTMLInputElement).checked;
    needsUse ??= nativeDark === "overridden" || settings.sites[siteHost]?.nativeDark === "use";
    // On writes "use" then, so the engine follows the site's theme even though it looks light.
    const use = follow && needsUse;
    // A detected native theme flips between used and ignored; "none" stays "none" until the page reports otherwise.
    if (nativeDark !== "none") nativeDark = follow ? "used" : "ignored";
    void writeSite({ nativeDark: use ? "use" : follow ? null : "ignore" });
  });

  el("report").addEventListener("click", () => {
    void (async () => {
      const device = readDevice(await send({ type: "deviceInfo" }).catch(() => null));
      const url = reportMailto({ host: siteHost, mode, theme, nativeDark, version: api.runtime.getManifest().version, device });
      try {
        await api.tabs.create({ url });
      } catch {
        mailtoFallback.open(url);
      }
    })();
  });
}

if (typeof browser !== "undefined" && typeof document !== "undefined" && document.getElementById("dusk-popup")) {
  void initPopup(browser);
}
