import SettingsKit
import XCTest
@testable import Dusk

@MainActor
final class ReportTests: XCTestCase {
    func testSubjectNamesTheHost() {
        XCTAssertEqual(ReportDraft.subject(host: "example.com"), "Site problem: example.com")
        XCTAssertEqual(ReportDraft.subject(host: ""), "Site problem")
        XCTAssertEqual(ReportDraft.subject(host: nil), "Site problem")
    }

    /// The report template, exactly.
    func testBodyMatchesTemplate() {
        let body = ReportDraft.body(
            host: "example.com", mode: .gentle, theme: .midnight, nativeDark: "ignored",
            appVersion: "1.0.0", osVersion: "18.2", device: "iPhone")
        XCTAssertEqual(body, """
            Site: example.com
            Mode: gentle
            Theme: midnight
            Site's own dark theme: ignored
            \(Brand.name) 1.0.0 · iOS 18.2 · iPhone

            What looks wrong? (A screenshot helps.)
            """)
    }

    func testEmptyHostAsksUserToTypeTheWebsite() {
        let body = ReportDraft.body(
            host: "", mode: nil, theme: .dark, nativeDark: "used",
            appVersion: "1.0.0", osVersion: "18.2", device: "iPad")
        XCTAssertTrue(body.hasPrefix("Site: (please type the website)\n"), body)
        XCTAssertFalse(body.contains("Mode:"), body)
    }

    func testMailtoEncodesSpacesAndNewlinesWithNoPathOrQueryLeak() throws {
        let url = ReportDraft.mailtoURL(
            to: Brand.reportEmail, host: "example.com", mode: .full, theme: .dark, nativeDark: "none",
            appVersion: "1.0.0", osVersion: "18.2", device: "iPhone")
        let s = url.absoluteString
        XCTAssertTrue(s.hasPrefix("mailto:\(Brand.reportEmail)?subject=Site%20problem:%20example.com&body="), s)
        XCTAssertFalse(s.contains(" "))
        XCTAssertFalse(s.contains("\n"))
        XCTAssertTrue(s.contains("%0A"))
        let comps = try XCTUnwrap(URLComponents(url: url, resolvingAgainstBaseURL: false))
        XCTAssertEqual(comps.queryItems?.map(\.name), ["subject", "body"])
        XCTAssertEqual(comps.queryItems?.last?.value?.hasPrefix("Site: example.com\nMode: full"), true)
    }

    func testAppOriginatedDraftSaysNoSiteTheme() async {
        let model = AppModel(group: InMemoryStore(), cloud: nil, defaults: UserDefaults(suiteName: UUID().uuidString)!)
        let draft = ReportDraft.current(model: model)
        XCTAssertTrue(draft.body.contains("Site's own dark theme: none"), draft.body)
    }
}
