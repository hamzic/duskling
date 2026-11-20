// Minimal ambient declarations for the Safari WebExtension `browser` namespace; only APIs Duskling uses.
// Ref: https://developer.apple.com/documentation/safariservices/safari-web-extensions
// Helper types live in `DuskBrowser` so they don't leak as globals (e.g. `Listener`).
// scripting fields checked against @mdn/browser-compat-data 8.1.6 (webextensions.api.scripting, safari_ios):
// register/update/getRegistered/unregisterContentScripts and RegisteredContentScript (id, matches, excludeMatches, js,
// css, allFrames, runAt, persistAcrossSessions, world) all 16.4. `matchAboutBlank` has no BCD entry, so it's omitted.
declare namespace DuskBrowser {
  type Listener<A extends unknown[]> = {
    addListener(cb: (...args: A) => void): void;
    removeListener(cb: (...args: A) => void): void;
  };

  interface RegisteredContentScript {
    id: string;
    matches?: string[];
    excludeMatches?: string[];
    js?: string[];
    css?: string[];
    allFrames?: boolean;
    runAt?: "document_start" | "document_end" | "document_idle";
    world?: "ISOLATED" | "MAIN";
    persistAcrossSessions?: boolean;
  }

  interface Tab {
    id?: number;
    url?: string;
    active?: boolean;
    windowId?: number;
  }
}

declare const browser: {
  storage: {
    local: {
      get(keys?: string | string[] | Record<string, unknown> | null): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
    };
    onChanged: DuskBrowser.Listener<[changes: Record<string, { oldValue?: unknown; newValue?: unknown }>, areaName: string]>;
  };
  scripting: {
    registerContentScripts(scripts: DuskBrowser.RegisteredContentScript[]): Promise<void>;
    updateContentScripts(scripts: DuskBrowser.RegisteredContentScript[]): Promise<void>;
    unregisterContentScripts(filter?: { ids?: string[] }): Promise<void>;
    getRegisteredContentScripts(filter?: { ids?: string[] }): Promise<DuskBrowser.RegisteredContentScript[]>;
  };
  runtime: {
    sendMessage(message: unknown): Promise<unknown>;
    onMessage: {
      addListener(
        cb: (message: unknown, sender: { id?: string; tab?: DuskBrowser.Tab; url?: string }, sendResponse: (r?: unknown) => void) => boolean | Promise<unknown> | void,
      ): void;
      removeListener(cb: (...args: never[]) => unknown): void;
    };
    // runtime.id and MessageSender.id: safari_ios 15 (@mdn/browser-compat-data 8.1.6).
    readonly id: string;
    sendNativeMessage(application: string, message: unknown): Promise<unknown>;
    onStartup: DuskBrowser.Listener<[]>;
    onInstalled: DuskBrowser.Listener<[details: { reason: string }]>;
    getURL(path: string): string;
    getManifest(): { version: string; [key: string]: unknown };
  };
  tabs: {
    query(info: { active?: boolean; currentWindow?: boolean; url?: string | string[] }): Promise<DuskBrowser.Tab[]>;
    sendMessage(tabId: number, message: unknown, options?: { frameId?: number }): Promise<unknown>;
    create(props: { url?: string; active?: boolean }): Promise<DuskBrowser.Tab>;
    onActivated: DuskBrowser.Listener<[info: { tabId: number; windowId: number }]>;
  };
  // i18n.getMessage: safari_ios 15 (@mdn/browser-compat-data 8.1.6, webextensions.api.i18n.getMessage).
  i18n: {
    getMessage(name: string, substitutions?: string | string[]): string;
  };
};
