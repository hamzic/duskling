import Foundation

/// The extension records which version last ran so the app can tell the extension is installed and alive.
public struct Heartbeat {
    static let key = "heartbeat.v1"

    private struct Record: Codable {
        var version: String
        var at: Int64
    }

    /// Best effort: a failing store write is ignored (a missed heartbeat must never break a sync).
    public static func record(version: String, in store: KeyValueStore, now: Int64) {
        try? write(version: version, in: store, now: now)
    }

    static func write(version: String, in store: KeyValueStore, now: Int64) throws {
        try store.set(canonicalJSON(Record(version: version, at: now)), forKey: key)
    }

    public static func lastSeen(in store: KeyValueStore) -> (version: String, at: Int64)? {
        guard let data = store.data(forKey: key),
              let r = try? JSONDecoder().decode(Record.self, from: data) else { return nil }
        return (r.version, r.at)
    }
}
