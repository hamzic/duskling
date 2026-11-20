// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "SettingsKit",
    platforms: [.iOS(.v18), .macOS(.v14)],
    products: [.library(name: "SettingsKit", targets: ["SettingsKit"])],
    targets: [
        .target(name: "SettingsKit"),
        .testTarget(name: "SettingsKitTests", dependencies: ["SettingsKit"]),
    ]
)
