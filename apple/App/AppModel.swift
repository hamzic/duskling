import Foundation
import Observation
import SettingsKit

enum ExtensionStatus: Equatable {
    case notSetUp
    /// Turned on in Settings, but no content script has run on a page yet: Safari hasn't been allowed into any website.
    case needsWebsiteAccess
    case working(version: String)
    case paused
}

/// A host with a live (non-tombstoned) rule.
struct SiteEntry: Identifiable, Equatable {
    var host: String
    var rule: SiteRule
    var id: String { host }
}

/// App state. The app is the only process that merges iCloud: every `refresh()` runs
/// `SettingsSync(group:cloud:)` with the `CloudStore`.
@Observable @MainActor
final class AppModel {
    static let onboardingKey = "onboarding.done"

    private(set) var settings: Settings
    private(set) var extensionStatus: ExtensionStatus = .notSetUp
    /// The extension has run in Safari (it's turned on in Settings).
    private(set) var isTurnedOn = false
    /// A content script has run on a page, which Safari allows only on websites the user granted access to.
    private(set) var hasWebsiteAccess = false
    /// Same key and store as `@AppStorage("onboarding.done")`; kept here so the model owns it and tests can inject the
    /// defaults (`@AppStorage` itself can't sit inside an `@Observable` class).
    var hasCompletedOnboarding: Bool {
        didSet { defaults.set(hasCompletedOnboarding, forKey: Self.onboardingKey) }
    }

    @ObservationIgnored private let group: KeyValueStore
    @ObservationIgnored private let sync: SettingsSync
    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private let now: @Sendable () -> Int64

    init(
        group: KeyValueStore,
        cloud: KeyValueStore?,
        defaults: UserDefaults,
        now: @escaping @Sendable () -> Int64 = AppModel.millisecondsNow,
        cloudSynchronize: (@Sendable () -> Void)? = nil
    ) {
        self.group = group
        self.defaults = defaults
        self.now = now
        sync = SettingsSync(group: group, cloud: cloud, now: now, cloudSynchronize: cloudSynchronize)
        settings = sync.current()
        hasCompletedOnboarding = defaults.bool(forKey: Self.onboardingKey)
        updateStatus()
    }

    nonisolated static func millisecondsNow() -> Int64 {
        Int64((Date().timeIntervalSince1970 * 1000).rounded())
    }

    /// Hosts with live rules, sorted by host.
    var liveSites: [SiteEntry] {
        settings.sites
            .filter { $0.value.deleted != true }
            .map { SiteEntry(host: $0.key, rule: $0.value) }
            .sorted { $0.host < $1.host }
    }

    /// Merges the App Group and iCloud copies, writes the result back to both, and re-reads the heartbeat.
    func refresh() async {
        // A failed store write (SettingsSync throws only on write) leaves the stores as they were; showing the App Group
        // copy is the best we can do, and the next refresh (foreground, iCloud change, or the 2 s onboarding poll)
        // retries. There's no user action that could fix a defaults write, so no error is surfaced.
        if let merged = try? sync.sync(incoming: nil) {
            settings = merged
        } else {
            settings = sync.current()
        }
        updateStatus()
    }

    /// An iCloud change from outside the app. After an Apple account change the iCloud copy is the new account's, so it
    /// replaces the App Group copy instead of being merged with the previous account's sites (`SettingsSync.adoptCloud`).
    /// https://developer.apple.com/documentation/foundation/nsubiquitouskeyvaluestorechangereasonkey
    func cloudChangedExternally(reason: Int?) async {
        guard reason == NSUbiquitousKeyValueStoreAccountChange else { return await refresh() }
        settings = (try? sync.adoptCloud()) ?? sync.current()
        updateStatus()
    }

    func setGlobal<T>(_ field: WritableKeyPath<Global, Stamped<T>>, _ value: T) {
        let stamp = now()
        apply { $0.global[keyPath: field] = Stamped(value: value, updatedAt: stamp) }
    }

    func setTheme(_ theme: ThemeID) {
        setGlobal(\.theme, theme)
    }

    /// Writes a tombstone so the deletion syncs.
    func removeSite(_ host: String) {
        let stamp = now()
        apply { $0.sites[host] = SiteRule(updatedAt: stamp, deleted: true) }
    }

    private func apply(_ change: (inout Settings) -> Void) {
        // Same reasoning as `refresh()`: a failed write isn't actionable by the user.
        if let updated = try? sync.update(change) {
            settings = updated
        } else {
            // The write failed; still show the change so the control doesn't snap back. The next refresh re-reads.
            change(&settings)
        }
        updateStatus()
    }

    private func updateStatus() {
        let seen = Heartbeat.lastSeen(in: group)
        isTurnedOn = seen != nil
        hasWebsiteAccess = Heartbeat.lastPageSeen(in: group) != nil
        guard let seen else {
            extensionStatus = .notSetUp
            return
        }
        if !settings.global.enabled.value {
            extensionStatus = .paused
        } else if !hasWebsiteAccess {
            extensionStatus = .needsWebsiteAccess
        } else {
            extensionStatus = .working(version: seen.version)
        }
    }
}

extension AppModel {
    /// Launch arguments used by the UI tests. Any argument starting with `-uitest` switches to isolated in-memory stores
    /// and a scratch defaults suite that's wiped on launch, so tests never touch the real App Group, iCloud or defaults.
    enum LaunchFlag: String {
        case uiTest = "-uitest"
        /// Seeds an extension heartbeat (turned on in Settings).
        case heartbeat = "-uitest-heartbeat"
        /// Seeds a content-script run on a page (website access granted).
        case pageSeen = "-uitest-page-seen"
        /// Seeds two site rules.
        case seedSites = "-uitest-seed-sites"
        /// Starts with onboarding already done.
        case onboarded = "-uitest-onboarded"
    }

    static func make(arguments: [String] = ProcessInfo.processInfo.arguments) -> AppModel {
        guard arguments.contains(where: { $0.hasPrefix(LaunchFlag.uiTest.rawValue) }) else {
            let cloud = CloudStore()
            return AppModel(
                group: AppGroupStore(suiteName: Brand.appGroupID),
                cloud: cloud,
                defaults: .standard,
                cloudSynchronize: { cloud.synchronize() })
        }
        let suite = "uitest.defaults"
        let defaults = UserDefaults(suiteName: suite) ?? .standard
        defaults.removePersistentDomain(forName: suite)
        let group = InMemoryStore()
        let now = millisecondsNow()
        if arguments.contains(LaunchFlag.seedSites.rawValue) {
            let seeded = Settings(global: Settings.defaults.global, sites: [
                "example.com": SiteRule(mode: .off, updatedAt: now),
                "news.example.org": SiteRule(theme: .midnight, updatedAt: now),
            ])
            try? group.set(canonicalJSON(seeded), forKey: SettingsSync.key)
        }
        if arguments.contains(LaunchFlag.heartbeat.rawValue) {
            Heartbeat.record(version: Brand.version, in: group, now: now)
        }
        if arguments.contains(LaunchFlag.pageSeen.rawValue) {
            Heartbeat.recordPage(in: group, now: now)
        }
        if arguments.contains(LaunchFlag.onboarded.rawValue) {
            defaults.set(true, forKey: onboardingKey)
        }
        return AppModel(group: group, cloud: InMemoryStore(), defaults: defaults)
    }
}
