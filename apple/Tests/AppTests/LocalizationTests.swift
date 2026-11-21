import SettingsKit
import XCTest

/// Every app string lives in `App/Localizable.xcstrings`, and the build compiles it into the app.
final class LocalizationTests: XCTestCase {
    private static let missing = "\u{1}missing"

    private func catalog() throws -> (source: String, strings: [String: [String: Any]]) {
        let apple = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let data = try Data(contentsOf: apple.appendingPathComponent("App/Localizable.xcstrings"))
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let strings = try XCTUnwrap(json["strings"] as? [String: [String: Any]])
        return (try XCTUnwrap(json["sourceLanguage"] as? String), strings)
    }

    /// `localizedString(forKey:value:table:)` returns `value` when the table has no entry for the key, so a key that
    /// comes back as itself (or its catalog value) proves the compiled table is in the app bundle.
    /// https://developer.apple.com/documentation/foundation/bundle/localizedstring(forkey:value:table:)
    func testEveryCatalogStringIsCompiledIntoTheApp() throws {
        let (source, strings) = try catalog()
        XCTAssertEqual(source, "en")
        XCTAssertGreaterThan(strings.count, 40)
        for (key, entry) in strings {
            let unit = ((entry["localizations"] as? [String: Any])?["en"] as? [String: Any])?["stringUnit"] as? [String: Any]
            let expected = unit?["value"] as? String ?? key
            XCTAssertEqual(Bundle.main.localizedString(forKey: key, value: Self.missing, table: "Localizable"), expected, key)
        }
    }

    /// A sample from every screen, so a catalog that lost a screen's strings fails here.
    func testCatalogCoversEveryScreen() throws {
        let keys = Set(try catalog().strings.keys)
        let sample = [
            "Dark mode for every website.", "onboarding.enable.title", "onboarding.safari.title", "onboarding.check.title",
            "Dark mode", "Use sites' own dark themes", "Dark theme", "Sites you change in Safari appear here.",
            "Gentle style", "Open-source licenses", "Version", "Report a problem",
        ]
        for key in sample { XCTAssertTrue(keys.contains(key), key) }
    }

    /// Copy naming the app is looked up by a stable key, so renaming it rewrites only catalog values.
    /// The key must never contain the name, and the value must use the current one.
    func testBrandedCopyUsesStableKeys() throws {
        let strings = try catalog().strings
        for key in strings.keys { XCTAssertFalse(key.contains(Brand.name), key) }
        XCTAssertEqual(Bundle.main.localizedString(forKey: "onboarding.enable.title", value: nil, table: "Localizable"), "Turn on \(Brand.name) in Safari.")
    }

    /// Strings removed from code are marked stale on extraction; the catalog must not keep them.
    func testCatalogHasNoStaleStrings() throws {
        for (key, entry) in try catalog().strings {
            XCTAssertNotEqual(entry["extractionState"] as? String, "stale", key)
        }
    }
}
