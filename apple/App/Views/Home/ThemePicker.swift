import SettingsKit
import SwiftUI

/// Three swatches, each a miniature page in that theme's colors.
struct ThemePicker: View {
    var selection: ThemeID
    var onSelect: (ThemeID) -> Void

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        let layout = dynamicTypeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(spacing: 16))
            : AnyLayout(HStackLayout(alignment: .top, spacing: 12))
        layout {
            ForEach(ThemeID.allCases, id: \.self) { theme in
                ThemeSwatch(theme: theme, isSelected: theme == selection) { onSelect(theme) }
            }
        }
        .padding(.vertical, 8)
    }
}

private struct ThemeSwatch: View {
    var theme: ThemeID
    var isSelected: Bool
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(spacing: 8) {
                PagePreview(colors: ThemeColors.of(theme))
                    .overlay {
                        RoundedRectangle(cornerRadius: 10)
                            .strokeBorder(isSelected ? AnyShapeStyle(.tint) : AnyShapeStyle(.separator),
                                          lineWidth: isSelected ? 3 : 1)
                    }
                Text(theme.displayName)
                    .font(.subheadline)
                    .fontWeight(isSelected ? .semibold : .regular)
                    .foregroundStyle(isSelected ? AnyShapeStyle(.tint) : AnyShapeStyle(.primary))
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
            }
            .frame(maxWidth: .infinity)
            .contentShape(Rectangle())
        }
        // Plain style so each swatch is its own target inside the List row.
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(theme.accessibilityName)
        .accessibilityAddTraits(isSelected ? [.isButton, .isSelected] : .isButton)
        .accessibilityIdentifier("home.theme.\(theme.rawValue)")
    }
}

/// A tiny page: a heading bar, three text lines and a link line on the theme background.
private struct PagePreview: View {
    var colors: ThemeColors

    var body: some View {
        RoundedRectangle(cornerRadius: 10)
            .fill(colors.background)
            .aspectRatio(4 / 3, contentMode: .fit)
            .overlay(alignment: .topLeading) {
                GeometryReader { proxy in
                    let w = proxy.size.width, h = proxy.size.height
                    VStack(alignment: .leading, spacing: h * 0.08) {
                        Capsule().fill(colors.text).frame(width: w * 0.55, height: h * 0.1)
                        Capsule().fill(colors.text.opacity(0.75)).frame(width: w * 0.8, height: h * 0.06)
                        Capsule().fill(colors.text.opacity(0.75)).frame(width: w * 0.7, height: h * 0.06)
                        Capsule().fill(colors.link).frame(width: w * 0.4, height: h * 0.06)
                    }
                    .padding(w * 0.12)
                }
            }
            .accessibilityHidden(true)
    }
}

/// sRGB values converted from the OKLCH theme anchors with the extension engine
/// (extension/src/engine/color: `paletteCss(PALETTES[id])` for background and text, and
/// `transformColor(#0066cc, "text", palette)` for the link line). Regenerate if the theme anchors in extension/src/engine/color/palettes.ts change.
struct ThemeColors {
    var background: Color
    var text: Color
    var link: Color

    static func of(_ theme: ThemeID) -> ThemeColors {
        switch theme {
        case .dark: ThemeColors(background: Color(hex: 0x191B1D), text: Color(hex: 0xE3E5E8), link: Color(hex: 0x9BC6FF))
        case .midnight: ThemeColors(background: Color(hex: 0x000000), text: Color(hex: 0xD6D7DA), link: Color(hex: 0x84B9FF))
        case .dim: ThemeColors(background: Color(hex: 0x25211B), text: Color(hex: 0xDCCFBC), link: Color(hex: 0x78B2FF))
        }
    }
}

extension Color {
    init(hex: UInt32) {
        self.init(.sRGB,
                  red: Double((hex >> 16) & 0xFF) / 255,
                  green: Double((hex >> 8) & 0xFF) / 255,
                  blue: Double(hex & 0xFF) / 255)
    }
}

extension ThemeID {
    var displayName: LocalizedStringKey {
        switch self {
        case .dark: "Dark"
        case .midnight: "Midnight"
        case .dim: "Dim"
        }
    }

    var accessibilityName: LocalizedStringKey {
        switch self {
        case .dark: "Dark theme"
        case .midnight: "Midnight theme"
        case .dim: "Dim theme"
        }
    }
}
