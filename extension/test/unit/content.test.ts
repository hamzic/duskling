import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONTENT_KEY, STATUS_TIMEOUT_MS, runContent } from "../../src/content/index";
import type { ContentDeps } from "../../src/content/index";
import type { Engine, EngineDeps } from "../../src/engine/index";
import { BRAND } from "../../src/shared/brand";
import type { PageStatus } from "../../src/shared/messages";
import { setGlobal, setSiteFields } from "../../src/shared/rules";
import { DEFAULT_SETTINGS, SETTINGS_KEY } from "../../src/shared/settings";
import type { EffectiveRule, Settings } from "../../src/shared/types";

type Changes = Record<string, { oldValue?: unknown; newValue?: unknown }>;
type Sender = { id?: string; tab?: DuskBrowser.Tab; url?: string };
type OnMessage = (m: unknown, s: Sender, r: (x?: unknown) => void) => unknown;

const EXT_ID = "dusk-test-id";
const tick = () => new Promise((r) => setTimeout(r, 0));

/** In-memory `browser` (storage + runtime) recording calls in one ordered log shared with the fake engine. */
function mockApi(settings: Settings | undefined, log: string[]) {
  const store: Record<string, unknown> = settings ? { [SETTINGS_KEY]: structuredClone(settings) } : {};
  const changed: ((c: Changes, area: string) => void)[] = [];
  const messages: OnMessage[] = [];
  const sent: unknown[] = [];
  let fetchReply: unknown = { ok: false };
  const held: (() => void)[] = [];
  let holding = false;
  const api = {
    storage: {
      local: {
        get: vi.fn(async (key?: unknown) => {
          log.push(`get:${String(key)}`);
          // The result is the store as of the call, like a read already in flight.
          const r = typeof key === "string" && key in store ? { [key]: structuredClone(store[key]) } : {};
          if (holding) await new Promise<void>((res) => held.push(res));
          return r;
        }),
        set: vi.fn(async () => {}),
      },
      onChanged: { addListener: (cb: (c: Changes, a: string) => void) => void changed.push(cb), removeListener() {} },
    },
    runtime: {
      id: EXT_ID,
      sendMessage: vi.fn(async (m: unknown) => (sent.push(m), fetchReply)),
      onMessage: { addListener: (cb: OnMessage) => void messages.push(cb), removeListener() {} },
    },
  };
  return {
    api: api as unknown as ContentDeps["api"],
    get: api.storage.local.get,
    sent,
    setFetchReply: (r: unknown) => void (fetchReply = r),
    /** Holds subsequent gets until release(). */
    hold: () => void (holding = true),
    release: () => {
      holding = false;
      for (const r of held.splice(0)) r();
    },
    /** Writes storage and fires onChanged like Safari (async, after the write). */
    write(s: Settings) {
      const oldValue = store[SETTINGS_KEY];
      store[SETTINGS_KEY] = structuredClone(s);
      for (const cb of changed) cb({ [SETTINGS_KEY]: { oldValue, newValue: structuredClone(s) } }, "local");
    },
    /** Changes storage without an event (e.g. while the page sat in the bfcache). */
    silentWrite(s: Settings) {
      store[SETTINGS_KEY] = structuredClone(s);
    },
    message: (m: unknown, sender: Sender = { id: EXT_ID }) => messages.map((cb) => cb(m, sender, () => {})),
    listenerCount: () => ({ changed: changed.length, messages: messages.length }),
  };
}

interface FakeEngine extends Engine {
  deps: EngineDeps;
  updates: EffectiveRule[];
}

function engineFactory(log: string[], fail?: "create" | "start") {
  const engines: FakeEngine[] = [];
  const create = (deps: EngineDeps): Engine => {
    if (fail === "create") throw new Error("createEngine failed");
    let rule = deps.rule;
    const st = (): PageStatus => ({ host: "example.com", mode: rule.enabled ? rule.mode : "off", theme: rule.theme, nativeDark: "none", active: true });
    const e: FakeEngine = {
      deps,
      updates: [],
      start: vi.fn(async () => {
        log.push("start");
        if (fail === "start") throw new Error("start failed");
        return st();
      }),
      update: vi.fn(async (r: EffectiveRule) => (log.push("update"), e.updates.push(r), (rule = r), st())),
      stop: vi.fn(),
      status: () => st(),
    };
    engines.push(e);
    return e;
  };
  return { create, engines };
}

