import SettingsKit
import SwiftUI

/// Hosts with custom rules. Swipe to delete writes a tombstone so the deletion syncs.
struct SitesView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        let sites = model.liveSites
        List {
            ForEach(sites) { site in
                VStack(alignment: .leading, spacing: 4) {
                    Text(site.host)
                    let summary = SiteSummary.text(for: site.rule)
                    if !summary.isEmpty {
                        Text(summary)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                }
                .accessibilityElement(children: .combine)
            }
            .onDelete { offsets in
                for host in offsets.map({ sites[$0].host }) { model.removeSite(host) }
            }
        }
        // An empty List draws a plain (white) background; keep the grouped background so the empty state matches the
        // filled list and Home. Both are the system grouped background color.
        .scrollContentBackground(.hidden)
        .background(Color(uiColor: .systemGroupedBackground))
        .overlay {
            if sites.isEmpty {
                Text("Sites you change in Safari appear here.")
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .padding(24)
            }
        }
        .navigationTitle("Sites")
    }
}

/// The one-line summary under a host: "Off", "Midnight", "Gentle style", "Site's own theme ignored", "Images dimmed".
enum SiteSummary {
    enum Part: Equatable {
        case off
        case mode(Mode)
        case theme(ThemeID)
        case nativeIgnored
        case nativeUsed
        case dimImages(Bool)
    }

    static func parts(for rule: SiteRule) -> [Part] {
        var parts: [Part] = []
        if let mode = rule.mode { parts.append(mode == .off ? .off : .mode(mode)) }
        if let theme = rule.theme { parts.append(.theme(theme)) }
        if rule.nativeDark == "ignore" { parts.append(.nativeIgnored) }
        if rule.nativeDark == "use" { parts.append(.nativeUsed) }
        if let dim = rule.dimImages { parts.append(.dimImages(dim)) }
        return parts
    }

    static func text(for rule: SiteRule) -> String {
        parts(for: rule).map(label).joined(separator: " · ")
    }

    private static func label(_ part: Part) -> String {
        switch part {
        case .off: String(localized: "Off")
        case .mode(.full): String(localized: "Default style")
        case .mode(.gentle): String(localized: "Gentle style")
        case .mode(.filter): String(localized: "Simple style")
        case .mode(.off): String(localized: "Off")
        case .theme(.dark): String(localized: "Dark")
        case .theme(.midnight): String(localized: "Midnight")
        case .theme(.dim): String(localized: "Dim")
        case .nativeIgnored: String(localized: "Site's own theme ignored")
        case .nativeUsed: String(localized: "Site's own theme always used")
        case .dimImages(true): String(localized: "Images dimmed")
        case .dimImages(false): String(localized: "Images not dimmed")
        }
    }
}
