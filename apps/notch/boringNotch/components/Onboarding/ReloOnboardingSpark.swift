//
//  ReloOnboardingSpark.swift
//  Relo
//
//  The light that ties the onboarding window to the notch: the pilot light drops a spark that blooms into the orb, each
//  Continue sends one up to the notch where the step lands, and Start flies the orb up into the notch. A clear panel
//  above both draws it only while a spark is in flight; with Reduce Motion nothing flies and the landing comes at once.
//

import AppKit
import SwiftUI

@MainActor
final class ReloOnboardingSpark {
    static let shared = ReloOnboardingSpark()

    struct Flight: Identifiable, Equatable {
        let id = UUID()
        var from: CGPoint
        var to: CGPoint
        var color: Color
        var duration: Double
        /// Rising flights accelerate upward; falling ones ease into the window.
        var rising: Bool
        var orb: Bool
    }

    @Observable final class Model { var flights: [Flight] = [] }

    private let model = Model()
    private var panel: NSPanel?

    /// The notch's screen: where the notch is drawn (the selected display).
    static var notchScreen: NSScreen? {
        let uuid = BoringViewCoordinator.shared.selectedScreenUUID
        return NSScreen.screens.first { $0.displayUUID == uuid } ?? NSScreen.main
    }

    /// The notch's bottom centre, in screen coordinates: the beams start there, so the step lands there.
    static var notchPoint: CGPoint {
        guard let screen = notchScreen else { return .zero }
        let height = screen.safeAreaInsets.top > 0 ? screen.safeAreaInsets.top : NSStatusBar.system.thickness
        return CGPoint(x: screen.frame.midX, y: screen.frame.maxY - height)
    }

    /// Flies a spark (or the orb) from `from` to `to` in screen coordinates, then calls `landed`.
    func fly(from: CGPoint, to: CGPoint, color: Color, duration: Double = 0.65, rising: Bool, orb: Bool = false,
             landed: @escaping @MainActor () -> Void) {
        guard !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion, let screen = Self.notchScreen else { landed(); return }
        let panel = panel(on: screen)
        let local = { (p: CGPoint) in CGPoint(x: p.x - screen.frame.minX, y: screen.frame.maxY - p.y) }
        let flight = Flight(from: local(from), to: local(to), color: color, duration: duration, rising: rising, orb: orb)
        model.flights.append(flight)
        panel.orderFrontRegardless()
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(duration))
            landed()
            try? await Task.sleep(for: .seconds(0.15))
            model.flights.removeAll { $0.id == flight.id }
            if model.flights.isEmpty { panel.orderOut(nil) }
        }
    }

    private func panel(on screen: NSScreen) -> NSPanel {
        if let panel, panel.screen == screen { return panel }
        let panel = NSPanel(contentRect: screen.frame, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.ignoresMouseEvents = true
        panel.level = .mainMenu + 4
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        panel.setFrame(screen.frame, display: false)
        panel.contentView = NSHostingView(rootView: ReloSparkLayer(model: model).frame(width: screen.frame.width, height: screen.frame.height))
        self.panel = panel
        return panel
    }
}

private struct ReloSparkLayer: View {
    let model: ReloOnboardingSpark.Model

    var body: some View {
        ZStack(alignment: .topLeading) {
            Color.clear
            ForEach(model.flights) { ReloSparkView(flight: $0) }
        }
        .allowsHitTesting(false)
    }
}

/// One flight: x and y move on different curves, so the path bends like the prototype's (a rising spark leaves
/// sideways first and accelerates up; a falling one drops straight and eases in).
private struct ReloSparkView: View {
    let flight: ReloOnboardingSpark.Flight
    @State private var gone = false

    var body: some View {
        let dx = flight.to.x - flight.from.x, dy = flight.to.y - flight.from.y
        let yCurve: Animation = flight.rising ? .timingCurve(0.55, 0, 0.75, 0.35, duration: flight.duration)
            : .timingCurve(0.55, 0, 1, 0.45, duration: flight.duration)
        let xCurve: Animation = flight.orb ? .timingCurve(0.4, 0, 0.2, 1, duration: flight.duration)
            : .timingCurve(0.2, 0.6, 0.4, 1, duration: flight.duration)
        mark
            .scaleEffect(flight.orb ? (gone ? 0.05 : 1) : (gone ? 0.6 : 1))
            .animation(.timingCurve(0.4, 0, 0.2, 1, duration: flight.duration), value: gone)
            .offset(y: gone ? dy : 0)
            .animation(yCurve, value: gone)
            .offset(x: gone ? dx : 0)
            .animation(xCurve, value: gone)
            .position(flight.from)
            .onAppear { gone = true }
    }

    @ViewBuilder private var mark: some View {
        if flight.orb {
            ReloOrb(mood: .clear).frame(width: 120, height: 120)
        } else {
            Circle().fill(.white).frame(width: 9, height: 9)
                .shadow(color: flight.color, radius: 5)
                .shadow(color: flight.color.opacity(0.8), radius: 12)
        }
    }
}