const w = window as unknown as Record<string | symbol, unknown>;
const settingsWith = (f: (s: Settings) => Settings) => f(structuredClone(DEFAULT_SETTINGS));

function setup(settings: Settings | undefined, boot?: { mode: string; theme: string; dimImages: boolean; respectNativeDark?: boolean }, fail?: "create" | "start") {
  const log: string[] = [];
  const m = mockApi(settings, log);
  const f = engineFactory(log, fail);
  if (boot) w["__duskBoot"] = boot;
  const run = () => runContent({ api: m.api, win: window as unknown as Window & typeof globalThis, createEngine: f.create });
  return { log, m, f, run };
}

beforeEach(() => {
  delete w["__duskBoot"];
  delete w[CONTENT_KEY];
  document.documentElement.removeAttribute("data-dusk-ready");
  // happy-dom serves about:blank by default; give the page a real host.
  (window as unknown as { happyDOM: { setURL(u: string): void } }).happyDOM.setURL("https://www.example.com/page");
});
afterEach(() => {
  delete w["__duskBoot"];
  delete w[CONTENT_KEY];
});

describe("content bootstrap with a boot file", () => {
  it("starts the engine synchronously from __duskBoot, then reads storage exactly once to reconcile", async () => {
    const { log, m, f, run } = setup(undefined, { mode: "gentle", theme: "midnight", dimImages: true });
    run();
    // Synchronous: started within run(), before storage was touched.
    expect(log[0]).toBe("start");
    expect(f.engines).toHaveLength(1);
    expect(f.engines[0]!.deps.rule).toMatchObject({ enabled: true, mode: "gentle", theme: "midnight", dimImages: true, respectNativeDark: true });
    await tick();
    // Empty storage resolves to the defaults (full, dark), so the stale boot class is reconciled.
    expect(log).toEqual(["start", `get:${SETTINGS_KEY}`, "update"]);
    expect(m.get).toHaveBeenCalledTimes(1);
    expect(f.engines[0]!.updates[0]).toMatchObject({ mode: "full", theme: "dark", dimImages: false });
  });

  it("a boot class with respectNativeDark off starts the engine with it off, so it never starts native mode first", () => {
    const { f, run } = setup(undefined, { mode: "full", theme: "dark", dimImages: false, respectNativeDark: false });
    run();
    expect(f.engines[0]!.deps.rule).toMatchObject({ mode: "full", respectNativeDark: false });
  });

  it("storage agreeing with the boot class hands the engine the same effective rule (the engine no-ops)", async () => {
    const s = settingsWith((x) => setSiteFields(x, "example.com", { mode: "gentle", theme: "midnight" }, 1));
    const { f, run } = setup(setGlobal(s, "dimImages", true, 1), { mode: "gentle", theme: "midnight", dimImages: true });
    run();
    await tick();
    expect(f.engines[0]!.updates).toHaveLength(1);
    expect(f.engines[0]!.updates[0]).toMatchObject({ enabled: true, mode: "gentle", theme: "midnight", dimImages: true, respectNativeDark: true });
  });

  it("a failed reconcile read keeps the boot rule", async () => {
    const { m, f, run } = setup(undefined, { mode: "gentle", theme: "dim", dimImages: false });
    m.get.mockRejectedValueOnce(new Error("storage unavailable"));
    run();
    await tick();
    expect(f.engines[0]!.updates).toHaveLength(0);
  });

  it("reconciles a stale boot class with the stored rule (e.g. iOS 18 overlap)", async () => {
    const s = settingsWith((x) => setSiteFields(x, "example.com", { theme: "dim" }, 1));
    const { f, run } = setup(s, { mode: "full", theme: "dark", dimImages: false });
    run();
    await tick();
    expect(f.engines[0]!.updates).toHaveLength(1);
    expect(f.engines[0]!.updates[0]).toMatchObject({ mode: "full", theme: "dim" });
  });

  it("reconciles respectNativeDark false (nativeDark ignore) after starting with the default", async () => {
    const s = settingsWith((x) => setSiteFields(x, "example.com", { nativeDark: "ignore" }, 1));
    const { f, run } = setup(s, { mode: "full", theme: "dark", dimImages: false });
    run();
    await tick();
    expect(f.engines[0]!.updates[0]).toMatchObject({ respectNativeDark: false });
  });

  it("a second injection (re-registration) only reconciles the existing engine", async () => {
    const { m, f, run } = setup(undefined, { mode: "full", theme: "dark", dimImages: false });
    run();
    await tick();
    m.silentWrite(settingsWith((x) => setGlobal(x, "theme", "midnight", 2)));
    run();
    await tick();
    expect(f.engines).toHaveLength(1);
    expect(f.engines[0]!.start).toHaveBeenCalledTimes(1);
    expect(f.engines[0]!.updates.at(-1)).toMatchObject({ theme: "midnight" });
    expect(m.listenerCount()).toEqual({ changed: 1, messages: 1 });
  });
});

