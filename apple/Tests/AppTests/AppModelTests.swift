@testable import Dusk
import SettingsKit
import XCTest

@MainActor
final class AppModelTests: XCTestCase {
    private var group: InMemoryStore!
    private var defaults: UserDefaults!
    private var suiteName: String!

    override func setUp() async throws {
        group = InMemoryStore()
        suiteName = "AppModelTests.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
    }

    override func tearDown() async throws {
        defaults.removePersistentDomain(forName: suiteName)
    }

    private func makeModel(now: Int64 = 1_000) -> AppModel {
        AppModel(group: group, cloud: nil, defaults: defaults, now: { now })
    }

    func testStatusIsNotSetUpWithoutHeartbeat() async {
        let model = makeModel()
        await model.refresh()
        XCTAssertEqual(model.extensionStatus, .notSetUp)
    }

    /// Turned on in Settings but never ran on a page: Safari hasn't let it into any website yet.
    func testStatusNeedsWebsiteAccessWithHeartbeatOnly() async {
        Heartbeat.record(version: "1.2.3", in: group, now: 500)
        let model = makeModel()
        await model.refresh()
        XCTAssertEqual(model.extensionStatus, .needsWebsiteAccess)
        XCTAssertTrue(model.isTurnedOn)
        XCTAssertFalse(model.hasWebsiteAccess)
    }

    func testStatusIsWorkingOnceItRanOnAPage() async {
        Heartbeat.record(version: "1.2.3", in: group, now: 500)
        Heartbeat.recordPage(in: group, now: 600)
        let model = makeModel()
        await model.refresh()
        XCTAssertEqual(model.extensionStatus, .working(version: "1.2.3"))
        XCTAssertTrue(model.hasWebsiteAccess)
    }

    func testStatusIsPausedWhenDisabled() async {
        Heartbeat.record(version: "1.2.3", in: group, now: 500)
        Heartbeat.recordPage(in: group, now: 600)
        let model = makeModel()
        await model.refresh()
        model.setGlobal(\.enabled, false)
        XCTAssertEqual(model.extensionStatus, .paused)
        model.setGlobal(\.enabled, true)
        XCTAssertEqual(model.extensionStatus, .working(version: "1.2.3"))
    }

    func testSetThemeStampsAndPersistsToGroupStore() async throws {
        let model = makeModel(now: 4_242)
        await model.refresh()
        model.setTheme(.midnight)
        XCTAssertEqual(model.settings.global.theme, Stamped(value: .midnight, updatedAt: 4_242))
        let data = try XCTUnwrap(group.data(forKey: SettingsSync.key))
        XCTAssertEqual(Settings.parse(data).global.theme, Stamped(value: .midnight, updatedAt: 4_242))
    }

    func testRemoveSiteWritesTombstone() async throws {
        let seeded = Settings(global: Settings.defaults.global, sites: ["example.com": SiteRule(mode: .off, updatedAt: 10)])
        try group.set(canonicalJSON(seeded), forKey: SettingsSync.key)
        let model = makeModel(now: 2_000)
        await model.refresh()
        XCTAssertEqual(model.liveSites.map(\.host), ["example.com"])
        model.removeSite("example.com")
        XCTAssertEqual(model.settings.sites["example.com"], SiteRule(updatedAt: 2_000, deleted: true))
        XCTAssertTrue(model.liveSites.isEmpty)
        let data = try XCTUnwrap(group.data(forKey: SettingsSync.key))
        XCTAssertEqual(Settings.parse(data).sites["example.com"]?.deleted, true)
    }

