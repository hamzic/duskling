import XCTest

/// DESIGN.md "Accessibility": VoiceOver labels on every control, Dynamic Type on every screen.
final class AccessibilityUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    @MainActor
    private func launch(_ extra: [String]) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-uitest"] + extra
        app.launch()
        return app
    }

    @MainActor
    private func launchHome(_ extra: [String] = []) -> XCUIApplication {
        let app = launch(["-uitest-onboarded", "-uitest-heartbeat"] + extra)
        XCTAssertTrue(app.switches["home.toggle"].waitForExistence(timeout: 10))
        return app
    }

    /// Every button, switch and link on screen has a non-empty VoiceOver label.
    ///
    /// Exception: a SwiftUI `Toggle` row appears as a labelled switch (the row, which VoiceOver focuses) with an unlabelled
    /// switch inside it (the knob). The knob isn't a separate VoiceOver element, and the audit's
    /// `sufficientElementDescription` check passes for these rows, so an unlabelled switch inside a labelled switch is
    /// accepted.
    @MainActor
    private func assertInteractiveElementsLabelled(_ app: XCUIApplication, _ screen: String,
                                                   file: StaticString = #filePath, line: UInt = #line) {
        let labelledSwitches = app.switches.allElementsBoundByIndex.filter { !$0.label.isEmpty }.map(\.frame)
        var checked = 0
        for type in [XCUIElement.ElementType.button, .switch, .link, .segmentedControl, .slider, .textField] {
            for element in app.descendants(matching: type).allElementsBoundByIndex where element.exists {
                checked += 1
                let label = element.label.trimmingCharacters(in: .whitespacesAndNewlines)
                if label.isEmpty, type == .switch, labelledSwitches.contains(where: { $0.contains(element.frame) }) { continue }
                XCTAssertFalse(label.isEmpty, "\(screen): unlabelled \(type) \(element.debugDescription)", file: file, line: line)
            }
        }
        XCTAssertGreaterThan(checked, 0, screen, file: file, line: line)
    }

    @MainActor
    func testHomeControlsHaveLabels() {
        let app = launchHome()
        assertInteractiveElementsLabelled(app, "Home (top)")
        app.swipeUp()
        assertInteractiveElementsLabelled(app, "Home (bottom)")
    }

    @MainActor
    func testHomeNotSetUpControlsHaveLabels() {
        let app = launch(["-uitest-onboarded"])
        XCTAssertTrue(app.buttons["home.status"].waitForExistence(timeout: 10))
        assertInteractiveElementsLabelled(app, "Home (not set up)")
    }

    @MainActor
    func testOnboardingControlsHaveLabels() {
        let app = launch([])
        XCTAssertTrue(app.buttons["onboarding.setup"].waitForExistence(timeout: 10))
        assertInteractiveElementsLabelled(app, "Onboarding welcome")
        app.buttons["onboarding.setup"].tap()
        XCTAssertTrue(app.buttons["onboarding.openSettings"].waitForExistence(timeout: 5))
        assertInteractiveElementsLabelled(app, "Onboarding enable")
        app.buttons["I've done this"].tap()
        XCTAssertTrue(app.buttons["onboarding.done"].waitForExistence(timeout: 5))
        assertInteractiveElementsLabelled(app, "Onboarding verify")
    }

    /// At the largest accessibility text size, each Home switch can still be reached and tapped. The launch argument sets
    /// the `UIPreferredContentSizeCategoryName` user default for this launch; the taller switch rows prove it applied.
    @MainActor
    func testHomeSwitchesHittableAtLargestAccessibilitySize() {
        let regular = launchHome()
        let regularHeight = regular.switches["home.toggle"].frame.height
        regular.terminate()

        let app = launchHome(["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"])
        XCTAssertGreaterThan(app.switches["home.toggle"].frame.height, regularHeight * 1.5, "text size didn't apply")
        for id in ["home.toggle", "home.nativeDark", "home.dimImages"] {
            let row = app.switches[id]
            for _ in 0..<8 where !row.isHittable { app.swipeUp() }
            XCTAssertTrue(row.isHittable, id)
            // The switch control inside the row, which is what a tap toggles.
            let control = row.switches.firstMatch
            XCTAssertTrue(control.isHittable, "\(id) switch")
            let before = row.value as? String
            control.tap()
            XCTAssertNotEqual(row.value as? String, before, "\(id) didn't toggle")
        }
    }

    // MARK: Accessibility audit, iPhone only
    // `performAccessibilityAudit(for:_:)`, iOS 17.0+; returning true from the issue handler ignores that issue.
    // https://developer.apple.com/documentation/xcuiautomation/xcuiapplication/performaccessibilityaudit(for:_:)

    /// Runs the audit and fails once per issue with its type and element, so a failure names what to fix.
    ///
    /// Filtered issues (each one checked by hand on iPhone 17 Pro, iOS 26.5):
    /// - `.contrast` on grouped-list section header and footer text. These use the iOS system secondary label color, which
    ///   is about 3.3:1 on the grouped background. Per the DESIGN.md Review log: headers and footers
    ///   keep the system color (it adapts under Increase Contrast); all other text must pass.
    ///   At most 3 such issues per screen (the Theme header and the two Home footers), so the filter can't hide a list
    ///   that lost its contrast.
    ///   On some simulators the audit reports these texts with no element (`issue.element` is nil), so the frame check
    ///   can't place them. Checked on a freshly created iPhone 17 Pro (iOS 26.5): every run reported the Theme header
    ///   plus two "Contrast nearly passed" issues with no element, where a long-used simulator reports the header and
    ///   both footers with elements. Adding a modifier to the two footer `Text`s (no change in color) turned the two
    ///   unbound issues into the two footers, so they are the footers. An unbound "Contrast nearly passed" issue
    ///   (between 3:1 and 4.5:1) therefore counts against the header/footer cells on screen: each one is reported once,
    ///   bound or not, so one more than there are cells still fails, and so does any unbound issue that fully fails.
    /// - `.contrast` on list text scrolled under the translucent navigation bar or its scroll edge effect (top less than
    ///   `scrollEdgeEffectDepth` below the bar's bottom edge), only on the scrolled Home audit: the audit measures it
    ///   against the bar's blur and the edge effect's fade, which is not what the text is read against. The bar's own
    ///   texts are never filtered.
    ///   The edge effect reaches below the bar (Apple's docs don't give its size). Checked in dark appearance after the
    ///   swipe: the bar ends at y 116 and the audit fails the "Dark mode" label at y 133.8, yet the screenshot measures
    ///   15.7:1 for it. With `.scrollEdgeEffectHidden(true, for: .top)` the audit passes, and comparing the two
    ///   screenshots shows the effect changes pixels down to y 147, 31 pt below the bar (it slightly darkens the
    ///   background, so the label's contrast is 15.2:1 without it). Light appearance doesn't report the label.
    /// - `.dynamicType` on the Home navigation rows (Report a problem, Sites, About). They're standard
    ///   List rows in the body text style, and `testHomeRowsScaleAtLargestAccessibilitySize` shows they grow with the
    ///   text size, so the report is a false positive.
    @MainActor
    private func audit(_ app: XCUIApplication, _ screen: String, scrolledUnderNavBar: Bool = false,
                       file: StaticString = #filePath, line: UInt = #line) throws {
        // In the List hierarchy, section headers and footers are cells holding one text and no control.
        let headerFooterCells = app.cells.allElementsBoundByIndex.filter {
            $0.buttons.count == 0 && $0.switches.count == 0 && $0.staticTexts.count == 1
        }.map(\.frame)
        let bar = app.navigationBars.firstMatch
        let navBar = scrolledUnderNavBar && bar.exists ? bar.frame : .null
        let barTexts = navBar.isNull ? [] : bar.descendants(matching: .any).allElementsBoundByIndex.map(\.frame)
        let scalingRows = Self.homeRows.map { app.buttons[$0] }.filter(\.exists).map(\.frame)
        var issues: [String] = []
        var headerFooterFiltered = 0
        try app.performAccessibilityAudit { issue in
            let element = issue.element
            let frame = element?.frame ?? .null
            if issue.auditType == .contrast, element?.elementType == .staticText,
               headerFooterCells.contains(where: { $0.insetBy(dx: -1, dy: -1).contains(frame) }) {
                headerFooterFiltered += 1
                return true
            }
            if issue.auditType == .contrast, element == nil, issue.compactDescription == "Contrast nearly passed",
               headerFooterFiltered < headerFooterCells.count {
                headerFooterFiltered += 1
                return true
            }
            if issue.auditType == .contrast, element?.elementType == .staticText, !navBar.isNull,
               frame.minY < navBar.maxY + Self.scrollEdgeEffectDepth,
               !barTexts.contains(frame) {
                return true
            }
            if issue.auditType == .dynamicType, scalingRows.contains(where: { $0.insetBy(dx: -1, dy: -1).contains(frame) }) {
                return true
            }
            let description = element.map { "\($0.elementType.rawValue) '\($0.label)' id=\($0.identifier) \($0.frame)" } ?? "none"
            issues.append("\(issue.compactDescription) | \(issue.detailedDescription) | \(description)")
            return true
        }
        for issue in issues { XCTFail("\(screen): \(issue)", file: file, line: line) }
        XCTAssertLessThanOrEqual(headerFooterFiltered, 3, "\(screen): more header/footer contrast issues than expected", file: file, line: line)
    }

    /// How far the top scroll edge effect reaches below the navigation bar, measured on iPhone 17 Pro, iOS 26.5 (31 pt).
    private static let scrollEdgeEffectDepth: CGFloat = 32

    private static let homeRows = ["home.report", "home.sites", "home.about"]

    /// Backs the `.dynamicType` filter above: each Home navigation row is much taller at the largest accessibility size.
    @MainActor
    func testHomeRowsScaleAtLargestAccessibilitySize() {
        let regular = launchHome()
        let regularHeights = Dictionary(uniqueKeysWithValues: Self.homeRows.map { id in
            let row = regular.buttons[id]
            for _ in 0..<4 where !row.isHittable { regular.swipeUp() }
            return (id, row.frame.height)
        })
        regular.terminate()

        let app = launchHome(["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"])
        for id in Self.homeRows {
            let row = app.buttons[id]
            for _ in 0..<10 where !row.isHittable { app.swipeUp() }
            XCTAssertGreaterThan(row.frame.height, regularHeights[id]! * 1.5, id)
        }
    }

    @MainActor
    private func skipUnlessPhone() throws {
        try XCTSkipUnless(UIDevice.current.userInterfaceIdiom == .phone, "The accessibility audit runs on iPhone only.")
    }

    @MainActor
    func testHomePassesAccessibilityAudit() throws {
        try skipUnlessPhone()
        let app = launchHome()
        try audit(app, "Home (top)")
        app.swipeUp()
        try audit(app, "Home (bottom)", scrolledUnderNavBar: true)
    }

    @MainActor
    func testHomeNotSetUpPassesAccessibilityAudit() throws {
        try skipUnlessPhone()
        let app = launch(["-uitest-onboarded"])
        XCTAssertTrue(app.buttons["home.status"].waitForExistence(timeout: 10))
        try audit(app, "Home (not set up)")
    }

    @MainActor
    func testOnboardingPassesAccessibilityAudit() throws {
        try skipUnlessPhone()
        let app = launch([])
        XCTAssertTrue(app.buttons["onboarding.setup"].waitForExistence(timeout: 10))
        try audit(app, "Onboarding welcome")
        app.buttons["onboarding.setup"].tap()
        XCTAssertTrue(app.buttons["onboarding.openSettings"].waitForExistence(timeout: 5))
        try audit(app, "Onboarding enable")
        app.buttons["I've done this"].tap()
        XCTAssertTrue(app.buttons["onboarding.done"].waitForExistence(timeout: 5))
        try audit(app, "Onboarding verify")
    }
}
