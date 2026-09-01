// swift-tools-version: 5.10

import PackageDescription

let package = Package(
    name: "Relo",
    platforms: [
        .macOS(.v14),
        .iOS(.v17)
    ],
    products: [
        .library(name: "ReloCore", targets: ["ReloCore"])
    ],
    targets: [
        .target(
            name: "ReloCore",
            path: "Sources/ReloCore"
        ),
        .target(
            name: "ReloNotificationSupport",
            path: "Sources/NotificationSupport"
        ),
        .target(
            name: "ReloActivityWire",
            dependencies: ["ReloCore"],
            path: "Sources/SharedActivity",
            exclude: [
                "ImmutablePresentationAssetCache.swift",
                "ReloLiveActivityResponseIntent.swift"
            ],
            sources: ["ReloActivityAttributes.swift"]
        ),
        .target(
            name: "ReloActivityResponse",
            dependencies: ["ReloCore"],
            path: "Sources/SharedActivity",
            exclude: [
                "ImmutablePresentationAssetCache.swift",
                "ReloActivityAttributes.swift"
            ],
            sources: ["ReloLiveActivityResponseIntent.swift"]
        ),
        .testTarget(
            name: "ReloCoreTests",
            dependencies: ["ReloCore", "ReloActivityWire", "ReloActivityResponse"],
            path: "Tests/ReloCoreTests",
            resources: [
                .copy("Fixtures/activitykit-content-state-interaction-generation.json"),
                .copy("Fixtures/delivery-evidence-v1.json")
            ]
        ),
        .testTarget(
            name: "ReloNotificationSupportTests",
            dependencies: ["ReloNotificationSupport"],
            path: "Tests/ReloNotificationSupportTests"
        )
    ]
)
