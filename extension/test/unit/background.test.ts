import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleFetchResource, hostClass, MAX_BYTES } from "../../src/background/fetch-resource";
import { HEARTBEAT_THROTTLE_MS, VISIBLE_SYNC_THROTTLE_MS, createBackground } from "../../src/background/index";
import { NATIVE_TIMEOUT_MS, NativeSync } from "../../src/background/native-sync";
import { planRegistrations } from "../../src/background/registrations";
import type { NativeRequest } from "../../src/shared/messages";
import { DEFAULT_SETTINGS, SETTINGS_KEY } from "../../src/shared/settings";
import type { Settings } from "../../src/shared/types";

type Script = DuskBrowser.RegisteredContentScript;
type Api = Parameters<typeof createBackground>[0];
type NativeHandler = (msg: NativeRequest) => unknown;

function listener<A extends unknown[]>() {
  const cbs: ((...a: A) => unknown)[] = [];
  return {
    addListener: (cb: (...a: A) => unknown) => void cbs.push(cb),
    removeListener: (cb: (...a: A) => unknown) => void cbs.splice(cbs.indexOf(cb), 1),
    fire: (...a: A) => cbs.map((cb) => cb(...a)),
  };
}

/** In-memory `browser`: storage.local with onChanged, scripting registry, native messaging. */
function mockBrowser(native: NativeHandler = (m) => (m.type === "sync" ? { ok: true, settings: m.settings } : { ok: true })) {
  const store: Record<string, unknown> = {};
  const registry = new Map<string, Script>();
  const log = { register: [] as string[][], update: [] as string[][], unregister: [] as string[][], native: [] as NativeRequest[], sets: 0 };
  const onChanged = listener<[Record<string, { oldValue?: unknown; newValue?: unknown }>, string]>();
  const onMessage = listener<[unknown, { id?: string; tab?: DuskBrowser.Tab; url?: string }, (r?: unknown) => void]>();
  const onStartup = listener<[]>();
  const onInstalled = listener<[{ reason: string }]>();
  const onActivated = listener<[{ tabId: number; windowId: number }]>();
  const state = { native };
  const clone = <T>(x: T): T => structuredClone(x);
  const api = {
    storage: {
      local: {
        async get(key?: string | string[] | Record<string, unknown> | null) {
          if (typeof key === "string") return key in store ? { [key]: clone(store[key]) } : {};
          return clone(store);
        },
        async set(items: Record<string, unknown>) {
          log.sets++;
          const changes: Record<string, { oldValue?: unknown; newValue?: unknown }> = {};
          for (const [k, v] of Object.entries(items)) {
            changes[k] = { oldValue: store[k], newValue: clone(v) };
            store[k] = clone(v);
          }
          // Safari fires onChanged asynchronously after the write.
          queueMicrotask(() => onChanged.fire(changes, "local"));
        },
      },
      onChanged,
    },
    scripting: {
      async registerContentScripts(scripts: Script[]) {
        for (const s of scripts) if (registry.has(s.id)) throw new Error(`duplicate id ${s.id}`);
        log.register.push(scripts.map((s) => s.id));
        for (const s of scripts) registry.set(s.id, clone(s));
      },
      async updateContentScripts(scripts: Script[]) {
        log.update.push(scripts.map((s) => s.id));
        for (const s of scripts) registry.set(s.id, { ...registry.get(s.id), ...clone(s) });
      },
      async unregisterContentScripts(filter?: { ids?: string[] }) {
        const ids = filter?.ids ?? [...registry.keys()];
        log.unregister.push(ids);
        for (const id of ids) registry.delete(id);
      },
      async getRegisteredContentScripts() {
        return [...registry.values()].map(clone);
      },
    },
    runtime: {
      async sendNativeMessage(_app: string, msg: unknown) {
        log.native.push(clone(msg) as NativeRequest);
        return state.native(msg as NativeRequest);
      },
      onMessage,
      onStartup,
      onInstalled,
      id: OWN.id,
      getManifest: () => ({ version: "1.2.3" }),
    },
    tabs: { onActivated },
  };
  return { api: api as unknown as Api, store, registry, log, state, onChanged, onMessage, onStartup, onInstalled, onActivated };
}

