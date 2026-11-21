import Foundation

public struct DeviceInfo: Codable, Sendable, Equatable {
    public enum Model: String, Codable, Sendable { case iPhone, iPad }
    public var model: Model
    public var osVersion: String
    public var appVersion: String

    public init(model: Model, osVersion: String, appVersion: String) {
        self.model = model
        self.osVersion = osVersion
        self.appVersion = appVersion
    }
}

/// Native message protocol (contract fixtures: shared/protocol/*.json; TS side:
/// extension/src/shared/messages.ts). Synchronous. Every well-formed request records the heartbeat
/// (`lastSeen` + `version`) in the App Group; malformed requests change nothing.
public struct NativeMessageRouter: Sendable {
    private let sync: SettingsSync
    private let group: KeyValueStore
    private let device: @Sendable () -> DeviceInfo
    private let now: @Sendable () -> Int64

    public init(
        sync: SettingsSync,
        group: KeyValueStore,
        device: @escaping @Sendable () -> DeviceInfo,
        now: @escaping @Sendable () -> Int64
    ) {
        self.sync = sync
        self.group = group
        self.device = device
        self.now = now
    }

    private enum Failure: String, Error { case bad_request, storage_unavailable }

    public func handle(_ request: Data) -> Data {
        do {
            return encode(try route(request))
        } catch let f as Failure {
            return encode(["ok": false, "error": f.rawValue] as [String: Any])
        } catch {
            return encode(["ok": false, "error": Failure.storage_unavailable.rawValue] as [String: Any])
        }
    }

    private func route(_ request: Data) throws -> [String: Any] {
        // A bare JSON string/number/array is not an object (and JSONSerialization rejects fragments without
        // .fragmentsAllowed anyway), so every non-object request ends up as bad_request.
        guard let obj = (try? JSONSerialization.jsonObject(with: request)) as? [String: Any],
              let type = obj["type"] as? String else { throw Failure.bad_request }
        switch type {
        case "heartbeat":
            guard let version = obj["version"] as? String else { throw Failure.bad_request }
            do { try Heartbeat.write(version: version, in: group, now: now()) } catch { throw Failure.storage_unavailable }
            return ["ok": true]
        case "pageSeen":
            guard let version = obj["version"] as? String else { throw Failure.bad_request }
            do {
                try Heartbeat.write(version: version, in: group, now: now())
                try Heartbeat.writePage(in: group, now: now())
            } catch { throw Failure.storage_unavailable }
            return ["ok": true]
        case "deviceInfo":
            let d = device()
            Heartbeat.record(version: d.appVersion, in: group, now: now())
            return ["ok": true, "device": json(d)]
        case "sync":
            // Same shape check as TS `isSettingsShape`; field-level problems are repaired by the tolerant decoder.
            guard let s = obj["settings"] as? [String: Any], isNumberOne(s["schemaVersion"]),
                  s["global"] is [String: Any], s["sites"] is [String: Any],
                  let data = try? JSONSerialization.data(withJSONObject: s) else { throw Failure.bad_request }
            Heartbeat.record(version: device().appVersion, in: group, now: now())
            let merged: Settings
            do { merged = try sync.sync(incoming: Settings.parse(data)) } catch { throw Failure.storage_unavailable }
            return ["ok": true, "settings": json(merged)]
        default:
            throw Failure.bad_request
        }
    }

    /// TS `schemaVersion === 1`: a JSON number equal to 1. Rejects `true` (an NSNumber bool, objCType "c"), 1.5, "1".
    private func isNumberOne(_ v: Any?) -> Bool {
        guard let n = v as? NSNumber, String(cString: n.objCType) != "c" else { return false }
        return n.doubleValue == 1
    }

    /// Reply for when the App Group is unusable (e.g. `Brand.appGroupID` is empty), so the handler fails loudly
    /// instead of silently falling back to `UserDefaults.standard`.
    public static var storageUnavailable: Data { Data(#"{"error":"storage_unavailable","ok":false}"#.utf8) }

    private func json<T: Encodable>(_ v: T) -> Any {
        (try? JSONSerialization.jsonObject(with: canonicalJSON(v))) ?? NSNull()
    }

    private func encode(_ obj: [String: Any]) -> Data {
        (try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys, .withoutEscapingSlashes])) ?? Self.storageUnavailable
    }
}
