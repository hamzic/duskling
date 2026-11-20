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
        app.buttons["onboarding.setup"].tap()
        XCTAssertTrue(app.staticTexts[try copy("onboarding.enable.title")].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["onboarding.openSettings"].exists)
        app.buttons["I've done this"].tap()
        XCTAssertTrue(app.staticTexts["Open any website in Safari."].waitForExistence(timeout: 5))
    }

    @MainActor
    func testWelcomeShowsAppIcon() {
        let app = launch()
        XCTAssertTrue(app.images["onboarding.icon"].waitForExistence(timeout: 10))
    }

    @MainActor
    func testFreshLaunchWaitsForSafari() throws {
        let app = launch()
        try walkToVerify(app)
        let status = app.staticTexts["onboarding.status"]
        XCTAssertTrue(status.waitForExistence(timeout: 5))
        XCTAssertEqual(status.label, "Waiting for Safari…")
    }

    @MainActor
    func testHeartbeatShowsWorkingThenDoneGoesHome() throws {
        let app = launch(["-uitest-heartbeat"])
        try walkToVerify(app)
        let status = app.staticTexts["onboarding.status"]
        let working = NSPredicate(format: "label == %@", try copy("onboarding.verify.working"))
        expectation(for: working, evaluatedWith: status)
        waitForExpectations(timeout: 10)
        app.buttons["onboarding.done"].tap()
        XCTAssertTrue(app.switches["home.toggle"].waitForExistence(timeout: 5))
    }
}
