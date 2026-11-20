import Foundation
import Testing
@testable import SettingsKit

/// Repo root: apple/Packages/SettingsKit/Tests/SettingsKitTests/<this file>.
private let repoRoot = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()

func sharedData(_ path: String) throws -> Data {
    try Data(contentsOf: repoRoot.appendingPathComponent("shared").appendingPathComponent(path))
}

func decodeSettings(_ path: String) throws -> Settings {
    try JSONDecoder().decode(Settings.self, from: sharedData(path))
}

private struct ResolutionCase: Decodable {
    let name: String
    let settings: Settings
    let host: String?
    let expected: EffectiveRule
}

private struct MergeCase: Decodable {
    let name: String
    let a: Settings
    let b: Settings
    let expected: Settings
}

@Suite struct ContractTests {
    @Test func defaultJSONEqualsDefaults() throws {
        #expect(try decodeSettings("settings/default.json") == Settings.defaults)
    }

    @Test func invalidThemeFallsBackToDefaultKeepingOtherFields() throws {
        let s = try decodeSettings("settings/invalid-theme.json")
        #expect(s.global.theme == Settings.defaults.global.theme)
        let raw = try JSONSerialization.jsonObject(with: sharedData("settings/invalid-theme.json")) as! [String: Any]
        let g = raw["global"] as! [String: Any]
        let enabled = g["enabled"] as! [String: Any]
        #expect(s.global.enabled.value == (enabled["value"] as! Bool))
        #expect(s.global.enabled.updatedAt == (enabled["updatedAt"] as! NSNumber).int64Value)
    }

    @Test func fullReEncodesSemanticallyEqual() throws {
        let data = try sharedData("settings/full.json")
        let s = try JSONDecoder().decode(Settings.self, from: data)
        let original = try JSONSerialization.jsonObject(with: data) as! NSDictionary
        let reencoded = try JSONSerialization.jsonObject(with: canonicalJSON(s)) as! NSDictionary
        #expect(original == reencoded)
        #expect(s.sites["gone.example.org"]?.deleted == true)
        #expect(s.sites["example.com"]?.nativeDark == "ignore")
    }

    @Test func resolutionCases() throws {
        let cases = try JSONDecoder().decode([ResolutionCase].self, from: sharedData("settings/resolution-cases.json"))
        #expect(!cases.isEmpty)
        for c in cases {
            #expect(c.settings.resolve(host: c.host) == c.expected, Comment(rawValue: c.name))
        }
    }

    @Test func mergeCases() throws {
        let cases = try JSONDecoder().decode([MergeCase].self, from: sharedData("settings/merge-cases.json"))
        #expect(!cases.isEmpty)
        for c in cases {
            #expect(merge(c.a, c.b) == c.expected, Comment(rawValue: c.name))
            #expect(merge(c.b, c.a) == c.expected, Comment(rawValue: "\(c.name) (swapped)"))
        }
    }

    @Test func tolerantDecoding() throws {
        let json = """
        {"schemaVersion":1,"extra":1,
         "global":{"enabled":{"value":"yes","updatedAt":5},"theme":{"value":"dim","updatedAt":7},"dimImages":{"value":true}},
         "sites":{"ok.com":{"mode":"off","updatedAt":1,"junk":true},
                  "badmode.com":{"mode":"nope","updatedAt":1},
                  "nostamp.com":{"mode":"off"},
                  "badnative.com":{"nativeDark":"x","updatedAt":1},
                  "use.com":{"nativeDark":"use","updatedAt":2},
                  "nullmode.com":{"mode":null,"updatedAt":1},
                  "num.com":3,
                  "tomb.com":{"updatedAt":9,"deleted":true}}}
        """
        let s = try JSONDecoder().decode(Settings.self, from: Data(json.utf8))
        #expect(s.global.enabled == Settings.defaults.global.enabled)
        #expect(s.global.theme == Stamped(value: .dim, updatedAt: 7))
        #expect(s.global.dimImages == Settings.defaults.global.dimImages)
        #expect(s.global.respectNativeDark == Settings.defaults.global.respectNativeDark)
        #expect(Set(s.sites.keys) == ["ok.com", "use.com", "tomb.com"])
        #expect(s.sites["use.com"] == SiteRule(nativeDark: "use", updatedAt: 2))
        #expect(s.sites["ok.com"] == SiteRule(mode: .off, updatedAt: 1))
        #expect(s.sites["tomb.com"] == SiteRule(updatedAt: 9, deleted: true))
    }

    @Test func nonObjectInputParsesToDefaults() {
        for raw in ["null", "\"x\"", "[]", "3", "not json"] {
            #expect(Settings.parse(Data(raw.utf8)) == Settings.defaults, Comment(rawValue: raw))
        }
    }

    @Test func canonicalJSONIsSortedAndUnescaped() {
        let s = Settings.defaults
        let text = String(decoding: canonicalJSON(s), as: UTF8.self)
        #expect(text.hasPrefix(#"{"global":{"dimImages":{"updatedAt":0,"value":false}"#))
        #expect(!text.contains(" "))
    }
}
