import SwiftUI

struct VerifyStep: View {
    var onDone: () -> Void

    @Environment(AppModel.self) private var model

    private var isWorking: Bool {
        if case .working = model.extensionStatus { return true }
        return false
    }

    var body: some View {
        OnboardingPage(title: "Open any website in Safari.") {
            HStack(alignment: .center, spacing: 8) {
                if isWorking {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundStyle(.primary)
                        .accessibilityHidden(true)
                    Text("onboarding.verify.working")
                        .accessibilityIdentifier("onboarding.status")
                } else {
                    // Decoration: the status text next to it says the same thing to VoiceOver.
                    ProgressView()
                        .accessibilityHidden(true)
                    Text("Waiting for Safari…")
                        .accessibilityIdentifier("onboarding.status")
                }
            }
            .font(.body)
        } actions: {
            OnboardingButton(title: "Done", action: onDone)
                .accessibilityIdentifier("onboarding.done")
        }
        // Polls while visible; `.task` is cancelled when the view disappears.
        // https://developer.apple.com/documentation/swiftui/view/task(priority:_:)
        .task {
            while !Task.isCancelled {
                await model.refresh()
                try? await Task.sleep(for: .seconds(2))
            }
        }
    }
}
