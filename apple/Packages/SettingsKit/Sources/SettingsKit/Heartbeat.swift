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

    /// When a content script last ran on a page. Safari runs content scripts only on websites the user allowed, so this
    /// tells the app the extension has website access, not just that it's turned on. No URL or host is stored.
    static let pageKey = "heartbeat.page.v1"

    private struct PageRecord: Codable {
        var at: Int64
    }

    public static func recordPage(in store: KeyValueStore, now: Int64) {
        try? writePage(in: store, now: now)
    }

    static func writePage(in store: KeyValueStore, now: Int64) throws {
        try store.set(canonicalJSON(PageRecord(at: now)), forKey: pageKey)
    }

    public static func lastPageSeen(in store: KeyValueStore) -> Int64? {
        guard let data = store.data(forKey: pageKey),
              let r = try? JSONDecoder().decode(PageRecord.self, from: data) else { return nil }
        return r.at
    }

    public static func lastSeen(in store: KeyValueStore) -> (version: String, at: Int64)? {
        guard let data = store.data(forKey: key),
              let r = try? JSONDecoder().decode(Record.self, from: data) else { return nil }
        return (r.version, r.at)
    }
}
