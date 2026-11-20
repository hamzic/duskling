import Foundation
import Testing
@testable import SettingsKit

private func fixture(_ name: String) throws -> Data { try sharedData("protocol/\(name).json") }

private func object(_ data: Data) throws -> NSDictionary {
    try JSONSerialization.jsonObject(with: data) as! NSDictionary
}

private let device = DeviceInfo(model: .iPhone, osVersion: "26.1", appVersion: "1.0.0")

private func router(
    group: KeyValueStore = InMemoryStore(), cloud: KeyValueStore? = nil, now: Int64 = 4242
) -> (NativeMessageRouter, SettingsSync, KeyValueStore) {
    let sync = SettingsSync(group: group, cloud: cloud, now: { now })
    return (NativeMessageRouter(sync: sync, group: group, device: { device }, now: { now }), sync, group)
}

@Suite struct RouterTests {
    @Test func syncMatchesFixtureShape() throws {
        let (r, _, _) = router()
        let out = try object(r.handle(fixture("sync-request")))
        let expected = try object(fixture("sync-response"))
        #expect(out == expected)
    }

    @Test func syncReturnsMergedSettingsAndPersists() throws {
        let group = InMemoryStore()
        var stored = Settings.defaults
        stored.global.theme = Stamped(value: .dim, updatedAt: 3)
        stored.sites["g.com"] = SiteRule(mode: .off, updatedAt: 1)
        try group.set(canonicalJSON(stored), forKey: "settings.v1")
        var incoming = Settings.defaults
        incoming.global.theme = Stamped(value: .midnight, updatedAt: 5)
        let req = try JSONSerialization.data(withJSONObject: [
            "type": "sync", "settings": JSONSerialization.jsonObject(with: canonicalJSON(incoming)),
        ])
        let (r, sync, _) = router(group: group)
        let resp = try object(r.handle(req))
        #expect(resp["ok"] as? Bool == true)
        let merged = Settings.parse(try JSONSerialization.data(withJSONObject: resp["settings"] as Any))
        #expect(merged.global.theme == Stamped(value: .midnight, updatedAt: 5))
        #expect(merged.sites["g.com"] != nil)
        #expect(sync.current() == merged)
    }

    @Test func heartbeatRequestRecordsLastSeen() throws {
        let (r, _, group) = router(now: 777)
        let out = try object(r.handle(fixture("heartbeat-request")))
        let expected = try object(fixture("heartbeat-response"))
        #expect(out == expected)
        let seen = try #require(Heartbeat.lastSeen(in: group))
        #expect(seen.version == "1.0.0")
        #expect(seen.at == 777)
    }

    @Test func syncAndDeviceInfoAlsoRecordHeartbeat() throws {
        let (r1, _, g1) = router(now: 11)
        _ = r1.handle(try fixture("sync-request"))
        #expect(Heartbeat.lastSeen(in: g1)?.at == 11)
        #expect(Heartbeat.lastSeen(in: g1)?.version == "1.0.0")
        let (r2, _, g2) = router(now: 22)
        _ = r2.handle(try fixture("device-info-request"))
        #expect(Heartbeat.lastSeen(in: g2)?.at == 22)
    }

    @Test func deviceInfoReturnsInjectedDevice() throws {
        let (r, _, _) = router()
        let out = try object(r.handle(fixture("device-info-request")))
        let expected = try object(fixture("device-info-response"))
        #expect(out == expected)
        let ipad = DeviceInfo(model: .iPad, osVersion: "18.6", appVersion: "2.0.0")
        let sync = SettingsSync(group: InMemoryStore(), cloud: nil, now: { 1 })
        let r2 = NativeMessageRouter(sync: sync, group: InMemoryStore(), device: { ipad }, now: { 1 })
        let d = try object(r2.handle(fixture("device-info-request")))["device"] as! NSDictionary
        #expect(d["model"] as? String == "iPad")
        #expect(d["osVersion"] as? String == "18.6")
    }

    @Test func garbageGivesBadRequest() throws {
        let (r, _, group) = router()
        let expected = try object(fixture("error-response"))
        let bad = [
            "not json", "[]", "3", "{}", #"{"type":"nope"}"#, #"{"type":"heartbeat"}"#, #"{"type":"heartbeat","version":3}"#,
            #"{"type":"sync"}"#, #""sync""#, #"{"type":"sync","settings":{"schemaVersion":true,"global":{},"sites":{}}}"#,
            #"{"type":"sync","settings":{"schemaVersion":1.5,"global":{},"sites":{}}}"#,
            #"{"type":"sync","settings":{"schemaVersion":"1","global":{},"sites":{}}}"#, #"{"type":"sync","settings":{"schemaVersion":2,"global":{},"sites":{}}}"#,
            #"{"type":"sync","settings":{"schemaVersion":1,"global":[],"sites":{}}}"#,
        ]
        for b in bad {
            let out = try object(r.handle(Data(b.utf8)))
            #expect(out == expected, Comment(rawValue: b))
        }
        #expect(group.data(forKey: "settings.v1") == nil)
        #expect(Heartbeat.lastSeen(in: group) == nil)
    }

    @Test func failingStoreGivesStorageUnavailable() throws {
        let group = InMemoryStore()
        group.failWrites = true
        let (r, _, _) = router(group: group)
        let out = try object(r.handle(fixture("sync-request")))
        #expect(out == ["ok": false, "error": "storage_unavailable"] as NSDictionary)
    }

    @Test func schemaVersionOneAsFloatIsAccepted() throws {
        let (r, _, _) = router()
        let out = try object(r.handle(Data(#"{"type":"sync","settings":{"schemaVersion":1.0,"global":{},"sites":{}}}"#.utf8)))
        #expect(out["ok"] as? Bool == true)
    }

    @Test func largeUpdatedAtSurvivesSyncExactly() throws {
        // 2^53 + 1 is not representable as a Double; it must pass through JSONSerialization as an integer.
        let req = #"{"type":"sync","settings":{"schemaVersion":1,"global":{},"sites":{"big.com":{"mode":"off","updatedAt":9007199254740993}}}}"#
        let (r, sync, _) = router()
        let out = try object(r.handle(Data(req.utf8)))
        #expect(out["ok"] as? Bool == true)
        #expect(sync.current().sites["big.com"]?.updatedAt == 9_007_199_254_740_993)
        let text = String(decoding: r.handle(Data(req.utf8)), as: UTF8.self)
        #expect(text.contains("9007199254740993"))
    }

    @Test func storageUnavailableConstantMatchesErrorShape() throws {
        let out = try object(NativeMessageRouter.storageUnavailable)
        #expect(out == ["ok": false, "error": "storage_unavailable"] as NSDictionary)
    }
}
