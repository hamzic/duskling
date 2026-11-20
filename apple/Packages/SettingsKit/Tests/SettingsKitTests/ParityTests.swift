import Foundation
import Testing
@testable import SettingsKit

private func parse(_ json: String) -> Settings { Settings.parse(Data(json.utf8)) }

private func site(_ body: String) -> String {
    """
    {"schemaVersion":1,"sites":{"x.com":\(body)}}
    """
}

@Suite struct ParityTests {
    @Test func purgeDoesNotTrapOnExtremeStamps() {
        var s = Settings.defaults
        s.sites["min.com"] = SiteRule(updatedAt: Int64.min, deleted: true)
        s.sites["max.com"] = SiteRule(updatedAt: Int64.max, deleted: true)
        s.sites["live.com"] = SiteRule(mode: .off, updatedAt: Int64.min)
        let out = s.purgedAndLimited(now: 5)
        #expect(Set(out.sites.keys) == ["max.com", "live.com"])
        // Negative `now` against a huge positive stamp overflows the other way.
        let neg = s.purgedAndLimited(now: Int64.min)
        #expect(neg.sites["max.com"] != nil)
        #expect(neg.sites["min.com"] != nil)
    }

    @Test func syncSurvivesInt64MinTombstone() throws {
        var i = Settings.defaults
        i.sites["min.com"] = SiteRule(updatedAt: Int64.min, deleted: true)
        let out = try SettingsSync(group: InMemoryStore(), cloud: nil, now: { 1_000 }).sync(incoming: i)
        #expect(out.sites["min.com"] == nil)
    }

    // Swift pins (TS accepts any finite number as a stamp; Swift needs an integer Int64).
    @Test func fractionalUpdatedAtDropsRule() {
        #expect(parse(site(#"{"mode":"off","updatedAt":1.5}"#)).sites.isEmpty)
    }

    @Test func exponentAndIntegralFloatUpdatedAt() {
        let r1 = parse(site(#"{"mode":"off","updatedAt":1e3}"#)).sites["x.com"]
        let r2 = parse(site(#"{"mode":"off","updatedAt":1000.0}"#)).sites["x.com"]
        // Pinned: whatever Foundation does today, both integral spellings behave the same.
        #expect(r1 == r2)
        #expect(r1 == nil || r1?.updatedAt == 1000)
        // Beyond Int64 is invalid.
        #expect(parse(site(#"{"mode":"off","updatedAt":1e30}"#)).sites.isEmpty)
    }

    @Test func normalizeHostRejectsJSWhitespaceIncludingBOM() {
        for ws in ["\u{FEFF}", "\u{A0}", "\u{2028}", "\u{3000}", "\u{0B}", "\u{1680}", " ", "\t", "\n"] {
            #expect(normalizeHost("a\(ws)b.com") == nil, Comment(rawValue: "U+\(String(ws.unicodeScalars.first!.value, radix: 16))"))
        }
        #expect(normalizeHost("a/b") == nil)
        #expect(normalizeHost("a:80") == nil)
        #expect(normalizeHost("WWW.Example.COM.") == "example.com")
        #expect(normalizeHost("192.168.0.1") == "192.168.0.1")
        #expect(normalizeHost("") == nil)
    }

    @Test func limitTieBreaksByHostName() {
        var sites: [String: SiteRule] = [:]
        for i in 0..<2001 { sites["h\(String(format: "%04d", i)).com"] = SiteRule(mode: .off, updatedAt: 7) }
        let out = Settings(global: Settings.defaults.global, sites: sites).purgedAndLimited(now: 8).sites
        #expect(out.count == 2000)
        #expect(out["h0000.com"] == nil)  // lexicographically smallest host is dropped first
        #expect(out["h0001.com"] != nil)
        #expect(out["h2000.com"] != nil)
    }

    @Test func nonObjectGlobalAndSitesFallBack() {
        #expect(parse(#"{"schemaVersion":1,"global":3,"sites":[]}"#) == Settings.defaults)
        #expect(parse(#"{"global":"x","sites":"y"}"#) == Settings.defaults)
        #expect(parse(#"{"global":null,"sites":null}"#) == Settings.defaults)
    }

    @Test func tieLiveRuleBeatsTombstoneEvenWithOtherFields() {
        let live = SiteRule(mode: .filter, theme: .dim, nativeDark: "ignore", updatedAt: 9)
        let tomb = SiteRule(mode: .off, theme: .midnight, updatedAt: 9, deleted: true)
        var a = Settings.defaults, b = Settings.defaults
        a.sites["x.com"] = live
        b.sites["x.com"] = tomb
        #expect(merge(a, b).sites["x.com"] == live)
        #expect(merge(b, a).sites["x.com"] == live)
    }
}
