// Serialized settings sync with the native handler. The extension sends its full settings; the
// handler merges them with the App Group copy (SettingsKit.merge) and returns the result, which the extension adopts.
// When native messaging fails, the local copy stays authoritative.
import { isNativeResponse, type NativeRequest, type NativeResponse } from "../shared/messages";
import { canonicalJson, parseSettings, SETTINGS_KEY } from "../shared/settings";

export const NATIVE_TIMEOUT_MS = 5_000;

export interface NativeSyncDeps {
  storage: {
    get(key: string): Promise<Record<string, unknown>>;
    set(items: Record<string, unknown>): Promise<void>;
  };
  send(msg: NativeRequest): Promise<unknown>;
  version(): string;
}

type Device = NonNullable<Extract<NativeResponse, { ok: true }>["device"]>;

export class NativeSync {
  private chain: Promise<unknown> = Promise.resolve();
  private failureLogged = false;
  // Canonical JSON of settings this class wrote back and whose storage.onChanged hasn't been seen yet.
  private pendingRemote: string | null = null;

  constructor(private readonly deps: NativeSyncDeps) {}

  /** True while a write-back from native is waiting for its storage.onChanged event. */
  get applyingRemote(): boolean {
    return this.pendingRemote !== null;
  }

  /**
   * For the storage.onChanged handler: true (and clears the flag) when `newValue` is the settings object this class
   * just wrote back from native, so the change must not trigger another sync.
   */
  takeRemoteChange(newValue: unknown): boolean {
    if (this.pendingRemote === null || canonicalJson(parseSettings(newValue)) !== this.pendingRemote) return false;
    this.pendingRemote = null;
    return true;
  }

  sync(reason: string): Promise<void> {
    return this.enqueue(async () => {
      const local = parseSettings((await this.deps.storage.get(SETTINGS_KEY))[SETTINGS_KEY]);
      const res = await this.request({ type: "sync", settings: local }, reason);
      if (!res?.settings) {
        if (res) this.fail(reason, "response without settings");
        return;
      }
      const merged = parseSettings(res.settings);
      const json = canonicalJson(merged);
      if (json === canonicalJson(local)) return;
      // A local write (e.g. from the popup) landed while native was answering: keep it. Its storage.onChanged has
      // queued a change-sync that sends the newer copy, so writing the merge of the stale copy would lose it.
      const current = parseSettings((await this.deps.storage.get(SETTINGS_KEY))[SETTINGS_KEY]);
      if (canonicalJson(current) !== canonicalJson(local)) return;
      this.pendingRemote = json;
      try {
        await this.deps.storage.set({ [SETTINGS_KEY]: merged });
      } catch (e) {
        this.pendingRemote = null;
        this.fail(reason, e);
      }
    });
  }

  heartbeat(): Promise<void> {
    return this.enqueue(async () => {
      await this.request({ type: "heartbeat", version: this.deps.version() }, "heartbeat");
    });
  }

  /** The device the app reports (iPad Safari sends a Mac user agent); null when native is unavailable. */
  deviceInfo(): Promise<Device | null> {
    return this.enqueue(async () => (await this.request({ type: "deviceInfo" }, "deviceInfo"))?.device ?? null);
  }

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = this.chain.then(job);
    this.chain = run.catch(() => {});
    return run;
  }

  private async request(msg: NativeRequest, reason: string): Promise<Extract<NativeResponse, { ok: true }> | null> {
    let res: unknown;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // A native handler that never answers must not block the chain.
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), NATIVE_TIMEOUT_MS);
      });
      res = await Promise.race([this.deps.send(msg), timeout]);
    } catch (e) {
      this.fail(reason, e);
      return null;
    } finally {
      clearTimeout(timer);
    }
    if (!isNativeResponse(res)) {
      this.fail(reason, "malformed response");
      return null;
    }
    if (!res.ok) {
      this.fail(reason, res.error);
      return null;
    }
    this.failureLogged = false;
    return res;
  }

  // Log the first failure of a run of failures, not every retry.
  private fail(reason: string, detail: unknown): void {
    if (this.failureLogged) return;
    this.failureLogged = true;
    console.warn(`Duskling: native ${reason} failed; keeping local settings`, detail);
  }
}
