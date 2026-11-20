import Foundation
import Testing
@testable import SettingsKit

private func withTheme(_ t: ThemeID, at stamp: Int64) -> Settings {
    var s = Settings.defaults
    s.global.theme = Stamped(value: t, updatedAt: stamp)
    return s
}

private func stored(_ store: KeyValueStore) -> Settings? {
    store.data(forKey: "settings.v1").map(Settings.parse)
}

private func put(_ s: Settings, in store: KeyValueStore) throws {
    try store.set(canonicalJSON(s), forKey: "settings.v1")
}

@Suite struct SyncTests {
    @Test func nilIncomingReturnsGroupValue() throws {
        let group = InMemoryStore(), cloud = InMemoryStore()
        let g = withTheme(.midnight, at: 10)
        try put(g, in: group)
        let sync = SettingsSync(group: group, cloud: cloud, now: { 1000 })
        #expect(try sync.sync(incoming: nil) == g)
        #expect(sync.current() == g)
    }

    @Test func emptyStoresYieldDefaultsAndWriteThem() throws {
        let group = InMemoryStore()
        let sync = SettingsSync(group: group, cloud: nil, now: { 1000 })
        #expect(sync.current() == Settings.defaults)
        #expect(try sync.sync(incoming: nil) == Settings.defaults)
        #expect(stored(group) == Settings.defaults)
    }

    @Test func threeWayMerge() throws {
        let group = InMemoryStore(), cloud = InMemoryStore()
        var g = withTheme(.dim, at: 10)
        g.sites["g.com"] = SiteRule(mode: .off, updatedAt: 5)
        var c = Settings.defaults
        c.global.enabled = Stamped(value: false, updatedAt: 20)
        c.sites["c.com"] = SiteRule(mode: .gentle, updatedAt: 6)
        var i = Settings.defaults
        i.global.theme = Stamped(value: .midnight, updatedAt: 30)
        i.sites["i.com"] = SiteRule(mode: .filter, updatedAt: 7)
        try put(g, in: group)
        try put(c, in: cloud)
        let out = try SettingsSync(group: group, cloud: cloud, now: { 1000 }).sync(incoming: i)
        #expect(out.global.theme == Stamped(value: .midnight, updatedAt: 30))
        #expect(out.global.enabled == Stamped(value: false, updatedAt: 20))
        #expect(Set(out.sites.keys) == ["g.com", "c.com", "i.com"])
    }

    @Test func writesToBothStores() throws {
        let group = InMemoryStore(), cloud = InMemoryStore()
        let out = try SettingsSync(group: group, cloud: cloud, now: { 1000 }).sync(incoming: withTheme(.dim, at: 9))
        #expect(stored(group) == out)
        #expect(stored(cloud) == out)
        #expect(out.global.theme.value == .dim)
    }

    @Test func purgesAndLimitsBeforeWriting() throws {
        let group = InMemoryStore()
        let day: Int64 = 24 * 60 * 60 * 1000
        var i = Settings.defaults
        i.sites["old.com"] = SiteRule(updatedAt: 1, deleted: true)
        i.sites["live.com"] = SiteRule(mode: .off, updatedAt: 1)
        let out = try SettingsSync(group: group, cloud: nil, now: { 40 * day }).sync(incoming: i)
        #expect(Set(out.sites.keys) == ["live.com"])
        #expect(stored(group) == out)
    }

    @Test func corruptStoredJSONTreatedAsDefaultsAndOverwritten() throws {
        let group = InMemoryStore(), cloud = InMemoryStore()
        try group.set(Data("{not json".utf8), forKey: "settings.v1")
        try cloud.set(Data("[1,2]".utf8), forKey: "settings.v1")
        let out = try SettingsSync(group: group, cloud: cloud, now: { 1000 }).sync(incoming: nil)
        #expect(out == Settings.defaults)
        #expect(stored(group) == Settings.defaults)
        #expect(stored(cloud) == Settings.defaults)
    }

    @Test func failingWriteMakesSyncThrow() {
        let group = InMemoryStore()
        group.failWrites = true
        let sync = SettingsSync(group: group, cloud: nil, now: { 1000 })
        #expect(throws: (any Error).self) { try sync.sync(incoming: nil) }
        let cloud = InMemoryStore()
        cloud.failWrites = true
        let sync2 = SettingsSync(group: InMemoryStore(), cloud: cloud, now: { 1000 })
        #expect(throws: (any Error).self) { try sync2.sync(incoming: nil) }
    }

