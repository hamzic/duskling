import SwiftUI

/// The setup check: turned on in Settings (the extension has run) and allowed on websites (a content script has run on a
/// page, which Safari allows only on websites the user granted). Both update by themselves while this is on screen.
struct VerifyStep: View {
    var onDone: () -> Void

    @Environment(AppModel.self) private var model
    @Environment(\.openURL) private var openURL

    private var allSet: Bool { model.isTurnedOn && model.hasWebsiteAccess }

    var body: some View {
        OnboardingPage(title: allSet ? "You're all set." : "onboarding.check.title") {
            VStack(alignment: .leading, spacing: 20) {
                CheckRow(title: "Turned on in Settings", done: model.isTurnedOn, waiting: true,
                         hint: "Not yet. Go back to step 2.")
                    .accessibilityIdentifier("onboarding.check.settings")
                CheckRow(title: "Allowed on websites", done: model.hasWebsiteAccess, waiting: model.isTurnedOn,
                         hint: model.isTurnedOn ? "Not yet. Go back to step 3." : nil)
                    .accessibilityIdentifier("onboarding.check.websites")
            }
            .padding(.top, 8)
            Text(allSet ? "Websites in Safari now open dark." : "This updates by itself.")
                .font(.subheadline)
                .accessibilityIdentifier("onboarding.status")
        } actions: {
            if model.isTurnedOn && !model.hasWebsiteAccess {
                OnboardingButton(title: "Open Safari") { SafariStep.openSafari(openURL) }
                    .accessibilityIdentifier("onboarding.openSafari")
            }
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

/// One line of the check: a check mark when done, a spinner while it's the one being waited for, an empty circle after.
private struct CheckRow: View {
    var title: LocalizedStringKey
    var done: Bool
    var waiting: Bool
    var hint: LocalizedStringKey?

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 16) {
            Group {
                if done {
                    Image(systemName: "checkmark.circle.fill").foregroundStyle(.tint)
                } else if waiting {
                    ProgressView()
                } else {
                    Image(systemName: "circle").foregroundStyle(.tertiary)
                }
            }
            .font(.title3)
            .frame(width: 32)
            .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                // Primary label color throughout (DESIGN.md: the onboarding status line is key content); secondary falls
                // under 4.5:1 at these sizes on iPhone Duo's outer display.
                Text(title)
                if !done, let hint {
                    Text(hint).font(.subheadline)
                }
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityValue(done ? Text("Done") : Text("Not yet"))
    }
}
