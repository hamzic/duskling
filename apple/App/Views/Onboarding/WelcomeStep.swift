import SwiftUI

struct WelcomeStep: View {
    var onSetUp: () -> Void

    var body: some View {
        OnboardingPage(title: "Dark mode for every website.", icon: Image("AppLogo")) {
            Text("Free and open source. No tracking, no accounts.")
                .font(.body)
            BeforeAfter()
                .padding(.top, 16)
        } actions: {
            OnboardingButton(title: "Set up", action: onSetUp)
                .accessibilityIdentifier("onboarding.setup")
        }
    }
}

/// A light page and the same page dark: what Duskling does, without words.
private struct BeforeAfter: View {
    var body: some View {
        HStack(spacing: 16) {
            page(background: Color(white: 0.95), title: Color(white: 0.11), picture: Color(red: 0.79, green: 0.84, blue: 0.91),
                 button: Color(red: 0.18, green: 0.42, blue: 0.85))
            Image(systemName: "arrow.right")
                .font(.title3.weight(.semibold))
                .foregroundStyle(.tint)
            page(background: Color(white: 0.11), title: Color(white: 0.9), picture: Color(red: 0.23, green: 0.27, blue: 0.35),
                 button: Color(red: 0.37, green: 0.56, blue: 0.9))
        }
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("A light web page becomes a dark web page.")
        .accessibilityIdentifier("onboarding.beforeAfter")
    }

    private func page(background: Color, title: Color, picture: Color, button: Color) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            RoundedRectangle(cornerRadius: 3).fill(title).frame(width: 74, height: 12)
            RoundedRectangle(cornerRadius: 6).fill(picture).frame(height: 54)
            ForEach([1.0, 0.85, 0.92, 0.6], id: \.self) { width in
                RoundedRectangle(cornerRadius: 3).fill(Color.gray).frame(width: 106 * width, height: 6)
            }
            RoundedRectangle(cornerRadius: 5).fill(button).frame(width: 53, height: 18).padding(.top, 4)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 14)
        .frame(width: 130, height: 190, alignment: .top)
        .background(background, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Color(white: 0.23)))
    }
}
