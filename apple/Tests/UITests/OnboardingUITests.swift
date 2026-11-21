import XCTest

/// Every launch passes `-uitest`, so the app uses isolated stores and starts with onboarding not done.
final class OnboardingUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    @MainActor
    private func launch(_ extra: [String] = []) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-uitest"] + extra
        app.launch()
        return app
    }

    /// The English copy for a stable key, read from the app's catalog, so the test holds after a rename
    /// (which rewrites the catalog's values, not its keys). The simulator shares the Mac's file system, as in LocalizationTests.
    private func copy(_ key: String) throws -> String {
        let apple = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let data = try Data(contentsOf: apple.appendingPathComponent("App/Localizable.xcstrings"))
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let entry = try XCTUnwrap((json["strings"] as? [String: Any])?[key] as? [String: Any], key)
        let unit = ((entry["localizations"] as? [String: Any])?["en"] as? [String: Any])?["stringUnit"] as? [String: Any]
        return try XCTUnwrap(unit?["value"] as? String, key)
    }

    @MainActor
    private func walkToVerify(_ app: XCUIApplication) throws {
        XCTAssertTrue(app.staticTexts["Dark mode for every website."].waitForExistence(timeout: 10))
        XCTAssertTrue(app.otherElements["onboarding.beforeAfter"].exists || app.images["onboarding.beforeAfter"].exists)
        app.buttons["onboarding.setup"].tap()
        XCTAssertTrue(app.staticTexts[try copy("onboarding.enable.title")].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["onboarding.openSettings"].exists)
        app.buttons["onboarding.enable.next"].tap()
        XCTAssertTrue(app.staticTexts[try copy("onboarding.safari.title")].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["onboarding.openSafari"].exists)
        app.buttons["onboarding.safari.next"].tap()
        XCTAssertTrue(app.buttons["onboarding.done"].waitForExistence(timeout: 5))
    }

    @MainActor
    private func check(_ app: XCUIApplication, _ id: String) -> XCUIElement {
        app.descendants(matching: .any)[id]
    }

    @MainActor
    func testWelcomeShowsAppIcon() {
        let app = launch()
        XCTAssertTrue(app.images["onboarding.icon"].waitForExistence(timeout: 10))
    }

    /// Nothing has run yet: both checks wait, and the first one points back to Settings.
    @MainActor
    func testFreshLaunchChecksBothAndWaits() throws {
        let app = launch()
        try walkToVerify(app)
        XCTAssertTrue(app.staticTexts[try copy("onboarding.check.title")].exists)
        XCTAssertEqual(check(app, "onboarding.check.settings").value as? String, "Not yet")
        XCTAssertEqual(check(app, "onboarding.check.websites").value as? String, "Not yet")
        XCTAssertFalse(app.buttons["onboarding.openSafari"].exists)
    }

    /// Turned on in Settings but never ran on a page (All Websites still on Ask): the case people got stuck on.
    @MainActor
    func testTurnedOnWithoutWebsiteAccessPointsToSafari() throws {
        let app = launch(["-uitest-heartbeat"])
        try walkToVerify(app)
        let settings = check(app, "onboarding.check.settings")
        expectation(for: NSPredicate(format: "value == %@", "Done"), evaluatedWith: settings)
        waitForExpectations(timeout: 10)
        XCTAssertEqual(check(app, "onboarding.check.websites").value as? String, "Not yet")
        XCTAssertTrue(app.staticTexts[try copy("onboarding.check.title")].exists)
        XCTAssertTrue(app.buttons["onboarding.openSafari"].exists)
    }

    @MainActor
    func testBothChecksShowAllSetThenDoneGoesHome() throws {
        let app = launch(["-uitest-heartbeat", "-uitest-page-seen"])
        try walkToVerify(app)
        XCTAssertTrue(app.staticTexts["You're all set."].waitForExistence(timeout: 10))
        XCTAssertEqual(check(app, "onboarding.check.websites").value as? String, "Done")
        XCTAssertFalse(app.buttons["onboarding.openSafari"].exists)
        app.buttons["onboarding.done"].tap()
        XCTAssertTrue(app.switches["home.toggle"].waitForExistence(timeout: 5))
    }

    /// The back control has its own label: on iPhone Duo's outer display the system back button has none.
    @MainActor
    func testBackButtonIsLabelledAndGoesBack() throws {
        let app = launch()
        XCTAssertTrue(app.buttons["onboarding.setup"].waitForExistence(timeout: 10))
        app.buttons["onboarding.setup"].tap()
        let back = app.buttons["onboarding.back"]
        XCTAssertTrue(back.waitForExistence(timeout: 5))
        XCTAssertEqual(back.label, "Back")
        back.tap()
        XCTAssertTrue(app.buttons["onboarding.setup"].waitForExistence(timeout: 5))
    }

    /// Hiding the system back button turns off its edge swipe, so onboarding handles the swipe itself.
    @MainActor
    func testEdgeSwipeGoesBack() throws {
        let app = launch()
        XCTAssertTrue(app.buttons["onboarding.setup"].waitForExistence(timeout: 10))
        app.buttons["onboarding.setup"].tap()
        XCTAssertTrue(app.buttons["onboarding.openSettings"].waitForExistence(timeout: 5))
        let window = app.windows.firstMatch
        let start = window.coordinate(withNormalizedOffset: CGVector(dx: 0.01, dy: 0.5))
        start.press(forDuration: 0.05, thenDragTo: window.coordinate(withNormalizedOffset: CGVector(dx: 0.7, dy: 0.5)))
        XCTAssertTrue(app.buttons["onboarding.setup"].waitForExistence(timeout: 5))
    }
}