describe("content bootstrap without a boot file", () => {
  it("reads storage exactly once before the engine starts", async () => {
    const { log, m, f, run } = setup(undefined);
    run();
    expect(f.engines).toHaveLength(0);
    await tick();
    expect(m.get).toHaveBeenCalledTimes(1);
    expect(log).toEqual([`get:${SETTINGS_KEY}`, "start"]);
    expect(f.engines[0]!.deps.rule).toMatchObject({ enabled: true, mode: "full", theme: "dark" });
  });

  it("an off rule sets data-dusk-ready and creates no engine", async () => {
    const { f, run } = setup(settingsWith((x) => setSiteFields(x, "example.com", { mode: "off" }, 1)));
    run();
    await tick();
    expect(f.engines).toHaveLength(0);
    expect(document.documentElement.hasAttribute("data-dusk-ready")).toBe(true);
  });

  it("globally disabled → no engine, ready set", async () => {
    const { f, run } = setup(settingsWith((x) => setGlobal(x, "enabled", false, 1)));
    run();
    await tick();
    expect(f.engines).toHaveLength(0);
    expect(document.documentElement.hasAttribute("data-dusk-ready")).toBe(true);
  });
});

describe("live updates", () => {
  it("a settings change in storage calls update without another storage read", async () => {
    const { m, f, run } = setup(undefined);
    run();
    await tick();
    m.write(settingsWith((x) => setSiteFields(x, "example.com", { mode: "gentle" }, 2)));
    await tick();
    expect(f.engines[0]!.updates).toHaveLength(1);
    expect(f.engines[0]!.updates[0]).toMatchObject({ mode: "gentle" });
    expect(m.get).toHaveBeenCalledTimes(1);
  });

  it("a site that was off starts the engine when it is turned on", async () => {
    const { m, f, run } = setup(settingsWith((x) => setSiteFields(x, "example.com", { mode: "off" }, 1)));
    run();
    await tick();
    expect(f.engines).toHaveLength(0);
    m.write(settingsWith((x) => setSiteFields(x, "example.com", { mode: "filter" }, 2)));
    await tick();
    expect(f.engines).toHaveLength(1);
    expect(f.engines[0]!.start).toHaveBeenCalledTimes(1);
    expect(f.engines[0]!.deps.rule).toMatchObject({ mode: "filter" });
  });

  it("pageshow with persisted re-reads settings and updates; a normal pageshow does not", async () => {
    const { m, f, run } = setup(undefined);
    run();
    await tick();
    m.silentWrite(settingsWith((x) => setGlobal(x, "theme", "dim", 2)));
    window.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: false }));
    await tick();
    expect(m.get).toHaveBeenCalledTimes(1);
    window.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }));
    await tick();
    expect(m.get).toHaveBeenCalledTimes(2);
    expect(f.engines[0]!.updates[0]).toMatchObject({ theme: "dim" });
  });
});

