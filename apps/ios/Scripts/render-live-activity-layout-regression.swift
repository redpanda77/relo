import Foundation
import ImageIO
import SwiftUI
import UniformTypeIdentifiers

/// Run with the production LiveActivityFittingLayout.swift source. This captures
/// a macOS SwiftUI layout harness, never a simulated ActivityKit/device screenshot.
@main
struct LiveActivityLayoutRegressionCapture {
    @MainActor
    static func main() throws {
        guard CommandLine.arguments.count == 2 else {
            throw CaptureError.missingOutputPath
        }
        let output = URL(fileURLWithPath: CommandLine.arguments[1])
        let before = alternatives
            .frame(maxWidth: .infinity, maxHeight: 96, alignment: .topLeading)
            .padding(14).background(.black, in: RoundedRectangle(cornerRadius: 24))
        let after = LiveActivityFittingLayout(maximumHeight: 96) { alternatives }
            .frame(maxWidth: .infinity, alignment: .topLeading)
            .padding(14).background(.black, in: RoundedRectangle(cornerRadius: 24))
        let beforeSize = try renderedSize(before)
        let afterSize = try renderedSize(after)
        guard beforeSize.height == 124, afterSize.height == 72 else {
            throw CaptureError.unexpectedSize
        }
        let comparison = VStack(alignment: .leading, spacing: 18) {
            Text("Card-height regression").font(.title2.bold())
            Text("Native SwiftUI layout harness · not an iOS/ActivityKit screenshot")
                .font(.callout).foregroundStyle(.secondary)
            HStack(alignment: .top, spacing: 24) {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Before · 124 pt").font(.headline)
                    before
                    Text("44 pt of content + 52 pt unused allocation + padding")
                        .font(.callout).foregroundStyle(.secondary)
                }
                VStack(alignment: .leading, spacing: 8) {
                    Text("Fixed · 72 pt").font(.headline)
                    after
                    Text("44 pt of content + padding. The height limit still applies.")
                        .font(.callout).foregroundStyle(.secondary)
                }
            }
            Text("Both reject the 200 pt primary candidate and choose the same 44 pt fallback.")
                .font(.callout).foregroundStyle(.secondary)
        }
        .padding(24).frame(width: 720, alignment: .leading)
        .background(Color(red: 0.95, green: 0.97, blue: 0.95))
        .environment(\.colorScheme, .light)
        let renderer = ImageRenderer(content: comparison)
        renderer.scale = 2
        guard let image = renderer.cgImage,
            let destination = CGImageDestinationCreateWithURL(
                output as CFURL, UTType.png.identifier as CFString, 1, nil)
        else { throw CaptureError.renderFailed }
        CGImageDestinationAddImage(destination, image, nil)
        guard CGImageDestinationFinalize(destination) else { throw CaptureError.renderFailed }
        print("Old allocation: \(beforeSize.height) pt; corrected: \(afterSize.height) pt")
        print(output.path)
    }

    @MainActor
    private static var alternatives: some View {
        ViewThatFits(in: .vertical) {
            Text("Oversized primary context").frame(height: 200)
            Text("Approve")
                .font(.subheadline.weight(.semibold)).foregroundStyle(.white)
                .frame(maxWidth: .infinity, minHeight: 44)
                .background(Color(red: 0.04, green: 0.43, blue: 0.34), in: Capsule())
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    @MainActor
    private static func renderedSize(_ content: some View) throws -> CGSize {
        let renderer = ImageRenderer(content: content)
        renderer.proposedSize = ProposedViewSize(width: 312, height: nil)
        guard let image = renderer.cgImage else { throw CaptureError.renderFailed }
        return CGSize(width: image.width, height: image.height)
    }

    private enum CaptureError: Error {
        case missingOutputPath, unexpectedSize, renderFailed
    }
}
