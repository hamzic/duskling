import XCTest

/// iPad (regular width): Home is the sidebar of a `NavigationSplitView` and its destinations fill the detail column, with
/// both columns on screen together.
final class SplitViewUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    @MainActor
    func testHomeSidebarAndDetailShowTogether() throws {
        try XCTSkipUnless(UIDevice.current.userInterfaceIdiom == .pad, "The split view is the iPad layout.")
        XCUIDevice.shared.orientation = .landscapeLeft
        defer { XCUIDevice.shared.orientation = .portrait }

        let app = XCUIApplication()
        app.launchArguments = ["-uitest", "-uitest-onboarded", "-uitest-heartbeat", "-uitest-page-seen", "-uitest-seed-sites"]
        app.launch()
        let toggle = app.switches["home.toggle"]
        XCTAssertTrue(toggle.waitForExistence(timeout: 10))

        // Sites is selected at launch and shown next to the sidebar.
        let site = app.staticTexts["example.com"]
        XCTAssertTrue(site.waitForExistence(timeout: 5))
        XCTAssertTrue(toggle.isHittable)
        XCTAssertLessThan(toggle.frame.maxX, site.frame.minX, "detail should sit to the right of the sidebar")

        // Choosing About replaces the detail column; the sidebar stays.
        // In landscape About is below the sidebar's fold; scroll the sidebar, not the detail column.
        let sidebar = app.collectionViews.containing(.switch, identifier: "home.toggle").firstMatch
        let about = app.buttons["home.about"]
        for _ in 0..<4 where !about.isHittable { sidebar.swipeUp() }
        about.tap()
        let version = app.staticTexts["about.version"]
        XCTAssertTrue(version.waitForExistence(timeout: 5))
        XCTAssertFalse(site.exists)
        for _ in 0..<4 where !toggle.isHittable { sidebar.swipeDown() }
        XCTAssertTrue(toggle.isHittable)
        XCTAssertLessThan(toggle.frame.maxX, version.frame.minX)

        // Settings changed in the sidebar apply while the detail stays open.
        toggle.switches.firstMatch.tap()
        XCTAssertEqual(toggle.value as? String, "0")
        XCTAssertTrue(version.exists)
    }
}