    @Test func updateAppliesMutationOnMergedBaseAndPersists() throws {
        let group = InMemoryStore(), cloud = InMemoryStore()
        try put(withTheme(.dim, at: 10), in: group)
        var c = Settings.defaults
        c.sites["c.com"] = SiteRule(mode: .gentle, updatedAt: 6)
        try put(c, in: cloud)
        let sync = SettingsSync(group: group, cloud: cloud, now: { 1000 })
        let out = try sync.update { $0.global.dimImages = Stamped(value: true, updatedAt: 50) }
        #expect(out.global.dimImages.value)
        #expect(out.global.theme.value == .dim)
        #expect(out.sites["c.com"] != nil)
        #expect(stored(group) == out)
        #expect(stored(cloud) == out)
    }

    @Test func cloudSynchronizeHookCalledAfterWrite() throws {
        let box = CallCounter()
        let sync = SettingsSync(group: InMemoryStore(), cloud: InMemoryStore(), now: { 1 }, cloudSynchronize: { box.bump() })
        _ = try sync.sync(incoming: nil)
        #expect(box.count == 1)
    }

    @Test func concurrentSyncsAreSerialized() async throws {
        let group = InMemoryStore()
        let sync = SettingsSync(group: group, cloud: nil, now: { 1000 })
        try await withThrowingTaskGroup(of: Void.self) { tg in
            for n in 0..<50 {
                tg.addTask {
                    var s = Settings.defaults
                    s.sites["h\(n).com"] = SiteRule(mode: .off, updatedAt: Int64(n + 1))
                    _ = try sync.sync(incoming: s)
                }
            }
            try await tg.waitForAll()
        }
        #expect(sync.current().sites.count == 50)
    }

    @Test func heartbeatRoundTrip() throws {
        let store = InMemoryStore()
        #expect(Heartbeat.lastSeen(in: store) == nil)
        Heartbeat.record(version: "1.2.3", in: store, now: 1234)
        let seen = try #require(Heartbeat.lastSeen(in: store))
        #expect(seen.version == "1.2.3")
        #expect(seen.at == 1234)
        Heartbeat.record(version: "1.2.4", in: store, now: 2000)
        #expect(Heartbeat.lastSeen(in: store)?.version == "1.2.4")
    }

    @Test func heartbeatIgnoresCorruptData() throws {
        let store = InMemoryStore()
        try store.set(Data("garbage".utf8), forKey: "heartbeat.v1")
        #expect(Heartbeat.lastSeen(in: store) == nil)
    }

    @Test func appGroupStoreRoundTripAndFallback() throws {
        let suite = "settingskit.test.\(UUID().uuidString)"
        defer { UserDefaults().removePersistentDomain(forName: suite) }
        let store = AppGroupStore(suiteName: suite)
        #expect(store.data(forKey: "k") == nil)
        try store.set(Data("v".utf8), forKey: "k")
        #expect(store.data(forKey: "k") == Data("v".utf8))
        try store.set(nil, forKey: "k")
        #expect(store.data(forKey: "k") == nil)
        // nil or empty suite falls back to .standard without crashing
        let std = AppGroupStore(suiteName: nil)
        try std.set(Data("x".utf8), forKey: suite)
        #expect(std.data(forKey: suite) == Data("x".utf8))
        try std.set(nil, forKey: suite)
        _ = AppGroupStore(suiteName: "")
    }

    @Test func brandReadsInfoDictionaryTolerantly() {
        let info: [String: Any] = [
            "CFBundleDisplayName": "Dusk", "DuskAppGroupID": "group.x", "DuskReportEmail": "r@example.invalid",
            "CFBundleShortVersionString": "1.0.0",
        ]
        #expect(Brand.string("CFBundleDisplayName", in: info) == "Dusk")
        #expect(Brand.string("DuskAppGroupID", in: info) == "group.x")
        #expect(Brand.string("DuskReportEmail", in: info) == "r@example.invalid")
        #expect(Brand.string("CFBundleShortVersionString", in: info) == "1.0.0")
        #expect(Brand.string("DuskAppGroupID", in: nil) == "")
        #expect(Brand.string("DuskAppGroupID", in: ["DuskAppGroupID": 3]) == "")
        // Bundle.main here is the test runner: must not crash.
        _ = (Brand.name, Brand.appGroupID, Brand.reportEmail, Brand.version)
    }

