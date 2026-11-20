import SettingsKit
import XCTest

final class SmokeTests: XCTestCase {
    /// Brand values come from Info.plist (fed by Base.xcconfig); no literal IDs here.
    func testBrandReadsInfoPlist() throws {
        let bundleID = try XCTUnwrap(Bundle.main.bundleIdentifier)
        XCTAssertTrue(Brand.appGroupID.hasPrefix("group."), Brand.appGroupID)
        XCTAssertTrue(Brand.appGroupID.hasSuffix(bundleID), Brand.appGroupID)
        XCTAssertFalse(Brand.name.isEmpty)
        XCTAssertFalse(Brand.reportEmail.isEmpty)
    }

    /// Inside the appex, `Bundle.main` is the extension, so its Info.plist must carry the same Brand keys.
    func testExtensionInfoPlistCarriesBrandKeys() throws {
        let plugins = try XCTUnwrap(Bundle.main.builtInPlugInsURL)
        let appex = try XCTUnwrap(Bundle(url: plugins.appendingPathComponent("DuskExtension.appex")))
        let app = try XCTUnwrap(Bundle.main.infoDictionary)
        let ext = try XCTUnwrap(appex.infoDictionary)
        for key in ["DuskAppGroupID", "DuskReportEmail", "CFBundleDisplayName", "CFBundleShortVersionString"] {
            let value = try XCTUnwrap(ext[key] as? String, key)
            XCTAssertFalse(value.isEmpty, key)
            XCTAssertEqual(value, app[key] as? String, key)
        }
        XCTAssertEqual(appex.bundleIdentifier, Bundle.main.bundleIdentifier.map { $0 + ".extension" })
        XCTAssertNotNil(appex.url(forResource: "manifest", withExtension: "json"), "manifest.json must be at the appex root")
    }

    /// Entitlement sources: both targets share the App Group; only the app gets iCloud key-value storage.
    /// Read from the source tree because unsigned simulator builds embed no entitlements.
    func testEntitlementSources() throws {
        let apple = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        func plist(_ path: String) throws -> [String: Any] {
            let data = try Data(contentsOf: apple.appendingPathComponent(path))
            return try XCTUnwrap(PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any])
        }
        let app = try plist("App/Dusk.entitlements")
        let ext = try plist("Extension/DuskExtension.entitlements")
        XCTAssertEqual(app["com.apple.security.application-groups"] as? [String], ["$(APP_GROUP_ID)"])
        XCTAssertEqual(ext["com.apple.security.application-groups"] as? [String], ["$(APP_GROUP_ID)"])
        XCTAssertEqual(app["com.apple.developer.ubiquity-kvstore-identifier"] as? String, "$(TeamIdentifierPrefix)$(APP_BUNDLE_ID)")
        XCTAssertNil(ext["com.apple.developer.ubiquity-kvstore-identifier"])
    }
}

final class BrandRepoTests: XCTestCase {
    /// The GitHub link in About comes from Base.xcconfig via Info.plist and must match the extension's brand.ts.
    func testRepoURLMatchesExtensionBrand() throws {
        let root = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let ts = try String(contentsOf: root.appendingPathComponent("extension/src/shared/brand.ts"), encoding: .utf8)
        let match = try XCTUnwrap(ts.firstMatch(of: /repoUrl:\s*"([^"]+)"/))
        XCTAssertEqual(Brand.repoURL, String(match.1))
    }

    /// THIRD_PARTY_NOTICES.md is bundled with the app for the Licenses screen.
    func testNoticesAreBundled() throws {
        let url = try XCTUnwrap(Bundle.main.url(forResource: "THIRD_PARTY_NOTICES", withExtension: "md"))
        XCTAssertTrue(try String(contentsOf: url, encoding: .utf8).contains("Dark Reader"))
    }
}
