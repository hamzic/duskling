import Foundation
import Testing
@testable import SettingsKit

private func settings(
    theme: (ThemeID, Int64)? = nil, enabled: (Bool, Int64)? = nil, sites: [String: SiteRule] = [:]
) -> Settings {
    var s = Settings.defaults
    if let theme { s.global.theme = Stamped(value: theme.0, updatedAt: theme.1) }
    if let enabled { s.global.enabled = Stamped(value: enabled.0, updatedAt: enabled.1) }
    s.sites = sites
    return s
}

/// SplitMix64, seeded for reproducible property tests.
private struct SeededRNG: RandomNumberGenerator {
    var state: UInt64
    mutating func next() -> UInt64 {
        state &+= 0x9E37_79B9_7F4A_7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
        z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
        return z ^ (z >> 31)
    }
}

private func randomSettings(_ rng: inout SeededRNG) -> Settings {
    // Small stamp space so ties are frequent.
    func stamp() -> Int64 { Int64.random(in: 0...3, using: &rng) }
    var s = Settings.defaults
    s.global.enabled = Stamped(value: Bool.random(using: &rng), updatedAt: stamp())
    s.global.theme = Stamped(value: ThemeID.allCases.randomElement(using: &rng)!, updatedAt: stamp())
    s.global.respectNativeDark = Stamped(value: Bool.random(using: &rng), updatedAt: stamp())
    s.global.dimImages = Stamped(value: Bool.random(using: &rng), updatedAt: stamp())
    for host in ["a.com", "b.com", "c.com", "d.com"] where Bool.random(using: &rng) {
        if Int.random(in: 0..<4, using: &rng) == 0 {
            s.sites[host] = SiteRule(updatedAt: stamp(), deleted: true)
        } else {
            s.sites[host] = SiteRule(
                mode: Bool.random(using: &rng) ? Mode.allCases.randomElement(using: &rng) : nil,
                theme: Bool.random(using: &rng) ? ThemeID.allCases.randomElement(using: &rng) : nil,
                nativeDark: Bool.random(using: &rng) ? "ignore" : nil,
                updatedAt: stamp())
        }
    }
    return s
}

@Suite struct MergeTests {
    @Test func newerGlobalFieldWins() {
        let a = settings(theme: (.midnight, 200))
        let b = settings(theme: (.dark, 100))
        #expect(merge(a, b).global.theme == Stamped(value: .midnight, updatedAt: 200))
        #expect(merge(b, a).global.theme == Stamped(value: .midnight, updatedAt: 200))
    }

    @Test func tieLargerEncodedValueWins() {
        let a = settings(theme: (.midnight, 5))
        let b = settings(theme: (.dim, 5))
        #expect(merge(a, b).global.theme.value == .midnight)
        #expect(merge(b, a).global.theme.value == .midnight)
    }

    @Test func hostsAreUnioned() {
        let a = settings(sites: ["a.com": SiteRule(mode: .off, updatedAt: 1)])
        let b = settings(sites: ["b.com": SiteRule(mode: .gentle, updatedAt: 2)])
        #expect(Set(merge(a, b).sites.keys) == ["a.com", "b.com"])
    }

    @Test func newerTombstoneBeatsRule() {
        let a = settings(sites: ["a.com": SiteRule(mode: .off, updatedAt: 1)])
        let b = settings(sites: ["a.com": SiteRule(updatedAt: 2, deleted: true)])
        #expect(merge(a, b).sites["a.com"] == SiteRule(updatedAt: 2, deleted: true))
        #expect(merge(b, a).sites["a.com"] == SiteRule(updatedAt: 2, deleted: true))
    }

    @Test func tieLiveRuleBeatsTombstone() {
        let live = SiteRule(mode: .off, updatedAt: 3)
        let a = settings(sites: ["a.com": live])
        let b = settings(sites: ["a.com": SiteRule(updatedAt: 3, deleted: true)])
        #expect(merge(a, b).sites["a.com"] == live)
    }

    @Test func commutativeOver300SeededPairs() {
        var rng = SeededRNG(state: 0xD05C)
        for i in 0..<300 {
            let a = randomSettings(&rng)
            let b = randomSettings(&rng)
            #expect(merge(a, b) == merge(b, a), Comment(rawValue: "pair \(i)"))
        }
    }

    @Test func associativeAndIdempotent() {
        var rng = SeededRNG(state: 0xBEEF)
        for i in 0..<300 {
            let a = randomSettings(&rng)
            let b = randomSettings(&rng)
            let c = randomSettings(&rng)
            #expect(merge(a, a) == a, Comment(rawValue: "idempotent \(i)"))
            #expect(merge(merge(a, b), c) == merge(a, merge(b, c)), Comment(rawValue: "associative \(i)"))
        }
    }

    // MARK: purgedAndLimited

    private let day: Int64 = 24 * 60 * 60 * 1000

    @Test func purgesTombstonesOlderThan30DaysOnly() {
        let now: Int64 = 100 * day
        let s = settings(sites: [
            "old.com": SiteRule(updatedAt: now - 31 * day, deleted: true),
            "recent.com": SiteRule(updatedAt: now - 29 * day, deleted: true),
            "oldlive.com": SiteRule(mode: .off, updatedAt: now - 90 * day),
        ])
        #expect(Set(s.purgedAndLimited(now: now).sites.keys) == ["recent.com", "oldlive.com"])
    }

    @Test func limitKeepsNewest2000() {
        var sites: [String: SiteRule] = [:]
        for i in 0..<2005 { sites["h\(i).com"] = SiteRule(mode: .off, updatedAt: 1000 + Int64(i)) }
        let out = settings(sites: sites).purgedAndLimited(now: 2000).sites
        #expect(out.count == 2000)
        #expect(out["h4.com"] == nil)
        #expect(out["h5.com"] != nil)
        #expect(out["h2004.com"] != nil)
    }

    @Test func limitDropsTombstonesBeforeLiveRules() {
        var sites: [String: SiteRule] = [:]
        for i in 0..<2000 { sites["h\(i).com"] = SiteRule(mode: .off, updatedAt: 1000 + Int64(i)) }
        sites["tomb.com"] = SiteRule(updatedAt: 5000, deleted: true)
        let out = settings(sites: sites).purgedAndLimited(now: 6000).sites
        #expect(out.count == 2000)
        #expect(out["tomb.com"] == nil)
        #expect(out["h0.com"] != nil)
    }
}
