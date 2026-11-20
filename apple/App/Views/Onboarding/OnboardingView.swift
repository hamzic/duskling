import SettingsKit
import SwiftUI

/// First-launch onboarding: welcome, enable in Safari, verify. Skippable after step 2: "Done" on the
/// verify step is always available.
struct OnboardingView: View {
    enum Step: Hashable {
        case welcome, enable, verify
    }

    var start: Step = .welcome
    var onFinish: () -> Void

    @State private var path: [Step] = []

    var body: some View {
        NavigationStack(path: $path) {
            screen(start)
                .navigationDestination(for: Step.self) { screen($0) }
        }
    }

    @ViewBuilder
    private func screen(_ step: Step) -> some View {
        switch step {
        case .welcome:
            WelcomeStep { path.append(.enable) }
        case .enable:
            EnableStep { path.append(.verify) }
        case .verify:
            VerifyStep(onDone: onFinish)
        }
    }
}

/// Shared layout for an onboarding step: an optional app icon, a scrolling heading and body, with the step's buttons
/// pinned below.
struct OnboardingPage<Content: View, Actions: View>: View {
    var title: LocalizedStringKey
    var icon: Image? = nil
    @ViewBuilder var content: Content
    @ViewBuilder var actions: Actions

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if let icon {
                    icon
                        .resizable()
                        .frame(width: 88, height: 88)
                        .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
                        .padding(.bottom, 8)
                        .accessibilityLabel(Text(verbatim: Brand.name))
                        .accessibilityIdentifier("onboarding.icon")
                }
                Text(title)
                    .font(.largeTitle.bold())
                    .accessibilityAddTraits(.isHeader)
                content
            }
            .frame(maxWidth: 560, alignment: .leading)
            .frame(maxWidth: .infinity)
            .padding(.horizontal, 24)
            .padding(.top, 24)
        }
        .safeAreaInset(edge: .bottom) {
            VStack(spacing: 12) {
                actions
            }
            .controlSize(.large)
            .frame(maxWidth: 560)
            .padding(.horizontal, 24)
            .padding(.vertical, 16)
        }
        .toolbarTitleDisplayMode(.inline)
    }
}

/// Onboarding buttons: quiet Ember text buttons (DESIGN.md: "There is no loud primary call to action"). Contrast (WCAG 2.x
/// relative luminance) on the page background: #A35F00 on white is 5.0:1, #F0A848 on black is 10.4:1. The label fills the
/// row width and at least 44 pt of height, so the whole row is the target.
struct OnboardingButton: View {
    var title: LocalizedStringKey
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .frame(maxWidth: .infinity, minHeight: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.borderless)
    }
}