describe("frames follow the top site", () => {
  it("a cross-origin frame resolves its rule from the top page's host (location.ancestorOrigins)", async () => {
    (window as unknown as { happyDOM: { setURL(u: string): void } }).happyDOM.setURL("https://www.embed.example/player");
    const off = settingsWith((x) => setSiteFields(x, "news.example", { mode: "off" }, 2));
    const { f, run } = setup(off, { mode: "full", theme: "dark", dimImages: false });
    const top = Object.getOwnPropertyDescriptor(window, "top");
    Object.defineProperty(window, "top", { configurable: true, get: () => ({}) });
    Object.defineProperty(window.location, "ancestorOrigins", { configurable: true, get: () => ["https://www.news.example"] });
    try {
      run();
      await tick();
      expect(f.engines[0]!.updates.at(-1)).toMatchObject({ enabled: true, mode: "off" });
    } finally {
      if (top) Object.defineProperty(window, "top", top);
      else delete (window as unknown as Record<string, unknown>)["top"];
      delete (window.location as unknown as Record<string, unknown>)["ancestorOrigins"];
    }
  });
});

describe("page becoming visible", () => {
  const setVisibility = (state: DocumentVisibilityState) => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
    document.dispatchEvent(new Event("visibilitychange"));
  };
  afterEach(() => void delete (document as unknown as Record<string, unknown>)["visibilityState"]);

  it("asks the background for a settings sync when the top page becomes visible, not when it's hidden", async () => {
    const { m, run } = setup(undefined, { mode: "full", theme: "dark", dimImages: false });
    run();
    const syncs = () => m.sent.filter((x) => (x as { type?: unknown }).type === "syncSettings");
    setVisibility("hidden");
    await tick();
    expect(syncs()).toEqual([]);
    setVisibility("visible");
    await tick();
    expect(syncs()).toEqual([{ type: "syncSettings" }]);
  });

  it("the top frame tells the background once that it ran on a page, with nothing about the page", async () => {
    const { m, run } = setup(undefined, { mode: "full", theme: "dark", dimImages: false });
    run();
    await tick();
    for (let i = 0; i < 3; i++) {
      setVisibility("hidden");
      setVisibility("visible");
      await tick();
    }
    const of = (type: string) => m.sent.filter((x) => (x as { type?: unknown }).type === type);
    expect(of("syncSettings")).toHaveLength(3);
    expect(of("pageSeen")).toEqual([{ type: "pageSeen" }]);
  });

  it("a subframe doesn't ask", async () => {
    const { m, run } = setup(undefined, { mode: "full", theme: "dark", dimImages: false });
    const top = Object.getOwnPropertyDescriptor(window, "top");
    Object.defineProperty(window, "top", { configurable: true, get: () => ({}) });
    try {
      run();
      setVisibility("visible");
      await tick();
      expect(m.sent).toEqual([]);
    } finally {
      if (top) Object.defineProperty(window, "top", top);
      else delete (window as unknown as Record<string, unknown>)["top"];
    }
  });
});

describe("messages", () => {
  it("pageStatus is answered with engine.status() in the top frame", async () => {
    const { m, run } = setup(undefined, { mode: "full", theme: "dark", dimImages: false });
    run();
    const [reply] = m.message({ type: "pageStatus" });
    await expect(reply).resolves.toMatchObject({ mode: "full", theme: "dark", active: true });
  });

  it("pageStatus is not answered in a subframe", async () => {
    const { m, run } = setup(undefined, { mode: "full", theme: "dark", dimImages: false });
    const top = Object.getOwnPropertyDescriptor(window, "top");
    Object.defineProperty(window, "top", { configurable: true, get: () => ({}) });
    try {
      run();
      expect(m.message({ type: "pageStatus" })).toEqual([undefined]);
    } finally {
      if (top) Object.defineProperty(window, "top", top);
      else delete (window as unknown as Record<string, unknown>)["top"];
    }
  });

  it("ignores messages from other senders", () => {
    const { m, run } = setup(undefined, { mode: "full", theme: "dark", dimImages: false });
    run();
    expect(m.message({ type: "pageStatus" }, { id: "someone-else" })).toEqual([undefined]);
  });

  it("an off page answers pageStatus with mode off, inactive", async () => {
    const { m, run } = setup(settingsWith((x) => setSiteFields(x, "example.com", { mode: "off" }, 1)));
    run();
    const [reply] = m.message({ type: "pageStatus" });
    await expect(reply).resolves.toEqual({ host: "example.com", mode: "off", theme: "dark", nativeDark: "none", active: false });
  });
});

