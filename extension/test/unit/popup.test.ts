import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initPopup, type PopupApi } from "../../src/popup/popup";
import { BRAND } from "../../src/shared/brand";
import type { PageStatus } from "../../src/shared/messages";
import { DEFAULT_SETTINGS, SETTINGS_KEY } from "../../src/shared/settings";
import type { Settings, SiteRule } from "../../src/shared/types";

const SRC = join(__dirname, "../../src");
const HTML = readFileSync(join(SRC, "popup/popup.html"), "utf8");
type Messages = Record<string, { message: string; placeholders?: Record<string, { content: string }> }>;
const MESSAGES = JSON.parse(readFileSync(join(SRC, "_locales/en/messages.json"), "utf8")) as Messages;
const msg = (key: string) => MESSAGES[key]!.message;

/** chrome.i18n semantics: $NAME$ → placeholder content, whose $1..$9 are the substitutions. */
function getMessage(name: string, subs?: string | string[]): string {
  const m = MESSAGES[name];
  if (!m) return "";
  const list = subs === undefined ? [] : Array.isArray(subs) ? subs : [subs];
  return m.message.replace(/\$([A-Za-z0-9_]+)\$/g, (_, p: string) => {
    const content = m.placeholders?.[p.toLowerCase()]?.content ?? "";
    return content.replace(/\$(\d)/g, (_x, i: string) => list[Number(i) - 1] ?? "");
  });
}

interface MockOpts {
  url?: string | undefined;
  settings?: Settings;
  status?: Partial<PageStatus> | "reject";
  device?: unknown;
  createRejects?: boolean;
}

function mockBrowser(opts: MockOpts = {}) {
  const store: Record<string, unknown> = opts.settings ? { [SETTINGS_KEY]: structuredClone(opts.settings) } : {};
  const changed: ((c: Record<string, { newValue?: unknown }>, area: string) => void)[] = [];
  const log = { runtime: [] as unknown[], tabMessages: [] as unknown[], created: [] as string[] };
  const url = "url" in opts ? opts.url : "https://www.example.com/";
  const api: PopupApi = {
    storage: {
      local: {
        get: vi.fn(async (key?: unknown) => {
          if (typeof key === "string") return key in store ? { [key]: structuredClone(store[key]) } : {};
          return structuredClone(store);
        }),
        set: vi.fn(async (items: Record<string, unknown>) => {
          const changes: Record<string, { oldValue?: unknown; newValue?: unknown }> = {};
          for (const [k, v] of Object.entries(items)) {
            changes[k] = { oldValue: store[k], newValue: structuredClone(v) };
            store[k] = structuredClone(v);
          }
          // Safari fires onChanged asynchronously after the write.
          queueMicrotask(() => changed.forEach((cb) => cb(structuredClone(changes), "local")));
        }),
      },
      onChanged: {
        addListener: (cb) => void changed.push(cb as never),
        removeListener: () => undefined,
      },
    },
    runtime: {
      sendMessage: vi.fn(async (m: unknown) => {
        log.runtime.push(m);
        if ((m as { type: string }).type === "deviceInfo") return opts.device ?? null;
        return undefined;
      }),
      getManifest: () => ({ version: "1.2.3" }),
    },
    tabs: {
      query: vi.fn(async () => [{ id: 7, url, active: true }]),
      sendMessage: vi.fn(async (_id: number, m: unknown) => {
        log.tabMessages.push(m);
        if (opts.status === "reject") throw new Error("Could not establish connection");
        return { host: "example.com", mode: "full", theme: "dark", nativeDark: "none", active: true, ...opts.status } satisfies PageStatus;
      }),
      create: vi.fn(async ({ url: u }: { url?: string }) => {
        log.created.push(u ?? "");
        if (opts.createRejects) throw new Error("no handler");
        return { id: 8 };
      }),
    },
    i18n: { getMessage },
  };
  const stored = () => store[SETTINGS_KEY] as Settings;
  const site = (host = "example.com"): SiteRule | undefined => stored()?.sites[host];
  return { api, log, stored, site };
}

const $ = <T extends Element = HTMLElement>(sel: string) => document.querySelector(sel) as unknown as T;
const visible = (sel: string) => {
  for (let el: Element | null = $(sel); el; el = el.parentElement) if ((el as HTMLElement).hidden) return false;
  return true;
};
const text = (sel: string) => ($(sel).textContent ?? "").replace(/\s+/g, " ").trim();
const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};
async function click(sel: string) {
  $(sel).click();
  await flush();
}

