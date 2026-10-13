import Foundation
import SwiftUI

/// Compile with the production ReloMediaViewport.swift and ReloNowStatusLabel.swift.
/// Measures native macOS SwiftUI geometry; it does not install or run an iOS app.
@main
struct HomeLoadingLayoutVerification {
    @MainActor
    static func main() throws {
        for width: CGFloat in [280, 343, 398] {
            for height: CGFloat in [96, 240] {
                for largeType in [false, true] {
                    let sizes = try (0..<4).map { state in
                        try size(VStack(spacing: 12) {
                            ReloMediaViewport(height: height) { media(state) }
                            Text("The next notification").frame(height: 44)
                        }.environment(\.dynamicTypeSize, largeType ? .accessibility3 : .large), width: width)
                    }
                    guard sizes.allSatisfy({ $0 == sizes[0] }), sizes[0].height == height + 56 else {
                        throw Failure.geometry("Media shifted the next row: \(sizes)")
                    }
                }
            }
            for symbol in ["checkmark.icloud", "wifi.slash", "bell.badge", "exclamationmark.circle"] {
                for updating in [false, true] {
                    let bounds = try size(ReloNowStatusLabel(updating: updating, symbol: symbol), width: nil)
                    guard bounds == CGSize(width: 44, height: 44) else {
                        throw Failure.geometry("Status changed toolbar bounds: \(bounds)")
                    }
                }
            }
        }
        // Reproduce the previous intrinsic sizing defect, so this check proves the
        // fixed viewport addresses an actual layout difference between load states.
        let oldLoading = try size(media(0).frame(maxWidth: .infinity, minHeight: 120, maxHeight: 240), width: 343)
        let oldLoaded = try size(media(2).frame(maxWidth: .infinity, minHeight: 120, maxHeight: 240), width: 343)
        guard oldLoading.height != oldLoaded.height else {
            throw Failure.geometry("Legacy fixture did not reproduce the height jump")
        }
        print("Legacy media load changed height: \(oldLoading.height) → \(oldLoaded.height) pt")
        print("PASS: 48 media states keep the next row at the same position across widths and text sizes")
        print("PASS: 24 connection/loading states retain a 44 × 44 pt toolbar control")
    }

    @MainActor
    @ViewBuilder
    private static func media(_ state: Int) -> some View {
        switch state {
        case 0: ProgressView()
        case 1: Label("Image unavailable", systemImage: "photo").font(.footnote)
        case 2: Image(systemName: "photo").resizable().scaledToFit()
        default: Text("A long alternative description that wraps over several lines.")
        }
    }

    @MainActor
    private static func size(_ content: some View, width: CGFloat?) throws -> CGSize {
        let renderer = ImageRenderer(content: content)
        renderer.proposedSize = ProposedViewSize(width: width, height: nil)
        renderer.scale = 1
        guard let image = renderer.cgImage else { throw Failure.geometry("Rendering failed") }
        return CGSize(width: image.width, height: image.height)
    }
    private enum Failure: Error { case geometry(String) }
}
