// swift-tools-version: 6.0

import PackageDescription

// Relo for Mac's voice: speaks a card's line on this Mac, after it is opened here. Phonon (Gradium, Apache-2.0)
// runs on the GPU through mlx-audio-swift once the owner downloads it; the system voice speaks until then. It is
// the only module that imports MLX, so the rest of the app never pays for it.
let package = Package(
    name: "ReloVoice",
    platforms: [.macOS(.v14)],
    products: [
        .library(name: "ReloVoice", targets: ["ReloVoice"])
    ],
    dependencies: [
        // Pinned: a model runtime changes how the voice sounds, so it moves only on purpose.
        .package(url: "https://github.com/Blaizzy/mlx-audio-swift.git", revision: "624fd5410b2fc8ea06f955500c9ac078e405261f"),
        .package(url: "https://github.com/ml-explore/mlx-swift.git", exact: "0.32.3")
    ],
    targets: [
        .target(
            name: "ReloVoice",
            dependencies: [
                .product(name: "MLXAudioTTS", package: "mlx-audio-swift"),
                .product(name: "MLXAudioCore", package: "mlx-audio-swift"),
                .product(name: "MLX", package: "mlx-swift")
            ],
            swiftSettings: [.swiftLanguageMode(.v6)]
        )
    ]
)
