import XCTest

/// Launches past onboarding with isolated stores (`-uitest*` launch arguments).
final class HomeUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    @MainActor
    private func launch(_ extra: [String] = []) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-uitest", "-uitest-onboarded", "-uitest-heartbeat"] + extra
        app.launch()
        XCTAssertTrue(app.switches["home.toggle"].waitForExistence(timeout: 10))
        return app
    }

    @MainActor
    func testTogglingDarkModeOffShowsPaused() {
        let app = launch()
        let status = app.descendants(matching: .any)["home.status"]
        XCTAssertTrue(status.label.hasSuffix("Working"), status.label)
        // The switch control itself, not the whole row, so the tap lands on the toggle.
        app.switches["home.toggle"].switches.firstMatch.tap()
        expectation(for: NSPredicate(format: "label ENDSWITH %@", "Paused"), evaluatedWith: status)
        waitForExpectations(timeout: 5)
        XCTAssertEqual(app.switches["home.toggle"].value as? String, "0")
    }

    @MainActor
    func testSelectingMidnightMarksItSelected() {
        let app = launch()
        let dark = app.buttons["home.theme.dark"]
        let midnight = app.buttons["home.theme.midnight"]
        XCTAssertTrue(dark.isSelected)
        XCTAssertFalse(midnight.isSelected)
        XCTAssertEqual(midnight.label, "Midnight theme")
        midnight.tap()
        XCTAssertTrue(midnight.isSelected)
        XCTAssertFalse(dark.isSelected)
    }

    @MainActor
    func testSitesListShowsSeededRulesAndSwipeDeletes() {
        let app = launch(["-uitest-seed-sites"])
        app.buttons["home.sites"].tap()
        let first = app.staticTexts["example.com"]
        let second = app.staticTexts["news.example.org"]
        XCTAssertTrue(first.waitForExistence(timeout: 5))
        XCTAssertTrue(second.exists)
        XCTAssertTrue(app.staticTexts["Off"].exists)
        XCTAssertTrue(app.staticTexts["Midnight"].exists)
        app.cells.containing(.staticText, identifier: "example.com").firstMatch.swipeLeft()
        app.buttons["Delete"].tap()
        XCTAssertTrue(first.waitForNonExistence(timeout: 5))
        XCTAssertTrue(second.exists)
    }

    @MainActor
    func testSitesEmptyState() {
        let app = launch()
        app.buttons["home.sites"].tap()
        XCTAssertTrue(app.staticTexts["Sites you change in Safari appear here."].waitForExistence(timeout: 5))
    }

    @MainActor
    func testAboutShowsVersionAndDarkReaderNotice() {
        let app = launch()
        let about = app.buttons["home.about"]
        if !about.isHittable { app.swipeUp() }
        about.tap()
        let version = app.staticTexts["about.version"]
        XCTAssertTrue(version.waitForExistence(timeout: 5))
        XCTAssertTrue(version.label.range(of: #"\d+\.\d+\.\d+"#, options: .regularExpression) != nil, version.label)
        // App Review 5.1.1(i): the privacy policy is reachable in the app.
        XCTAssertTrue(app.descendants(matching: .any)["about.privacyPolicy"].exists)
        app.buttons["about.licenses"].tap()
        let notice = app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "Dark Reader")).firstMatch
        XCTAssertTrue(notice.waitForExistence(timeout: 5))
    }

    /// The tip jar is left out of 1.0: Home offers no purchase.
    @MainActor
    func testHomeHasNoTipJar() {
        let app = launch()
        let about = app.buttons["home.about"]
        if !about.isHittable { app.swipeUp() }
        XCTAssertTrue(about.exists)
        XCTAssertFalse(app.buttons["home.tips"].exists)
        XCTAssertFalse(app.buttons["Support development"].exists)
    }
}
