import SafariServices
import SettingsKit
import UIKit

/// Safari web extension native handler. Message plumbing per Apple's "Messaging between the app and JavaScript in a
/// Safari web extension": the JS message arrives as `SFExtensionMessageKey` in the first input item's `userInfo`, and
/// the reply goes back the same way via `completeRequest`.
/// https://developer.apple.com/documentation/safariservices/messaging-between-the-app-and-javascript-in-a-safari-web-extension
/// The extension only touches the App Group store (never iCloud).
final class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
    func beginRequest(with context: NSExtensionContext) {
        let item = context.inputItems.first as? NSExtensionItem
        let message = item?.userInfo?[SFExtensionMessageKey]

        // An empty App Group id would make AppGroupStore fall back to .standard; never do that silently.
        guard !Brand.appGroupID.isEmpty else {
            let response = NSExtensionItem()
            let reply = (try? JSONSerialization.jsonObject(with: NativeMessageRouter.storageUnavailable)) ?? [:]
            response.userInfo = [SFExtensionMessageKey: reply]
            context.completeRequest(returningItems: [response], completionHandler: nil)
            return
        }

        let group = AppGroupStore(suiteName: Brand.appGroupID)
        let clock: @Sendable () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }
        let info = Self.deviceInfo()
        let router = NativeMessageRouter(
            sync: SettingsSync(group: group, cloud: nil, now: clock),
            group: group,
            device: { info },
            now: clock)

        // Anything that is not valid JSON goes to the router as empty data, which answers `bad_request`.
        let request = message.flatMap { JSONSerialization.isValidJSONObject($0) ? try? JSONSerialization.data(withJSONObject: $0) : nil } ?? Data()
        let reply = (try? JSONSerialization.jsonObject(with: router.handle(request))) ?? ["ok": false, "error": "bad_request"]

        let response = NSExtensionItem()
        response.userInfo = [SFExtensionMessageKey: reply]
        context.completeRequest(returningItems: [response], completionHandler: nil)
    }

    /// iPad Safari reports a Mac user agent, so model and OS come from the device, not the page.
    /// `UIDevice` is main-actor isolated (https://developer.apple.com/documentation/uikit/uidevice); `beginRequest` may
    /// run on another queue, so hop to main synchronously (the extension has nothing else waiting on the main queue).
    private static func deviceInfo() -> DeviceInfo {
        let read: @MainActor () -> DeviceInfo = {
            DeviceInfo(
                model: UIDevice.current.userInterfaceIdiom == .pad ? .iPad : .iPhone,
                osVersion: UIDevice.current.systemVersion,
                appVersion: Brand.version)
        }
        if Thread.isMainThread { return MainActor.assumeIsolated(read) }
        return DispatchQueue.main.sync { MainActor.assumeIsolated(read) }
    }
}
