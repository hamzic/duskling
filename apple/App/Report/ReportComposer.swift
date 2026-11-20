import MessageUI
import SettingsKit
import SwiftUI

/// The report draft. Only the host is ever included, never a URL, path or query.
enum ReportDraft {
    static func subject(host: String?) -> String {
        guard let host, !host.isEmpty else { return "Site problem" }
        return "Site problem: \(host)"
    }

    /// `mode` is nil when the report starts from the app (no site chosen); the Mode line is then left out.
    static func body(
        host: String?, mode: Mode?, theme: ThemeID, nativeDark: String,
        appVersion: String, osVersion: String, device: String
    ) -> String {
        var lines = ["Site: \(host.flatMap { $0.isEmpty ? nil : $0 } ?? "(please type the website)")"]
        if let mode { lines.append("Mode: \(mode.rawValue)") }
        lines += [
            "Theme: \(theme.rawValue)",
            "Site's own dark theme: \(nativeDark)",
            "\(Brand.name) \(appVersion) · iOS \(osVersion) · \(device)",
            "",
            "What looks wrong? (A screenshot helps.)",
        ]
        return lines.joined(separator: "\n")
    }

    /// `mailto:` per RFC 6068: header values percent-encoded, so spaces and newlines never appear raw.
    static func mailtoURL(
        to address: String, host: String?, mode: Mode?, theme: ThemeID, nativeDark: String,
        appVersion: String, osVersion: String, device: String
    ) -> URL {
        var allowed = CharacterSet.urlQueryAllowed
        allowed.remove(charactersIn: "&=+?#")
        func enc(_ s: String) -> String { s.addingPercentEncoding(withAllowedCharacters: allowed) ?? "" }
        let body = body(
            host: host, mode: mode, theme: theme, nativeDark: nativeDark,
            appVersion: appVersion, osVersion: osVersion, device: device)
        return URL(string: "mailto:\(address)?subject=\(enc(subject(host: host)))&body=\(enc(body))")
            ?? URL(string: "mailto:\(address)")!
    }

    /// The draft for the current device and settings.
    @MainActor
    static func current(host: String? = nil, model: AppModel) -> (subject: String, body: String, mailto: URL) {
        let theme = model.settings.global.theme.value
        // No site chosen, so no site-level own-theme state to report.
        let nativeDark = "none"
        let device = UIDevice.current.userInterfaceIdiom == .pad ? "iPad" : "iPhone"
        let os = UIDevice.current.systemVersion
        return (
            subject(host: host),
            body(host: host, mode: nil, theme: theme, nativeDark: nativeDark,
                 appVersion: Brand.version, osVersion: os, device: device),
            mailtoURL(to: Brand.reportEmail, host: host, mode: nil, theme: theme, nativeDark: nativeDark,
                      appVersion: Brand.version, osVersion: os, device: device))
    }
}

/// Wraps `MFMailComposeViewController`. Present it only when `canSend` is true; otherwise open the draft's
/// `mailto:` URL. https://developer.apple.com/documentation/messageui/mfmailcomposeviewcontroller
struct ReportComposer: UIViewControllerRepresentable {
    let subject: String
    let body: String
    let onFinish: () -> Void

    static var canSend: Bool { MFMailComposeViewController.canSendMail() }

    func makeUIViewController(context: Context) -> MFMailComposeViewController {
        let vc = MFMailComposeViewController()
        vc.mailComposeDelegate = context.coordinator
        vc.setToRecipients([Brand.reportEmail])
        vc.setSubject(subject)
        vc.setMessageBody(body, isHTML: false)
        return vc
    }

    func updateUIViewController(_ vc: MFMailComposeViewController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(onFinish: onFinish) }

    final class Coordinator: NSObject, MFMailComposeViewControllerDelegate {
        let onFinish: () -> Void
        init(onFinish: @escaping () -> Void) { self.onFinish = onFinish }

        func mailComposeController(
            _ controller: MFMailComposeViewController, didFinishWith result: MFMailComposeResult, error: Error?
        ) {
            onFinish()
        }
    }
}
