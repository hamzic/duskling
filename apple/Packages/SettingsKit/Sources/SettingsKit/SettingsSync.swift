import Foundation

/// Merges the App Group copy, the iCloud copy (app only) and an incoming copy (from the extension), then stores the
/// result in every store. Synchronous and guarded by a lock so extension handlers need no async bridging; the
/// stores are never touched outside the lock. The lock is per process: the app and the extension are separate
/// processes, so `commit` merges in the App Group copy again right before writing (see there).
public final class SettingsSync: @unchecked Sendable {
    public static let key = "settings.v1"

    private let lock = NSLock()
    private let group: KeyValueStore
    private let cloud: KeyValueStore?
    private let now: @Sendable () -> Int64
    private let cloudSynchronize: (@Sendable () -> Void)?

    /// - Parameter cloudSynchronize: optional hook run after the cloud write, e.g. `{ cloudStore.synchronize() }`.
    public init(
        group: KeyValueStore,
        cloud: KeyValueStore?,
        now: @escaping @Sendable () -> Int64,
        cloudSynchronize: (@Sendable () -> Void)? = nil
    ) {
        self.group = group
        self.cloud = cloud
        self.now = now
        self.cloudSynchronize = cloudSynchronize
    }

    /// The App Group copy; defaults if absent or corrupt.
    public func current() -> Settings {
        lock.withLock { read(group) ?? .defaults }
    }

    /// Merge incoming + group + cloud, purge and limit, write to both stores, return the result.
    public func sync(incoming: Settings?) throws -> Settings {
        try lock.withLock { try commit(mergedLocked(incoming: incoming)) }
    }

    /// After an Apple account change the iCloud store holds the new account's data ("the system removes any previous
    /// iCloud data and replaces it with data from the new account. Use the new data to configure your app."
    /// https://developer.apple.com/documentation/foundation/nsubiquitouskeyvaluestoreaccountchange). The App Group copy
    /// still holds the previous account's sites, so it is replaced, not merged.
    public func adoptCloud() throws -> Settings {
        try lock.withLock {
            let s = cloud.flatMap(read) ?? .defaults
            let out = s.purgedAndLimited(now: now())
            try write(canonicalJSON(out))
            return out
        }
    }

    /// Apply `f` to the merged group + cloud copy and persist. The closure is responsible for stamping `updatedAt`.
    public func update(_ f: (inout Settings) -> Void) throws -> Settings {
        try lock.withLock {
            var s = mergedLocked(incoming: nil)
            f(&s)
            return try commit(s)
        }
    }

    // Caller holds `lock`.

    /// Missing key: skipped. Present but corrupt: treated as defaults (then overwritten by `commit`).
    private func read(_ store: KeyValueStore) -> Settings? {
        store.data(forKey: Self.key).map(Settings.parse)
    }

    private func mergedLocked(incoming: Settings?) -> Settings {
        let parts = [read(group), cloud.flatMap(read), incoming].compactMap { $0 }
        guard let first = parts.first else { return .defaults }
        return parts.dropFirst().reduce(first, merge)
    }

    /// The other process may have committed since `mergedLocked` read the App Group copy; reading it again and merging
    /// (per-field last writer wins) keeps that write. Only the time between this read and the write stays unguarded:
    /// UserDefaults has no cross-process transaction.
    private func commit(_ s: Settings) throws -> Settings {
        let fresh = read(group).map { merge(s, $0) } ?? s
        let out = fresh.purgedAndLimited(now: now())
        try write(canonicalJSON(out))
        return out
    }

    /// Writes only the stores whose copy differs. The app refreshes on every foreground, every iCloud change and every
    /// 2 s during onboarding, and `synchronize()` is to be called "sparingly" ("iCloud limits updates to several times
    /// per minute", https://developer.apple.com/documentation/foundation/nsubiquitouskeyvaluestore/synchronize()).
    private func write(_ data: Data) throws {
        if group.data(forKey: Self.key) != data { try group.set(data, forKey: Self.key) }
        if let cloud, cloud.data(forKey: Self.key) != data {
            try cloud.set(data, forKey: Self.key)
            cloudSynchronize?()
        }
    }
}
