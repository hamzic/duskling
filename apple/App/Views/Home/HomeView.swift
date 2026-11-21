import SettingsKit
import SwiftUI

/// Places Home navigates to. On iPad they fill the split view's detail column.
enum HomeDestination: Hashable {
    case sites, about
}

/// Home: one grouped list.
struct HomeView: View {
    /// The split view's sidebar selection on regular width; nil inside a `NavigationStack`.
    var selection: Binding<HomeDestination?>?

    @Environment(AppModel.self) private var model
    @Environment(\.openURL) private var openURL
    /// Where setup opens; non-nil shows it. `sheet(item:)` builds the sheet from this value, so it opens at the step
    /// that was tapped (with `isPresented` the content could be built from the previous value).
    @State private var setupStart: OnboardingView.Step?

    var body: some View {
        list
            // DESIGN.md: "The system switch, tinted Ember." Toggle doesn't pick up the app accent on its own.
            .tint(Color.accentColor)
            .navigationTitle(Brand.name)
            .sheet(item: $setupStart) { start in
                OnboardingView(start: start) { setupStart = nil }
            }
    }

    @ViewBuilder
    private var list: some View {
        if let selection {
            // Sidebar lists drop section backgrounds and footer spacing; keep the grouped Home look.
            List(selection: selection) { content }
                .listStyle(.insetGrouped)
        } else {
            List { content }
        }
    }

    @ViewBuilder
    private var content: some View {
        Section {
            status
            Toggle("Dark mode", isOn: binding(\.enabled))
                .accessibilityIdentifier("home.toggle")
        }
        Section {
            ThemePicker(selection: model.settings.global.theme.value) { model.setTheme($0) }
        } header: {
            Text("Theme")
        }
        Section {
            Toggle("Use sites' own dark themes", isOn: binding(\.respectNativeDark))
                .accessibilityIdentifier("home.nativeDark")
        } footer: {
            Text("home.nativeDark.footer")
        }
        Section {
            Toggle("Dim images", isOn: binding(\.dimImages))
                .accessibilityIdentifier("home.dimImages")
        } footer: {
            Text("Makes photos and videos slightly darker.")
        }
        Section {
            NavigationLink("Sites", value: HomeDestination.sites)
                .accessibilityIdentifier("home.sites")
            Button("Report a problem") { report() }
                .foregroundStyle(.primary)
                .accessibilityIdentifier("home.report")
            NavigationLink("About", value: HomeDestination.about)
                .accessibilityIdentifier("home.about")
        }
    }

    @ViewBuilder
    private var status: some View {
        switch model.extensionStatus {
        case .working:
            LabeledContent("Safari extension") { Text("Working") }
                .accessibilityIdentifier("home.status")
        case .paused:
            LabeledContent("Safari extension") { Text("Paused") }
                .accessibilityIdentifier("home.status")
        case .notSetUp:
            setupButton("Not set up yet", start: .enable)
        case .needsWebsiteAccess:
            // Turned on in Settings, but Safari hasn't let it into any website: the step people miss.
            setupButton("Needs website access", start: .safari)
        }
    }

    private func setupButton(_ state: LocalizedStringKey, start: OnboardingView.Step) -> some View {
        Button {
            setupStart = start
        } label: {
            LabeledContent("Safari extension") {
                HStack(spacing: 8) {
                    Text(state).foregroundStyle(.secondary)
                    Image(systemName: "chevron.forward")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(.tertiary)
                        .accessibilityHidden(true)
                }
            }
        }
        .foregroundStyle(.primary)
        .accessibilityIdentifier("home.status")
        .accessibilityHint("home.setUp.hint")
    }

    /// Opens the repository's issue list in the browser.
    private func report() {
        if let url = ReportLink.issues() { openURL(url) }
    }

    private func binding(_ field: WritableKeyPath<Global, Stamped<Bool>>) -> Binding<Bool> {
        Binding(
            get: { model.settings.global[keyPath: field].value },
            set: { model.setGlobal(field, $0) })
    }
}

extension HomeDestination {
    @MainActor @ViewBuilder
    var view: some View {
        switch self {
        case .sites: SitesView()
        case .about: AboutView()
        }
    }
}
