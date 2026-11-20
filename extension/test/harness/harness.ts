// In-page `browser` shim for the e2e suite, bundled to dist-test/harness.js by `build.mjs --test`.
//
// The e2e helpers inject it as part of one init script per page, after the bridge and pre-paint files and before the boot
// file and content.js, mirroring the registration order Safari uses. It only provides what content.js uses:
// - storage.local: held on the Node side behind the `__duskStorage` binding (page.exposeBinding), so it survives
//   navigations; Node calls `__duskHarness.fireChanged` in every frame when a test changes it.
// - runtime.sendMessage({type:"fetchResource"}): answered on the Node side by the real background handler through the
//   `__duskFetch` binding.
// - runtime.onMessage: listeners are kept so a test can ask for the page status (`__duskHarness.sendToContent`).
// - tabs and i18n: inert stubs.
type Changes = Record<string, { oldValue?: unknown; newValue?: unknown }>;
type ChangedCb = (changes: Changes, area: string) => void;
type MessageCb = (message: unknown, sender: { id?: string; url?: string }, sendResponse: (r?: unknown) => void) => unknown;

interface HarnessWindow {
  __duskStorage(op: "get" | "set", arg: unknown): Promise<Record<string, unknown>>;
  __duskFetch(message: unknown): Promise<unknown>;
  __duskHarness?: unknown;
  browser?: unknown;
}

const w = globalThis as unknown as HarnessWindow;
const ID = "dusk-harness";

if (!w.__duskHarness) {
  const changed = new Set<ChangedCb>();
  const messages = new Set<MessageCb>();
  const listener = <T>(set: Set<T>) => ({ addListener: (cb: T) => void set.add(cb), removeListener: (cb: T) => void set.delete(cb), hasListener: (cb: T) => set.has(cb) });
  const inert = { addListener() {}, removeListener() {} };

  w.browser = {
    storage: {
      local: {
        get: (keys?: unknown) => w.__duskStorage("get", keys ?? null),
        set: async (items: Record<string, unknown>) => void (await w.__duskStorage("set", items)),
      },
      onChanged: listener(changed),
    },
    runtime: {
      id: ID,
      sendMessage: async (message: unknown) =>
        (message as { type?: unknown } | null)?.type === "fetchResource" ? w.__duskFetch(message) : undefined,
      onMessage: listener(messages),
      onStartup: inert,
      onInstalled: inert,
      getURL: (path: string) => `safari-web-extension://${ID}/${path.replace(/^\//, "")}`,
      getManifest: () => ({ version: "0.0.0" }),
    },
    tabs: {
      query: async () => [],
      sendMessage: async () => undefined,
      create: async () => ({}),
      onActivated: inert,
    },
    i18n: { getMessage: (name: string) => name },
  };

  w.__duskHarness = {
    fireChanged(changes: Changes, area = "local"): void {
      for (const cb of [...changed]) cb(changes, area);
    },
    /** Delivers a message to the content script's onMessage listeners as the extension would; resolves with the first answer. */
    async sendToContent(message: unknown): Promise<unknown> {
      for (const cb of [...messages]) {
        let answer: unknown;
        const r = cb(message, { id: ID }, (x) => (answer = x));
        if (r instanceof Promise) return r;
        if (r === true || answer !== undefined) return answer;
      }
      return undefined;
    },
  };
}

export {};