describe("engine adapters", () => {
  it("fetchResource goes through runtime.sendMessage and passes the FetchResult through", async () => {
    const { m, f, run } = setup(undefined, { mode: "full", theme: "dark", dimImages: false });
    run();
    m.setFetchReply({ ok: true, dataUrl: "data:image/png;base64,AA==", corsOk: true });
    const r = await f.engines[0]!.deps.fetchResource("https://cdn.example.com/a.png", "blob");
    expect(m.sent.filter((x) => (x as { type?: unknown }).type === "fetchResource")).toEqual([{ type: "fetchResource", url: "https://cdn.example.com/a.png", as: "blob" }]);
    expect(r).toEqual({ ok: true, dataUrl: "data:image/png;base64,AA==", corsOk: true });
  });

  it("fetchResource maps a rejected or malformed reply to {ok:false}", async () => {
    const { m, f, run } = setup(undefined, { mode: "full", theme: "dark", dimImages: false });
    run();
    m.setFetchReply(undefined);
    await expect(f.engines[0]!.deps.fetchResource("https://x.test/a.css", "text")).resolves.toEqual({ ok: false });
    (m.api.runtime.sendMessage as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("no background"));
    await expect(f.engines[0]!.deps.fetchResource("https://x.test/a.css", "text")).resolves.toEqual({ ok: false });
  });

  it("setPromotion dispatches dusk:native-promotion with on/off", () => {
    const { f, run } = setup(undefined, { mode: "full", theme: "dark", dimImages: false });
    run();
    const seen: unknown[] = [];
    const cb = (e: Event) => seen.push((e as CustomEvent).detail);
    document.addEventListener("dusk:native-promotion", cb);
    f.engines[0]!.deps.bridge.setPromotion(true);
    f.engines[0]!.deps.bridge.setPromotion(false);
    document.removeEventListener("dusk:native-promotion", cb);
    expect(seen).toEqual(["on", "off"]);
  });

  it("setClosedRepair dispatches dusk:closed-repair with on/off", () => {
    const { f, run } = setup(undefined, { mode: "full", theme: "dark", dimImages: false });
    run();
    const seen: unknown[] = [];
    const cb = (e: Event) => seen.push((e as CustomEvent).detail);
    document.addEventListener("dusk:closed-repair", cb);
    f.engines[0]!.deps.bridge.setClosedRepair?.(true);
    f.engines[0]!.deps.bridge.setClosedRepair?.(false);
    document.removeEventListener("dusk:closed-repair", cb);
    expect(seen).toEqual(["on", "off"]);
  });

  it("dusk:sheet-change maps to the document or the open shadow root; dusk:shadow-attached to the host", () => {
    const { f, run } = setup(undefined, { mode: "full", theme: "dark", dimImages: false });
    run();
    const sheets: (Document | ShadowRoot)[] = [];
    const hosts: Element[] = [];
    f.engines[0]!.deps.bridge.onSheetChange((r) => sheets.push(r));
    f.engines[0]!.deps.bridge.onShadowAttached((h) => hosts.push(h));
    const outer = document.createElement("div");
    document.body.append(outer);
    const outerRoot = outer.attachShadow({ mode: "open" });
    const inner = document.createElement("span");
    outerRoot.append(inner);
    const innerRoot = inner.attachShadow({ mode: "open" });

    document.dispatchEvent(new CustomEvent("dusk:sheet-change", { detail: "" }));
    // A host nested in another shadow root: the event is retargeted at document, so the adapter must use composedPath.
    inner.dispatchEvent(new CustomEvent("dusk:sheet-change", { bubbles: true, composed: true, detail: "" }));
    inner.dispatchEvent(new CustomEvent("dusk:shadow-attached", { bubbles: true, composed: true, detail: "" }));
    outer.remove();
    expect(sheets).toEqual([document, innerRoot]);
    expect(hosts).toEqual([inner]);
  });
});

