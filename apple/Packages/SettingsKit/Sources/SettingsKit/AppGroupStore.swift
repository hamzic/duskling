import Foundation

/// `UserDefaults(suiteName:)` for the App Group; `.standard` when the suite name is nil, empty or unavailable.
/// `UserDefaults` is documented thread-safe ("can be called from any thread") but is not annotated Sendable.
/// https://developer.apple.com/documentation/foundation/userdefaults
public final class AppGroupStore: KeyValueStore, @unchecked Sendable {
    private let defaults: UserDefaults

    public init(suiteName: String?) {
        if let suiteName, !suiteName.isEmpty, let d = UserDefaults(suiteName: suiteName) {
            defaults = d
        } else {
            defaults = .standard
        }
    }

    public func data(forKey key: String) -> Data? {
        defaults.data(forKey: key)
    }

    public func set(_ data: Data?, forKey key: String) throws {
        if let data {
            defaults.set(data, forKey: key)
        } else {
            defaults.removeObject(forKey: key)
        }
    }
}
