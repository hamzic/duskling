import SettingsKit
import SwiftUI

/// Turning Duskling on in Settings isn't enough: with All Websites left on "Ask", Safari runs it on no website until the
/// user allows it from the page menu. "When the user visits a page where they haven't granted access to your Safari web
/// extension, Safari shows a badge … In iOS, the user selects the extension's entry in the More menu, and selects a
/// permission option."
/// https://developer.apple.com/documentation/safariservices/managing-safari-web-extension-permissions
/// Labels and pictures are from iOS 27.2 Safari: Page Menu button › "Duskling ⚠ Permission Required" › "Always Allow…" ›
/// "Always Allow on Every Website".
struct SafariStep: View {
    var onDone: () -> Void

    @Environment(\.openURL) private var openURL

    var body: some View {
        OnboardingPage(title: "onboarding.safari.title") {
            VStack(alignment: .leading, spacing: 20) {
                OnboardingStepRow(number: 1, symbol: Image(systemName: "safari"), text: "Open any website in **Safari**.")
                // The button's glyph is the row's symbol, not inline: an image inside Text doesn't grow with Dynamic Type.
                OnboardingStepRow(number: 2, symbol: Image("PageMenu"), text: "onboarding.safari.step2")
                OnboardingStepRow(number: 3, symbol: Image(systemName: "checkmark"),
                                  text: "Tap **Always Allow…**, then **Always Allow on Every Website**.")
            }
            .padding(.top, 8)
            SafariPicture()
                .padding(.top, 20)
        } actions: {
            OnboardingButton(title: "Open Safari") { SafariStep.openSafari(openURL) }
                .accessibilityIdentifier("onboarding.openSafari")
            OnboardingButton(title: "Next", action: onDone)
                .accessibilityIdentifier("onboarding.safari.next")
        }
    }

    /// Opens the project's page in Safari: any website works, and this one is ours.
    static func openSafari(_ openURL: OpenURLAction) {
        if let url = URL(string: Brand.repoURL), !Brand.repoURL.isEmpty { openURL(url) }
    }
}

/// The address bar's page menu button (1), then Safari's menu with the Duskling entry (2). The button is drawn over the
/// screenshot with the same glyph as the step text, so the picture and the instruction show the same button.
private struct SafariPicture: View {
    var body: some View {
        VStack(spacing: 10) {
            marked(Image("SafariBar"), ring: CGRect(x: 0.245, y: 0.24, width: 0.09, height: 0.52), number: 1, round: true,
                   glyph: true)
            marked(Image("SafariMenu"), ring: CGRect(x: 0.16, y: 0.36, width: 0.62, height: 0.19), number: 2, round: false)
                .frame(maxHeight: 200)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("onboarding.safari.picture")
        .accessibilityIdentifier("onboarding.safariPicture")
    }

    private func marked(_ image: Image, ring: CGRect, number: Int, round: Bool, glyph: Bool = false) -> some View {
        image
            .resizable()
            .scaledToFit()
            .overlay {
                GeometryReader { geo in
                    let r = CGRect(x: ring.minX * geo.size.width, y: ring.minY * geo.size.height,
                                   width: ring.width * geo.size.width, height: ring.height * geo.size.height)
                    if glyph {
                        Image("PageMenu")
                            .foregroundStyle(Color(white: 0.11))
                            .frame(width: r.height * 0.9, height: r.height * 0.9)
                            .background(Color(white: 0.99), in: Circle())
                            .position(x: r.midX, y: r.midY)
                    }
                    RoundedRectangle(cornerRadius: round ? r.height / 2 : 12, style: .continuous)
                        .strokeBorder(Color.accentColor, lineWidth: 3)
                        .frame(width: r.width, height: r.height)
                        .position(x: r.midX, y: r.midY)
                    Text(verbatim: "\(number)")
                        .font(.caption.bold())
                        // The page color on Ember: white on #A35F00 (5.0:1), black on #F0A848 (10.4:1).
                        .foregroundStyle(Color(.systemBackground))
                        .frame(width: 22, height: 22)
                        .background(Color.accentColor, in: Circle())
                        .position(x: r.maxX, y: r.minY)
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
    }
}
