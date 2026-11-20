import XCTest
@testable import Dusk

@MainActor
final class ExtensionSettingsOpenerTests: XCTestCase {
    func testIdentifierDerivedFromBundleID() throws {
        let bundleID = try XCTUnwrap(Bundle.main.bundleIdentifier)
        XCTAssertEqual(ExtensionSettingsOpener.extensionIdentifier(), bundleID + ".extension")
        XCTAssertNil(ExtensionSettingsOpener.extensionIdentifier(appBundleIdentifier: nil))
    }

    func testSafariAPIPathPassesExtensionIdentifier() async {
        var received: [[String]] = []
        var fellBack = false
        let opener = ExtensionSettingsOpener(
            identifier: "app.ext", isSafariAPIAvailable: true,
            openSafariExtensionSettings: { received.append($0) },
            openAppSettings: { fellBack = true })
        await opener.open()
        XCTAssertEqual(received, [["app.ext"]])
        XCTAssertFalse(fellBack)
    }

    func testErrorFallsBackToAppSettings() async {
        struct Boom: Error {}
        var fellBack = false
        let opener = ExtensionSettingsOpener(
            identifier: "app.ext", isSafariAPIAvailable: true,
            openSafariExtensionSettings: { _ in throw Boom() },
            openAppSettings: { fellBack = true })
        await opener.open()
        XCTAssertTrue(fellBack)
    }

    func testOlderOSFallsBackWithoutCallingSafariAPI() async {
        var called = false
        var fellBack = false
        let opener = ExtensionSettingsOpener(
            identifier: "app.ext", isSafariAPIAvailable: false,
            openSafariExtensionSettings: { _ in called = true },
            openAppSettings: { fellBack = true })
        await opener.open()
        XCTAssertFalse(called)
        XCTAssertTrue(fellBack)
    }
}
