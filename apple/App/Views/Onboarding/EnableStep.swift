import SwiftUI

struct EnableStep: View {
    var onDone: () -> Void

    var body: some View {
        OnboardingPage(title: "onboarding.enable.title") {
            VStack(alignment: .leading, spacing: 20) {
                step(1, "gearshape", "Open **Settings › Apps › Safari › Extensions**.")
                step(2, "switch.2", "onboarding.enable.step2")
                step(3, "globe", "Set **All Websites** to **Allow**.")
            }
            .padding(.top, 8)
        } actions: {
            OnboardingButton(title: "Open Settings") {
                Task { await ExtensionSettingsOpener().open() }
            }
            .accessibilityIdentifier("onboarding.openSettings")
            OnboardingButton(title: "I've done this", action: onDone)
        }
    }

    /// The symbol is decoration; VoiceOver reads the step number and text.
    private func step(_ number: Int, _ symbol: String, _ text: LocalizedStringKey) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 16) {
            Image(systemName: symbol)
                .font(.title2)
                .foregroundStyle(.tint)
                .frame(width: 32)
                .accessibilityHidden(true)
            Text(text)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: "\(number). ") + Text(text))
    }
}
