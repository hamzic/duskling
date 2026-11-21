import SwiftUI

struct EnableStep: View {
    var onDone: () -> Void

    var body: some View {
        OnboardingPage(title: "onboarding.enable.title") {
            VStack(alignment: .leading, spacing: 20) {
                OnboardingStepRow(number: 1, symbol: Image(systemName: "gearshape"),
                                  text: "Open **Settings › Apps › Safari › Extensions**.")
                OnboardingStepRow(number: 2, symbol: Image(systemName: "switch.2"), text: "onboarding.enable.step2")
                OnboardingStepRow(number: 3, symbol: Image(systemName: "globe"), text: "Set **All Websites** to **Allow**.")
            }
            .padding(.top, 8)
            SettingsPreview()
                .padding(.top, 20)
        } actions: {
            OnboardingButton(title: "Open Settings") {
                Task { await ExtensionSettingsOpener().open() }
            }
            .accessibilityIdentifier("onboarding.openSettings")
            OnboardingButton(title: "Next", action: onDone)
                .accessibilityIdentifier("onboarding.enable.next")
        }
    }
}

/// Duskling's page in Settings as it looks when it's set up (labels as in iOS 27.2 Settings › Apps › Safari ›
/// Extensions › Duskling). A picture, not controls: it can't be changed from here.
private struct SettingsPreview: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            // Primary label color: the secondary color is just under 4.5:1 at this size (DESIGN.md: key content is primary).
            Text("What it looks like in Settings")
                .font(.footnote)
                .textCase(.uppercase)
                .padding(.leading, 16)
            VStack(spacing: 0) {
                HStack {
                    Text("Allow Extension")
                    Spacer()
                    Capsule().fill(Color.green).frame(width: 51, height: 31)
                        .overlay(alignment: .trailing) { Circle().fill(.white).padding(2) }
                }
                .padding(.horizontal, 16)
                .frame(minHeight: 52)
                Divider().padding(.leading, 16)
                HStack {
                    Text("All Websites")
                    Spacer()
                    // Primary, not secondary: secondary is under 4.5:1 here on iPhone Duo's outer display.
                    Text("Allow")
                    Image(systemName: "chevron.forward").font(.footnote.weight(.semibold)).foregroundStyle(.tertiary)
                }
                .padding(.horizontal, 16)
                .frame(minHeight: 52)
            }
            .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("In Settings, Allow Extension is on and All Websites is set to Allow.")
        .accessibilityIdentifier("onboarding.settingsPreview")
    }
}

/// One numbered instruction. The symbol is decoration; VoiceOver reads the step number and text.
struct OnboardingStepRow: View {
    var number: Int
    var symbol: Image
    var text: LocalizedStringKey

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 16) {
            symbol
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
