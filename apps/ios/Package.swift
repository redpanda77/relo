// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "Relo",
    platforms: [
        .macOS(.v14),
        .iOS(.v17)
    ],
    products: [
        .library(name: "ReloCore", targets: ["ReloCore"]),
        .library(name: "ReloRuntime", targets: ["ReloRuntime"]),
        .library(name: "ReloPersistence", targets: ["ReloPersistence"]),
        .library(name: "ReloTransport", targets: ["ReloTransport"])
    ],
    targets: [
        .target(name: "ReloRuntime", dependencies: ["ReloCore"], path: "Sources/ReloRuntime", swiftSettings: [.swiftLanguageMode(.v6)]),
        .target(name: "ReloPersistence", dependencies: ["ReloCore", "ReloNotificationSupport"], path: "Sources/ReloPersistence", swiftSettings: [.swiftLanguageMode(.v6)]),
        .target(name: "ReloTransport", dependencies: ["ReloCore"], path: "Sources/ReloTransport", swiftSettings: [.swiftLanguageMode(.v6)]),
        .target(
            name: "ReloActivityLayout",
            path: "Sources/LiveActivities",
            exclude: ["ReloLiveActivityWidget.swift", "ReloLiveActivityBundle.swift", "ReloLiveActivityPreviews.swift"],
            sources: ["LiveActivityFittingLayout.swift"]
        ),
        .testTarget(
            name: "ReloActivityLayoutTests",
            dependencies: ["ReloActivityLayout"],
            path: "Tests/ReloActivityLayoutTests"
        ),
        .target(
            name: "ReloCore",
            path: "Sources/ReloCore",
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
        .target(
            name: "ReloNotificationSupport",
            dependencies: ["ReloCore"],
            path: "Sources/NotificationSupport",
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
        .target(
            name: "ReloActivityWire",
            dependencies: ["ReloCore"],
            path: "Sources/SharedActivity",
            exclude: [
                "ImmutablePresentationAssetCache.swift",
                "ReloLiveActivityResponseIntent.swift"
            ],
            sources: ["ReloActivityAttributes.swift", "ReloLiveActivityReferenceFixtures.swift"]
        ),
        .target(
            name: "ReloActivityResponse",
            dependencies: ["ReloCore", "ReloTransport", "ReloPersistence", "ReloNotificationSupport"],
            path: "Sources/SharedActivity",
            exclude: [
                "ImmutablePresentationAssetCache.swift",
                "ReloActivityAttributes.swift",
                "ReloLiveActivityReferenceFixtures.swift"
            ],
            sources: ["ReloLiveActivityResponseIntent.swift"]
        ),
        .testTarget(
            name: "ReloCoreTests",
            dependencies: ["ReloCore", "ReloRuntime", "ReloTransport", "ReloPersistence", "ReloNotificationSupport", "ReloActivityWire", "ReloActivityResponse"],
            path: "Tests/ReloCoreTests",
            resources: [
                .copy("Fixtures/activitykit-content-state-interaction-generation.json"),
                .copy("Fixtures/delivery-evidence-v1.json"),
                .copy("Fixtures/relevance.json"),
                .copy("Fixtures/receipt-scope-v1.json"),
                .copy("Fixtures/e2ee-v1.json")
            ]
        ),
        .testTarget(
            name: "ReloNotificationSupportTests",
            dependencies: ["ReloCore", "ReloNotificationSupport"],
            path: "Tests/ReloNotificationSupportTests"
        )
    ],
    swiftLanguageModes: [.v6]
)
