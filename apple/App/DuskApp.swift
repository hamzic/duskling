import SwiftUI

@main
struct DuskApp: App {
    @State private var model = AppModel.make()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .onChange(of: scenePhase, initial: true) { _, phase in
                    if phase == .active { Task { await model.refresh() } }
                }
                // "Register for it shortly after launch. Specify the default key-value store object as the object from
                // which you want to receive notifications."
                // https://developer.apple.com/documentation/foundation/nsubiquitouskeyvaluestore/didchangeexternallynotification
                .onReceive(NotificationCenter.default.publisher(
                    for: NSUbiquitousKeyValueStore.didChangeExternallyNotification,
                    object: NSUbiquitousKeyValueStore.default
                ).receive(on: RunLoop.main)) { note in
                    let reason = note.userInfo?[NSUbiquitousKeyValueStoreChangeReasonKey] as? Int
                    Task { await model.cloudChangedExternally(reason: reason) }
                }
        }
    }
}

struct RootView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        if model.hasCompletedOnboarding {
            MainView()
        } else {
            OnboardingView { model.hasCompletedOnboarding = true }
        }
    }
}

/// `NavigationSplitView` on regular width (iPad), `NavigationStack` on compact width (iPhone).
struct MainView: View {
    @Environment(\.horizontalSizeClass) private var sizeClass
    @State private var selection: HomeDestination? = .sites
    @State private var path: [HomeDestination] = []

    var body: some View {
        if sizeClass == .regular {
            NavigationSplitView {
                HomeView(selection: $selection)
            } detail: {
                NavigationStack {
                    selection?.view
                }
            }
        } else {
            NavigationStack(path: $path) {
                HomeView()
                    .navigationDestination(for: HomeDestination.self) { $0.view }
            }
        }
    }
}