const OWN = { id: "dusk-ext" };

const settle = async () => {
  for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(0);
};

const offSite = (s: Settings, host: string, at = 10): Settings => ({ ...s, sites: { ...s.sites, [host]: { mode: "off", updatedAt: at } } });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-18T00:00:00Z"));
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("registrations", () => {
  it("install registers the default scripts in planner order", async () => {
    const m = mockBrowser();
    createBackground(m.api);
    m.onInstalled.fire({ reason: "install" });
    await settle();
    const plan = planRegistrations(DEFAULT_SETTINGS);
    expect(plan.length).toBeGreaterThan(0);
    expect(m.log.register.flat()).toEqual(plan.map((s) => s.id));
    expect(m.registry.get("engine-full-dark-0")?.matches).toEqual(["<all_urls>"]);
  });

  it("startup with matching registrations changes nothing", async () => {
    const m = mockBrowser();
    for (const s of planRegistrations(DEFAULT_SETTINGS)) m.registry.set(s.id, structuredClone(s));
    createBackground(m.api);
    m.onStartup.fire();
    await settle();
    expect(m.log).toMatchObject({ register: [], update: [], unregister: [] });
  });

  it("a settings change re-plans: exclusion appears for an off host, via update and without unregistering", async () => {
    const m = mockBrowser();
    createBackground(m.api);
    m.onInstalled.fire({ reason: "install" });
    await settle();
    m.log.register = [];
    await m.api.storage.local.set({ [SETTINGS_KEY]: offSite(DEFAULT_SETTINGS, "example.com") });
    await settle();
    expect(m.registry.get("engine-full-dark-0")?.excludeMatches).toEqual([]); // still debounced
    await vi.advanceTimersByTimeAsync(250);
    await settle();
    expect(m.registry.get("engine-full-dark-0")?.excludeMatches).toEqual(["*://example.com/*", "*://*.example.com/*"]);
    expect(m.log.update.flat()).toContain("engine-full-dark-0");
    expect(m.log.unregister).toEqual([]);
    expect(m.log.register).toEqual([]);
  });

  it("removed classes are unregistered and new ones registered (specific before default)", async () => {
    const m = mockBrowser();
    createBackground(m.api);
    m.onInstalled.fire({ reason: "install" });
    await settle();
    m.log.register = [];
    const s: Settings = { ...DEFAULT_SETTINGS, global: { ...DEFAULT_SETTINGS.global, theme: { value: "dim", updatedAt: 5 } } };
    await m.api.storage.local.set({ [SETTINGS_KEY]: s });
    await vi.advanceTimersByTimeAsync(300);
    await settle();
    expect([...m.registry.keys()].sort()).toEqual(planRegistrations(s).map((x) => x.id).sort());
    expect(m.log.unregister.flat()).toContain("engine-full-dark-0");
    expect(m.log.register.flat()).toEqual(planRegistrations(s).filter((x) => x.id.includes("dim")).map((x) => x.id));
  });

  it("concurrent applyRegistrations calls are serialized (no duplicate registration)", async () => {
    const m = mockBrowser();
    const bg = createBackground(m.api);
    await Promise.all([bg.applyRegistrations(), bg.applyRegistrations(), bg.applyRegistrations()]);
    expect(m.log.register).toHaveLength(1);
    expect(console.warn).not.toHaveBeenCalled();
  });
});