    @Test func unchangedRefreshWritesNeitherStore() throws {
        let group = CountingStore(), cloud = CountingStore(), syncs = CallCounter()
        let sync = SettingsSync(group: group, cloud: cloud, now: { 1000 }, cloudSynchronize: { syncs.bump() })
        _ = try sync.sync(incoming: withTheme(.dim, at: 9))
        #expect(group.writes == 1 && cloud.writes == 1 && syncs.count == 1)
        _ = try sync.sync(incoming: nil)
        _ = try sync.sync(incoming: withTheme(.dim, at: 9))
        #expect(group.writes == 1 && cloud.writes == 1 && syncs.count == 1)
        _ = try sync.sync(incoming: withTheme(.midnight, at: 10))
        #expect(group.writes == 2 && cloud.writes == 2 && syncs.count == 2)
    }

    @Test func aWriteByTheOtherProcessDuringASyncIsKept() throws {
        // The app and the extension are separate processes; the lock is per process. The other one commits between this
        // sync's first read and its write.
        let group = RacingStore(), cloud = InMemoryStore()
        try put(withTheme(.dim, at: 5), in: group)
        group.onFirstRead = { try? put(withTheme(.midnight, at: 50), in: group.inner) }
        let out = try SettingsSync(group: group, cloud: cloud, now: { 1000 }).sync(incoming: withTheme(.dim, at: 9))
        #expect(out.global.theme == Stamped(value: .midnight, updatedAt: 50))
        #expect(stored(group)?.global.theme == Stamped(value: .midnight, updatedAt: 50))
    }

    @Test func adoptCloudReplacesTheGroupCopyAfterAnAccountChange() throws {
        let group = InMemoryStore(), cloud = InMemoryStore()
        var g = withTheme(.midnight, at: 10)
        g.sites["old-account.com"] = SiteRule(mode: .off, updatedAt: 5)
        var c = Settings.defaults
        c.sites["new-account.com"] = SiteRule(mode: .gentle, updatedAt: 6)
        try put(g, in: group)
        try put(c, in: cloud)
        let out = try SettingsSync(group: group, cloud: cloud, now: { 1000 }).adoptCloud()
        #expect(Set(out.sites.keys) == ["new-account.com"])
        #expect(out.global.theme == Settings.defaults.global.theme)
        #expect(stored(group) == out)
        #expect(stored(cloud) == out)
    }

    @Test func adoptCloudWithAnEmptyNewAccountStartsFromDefaults() throws {
        let group = InMemoryStore(), cloud = InMemoryStore()
        try put(withTheme(.midnight, at: 10), in: group)
        let out = try SettingsSync(group: group, cloud: cloud, now: { 1000 }).adoptCloud()
        #expect(out == Settings.defaults)
        #expect(stored(group) == Settings.defaults)
    }
}

private final class CallCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var n = 0
    func bump() { lock.lock(); n += 1; lock.unlock() }
    var count: Int { lock.lock(); defer { lock.unlock() }; return n }
}

/// Counts writes, to check that an unchanged refresh doesn't write (`synchronize()` is to be called sparingly).
private final class CountingStore: KeyValueStore, @unchecked Sendable {
    let inner = InMemoryStore()
    private let lock = NSLock()
    private var n = 0
    var writes: Int { lock.withLock { n } }
    func data(forKey key: String) -> Data? { inner.data(forKey: key) }
    func set(_ data: Data?, forKey key: String) throws {
        lock.withLock { n += 1 }
        try inner.set(data, forKey: key)
    }
}

/// Runs `onFirstRead` once, right after the first read: another process writing in between.
private final class RacingStore: KeyValueStore, @unchecked Sendable {
    let inner = InMemoryStore()
    var onFirstRead: (() -> Void)?
    func data(forKey key: String) -> Data? {
        let d = inner.data(forKey: key)
        if let f = onFirstRead {
            onFirstRead = nil
            f()
        }
        return d
    }
    func set(_ data: Data?, forKey key: String) throws { try inner.set(data, forKey: key) }
}
