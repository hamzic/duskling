import Foundation
import SafariServices
import UIKit

/// Opens Safari › Extensions › Duskling directly on iOS 26.2+, otherwise the app's own Settings page.
///
/// "Opens the Settings app to the page for the specified Safari extensions ... Call this method while your app is in
/// the foreground." With one identifier, Settings shows that extension's detail view. iOS/iPadOS 26.2+.
/// https://developer.apple.com/documentation/safariservices/sfsafarisettings/openextensionssettings(foridentifiers:completionhandler:)
/// The fallback uses UIApplication.openSettingsURLString (no private App-prefs: schemes):
/// https://developer.apple.com/documentation/uikit/uiapplication/opensettingsurlstring
@MainActor
struct ExtensionSettingsOpener {
    /// Bundle identifier of the embedded DuskExtension appex ($(APP_BUNDLE_ID).extension in project.yml).
    static func extensionIdentifier(appBundleIdentifier: String? = Bundle.main.bundleIdentifier) -> String? {
        appBundleIdentifier.map { $0 + ".extension" }
    }

    var identifier: String? = Self.extensionIdentifier()
    var isSafariAPIAvailable: Bool = {
        if #available(iOS 26.2, *) { return true }
        return false
    }()
    var openSafariExtensionSettings: (_ identifiers: [String]) async throws -> Void = { identifiers in
        if #available(iOS 26.2, *) {
            try await SFSafariSettings.openExtensionsSettings(forIdentifiers: identifiers)
        }
    }
    var openAppSettings: () -> Void = {
        if let url = URL(string: UIApplication.openSettingsURLString) {
            UIApplication.shared.open(url)
        }
    }

    func open() async {
        if isSafariAPIAvailable, let identifier {
            do {
                try await openSafariExtensionSettings([identifier])
                return
            } catch {}
        }
        openAppSettings()
    }
}