function withSites(sites: Record<string, SiteRule>, global: Partial<Settings["global"]> = {}): Settings {
  return { ...structuredClone(DEFAULT_SETTINGS), global: { ...structuredClone(DEFAULT_SETTINGS.global), ...global }, sites };
}

async function open(opts: MockOpts = {}) {
  const m = mockBrowser(opts);
  await initPopup(m.api, document);
  await flush();
  return m;
}

beforeEach(() => {
  // Load the real page without its script and stylesheet (the test drives initPopup itself).
  const body = /<body>([\s\S]*)<\/body>/.exec(HTML)![1]!;
  document.body.innerHTML = body;
});
afterEach(() => vi.restoreAllMocks());

describe("popup", () => {
  it("sends popupOpened on open and asks the active tab for its status", async () => {
    const { log, api } = await open();
    expect(log.runtime[0]).toEqual({ type: "popupOpened" });
    expect(api.tabs.query).toHaveBeenCalledWith({ active: true, currentWindow: true });
    expect(log.tabMessages).toEqual([{ type: "pageStatus" }]);
  });

  it("renders the host without www.", async () => {
    await open({ url: "https://www.Example.com/some/path?q=1" });
    expect(text("#host")).toBe("example.com");
    expect(visible("#state-normal")).toBe(true);
  });

  it("fills every labelled element from messages.json", async () => {
    await open();
    for (const el of document.querySelectorAll("[data-i18n]")) {
      expect(el.textContent).toBe(msg(el.getAttribute("data-i18n")!));
    }
    expect($("#theme").getAttribute("aria-label")).toBe(msg("popupThemeGroup"));
  });

  it("toggling the site switch off writes mode off, and on again clears it", async () => {
    const { site } = await open();
    const toggle = $<HTMLInputElement>("#site-toggle");
    expect(toggle.getAttribute("role")).toBe("switch");
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    await click("#site-toggle");
    expect(site()?.mode).toBe("off");
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    await click("#site-toggle");
    expect(site()?.mode).toBeUndefined();
    expect(toggle.checked).toBe(true);
  });

  it("turning a site back on writes full when an inherited rule is off", async () => {
    const { site } = await open({ url: "https://a.example.com/", settings: withSites({ "example.com": { mode: "off", updatedAt: 1 } }), status: { mode: "off" } });
    expect($<HTMLInputElement>("#site-toggle").checked).toBe(false);
    await click("#site-toggle");
    expect(site("a.example.com")?.mode).toBe("full");
  });

  it("selecting Midnight writes the site theme and shows the override caption; Use default clears it", async () => {
    const { site } = await open();
    expect($("#theme").getAttribute("role")).toBe("radiogroup");
    expect($<HTMLInputElement>('input[value="dark"]').checked).toBe(true);
    expect(visible("#theme-caption")).toBe(false);
    await click('input[value="midnight"]');
    expect(site()?.theme).toBe("midnight");
    expect(visible("#theme-caption")).toBe(true);
    expect(text("#theme-only-on")).toBe("Only on example.com");
    expect(text("#theme-default")).toBe("Use default");
    await click("#theme-default");
    expect(site()?.theme).toBeUndefined();
    expect(visible("#theme-caption")).toBe(false);
    expect($<HTMLInputElement>('input[value="dark"]').checked).toBe(true);
  });

  it("selects the effective theme and shows the caption for an existing override", async () => {
    await open({ settings: withSites({ "example.com": { theme: "dim", updatedAt: 1 } }), status: { theme: "dim" } });
    expect($<HTMLInputElement>('input[value="dim"]').checked).toBe(true);
    expect(text("#theme-only-on")).toBe("Only on example.com");
  });

  it("dim switch follows the global setting; turning it on writes dimImages true, off again clears it", async () => {
    const { site } = await open();
    const toggle = $<HTMLInputElement>("#dim-toggle");
    expect(text("#dim-row")).toBe("Dim images");
    expect(toggle.getAttribute("role")).toBe("switch");
    expect(toggle.checked).toBe(false);
    await click("#dim-toggle");
    expect(site()?.dimImages).toBe(true);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    await click("#dim-toggle");
    expect(site()).toEqual({ updatedAt: expect.any(Number), deleted: true });
    expect(toggle.checked).toBe(false);
  });

  it("dim switch with the global setting on: off writes dimImages false, on clears it", async () => {
    const { site } = await open({ settings: withSites({}, { dimImages: { value: true, updatedAt: 1 } }) });
    expect($<HTMLInputElement>("#dim-toggle").checked).toBe(true);
    await click("#dim-toggle");
    expect(site()?.dimImages).toBe(false);
    await click("#dim-toggle");
    expect(site()?.dimImages).toBeUndefined();
  });

  it("dim switch shows an inherited override and keeps the choice explicit where clearing would inherit it", async () => {
    const { site } = await open({ url: "https://a.example.com/", settings: withSites({ "example.com": { dimImages: true, updatedAt: 1 } }) });
    expect($<HTMLInputElement>("#dim-toggle").checked).toBe(true);
    await click("#dim-toggle");
    expect(site("a.example.com")?.dimImages).toBe(false);
    await click("#dim-toggle");
    expect(site("a.example.com")?.dimImages).toBeUndefined();
    expect($<HTMLInputElement>("#dim-toggle").checked).toBe(true);
  });

  it("hides the dim switch while the site is off", async () => {
    await open();
    expect(visible("#dim-row")).toBe(true);
    await click("#site-toggle");
    expect(visible("#dim-row")).toBe(false);
  });

  it("hides the dim switch in Simple (filter) mode, where the engine doesn't dim", async () => {
    await open({ url: "https://example.com/", settings: withSites({ "example.com": { mode: "filter", updatedAt: 1 } }), status: { mode: "filter" } });
    expect(visible("#site-toggle")).toBe(true);
    expect(visible("#dim-row")).toBe(false);
  });

  it("a save drops tombstones older than 30 days, as Swift's sync does (no native messaging needed)", async () => {
    const day = 24 * 60 * 60 * 1000;
    const { site } = await open({
      url: "https://example.com/",
      settings: withSites({
        "old.example": { deleted: true, updatedAt: Date.now() - 31 * day },
        "recent.example": { deleted: true, updatedAt: Date.now() - day },
      }),
    });
    await click("#site-toggle");
    expect(site("old.example")).toBeUndefined();
    expect(site("recent.example")?.deleted).toBe(true);
    expect(site()?.mode).toBe("off");
  });

  it("the native switch shows a parent domain's ignore, disabled with where it's set", async () => {
    await open({ url: "https://a.example.com/", settings: withSites({ "example.com": { nativeDark: "ignore", updatedAt: 1 } }) });
    expect($<HTMLInputElement>("#native-toggle").checked).toBe(false);
    expect($<HTMLInputElement>("#native-toggle").disabled).toBe(true);
    expect(visible("#native-caption")).toBe(true);
    expect(text("#native-caption")).toBe(msg("popupNativeSetOn").replace("$HOST$", "example.com"));
  });

  it("the native switch stays usable for the host's own ignore", async () => {
    await open({ url: "https://example.com/", settings: withSites({ "example.com": { nativeDark: "ignore", updatedAt: 1 } }) });
    expect($<HTMLInputElement>("#native-toggle").checked).toBe(false);
    expect($<HTMLInputElement>("#native-toggle").disabled).toBe(false);
    expect(visible("#native-caption")).toBe(false);
  });

  it("has no mode ladder", async () => {
    await open();
    expect($("#ladder")).toBeNull();
    expect(Object.keys(MESSAGES).filter((k) => /Ladder|LooksBroken|Undo/.test(k))).toEqual([]);
  });

  it("hides the native-theme switch while the site is off", async () => {
    await open({ status: { nativeDark: "used" } });
    expect(visible("#native-group")).toBe(true);
    await click("#site-toggle");
    expect(visible("#native-group")).toBe(false);
    await click("#site-toggle");
    expect(visible("#native-group")).toBe(true);
  });

  it("warns once when saving fails and keeps the UI usable", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const m = mockBrowser();
    m.api.storage.local.set = vi.fn(async () => {
      throw new Error("quota");
    });
    await initPopup(m.api, document);
    await flush();
    await click("#site-toggle");
    await click("#dim-toggle");
    expect(warn).toHaveBeenCalledTimes(1);
    expect($<HTMLInputElement>("#site-toggle").checked).toBe(false);
  });

  // When Duskling overrides a site's dark theme that looks light, the switch shows off with a caption
  // saying why, and turning it on writes "use" so the site's theme is followed anyway.
  it("an overridden site's theme: caption above the switch, switch off, on writes use", async () => {
    const { site } = await open({ status: { nativeDark: "overridden" } });
    const toggle = $<HTMLInputElement>("#native-toggle");
    expect(visible("#native-overridden")).toBe(true);
    expect(text("#native-overridden")).toBe(msg("popupNativeOverridden"));
    expect(toggle.checked).toBe(false);
    expect(visible("#native-text")).toBe(false);
    await click("#native-toggle");
    expect(site()?.nativeDark).toBe("use");
    expect(toggle.checked).toBe(true);
    expect(visible("#native-overridden")).toBe(false);
    expect(text("#native-text")).toBe("This site has its own dark theme.");
    await click("#native-toggle");
    expect(site()?.nativeDark).toBe("ignore");
    await click("#native-toggle");
    expect(site()?.nativeDark).toBe("use");
  });

  it("a site with the use rule shows the switch on, and off writes ignore", async () => {
    const { site } = await open({ settings: withSites({ "example.com": { nativeDark: "use", updatedAt: 1 } }), status: { nativeDark: "used" } });
    expect($<HTMLInputElement>("#native-toggle").checked).toBe(true);
    expect(visible("#native-overridden")).toBe(false);
    await click("#native-toggle");
    expect(site()?.nativeDark).toBe("ignore");
  });

  it("native-theme switch: off writes nativeDark ignore, on clears it", async () => {
    const { site } = await open({ status: { nativeDark: "used" } });
    const toggle = $<HTMLInputElement>("#native-toggle");
    expect(visible("#native-group")).toBe(true);
    expect(text("#native-group label")).toBe("Use this site's dark theme");
    expect(toggle.getAttribute("role")).toBe("switch");
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(text("#native-text")).toBe("This site has its own dark theme.");
    await click("#native-toggle");
    expect(site()?.nativeDark).toBe("ignore");
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(text("#native-text")).toBe(`Using ${BRAND.name}'s theme.`);
    await click("#native-toggle");
    expect(site()?.nativeDark).toBeUndefined();
    expect(toggle.checked).toBe(true);
    expect(text("#native-text")).toBe("This site has its own dark theme.");
  });

  it("native-theme switch reflects the site rule even when the page has no dark theme", async () => {
    const { site } = await open({ settings: withSites({ "example.com": { nativeDark: "ignore", updatedAt: 1 } }), status: { nativeDark: "none" } });
    expect(visible("#native-group")).toBe(true);
    expect($<HTMLInputElement>("#native-toggle").checked).toBe(false);
    expect(visible("#native-text")).toBe(false);
    await click("#native-toggle");
    expect(site()?.nativeDark).toBeUndefined();
    expect(visible("#native-text")).toBe(false);
  });

  it("native-theme status line follows what the page reports", async () => {
    await open({ settings: withSites({ "example.com": { nativeDark: "ignore", updatedAt: 1 } }), status: { nativeDark: "ignored" } });
    expect($<HTMLInputElement>("#native-toggle").checked).toBe(false);
    expect(text("#native-text")).toBe(`Using ${BRAND.name}'s theme.`);
  });

  it("hides the native-theme switch when sites' own dark themes are off globally", async () => {
    await open({ settings: withSites({}, { respectNativeDark: { value: false, updatedAt: 1 } }), status: { nativeDark: "ignored" } });
    expect(visible("#native-group")).toBe(false);
  });

  it("falls back to the stored rule with nativeDark none when the content script doesn't answer", async () => {
    await open({ status: "reject", settings: withSites({ "example.com": { theme: "midnight", mode: "gentle", updatedAt: 1 } }) });
    expect(visible("#state-normal")).toBe(true);
    expect($<HTMLInputElement>('input[value="midnight"]').checked).toBe(true);
    expect(visible("#native-text")).toBe(false);
    expect($<HTMLInputElement>("#site-toggle").checked).toBe(true); // gentle is on
  });

  it("shows the no-access copy when the tab has no url", async () => {
    await open({ url: undefined });
    expect(visible("#state-no-access")).toBe(true);
    expect(text("#state-no-access h1")).toBe(`${BRAND.name} can't see this page yet.`);
    expect(text("#state-no-access p")).toBe(`Tap the puzzle icon in the address bar, choose ${BRAND.name}, then Always Allow on Every Website.`);
    expect(visible("#state-normal")).toBe(false);
    expect(visible("#report")).toBe(false);
  });

  it("shows the unsupported copy for non-http(s) pages", async () => {
    for (const url of ["about:blank", "safari-web-extension://abc/popup.html", "file:///x.html"]) {
      document.body.innerHTML = /<body>([\s\S]*)<\/body>/.exec(HTML)![1]!;
      const { log } = await open({ url });
      expect(visible("#state-unsupported")).toBe(true);
      expect(text("#state-unsupported")).toBe("Dark mode isn't available on this page.");
      expect(visible("#state-normal")).toBe(false);
      expect(log.tabMessages).toEqual([]);
    }
  });

  it("Pause everywhere shows the banner and Resume clears it", async () => {
    const { stored } = await open({ url: undefined });
    expect(visible("#footer")).toBe(true);
    expect(visible("#paused-banner")).toBe(false);
    await click("#pause-toggle");
    expect(stored().global.enabled.value).toBe(false);
    expect(visible("#paused-banner")).toBe(true);
    expect(text("#paused-banner p")).toBe("Paused everywhere");
    await click("#resume");
    expect(stored().global.enabled.value).toBe(true);
    expect(visible("#paused-banner")).toBe(false);
    expect($<HTMLInputElement>("#pause-toggle").checked).toBe(false);
  });

  it("stamps writes with Date.now()", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const { site } = await open();
    await click("#dim-toggle");
    expect(site()?.updatedAt).toBe(1_700_000_000_000);
  });

  it("re-renders when settings change in storage (e.g. native sync)", async () => {
    const m = await open();
    await m.api.storage.local.set({ [SETTINGS_KEY]: withSites({ "example.com": { theme: "dim", updatedAt: 5 } }) });
    await flush();
    expect($<HTMLInputElement>('input[value="dim"]').checked).toBe(true);
  });

  describe("report", () => {
    it("opens the repository's issue list, with nothing about the page in it", async () => {
      const { log } = await open({
        url: "https://www.example.com/secret/path?token=abc#frag",
        status: { mode: "gentle", theme: "midnight", nativeDark: "ignored" },
      });
      await click("#report");
      expect(log.created).toEqual([`${BRAND.repoUrl}/issues`]);
      expect(log.runtime).not.toContainEqual({ type: "deviceInfo" });
    });

    it("falls back to location when tabs.create rejects", async () => {
      const assign = vi.fn();
      const { log } = await open({ createRejects: true });
      const popup = await import("../../src/popup/popup");
      popup.reportFallback.open = assign;
      await click("#report");
      expect(log.created).toHaveLength(1);
      expect(assign).toHaveBeenCalledWith(log.created[0]);
    });
  });
});