describe("startup failsafe", () => {
  it("an engine whose start rejects still leaves data-dusk-ready set", async () => {
    const { m, run } = setup(undefined, { mode: "full", theme: "dark", dimImages: false }, "start");
    run();
    await tick();
    expect(document.documentElement.hasAttribute("data-dusk-ready")).toBe(true);
    expect(m.listenerCount()).toEqual({ changed: 1, messages: 1 });
  });

  it("a createEngine that throws leaves data-dusk-ready set and the listeners registered", async () => {
    const { m, run } = setup(undefined, { mode: "full", theme: "dark", dimImages: false }, "create");
    expect(() => run()).not.toThrow();
    expect(document.documentElement.hasAttribute("data-dusk-ready")).toBe(true);
    expect(m.listenerCount()).toEqual({ changed: 1, messages: 1 });
    await tick();
  });

  it("a throwing listener API does not prevent the boot rule from theming", () => {
    const { m, f } = setup(undefined, { mode: "full", theme: "dark", dimImages: false });
    const api = { ...m.api, storage: { ...m.api.storage, onChanged: { addListener: () => { throw new Error("no onChanged"); } } } };
    expect(() => runContent({ api: api as unknown as ContentDeps["api"], win: window as unknown as Window & typeof globalThis, createEngine: f.create })).not.toThrow();
    expect(f.engines[0]!.start).toHaveBeenCalledTimes(1);
  });
});

describe("reconcile races", () => {
  it("a read in flight when onChanged arrives is dropped (the old rule is not applied)", async () => {
    const { m, f, run } = setup(undefined, { mode: "full", theme: "dark", dimImages: false });
    m.hold();
    run(); // reconcile get is now in flight with the old (empty → default) settings
    m.write(settingsWith((x) => setSiteFields(x, "example.com", { mode: "gentle" }, 2)));
    m.release();
    await tick();
    expect(f.engines[0]!.updates).toHaveLength(1);
    expect(f.engines[0]!.updates[0]).toMatchObject({ mode: "gentle" });
  });

  it("pageStatus falls back after STATUS_TIMEOUT_MS when the first read hangs", async () => {
    vi.useFakeTimers();
    try {
      const { m, run } = setup(undefined);
      m.hold();
      run();
      const [reply] = m.message({ type: "pageStatus" });
      await vi.advanceTimersByTimeAsync(STATUS_TIMEOUT_MS);
      await expect(reply).resolves.toEqual({ host: "example.com", mode: "off", theme: "dark", nativeDark: "none", active: false });
      m.release();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("manifest and locales", () => {
  const read = (p: string) => JSON.parse(readFileSync(resolve(__dirname, "../../src", p), "utf8"));

  it("declares MV3 with dynamic scripts only", () => {
    const m = read("manifest.json");
    expect(m.manifest_version).toBe(3);
    expect(m.default_locale).toBe("en");
    // No `tabs`: the popup reads the active tab's URL through the <all_urls> host permission (MDN tabs.Tab.url).
    expect(m.permissions).toEqual(["storage", "scripting", "nativeMessaging"]);
    expect(m.host_permissions).toEqual(["<all_urls>"]);
    // Safari iOS requires persistent:false.
    expect(m.background).toEqual({ scripts: ["background.js"], persistent: false });
    expect(m.action.default_popup).toBe("popup/popup.html");
    expect(Object.keys(m.action.default_icon).length).toBeGreaterThan(0);
    expect(m.content_scripts).toBeUndefined();
  });

  it("has the name and description messages the manifest references", () => {
    const msgs = read("_locales/en/messages.json");
    expect(msgs.extName.message).toBe(BRAND.name);
    expect(msgs.extDescription.message).toBe("Dark mode for every website. Free, private, open source.");
  });
});
