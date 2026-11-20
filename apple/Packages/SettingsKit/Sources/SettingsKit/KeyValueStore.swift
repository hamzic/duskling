import Foundation

public enum StoreError: Error, Equatable, Sendable {
    case writeFailed
}

public protocol KeyValueStore: Sendable {
    func data(forKey: String) -> Data?
    func set(_ data: Data?, forKey: String) throws
}

/// Test double; `failWrites` makes every `set` throw.
public final class InMemoryStore: KeyValueStore, @unchecked Sendable {
    private let lock = NSLock()
    private var storage: [String: Data] = [:]
    private var _failWrites = false

    public init() {}

    public var failWrites: Bool {
        get { lock.withLock { _failWrites } }
        set { lock.withLock { _failWrites = newValue } }
    }

    public func data(forKey key: String) -> Data? {
        lock.withLock { storage[key] }
    }

    public func set(_ data: Data?, forKey key: String) throws {
        try lock.withLock {
            if _failWrites { throw StoreError.writeFailed }
            storage[key] = data
        }
    }
}