/** Every non-empty text node the user can see: no `hidden` ancestor up to <body>. */
function visibleTexts(): string[] {
  const out: string[] = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const value = (node.textContent ?? "").replace(/\s+/g, " ").trim();
    if (!value) continue;
    let shown = true;
    for (let el = node.parentElement; el; el = el.parentElement) if (el.hidden) shown = false;
    if (shown) out.push(value);
  }
  return out;
}

describe("popup copy (every string from messages.json)", () => {
  const HOST = "example.com";
  // Every message as the popup can render it; placeholders take the page host, the only substitution the popup makes.
  const rendered = new Set(Object.keys(MESSAGES).map((key) => getMessage(key, [HOST])));

  async function expectAllCopyFromMessages(state: string) {
    const texts = visibleTexts();
    expect(texts.length, state).toBeGreaterThan(0);
    for (const value of texts) {
      // The host line is page data, not copy.
      if (value === HOST && visible("#host")) continue;
      expect(rendered.has(value), `${state}: "${value}" is not a messages.json value`).toBe(true);
    }
  }

  it("normal, theme override, both native notices, paused, no access and unsupported", async () => {
    await open();
    await expectAllCopyFromMessages("normal");

    // [state, options, element that proves the state is showing]
    const states: [string, MockOpts, string][] = [
      ["theme override", { settings: withSites({ [HOST]: { theme: "dim", updatedAt: 1 } }), status: { theme: "dim" } }, "#theme-caption"],
      ["native used", { status: { nativeDark: "used" } }, "#native-text"],
      ["native ignored", { settings: withSites({ [HOST]: { nativeDark: "ignore", updatedAt: 1 } }), status: { nativeDark: "ignored" } }, "#native-text"],
      ["paused", { settings: withSites({}, { enabled: { value: false, updatedAt: 1 } }) }, "#paused-banner"],
      ["no access", { url: undefined }, "#state-no-access"],
      ["unsupported", { url: "about:blank" }, "#state-unsupported"],
    ];
    for (const [state, opts, proof] of states) {
      document.body.innerHTML = /<body>([\s\S]*)<\/body>/.exec(HTML)![1]!;
      await open(opts);
      expect(visible(proof), state).toBe(true);
      await expectAllCopyFromMessages(state);
    }
  });
});
