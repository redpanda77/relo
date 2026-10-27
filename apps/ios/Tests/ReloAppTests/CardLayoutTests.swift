import ReloCore
import SwiftUI
import XCTest
@testable import Relo

/// The card layout rules, measured: every card stays compact at phone width (no reserved space a List cell
/// would show as a gap), and the plan bar is content: a row in the body, inside the card's insets, never on its
/// edge or in the footer.
@MainActor
final class CardLayoutTests: XCTestCase {
    private let width: CGFloat = 358
    /// A color nothing else on a card uses, so the bar's pixels can be found.
    private let probe = Color(red: 1, green: 0, blue: 0)

    private func workCard<Extra: View>(surface: ReloCardPlacement = .card, @ViewBuilder extra: @escaping () -> Extra) -> some View {
        ReloWorkCard(origin: ReloCardOrigin(source: "Claude Code", project: "relo", topic: "Release review"),
                     at: Date(timeIntervalSince1970: 1_800_000_000), title: "Make every iPhone card compact",
                     summary: "Waiting on your unlocked iPhone near the Mac",
                     steps: NowItem.Steps(done: 2, total: 3, current: "Install", currentIndex: 3), progressCaption: "Step 3 of 3 · Install",
                     color: probe, state: .done, facts: [], computer: "MacBook Pro", surface: surface, extra: extra)
    }

    /// The height the card gets as a cell of a real inset-grouped List, the way History hosts it: the List sizes
    /// cells its own way, which is where a reserved, undrawn height shows up as a gap.
    private func cellHeight(_ view: some View) throws -> CGFloat {
        let host = UIHostingController(rootView: List {
            view.listRowInsets(EdgeInsets(top: 0, leading: 20, bottom: 0, trailing: 20))
        }.listStyle(.insetGrouped))
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: width + 32, height: 1_200))
        window.rootViewController = host
        window.makeKeyAndVisible()
        defer { window.isHidden = true }
        for _ in 0..<5 { host.view.layoutIfNeeded(); RunLoop.main.run(until: Date().addingTimeInterval(0.05)) }
        let list = try XCTUnwrap(Self.find(UICollectionView.self, in: host.view), "the List renders a collection view")
        return try XCTUnwrap(list.visibleCells.first, "the card renders as a cell").frame.height
    }

    private static func find<T: UIView>(_ type: T.Type, in view: UIView) -> T? {
        if let match = view as? T { return match }
        return view.subviews.lazy.compactMap { find(type, in: $0) }.first
    }

    func testCardsStayCompactInAList() throws {
        // Header, title, status, progress (bar and step line), the question panel (its own inset, with 12 pt above it),
        // footer and the insets: about 205 pt. A layout that reserves another layout's height (the History gap) lands far past the ceiling.
        let card = try cellHeight(workCard(surface: .listCell) {
            CardDecisionLine(prompt: "Publish Relo 0.17.50 to the public GitHub repo with every release asset?",
                             answer: "You approved", tint: .reloDone, at: Date(timeIntervalSince1970: 1_800_000_000))
        })
        XCTAssertLessThan(card, 215, "a History card with a question must be its rows and insets, nothing more")
        XCTAssertLessThan(try cellHeight(workCard(surface: .listCell) { EmptyView() }), 160)
    }

    func testThePlanBarIsABodyRowNotTheEdge() throws {
        // A bare card (no glass, no shadow): the image's edge is the card's edge.
        let renderer = ImageRenderer(content: workCard(surface: .row) { EmptyView() }.frame(width: width).background(Color.black))
        renderer.scale = 1
        let image = try XCTUnwrap(renderer.cgImage)
        let rows = try barRows(image)
        let bottom = try XCTUnwrap(rows.last, "the bar must render")
        // The footer row (meta and time) and the bottom inset lie under the bar: it is never the card's last row.
        XCTAssertLessThanOrEqual(bottom, image.height - 1 - Int(ReloLayout.rowInset) - 24, "the bar sits on the card's edge or in the footer; the step line and footer belong under it")
        let columns = try barColumns(image)
        XCTAssertGreaterThanOrEqual(try XCTUnwrap(columns.first), Int(ReloLayout.cardInset) - 1, "the bar runs into the corner")
        // The Lock Screen's layout: the bar runs across the card, not beside the step line. Two of three segments
        // are filled (the probe color), so the filled run is about two thirds of the card's inner width.
        XCTAssertGreaterThan(try XCTUnwrap(columns.last) - columns.first!, Int((width - 2 * ReloLayout.cardInset) * 2 / 3) - 8, "the bar must span the card")
    }

    private func pixels(_ image: CGImage) throws -> (data: [UInt8], width: Int, height: Int) {
        let w = image.width, h = image.height
        var data = [UInt8](repeating: 0, count: w * h * 4)
        let context = try XCTUnwrap(CGContext(data: &data, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                                              space: CGColorSpaceCreateDeviceRGB(),
                                              bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        context.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
        return (data, w, h)
    }

    private func isProbe(_ d: [UInt8], _ i: Int) -> Bool { d[i] > 180 && d[i + 1] < 70 && d[i + 2] < 70 }

    /// Rows (top = 0) that hold the probe color.
    private func barRows(_ image: CGImage) throws -> [Int] {
        let (d, w, h) = try pixels(image)
        // The bitmap's first row in memory is the image's top row.
        return (0..<h).filter { y in (0..<w).contains { x in isProbe(d, (y * w + x) * 4) } }
    }

    private func barColumns(_ image: CGImage) throws -> [Int] {
        let (d, w, h) = try pixels(image)
        return (0..<w).filter { x in (0..<h).contains { y in isProbe(d, (y * w + x) * 4) } }
    }
}
