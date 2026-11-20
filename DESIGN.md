# Design

Read `PRODUCT.md` first. Both the Safari popup and the companion app are *operate* surfaces: native, quiet, fast to scan.

## Tokens

**Type.** System font stack only: `-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif`. In SwiftUI, use
the system fonts and Dynamic Type.

**Spacing.** 4, 8, 12, 16, 24 (px in the popup, pt in the app). No other values.

**Corner radius.** 10 for rows, 14 for grouped sections.

**Accent: Ember.** Light mode `#A35F00`, dark mode `#F0A848`. Used on controls only, never on large surfaces. No
purple, no gradients, no glow.

| Token | Light | Dark |
|---|---|---|
| Popup background | `#F2F2F7` | `#000000` |
| Grouped cell | `#FFFFFF` | `#1C1C1E` |
| Text | `#000000` | `#FFFFFF` |
| Secondary text | `#3C3C4399` | `#EBEBF599` |
| Accent (Ember) | `#A35F00` | `#F0A848` |

The secondary-text values are the iOS system values.

## Components

- **Grouped list.** Rows on a grouped cell, radius 14 on the section and 10 on a row. Hairline separators.
- **Switch.** The system switch, tinted Ember.
- **Segmented control.** For choosing one of a few options (theme, mode). Native control, Ember selection.
- **Secondary button.** A quiet text or tinted button. There is no loud primary call to action.
- **Status line.** One short sentence that says what is happening now, in secondary text.
- **Banner.** A short inline message for a state the user must notice. Never a modal, never repeated.

Use a system control wherever one exists. Don't build custom ones.

## Copy rules

- Short and concrete. Sentence case.
- No exclamation marks.
- Say what happens, not what the product is. Headings and buttons name the thing or the action.
- Headings and calls to action are specific, not vague.

## Banned patterns

- Italic serif headings
- Eyebrow chips above headlines
- Cards nested in cards
- Icon tiles in lists
- Numbered section labels
- Pulsing status dots
- Labels that exist only as placeholders
- Low-contrast text
- Vague headings or calls to action
- Purple, gradients, glow

## Accessibility

Text meets WCAG 4.5:1 in both appearances. Targets are at least 44 pt. Dynamic Type and VoiceOver work on every screen.

## Review log

- 2026-10-18 (app, review): Secondary text stays the iOS system secondary label color for footers,
  captions and summaries (the token table above lists the iOS values, and the system color adapts under Increase
  Contrast). Key content, such as onboarding body text and the onboarding status line, uses the primary label color.
- 2026-10-18 (app and popup, critique and accessibility audit): Reviewed every app screen (onboarding,
  Home on iPhone and iPad, Sites, About, Licenses) in both appearances, and every
  popup state, against this file and the banned patterns. No banned pattern found. Fixes:
  - Onboarding: every action (Set up, Open Settings, I've done this, Done) is a quiet Ember text button with a
    full-width target at least 44 pt tall, so there is still no loud primary call to action. Ember is 5.0:1 on the white
    page and `#F0A848` is 10.4:1 on black. The bordered style it replaces put Ember text on a tinted fill, which the
    audit reported below 4.5:1. The step numbers use the primary label color.
  - Sites: the empty state keeps the grouped background (an empty List drew plain white).
  - Exception: grouped-list section headers and footers keep the iOS system secondary color (about
    3.3:1 on the grouped background, adapts under Increase Contrast), so they are below the 4.5:1 rule above. The
    accessibility audit filters only that case.
