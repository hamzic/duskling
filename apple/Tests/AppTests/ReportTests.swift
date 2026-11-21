import SettingsKit
import XCTest
@testable import Dusk

final class ReportTests: XCTestCase {
    /// The report link is the repository's issue list and nothing else: no query, so nothing about a site or the device.
    func testReportOpensTheRepositoryIssues() throws {
        XCTAssertFalse(Brand.repoURL.isEmpty)
        let url = try XCTUnwrap(ReportLink.issues())
        XCTAssertEqual(url.absoluteString, "\(Brand.repoURL)/issues")
        XCTAssertNil(url.query)
        XCTAssertNil(url.fragment)
    }

    func testNoRepositoryNoLink() {
        XCTAssertNil(ReportLink.issues(repo: ""))
    }
}
