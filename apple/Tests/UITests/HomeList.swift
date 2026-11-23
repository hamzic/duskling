import XCTest

extension XCUIApplication {
    /// Home's list: the whole screen on compact width, the sidebar on regular width (iPad, iPhone Duo's inner display).
    /// Scroll this, not the app: on regular width the middle of the screen is the detail column. Found by any of its rows
    /// (all `home.*`), so it's found however far it's scrolled; no other screen uses that prefix.
    var homeList: XCUIElement {
        collectionViews.containing(NSPredicate(format: "identifier BEGINSWITH 'home.'")).firstMatch
    }

    /// Scrolls Home's list up until the element can be tapped (rows below the fold aren't created until they scroll in).
    @discardableResult
    func scrollHome(to element: XCUIElement, maxSwipes: Int = 8) -> XCUIElement {
        for _ in 0..<maxSwipes where !(element.exists && element.isHittable) { homeList.swipeUp() }
        return element
    }
}