describe("native sync", () => {
  it("writes the merged result once and doesn't loop", async () => {
    const merged = offSite(DEFAULT_SETTINGS, "example.com", 99);
    const m = mockBrowser((msg) => (msg.type === "sync" ? { ok: true, settings: merged } : { ok: true }));
    createBackground(m.api);
    m.onInstalled.fire({ reason: "install" });
    await settle();
    await vi.advanceTimersByTimeAsync(5000);
    await settle();
    expect(m.log.sets).toBe(1);
    expect(m.store[SETTINGS_KEY]).toEqual(merged);
    expect(m.log.native.filter((x) => x.type === "sync")).toHaveLength(1);
    // The remote write still re-plans the registrations.
    expect(m.registry.get("engine-full-dark-0")?.excludeMatches).toContain("*://example.com/*");
  });

  it("a local change syncs after the debounce", async () => {
    const m = mockBrowser();
    createBackground(m.api);
    await m.api.storage.local.set({ [SETTINGS_KEY]: offSite(DEFAULT_SETTINGS, "a.com") });
    await m.api.storage.local.set({ [SETTINGS_KEY]: offSite(DEFAULT_SETTINGS, "b.com") });
    await vi.advanceTimersByTimeAsync(249);
    expect(m.log.native).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(m.log.native).toEqual([{ type: "sync", settings: offSite(DEFAULT_SETTINGS, "b.com") }]);
    expect(m.log.sets).toBe(2); // native echoed the same settings: no write-back
  });

  it("change detection uses canonicalJson, so key order never triggers a write", async () => {
    const local = offSite(DEFAULT_SETTINGS, "example.com");
    const reordered = JSON.parse(JSON.stringify({ sites: local.sites, global: local.global, schemaVersion: 1 }));
    reordered.global = Object.fromEntries(Object.entries(local.global).reverse());
    const m = mockBrowser((msg) => (msg.type === "sync" ? { ok: true, settings: reordered } : { ok: true }));
    m.store[SETTINGS_KEY] = structuredClone(local);
    const sync = new NativeSync({ storage: m.api.storage.local, send: (msg) => m.api.runtime.sendNativeMessage("x", msg), version: () => "1" });
    await sync.sync("test");
    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(local));
    expect(m.log.sets).toBe(0);
  });

  it("a native error or exception keeps the local settings and logs once", async () => {
    const local = offSite(DEFAULT_SETTINGS, "example.com");
    const m = mockBrowser(() => ({ ok: false, error: "storage_unavailable" }));
    m.store[SETTINGS_KEY] = structuredClone(local);
    const sync = new NativeSync({ storage: m.api.storage.local, send: (msg) => m.api.runtime.sendNativeMessage("x", msg), version: () => "1" });
    await sync.sync("a");
    m.state.native = () => {
      throw new Error("no handler");
    };
    await sync.sync("b");
    m.state.native = () => ({ nonsense: true });
    await sync.sync("c");
    expect(m.store[SETTINGS_KEY]).toEqual(local);
    expect(m.log.sets).toBe(0);
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it("a local write during an in-flight sync survives and is sent next", async () => {
    const remote = offSite(DEFAULT_SETTINGS, "remote.example", 50);
    const m = mockBrowser(async (msg) => {
      await new Promise((r) => setTimeout(r, 100));
      return msg.type === "sync" ? { ok: true, settings: msg.settings.sites["user.example"] ? msg.settings : remote } : { ok: true };
    });
    createBackground(m.api);
    m.onActivated.fire({ tabId: 1, windowId: 1 }); // sync reads the defaults, native replies after 100 ms
    await settle();
    const user = offSite(DEFAULT_SETTINGS, "user.example", 60);
    await m.api.storage.local.set({ [SETTINGS_KEY]: user }); // popup write while native is answering
    await vi.advanceTimersByTimeAsync(100);
    await settle();
    expect(m.store[SETTINGS_KEY]).toEqual(user); // the stale merge was not written over it
    await vi.advanceTimersByTimeAsync(400);
    await settle();
    expect(m.log.native.filter((x) => x.type === "sync").map((x) => x.type === "sync" && Object.keys(x.settings.sites))).toEqual([[], ["user.example"]]);
    expect(m.store[SETTINGS_KEY]).toEqual(user);
  });

  it("a native handler that never answers times out and doesn't block the chain", async () => {
    const m = mockBrowser(() => new Promise(() => {}));
    const sync = new NativeSync({ storage: m.api.storage.local, send: (msg) => m.api.runtime.sendNativeMessage("x", msg), version: () => "1" });
    let done = 0;
    void sync.sync("a").then(() => done++);
    void sync.heartbeat().then(() => done++);
    await vi.advanceTimersByTimeAsync(NATIVE_TIMEOUT_MS - 1);
    expect(done).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe(1);
    await vi.advanceTimersByTimeAsync(NATIVE_TIMEOUT_MS);
    expect(done).toBe(2);
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("sync calls are serialized", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const m = mockBrowser(async (msg) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 100));
      inFlight--;
      return msg.type === "sync" ? { ok: true, settings: msg.settings } : { ok: true };
    });
    const sync = new NativeSync({ storage: m.api.storage.local, send: (msg) => m.api.runtime.sendNativeMessage("x", msg), version: () => "1" });
    const all = Promise.all([sync.sync("a"), sync.sync("b"), sync.heartbeat()]);
    await vi.advanceTimersByTimeAsync(400);
    await all;
    expect(maxInFlight).toBe(1);
    expect(m.log.native.map((x) => x.type)).toEqual(["sync", "sync", "heartbeat"]);
  });

  it("install and startup send a heartbeat with the manifest version", async () => {
    const m = mockBrowser();
    createBackground(m.api);
    m.onStartup.fire();
    await settle();
    expect(m.log.native).toContainEqual({ type: "heartbeat", version: "1.2.3" });
    expect(m.log.native).toContainEqual({ type: "sync", settings: DEFAULT_SETTINGS });
  });

  it("popupOpened syncs every time and heartbeats at most once per hour", async () => {
    const m = mockBrowser();
    createBackground(m.api);
    const open = async () => {
      await m.onMessage.fire({ type: "popupOpened" }, OWN, () => {})[0];
      await settle();
    };
    await open();
    await open();
    expect(m.log.native.map((x) => x.type)).toEqual(["sync", "heartbeat", "sync"]);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    await open();
    expect(m.log.native.filter((x) => x.type === "heartbeat")).toHaveLength(2);
  });

  it("tab activation syncs at most once per 60 s", async () => {
    const m = mockBrowser();
    createBackground(m.api);
    for (let i = 0; i < 3; i++) m.onActivated.fire({ tabId: i, windowId: 1 });
    await settle();
    await vi.advanceTimersByTimeAsync(59_000);
    m.onActivated.fire({ tabId: 9, windowId: 1 });
    await settle();
    expect(m.log.native).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    m.onActivated.fire({ tabId: 10, windowId: 1 });
    await settle();
    expect(m.log.native).toHaveLength(2);
  });

  it("pageSeen (a content script ran on a page) reaches native at most once per hour, without the page", async () => {
    const m = mockBrowser();
    createBackground(m.api);
    const seen = async () => {
      await m.onMessage.fire({ type: "pageSeen" }, { ...OWN, tab: { id: 1, url: "https://private.example/x" } }, () => {})[0];
      await settle();
    };
    await seen();
    await seen();
    expect(m.log.native).toEqual([{ type: "pageSeen", version: "1.2.3" }]);
    await vi.advanceTimersByTimeAsync(HEARTBEAT_THROTTLE_MS);
    await seen();
    expect(m.log.native.filter((x) => x.type === "pageSeen")).toHaveLength(2);
  });

  it("a pageSeen that native couldn't record is sent again on the next page", async () => {
    const m = mockBrowser();
    createBackground(m.api);
    const seen = async () => {
      await m.onMessage.fire({ type: "pageSeen" }, OWN, () => {})[0];
      await settle();
    };
    m.state.native = () => ({ ok: false, error: "storage_unavailable" });
    await seen();
    m.state.native = () => ({ ok: true });
    await seen();
    await seen();
    expect(m.log.native.filter((x) => x.type === "pageSeen")).toHaveLength(2);
  });

  it("syncSettings (a page became visible) syncs at most once per 2 s", async () => {
    const m = mockBrowser();
    createBackground(m.api);
    const visible = async () => {
      await m.onMessage.fire({ type: "syncSettings" }, OWN, () => {})[0];
      await settle();
    };
    await visible();
    await visible();
    expect(m.log.native.map((x) => x.type)).toEqual(["sync"]);
    await vi.advanceTimersByTimeAsync(VISIBLE_SYNC_THROTTLE_MS);
    await visible();
    expect(m.log.native.map((x) => x.type)).toEqual(["sync", "sync"]);
  });

  it("deviceInfo is forwarded to native; device or null comes back", async () => {
    const device = { model: "iPad", osVersion: "26.1", appVersion: "1.0.0" };
    const m = mockBrowser((msg) => (msg.type === "deviceInfo" ? { ok: true, device } : { ok: true }));
    createBackground(m.api);
    expect(await m.onMessage.fire({ type: "deviceInfo" }, OWN, () => {})[0]).toEqual(device);
    expect(m.log.native).toEqual([{ type: "deviceInfo" }]);
    m.state.native = () => ({ ok: false, error: "bad_request" });
    expect(await m.onMessage.fire({ type: "deviceInfo" }, OWN, () => {})[0]).toBeNull();
    m.state.native = () => Promise.reject(new Error("gone"));
    expect(await m.onMessage.fire({ type: "deviceInfo" }, OWN, () => {})[0]).toBeNull();
  });

  it("ignores unknown messages so other listeners can answer", () => {
    const m = mockBrowser();
    createBackground(m.api);
    expect(m.onMessage.fire({ type: "pageStatus" }, OWN, () => {})[0]).toBeUndefined();
    expect(m.onMessage.fire("junk", OWN, () => {})[0]).toBeUndefined();
  });

  it("ignores messages from other extensions", () => {
    const m = mockBrowser();
    createBackground(m.api);
    for (const sender of [{}, { id: "other-ext" }]) {
      expect(m.onMessage.fire({ type: "deviceInfo" }, sender, () => {})[0]).toBeUndefined();
      expect(m.onMessage.fire({ type: "fetchResource", url: "https://cdn.example/a.css", as: "text" }, sender, () => {})[0]).toBeUndefined();
    }
    expect(m.log.native).toEqual([]);
  });
});

