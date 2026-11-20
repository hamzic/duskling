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
    @State private var showsSetup = false
    @State private var draft: (subject: String, body: String, mailto: URL)?

    var body: some View {
        list
            // DESIGN.md: "The system switch, tinted Ember." Toggle doesn't pick up the app accent on its own.
            .tint(Color.accentColor)
            .navigationTitle(Brand.name)
            .sheet(isPresented: $showsSetup) {
                OnboardingView(start: .enable) { showsSetup = false }
            }
            .sheet(isPresented: Binding(get: { draft != nil }, set: { if !$0 { draft = nil } })) {
                if let draft {
                    ReportComposer(subject: draft.subject, body: draft.body) { self.draft = nil }
                        .ignoresSafeArea()
                }
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
            Button {
                showsSetup = true
            } label: {
                LabeledContent("Safari extension") {
                    HStack(spacing: 8) {
                        Text("Not set up yet").foregroundStyle(.secondary)
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
    }

    /// In-app Mail composer; falls back to the `mailto:` draft when Mail isn't set up.
    private func report() {
        let current = ReportDraft.current(model: model)
        if ReportComposer.canSend { draft = current } else { openURL(current.mailto) }
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
