import XCTest

final class LaunchUITests: XCTestCase {
    /// Past onboarding, Home shows the brand name (from Info.plist) as its navigation title.
    @MainActor
    func testLaunchShowsName() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-uitest", "-uitest-onboarded"]
        app.launch()
        XCTAssertTrue(app.switches["home.toggle"].waitForExistence(timeout: 10))
        let bar = app.navigationBars.firstMatch
        XCTAssertTrue(bar.exists)
        XCTAssertFalse(bar.identifier.isEmpty)
    }
}
