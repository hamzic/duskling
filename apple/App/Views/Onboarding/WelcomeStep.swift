import SwiftUI

struct WelcomeStep: View {
    var onSetUp: () -> Void

    var body: some View {
        OnboardingPage(title: "Dark mode for every website.", icon: Image("AppLogo")) {
            Text("Free and open source. No tracking, no accounts.")
                .font(.body)
        } actions: {
            OnboardingButton(title: "Set up", action: onSetUp)
                .accessibilityIdentifier("onboarding.setup")
        }
    }
}
