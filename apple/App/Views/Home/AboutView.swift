import SettingsKit
import SwiftUI

struct AboutView: View {
    var body: some View {
        List {
            Section {
                Text("about.privacy")
                if let url = URL(string: Brand.repoURL + "/blob/main/PRIVACY.md") {
                    Link("Privacy policy", destination: url)
                        .accessibilityIdentifier("about.privacyPolicy")
                }
            } header: {
                Text("Privacy")
            }
            Section {
                if let url = URL(string: Brand.repoURL) {
                    Link("Source code on GitHub", destination: url)
                        .accessibilityIdentifier("about.github")
                }
                NavigationLink("Open-source licenses") { LicensesView() }
                    .accessibilityIdentifier("about.licenses")
            }
            Section {
                LabeledContent("Version") {
                    Text(Brand.version).accessibilityIdentifier("about.version")
                }
            }
        }
        .navigationTitle("About")
    }
}