describe("fetchResource", () => {
  const page = { tabUrl: "https://news.example/article", frameUrl: "https://news.example/article" };
  const bytes = (n: number) => new Uint8Array(n).fill(65);
  const okFetch = (body: BodyInit | null, headers: Record<string, string> = {}) =>
    vi.fn<(u: string, init: RequestInit) => Promise<Response>>(async () => new Response(body, { status: 200, headers: { "content-type": "text/css", ...headers } }));

  it("rejects non-http(s) schemes without fetching", async () => {
    const f = okFetch("x");
    for (const url of ["file:///etc/passwd", "data:text/css,a{}", "blob:https://a.com/x", "javascript:1", "ftp://a.com/x", "not a url"]) {
      expect(await handleFetchResource({ type: "fetchResource", url, as: "text" }, page, f)).toEqual({ ok: false });
    }
    expect(f).not.toHaveBeenCalled();
  });

  it("only makes credentials:omit, force-cache fetches", async () => {
    const f = okFetch("body{}");
    expect(await handleFetchResource({ type: "fetchResource", url: "https://cdn.example/a.css", as: "text" }, page, f)).toEqual({ ok: true, text: "body{}" });
    expect(vi.getTimerCount()).toBe(0); // the 10 s timeout is cleared on success
    await handleFetchResource({ type: "fetchResource", url: "http://cdn.example/b.png", as: "blob" }, page, f);
    expect(f).toHaveBeenCalledTimes(2);
    for (const [, init] of f.mock.calls) expect(init).toMatchObject({ credentials: "omit", cache: "force-cache", redirect: "manual" });
  });

  it("rejects 6 MB bodies by Content-Length and by streamed count", async () => {
    const big = bytes(6 * 1024 * 1024);
    const declared = okFetch(null, { "content-length": String(big.length) });
    expect(await handleFetchResource({ type: "fetchResource", url: "https://cdn.example/big.css", as: "text" }, page, declared)).toEqual({ ok: false });
    const streamed = okFetch(new ReadableStream({ start(c) { for (let i = 0; i < 6; i++) c.enqueue(bytes(1024 * 1024)); c.close(); } }), { "content-type": "image/png" });
    expect(await handleFetchResource({ type: "fetchResource", url: "https://cdn.example/big.png", as: "blob" }, page, streamed)).toEqual({ ok: false });
    const atLimit = okFetch(bytes(MAX_BYTES));
    expect((await handleFetchResource({ type: "fetchResource", url: "https://cdn.example/ok.css", as: "text" }, page, atLimit)).ok).toBe(true);
  });

  it("times out at 10 s", async () => {
    let signal: AbortSignal | undefined;
    const f = vi.fn((_u: string | URL | Request, init?: RequestInit) => new Promise<Response>((_, reject) => {
      signal = init?.signal ?? undefined;
      signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));
    let result: unknown;
    void handleFetchResource({ type: "fetchResource", url: "https://slow.example/a.css", as: "text" }, page, f).then((r) => (result = r));
    await vi.advanceTimersByTimeAsync(9_999);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(signal?.aborted).toBe(true);
    expect(result).toEqual({ ok: false });
  });

  it("rejects HTTP errors", async () => {
    const f = vi.fn(async () => new Response("nope", { status: 404 }));
    expect(await handleFetchResource({ type: "fetchResource", url: "https://cdn.example/a.css", as: "text" }, page, f)).toEqual({ ok: false });
  });

  it("returns blobs as data URLs with corsOk from Access-Control-Allow-Origin", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const msg = { type: "fetchResource", url: "https://img.example/a.png", as: "blob" } as const;
    expect(await handleFetchResource(msg, page, okFetch(png, { "content-type": "image/png" }))).toEqual({ ok: true, dataUrl: "data:image/png;base64,iVBORw==", corsOk: false });
    expect(await handleFetchResource(msg, page, okFetch(png, { "content-type": "image/png", "access-control-allow-origin": "*" }))).toMatchObject({ corsOk: true });
    expect(await handleFetchResource(msg, page, okFetch(png, { "content-type": "image/png", "access-control-allow-origin": "https://news.example" }))).toMatchObject({ corsOk: true });
    expect(await handleFetchResource(msg, page, okFetch(png, { "content-type": "image/png", "access-control-allow-origin": "https://evil.example" }))).toMatchObject({ corsOk: false });
    expect(await handleFetchResource(msg, page, okFetch(png, { "content-type": "IMAGE/PNG; x=1" }))).toMatchObject({ dataUrl: "data:image/png;base64,iVBORw==" });
    expect(await handleFetchResource(msg, page, okFetch(png, { "content-type": "image/png,<svg>" }))).toEqual({ ok: false });
  });

  it("classifies local-network hosts", () => {
    const cases: Record<string, string | null> = {
      localhost: "loopback", "dev.localhost": "loopback", "127.0.0.1": "loopback", "127.9.9.9": "loopback", "0.0.0.0": "loopback", "[::1]": "loopback",
      "[::ffff:7f00:1]": "loopback", "10.1.2.3": "private", "172.16.0.1": "private", "172.31.255.255": "private", "192.168.1.1": "private",
      "100.64.0.1": "private", "[::ffff:c0a8:101]": "private", "169.254.169.254": "link-local", "[fe80::1]": "link-local", "printer.local": "local",
      "[fd12::1]": "ula", "[fc00::1]": "ula", "[64:ff9b::7f00:1]": "loopback", "[64:ff9b::c0a8:101]": "private", "[64:ff9b::a9fe:a9fe]": "link-local",
      "[::127.0.0.1]": "loopback", "[::10.0.0.1]": "private", "[fec0::1]": "private", "nas.internal": "private", "router.lan": "private", "printer.home.arpa": "private",
      // Single-label names (router, nas) only resolve through a local search domain or hosts file.
      router: "private", nas: "private", "router.": "private",
      "[64:ff9b::808:808]": null, "[::ffff:808:808]": null, "lan.example.com": null, "internal.example.com": null, "172.32.0.1": null, "8.8.8.8": null, "example.com": null, "[2001:db8::1]": null, "localhost.example.com": null,
    };
    for (const [h, c] of Object.entries(cases)) expect([h, hostClass(new URL(`http://${h}/`).hostname)]).toEqual([h, c]);
  });

  it("rejects local-network targets unless the requesting tab is in the same class", async () => {
    const f = okFetch("x");
    const req = (url: string) => ({ type: "fetchResource", url, as: "text" }) as const;
    for (const url of ["http://localhost:8080/a.css", "http://192.168.1.1/a.css", "http://169.254.169.254/latest", "http://printer.local/a.css", "http://[fd00::1]/a.css", "http://2130706433/a.css"]) {
      expect([url, await handleFetchResource(req(url), page, f)]).toEqual([url, { ok: false }]);
    }
    expect(await handleFetchResource(req("http://192.168.1.1/a.css"), {}, f)).toEqual({ ok: false });
    expect(f).not.toHaveBeenCalled();
    expect(await handleFetchResource(req("http://127.0.0.1:3000/a.css"), { tabUrl: "http://localhost:3000/", frameUrl: "http://localhost:3000/" }, f)).toEqual({ ok: true, text: "x" });
    expect(await handleFetchResource(req("http://10.0.0.2/a.css"), { tabUrl: "http://192.168.1.5/", frameUrl: "http://router.lan/" }, f)).toEqual({ ok: true, text: "x" });
    expect(await handleFetchResource(req("http://localhost/a.css"), { tabUrl: "http://192.168.1.5/", frameUrl: "http://192.168.1.5/" }, f)).toEqual({ ok: false });
    // Both the tab and the frame must be in the target's class; a missing URL never matches.
    expect(await handleFetchResource(req("http://localhost/a.css"), { tabUrl: "http://localhost/", frameUrl: "https://ads.example/" }, f)).toEqual({ ok: false });
    expect(await handleFetchResource(req("http://localhost/a.css"), { tabUrl: "https://news.example/", frameUrl: "http://localhost/" }, f)).toEqual({ ok: false });
    expect(await handleFetchResource(req("http://localhost/a.css"), { tabUrl: "http://localhost/" }, f)).toEqual({ ok: false });
    expect(await handleFetchResource(req("http://localhost/a.css"), { frameUrl: "http://localhost/" }, f)).toEqual({ ok: false });
  });

  const redirect = (location: string, status = 302) => new Response(null, { status, headers: { location } });
  const css = () => new Response("a{}", { status: 200, headers: { "content-type": "text/css" } });
  const routed = (routes: Record<string, () => Response>) =>
    vi.fn<(u: string, init: RequestInit) => Promise<Response>>(async (u) => (routes[u] ?? (() => new Response("missing", { status: 404 })))());
  const cssReq = (url = "https://cdn.example/a.css") => ({ type: "fetchResource", url, as: "text" }) as const;

  it("follows allowed redirects by hand, re-validating each hop", async () => {
    const f = routed({ "https://cdn.example/a.css": () => redirect("/b.css", 301), "https://cdn.example/b.css": () => redirect("https://other.example/c.css"), "https://other.example/c.css": css });
    expect(await handleFetchResource(cssReq(), page, f)).toEqual({ ok: true, text: "a{}" });
    expect(f.mock.calls.map(([u]) => u)).toEqual(["https://cdn.example/a.css", "https://cdn.example/b.css", "https://other.example/c.css"]);
    for (const [, init] of f.mock.calls) expect(init).toMatchObject({ credentials: "omit", redirect: "manual" });
  });

  it("rejects redirects to private or non-http targets without requesting them", async () => {
    for (const loc of ["http://192.168.0.1/admin", "http://localhost/x.css", "http://[fd00::1]/x.css", "file:///etc/passwd", "data:text/css,a{}"]) {
      const f = routed({ "https://cdn.example/a.css": () => redirect(loc), [loc]: css });
      expect([loc, await handleFetchResource(cssReq(), page, f)]).toEqual([loc, { ok: false }]);
      expect(f).toHaveBeenCalledTimes(1);
    }
  });

  it("fails closed on opaque redirects, missing Location and more than 5 redirects", async () => {
    const opaque = routed({ "https://cdn.example/a.css": () => {
      const r = new Response(null, { status: 200 });
      Object.defineProperty(r, "type", { value: "opaqueredirect" });
      Object.defineProperty(r, "status", { value: 0 });
      return r;
    } });
    expect(await handleFetchResource(cssReq(), page, opaque)).toEqual({ ok: false });
    expect(await handleFetchResource(cssReq(), page, routed({ "https://cdn.example/a.css": () => new Response(null, { status: 302 }) }))).toEqual({ ok: false });
    const chain = (n: number) => routed(Object.fromEntries([...Array.from({ length: n }, (_, i) => [`https://cdn.example/${i}.css`, () => redirect(`/${i + 1}.css`)]), [`https://cdn.example/${n}.css`, css]]));
    expect(await handleFetchResource(cssReq("https://cdn.example/0.css"), page, chain(5))).toEqual({ ok: true, text: "a{}" });
    expect(await handleFetchResource(cssReq("https://cdn.example/0.css"), page, chain(6))).toEqual({ ok: false });
  });

  it("returns text only for text/css", async () => {
    for (const type of ["text/html", "application/json", "text/plain", "text/css-x", ""]) {
      expect([type, await handleFetchResource(cssReq(), page, okFetch("secret", { "content-type": type }))]).toEqual([type, { ok: false }]);
    }
    expect(await handleFetchResource(cssReq(), page, okFetch("a{}", { "content-type": "Text/CSS; charset=utf-8" }))).toEqual({ ok: true, text: "a{}" });
  });

  it("returns blobs only for image/* types", async () => {
    const msg = { type: "fetchResource", url: "https://img.example/a", as: "blob" } as const;
    for (const type of ["text/html", "text/css", "application/octet-stream", ""]) {
      expect([type, await handleFetchResource(msg, page, okFetch("x", { "content-type": type }))]).toEqual([type, { ok: false }]);
    }
    expect(await handleFetchResource(msg, page, okFetch("<svg/>", { "content-type": "image/svg+xml" }))).toMatchObject({ ok: true, dataUrl: "data:image/svg+xml;base64,PHN2Zy8+" });
  });

  it("is wired to runtime.onMessage with the sender's tab and frame", async () => {
    const m = mockBrowser();
    const f = okFetch("body{}");
    vi.stubGlobal("fetch", f);
    createBackground(m.api);
    const sender = { ...OWN, tab: { url: "https://news.example/" }, url: "https://news.example/frame" };
    expect(await m.onMessage.fire({ type: "fetchResource", url: "https://cdn.example/a.css", as: "text" }, sender, () => {})[0]).toEqual({ ok: true, text: "body{}" });
    expect(await m.onMessage.fire({ type: "fetchResource", url: "file:///x", as: "text" }, sender, () => {})[0]).toEqual({ ok: false });
    expect(await m.onMessage.fire({ type: "fetchResource", url: 5, as: "text" }, sender, () => {})[0]).toEqual({ ok: false });
    vi.unstubAllGlobals();
  });
});
