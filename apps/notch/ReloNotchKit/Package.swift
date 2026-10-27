// swift-tools-version: 6.0

import PackageDescription

// Relo's owner client for the Mac notch: sign-in, this Mac as an owner device, the live Now feed and
// answers. It reuses the iPhone's client modules (apps/ios) so protocol and encryption live in one place.
let package = Package(
    name: "ReloNotchKit",
    platforms: [.macOS(.v14)],
    products: [
        .library(name: "ReloNotchKit", targets: ["ReloNotchKit"])
    ],
    dependencies: [
        .package(path: "../../ios")
    ],
    targets: [
        .target(
            name: "ReloNotchKit",
            dependencies: [
                .product(name: "ReloCore", package: "ios"),
                .product(name: "ReloTransport", package: "ios"),
                .product(name: "ReloRuntime", package: "ios"),
                .product(name: "ReloPersistence", package: "ios"),
                .product(name: "ReloNotificationSupport", package: "ios")
            ],
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
        .testTarget(
            name: "ReloNotchKitTests",
            dependencies: [
                "ReloNotchKit",
                .product(name: "ReloCore", package: "ios")
            ]
        )
    ]
)
