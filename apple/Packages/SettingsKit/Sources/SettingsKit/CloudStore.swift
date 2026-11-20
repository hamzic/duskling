#if canImport(Darwin)
import Foundation

/// iCloud key-value store, used only by the app; the extension never touches it.
/// API per Apple docs, https://developer.apple.com/documentation/foundation/nsubiquitouskeyvaluestore :
/// `data(forKey:)`, `set(_:forKey:)`, `removeObject(forKey:)` and `synchronize()` (returns Bool; "explicitly
/// synchronizes in-memory keys and values with those stored on disk"). Verified against the macOS SDK header
/// NSUbiquitousKeyValueStore.h (`dataForKey:`, `setData:forKey:`, `removeObjectForKey:`, `synchronize`).
/// The class is not annotated `Sendable`, but Apple documents it as safe to use from any thread.
public final class CloudStore: KeyValueStore, @unchecked Sendable {
    private let store: NSUbiquitousKeyValueStore

    public init(store: NSUbiquitousKeyValueStore = .default) {
        self.store = store
    }

    public func data(forKey key: String) -> Data? {
        store.data(forKey: key)
    }

    public func set(_ data: Data?, forKey key: String) throws {
        if let data {
            store.set(data, forKey: key)
        } else {
            store.removeObject(forKey: key)
        }
    }

    /// Pass as `SettingsSync(cloudSynchronize:)`.
    @discardableResult
    public func synchronize() -> Bool {
        store.synchronize()
    }
}
#endif