    func testLiveSitesSortedByHostWithSummaries() async throws {
        let seeded = Settings(global: Settings.defaults.global, sites: [
            "b.example": SiteRule(theme: .midnight, updatedAt: 1),
            "a.example": SiteRule(mode: .off, updatedAt: 1),
            "c.example": SiteRule(mode: .gentle, nativeDark: "ignore", updatedAt: 1),
            "gone.example": SiteRule(updatedAt: 1, deleted: true),
        ])
        try group.set(canonicalJSON(seeded), forKey: SettingsSync.key)
        let model = makeModel()
        await model.refresh()
        XCTAssertEqual(model.liveSites.map(\.host), ["a.example", "b.example", "c.example"])
        XCTAssertEqual(SiteSummary.parts(for: seeded.sites["a.example"]!), [.off])
        XCTAssertEqual(SiteSummary.parts(for: seeded.sites["b.example"]!), [.theme(.midnight)])
        XCTAssertEqual(SiteSummary.parts(for: seeded.sites["c.example"]!), [.mode(.gentle), .nativeIgnored])
        XCTAssertEqual(SiteSummary.parts(for: SiteRule(mode: .off, theme: .dim, updatedAt: 1)), [.off, .theme(.dim)])
        XCTAssertEqual(SiteSummary.parts(for: SiteRule(dimImages: true, updatedAt: 1)), [.dimImages(true)])
        XCTAssertEqual(SiteSummary.parts(for: SiteRule(nativeDark: "use", updatedAt: 1)), [.nativeUsed])
        XCTAssertEqual(SiteSummary.parts(for: SiteRule(theme: .dark, dimImages: false, updatedAt: 1)), [.theme(.dark), .dimImages(false)])
    }

    func testAppleAccountChangeAdoptsTheNewAccountsSitesInsteadOfMerging() async throws {
        let cloud = InMemoryStore()
        var old = Settings.defaults
        old.sites["old-account.com"] = SiteRule(mode: .off, updatedAt: 5)
        try group.set(canonicalJSON(old), forKey: SettingsSync.key)
        var new = Settings.defaults
        new.sites["new-account.com"] = SiteRule(mode: .gentle, updatedAt: 6)
        try cloud.set(canonicalJSON(new), forKey: SettingsSync.key)
        let model = AppModel(group: group, cloud: cloud, defaults: defaults, now: { 1_000 })
        await model.cloudChangedExternally(reason: NSUbiquitousKeyValueStoreAccountChange)
        XCTAssertEqual(model.liveSites.map(\.host), ["new-account.com"])
    }

    func testOtherICloudChangesMerge() async throws {
        let cloud = InMemoryStore()
        var old = Settings.defaults
        old.sites["here.com"] = SiteRule(mode: .off, updatedAt: 5)
        try group.set(canonicalJSON(old), forKey: SettingsSync.key)
        var other = Settings.defaults
        other.sites["other-device.com"] = SiteRule(mode: .gentle, updatedAt: 6)
        try cloud.set(canonicalJSON(other), forKey: SettingsSync.key)
        let model = AppModel(group: group, cloud: cloud, defaults: defaults, now: { 1_000 })
        await model.cloudChangedExternally(reason: NSUbiquitousKeyValueStoreServerChange)
        XCTAssertEqual(model.liveSites.map(\.host), ["here.com", "other-device.com"])
    }

    func testOnboardingFlagPersistsUnderAppStorageKey() {
        let model = makeModel()
        XCTAssertFalse(model.hasCompletedOnboarding)
        model.hasCompletedOnboarding = true
        XCTAssertTrue(defaults.bool(forKey: "onboarding.done"))
        XCTAssertTrue(makeModel().hasCompletedOnboarding)
    }
}

final class NoticeBlockTests: XCTestCase {
    func testParsesHeadingsParagraphsAndReflowsFencedText() {
        let md = "# Title\n\nOne\ntwo.\n\n```\nLine a\nline b\n\nNext para\n```\n"
        let blocks = NoticeBlock.parse(md).map { "\($0.kind):\($0.text)" }
        XCTAssertEqual(blocks, ["heading:Title", "paragraph:One two.", "code:Line a line b", "code:Next para"])
    }
}
