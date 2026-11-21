import type { Mode, Settings, ThemeId } from "./types";

export type NativeRequest =
  | { type: "sync"; settings: Settings }
  | { type: "heartbeat"; version: string }
  // A content script ran on a page, so Safari let the extension into at least one website. Nothing about the page.
  | { type: "pageSeen"; version: string }
  | { type: "deviceInfo" };

export type NativeResponse =
  | { ok: true; settings?: Settings; device?: { model: "iPhone" | "iPad"; osVersion: string; appVersion: string } }
  | { ok: false; error: "bad_request" | "storage_unavailable" };

export type RuntimeMessage =
  | { type: "fetchResource"; url: string; as: "text" | "blob" }
  | { type: "pageStatus" }
  | { type: "popupOpened" }
  // content (top frame) → background when the page becomes visible: the user may be back from the app
  | { type: "syncSettings" }
  // content (top frame) → background once per page: the extension has website access (no URL, host or content)
  | { type: "pageSeen" }
  // popup → background → native; device and OS come from native, never from the user agent (iPad Safari reports a Mac UA)
  | { type: "deviceInfo" };

// corsOk (blobs only): the response carried `Access-Control-Allow-Origin: *` or the requesting page's origin, so the
// engine may read its pixels (images.ts FetchedImage).
export type FetchResult = { ok: true; text?: string; dataUrl?: string; corsOk?: boolean } | { ok: false };

export interface PageStatus {
  host: string | null;
  mode: Mode;
  theme: ThemeId;
  /** "overridden": the page declares a dark scheme but paints light, so Duskling themes it. */
  nativeDark: "used" | "ignored" | "overridden" | "none";
  active: boolean;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

// Shape check only; callers adopt settings through parseSettings, which is tolerant of field-level problems.
function isSettingsShape(x: unknown): x is Settings {
  return isRecord(x) && x["schemaVersion"] === 1 && isRecord(x["global"]) && isRecord(x["sites"]);
}

export function isNativeRequest(x: unknown): x is NativeRequest {
  if (!isRecord(x)) return false;
  switch (x["type"]) {
    case "sync": return isSettingsShape(x["settings"]);
    case "heartbeat":
    case "pageSeen": return typeof x["version"] === "string";
    case "deviceInfo": return true;
    default: return false;
  }
}

export function isNativeResponse(x: unknown): x is NativeResponse {
  if (!isRecord(x)) return false;
  if (x["ok"] === false) return x["error"] === "bad_request" || x["error"] === "storage_unavailable";
  if (x["ok"] !== true) return false;
  if (x["settings"] !== undefined && !isSettingsShape(x["settings"])) return false;
  const d = x["device"];
  if (d !== undefined) {
    if (!isRecord(d)) return false;
    if (d["model"] !== "iPhone" && d["model"] !== "iPad") return false;
    if (typeof d["osVersion"] !== "string" || typeof d["appVersion"] !== "string") return false;
  }
  return true;
}
