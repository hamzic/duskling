import Foundation

/// Single source for the codename and identifiers in Swift code; values come from Info.plist (fed by
/// apple/Config/Base.xcconfig). Tolerant: a missing or non-string key (e.g. under the xctest runner, where
/// `Bundle.main` is not the app) yields an empty string rather than crashing.
public enum Brand {
    public static var name: String { string("CFBundleDisplayName", in: Bundle.main.infoDictionary) }
    public static var appGroupID: String { string("DuskAppGroupID", in: Bundle.main.infoDictionary) }
    public static var reportEmail: String { string("DuskReportEmail", in: Bundle.main.infoDictionary) }
    public static var version: String { string("CFBundleShortVersionString", in: Bundle.main.infoDictionary) }
    public static var repoURL: String { string("DuskRepoURL", in: Bundle.main.infoDictionary) }

    static func string(_ key: String, in info: [String: Any]?) -> String {
        (info?[key] as? String) ?? ""
    }
}
