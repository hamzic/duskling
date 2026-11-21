import Foundation
import SettingsKit

/// "Report a problem": the repository's issue list, where people can search for the site or open a new issue.
/// Nothing about the device, the settings or any site goes in the link.
enum ReportLink {
    static func issues(repo: String = Brand.repoURL) -> URL? {
        repo.isEmpty ? nil : URL(string: "\(repo)/issues")
    }
}
