import { describe, expect, it } from "vitest";
import { isNativeRequest, isNativeResponse } from "../../src/shared/messages";
import { DEFAULT_SETTINGS } from "../../src/shared/settings";
import { loadShared } from "./shared-fixtures";

const requests = ["sync-request", "heartbeat-request", "device-info-request"];
const responses = ["sync-response", "heartbeat-response", "device-info-response", "error-response"];

describe("protocol fixtures", () => {
  for (const f of requests) {
    it(`${f}.json matches NativeRequest`, () => {
      expect(isNativeRequest(loadShared(`protocol/${f}.json`))).toBe(true);
    });
  }
  for (const f of responses) {
    it(`${f}.json passes isNativeResponse`, () => {
      expect(isNativeResponse(loadShared(`protocol/${f}.json`))).toBe(true);
    });
  }
  it("sync-request carries valid settings and error-response uses a known code", () => {
    const req = loadShared("protocol/sync-request.json") as { settings: unknown };
    expect(req.settings).toEqual(DEFAULT_SETTINGS);
    expect(loadShared("protocol/error-response.json")).toEqual({ ok: false, error: "bad_request" });
  });
});

describe("guards reject malformed input", () => {
  it("isNativeResponse", () => {
    for (const bad of [null, 1, {}, { ok: "yes" }, { ok: false }, { ok: false, error: "nope" }, { ok: true, device: { model: "Mac", osVersion: "1", appVersion: "1" } }, { ok: true, settings: { schemaVersion: 2 } }]) {
      expect(isNativeResponse(bad)).toBe(false);
    }
    expect(isNativeResponse({ ok: true })).toBe(true);
  });
  it("isNativeRequest", () => {
    for (const bad of [null, {}, { type: "sync" }, { type: "heartbeat" }, { type: "bogus" }, { type: "sync", settings: {} }]) {
      expect(isNativeRequest(bad)).toBe(false);
    }
  });
});
