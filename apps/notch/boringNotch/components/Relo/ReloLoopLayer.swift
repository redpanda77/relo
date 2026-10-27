//
//  ReloLoopLayer.swift
//  Relo for Mac
//
//  A repeating effect played by Core Animation: the effect builds its layers once and gives each moving property a
//  keyframe animation sampled from its own Swift function of time (the same function SwiftUI drew from), so the render
//  server plays it and nothing in the app runs per frame. Time follows ReloMotionTimeline: it runs while the effect can
//  be seen, holds out of sight, and shows the still frame with Reduce Motion or when the effect is off.
//

import AppKit
import SwiftUI

/// Builds an effect's layers into `root` (sized `size`), adding its animations with `ReloLoop.animation`.
typealias ReloLoopBuild = (_ root: CALayer, _ size: CGSize) -> Void

enum ReloLoop {
    /// A property's value over one `period`, sampled `fps` times a second, looping forever. `delay` holds the first
    /// value that long before the first loop starts (an effect that waits a beat).
    static func animation(_ keyPath: String, period: Double, fps: Double = 60, delay: Double = 0,
                          _ value: (Double) -> Any) -> CAKeyframeAnimation {
        let count = max(2, Int((period * fps).rounded()) + 1)
        let animation = CAKeyframeAnimation(keyPath: keyPath)
        animation.values = (0..<count).map { value(period * Double($0) / Double(count - 1)) }
        animation.keyTimes = (0..<count).map { NSNumber(value: Double($0) / Double(count - 1)) }
        animation.calculationMode = .linear
        animation.duration = period
        animation.repeatCount = .infinity
        // Never 0 (Core Animation would start it "now"): the root's own time places it.
        animation.beginTime = max(delay, 1e-6)
        animation.fillMode = .backwards
        animation.isRemovedOnCompletion = false
        return animation
    }

    /// A SwiftUI view drawn once into a layer `size` big, centred on `center` (an effect's static look, which its
    /// animations then move, scale or fade).
    @MainActor
    static func imageLayer(_ view: some View, size: CGSize, center: CGPoint, scale: CGFloat) -> CALayer {
        let layer = CALayer()
        layer.bounds = CGRect(origin: .zero, size: size)
        layer.position = center
        let renderer = ImageRenderer(content: view.frame(width: size.width, height: size.height).environment(\.colorScheme, .dark))
        renderer.scale = scale
        layer.contents = renderer.cgImage
        layer.contentsScale = scale
        return layer
    }

    /// A circle's outline, `lineWidth` wide, inside `rect` (`inset` moves it in, as strokeBorder does).
    static func ring(_ rect: CGRect, color: Color, lineWidth: CGFloat, inset: Bool) -> CAShapeLayer {
        let layer = CAShapeLayer()
        layer.bounds = CGRect(origin: .zero, size: rect.size)
        layer.position = CGPoint(x: rect.midX, y: rect.midY)
        let pathRect = inset ? layer.bounds.insetBy(dx: lineWidth / 2, dy: lineWidth / 2) : layer.bounds
        layer.path = CGPath(ellipseIn: pathRect, transform: nil)
        layer.fillColor = nil
        layer.strokeColor = cgColor(color)
        layer.lineWidth = lineWidth
        return layer
    }

    /// A disc of `color`, `size` across, blurred by SwiftUI's `blur(radius:)`: drawn once (with room for the blur) and
    /// centred on `center`, for a backdrop's drifting light.
    @MainActor
    static func blob(_ color: Color, size: CGFloat, blur: CGFloat, center: CGPoint, scale: CGFloat) -> CALayer {
        let side = size + 6 * blur
        // Light this soft needs no detail: half the backing scale is indistinguishable and a quarter of the memory.
        return imageLayer(Circle().fill(color).frame(width: size, height: size).blur(radius: blur),
                          size: CGSize(width: side, height: side), center: center, scale: max(1, scale / 2))
    }

    /// Moves a layer from `a` to `b` and back as `drift` (0…1) does over `period`.
    static func drift(_ layer: CALayer, from a: CGPoint, to b: CGPoint, period: Double, _ drift: @escaping (Double) -> Double) {
        let at = { (t: Double) in CGPoint(x: a.x + (b.x - a.x) * drift(t), y: a.y + (b.y - a.y) * drift(t)) }
        layer.position = at(0)
        layer.add(animation("position", period: period, fps: 15) { NSValue(point: at($0)) }, forKey: "drift")
    }

    static func cgColor(_ color: Color) -> CGColor {
        let c = ReloEffectRenderer.resolve(color)
        return CGColor(srgbRed: CGFloat(c.x), green: CGFloat(c.y), blue: CGFloat(c.z), alpha: CGFloat(c.w))
    }
}

/// A looping Core Animation effect in SwiftUI. `key` names what it shows: a new key rebuilds the layers.
struct ReloLoopView<Key: Equatable>: NSViewRepresentable {
    let key: Key
    var live = true
    var still: TimeInterval = 0
    /// A view whose shape masks the effect (text a shine passes through), drawn once per size and key.
    var mask: AnyView?
    /// Added onto what is under it (plusLighter), as a light is.
    var additive = false
    let build: ReloLoopBuild
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.reloMotionPaused) private var motionPaused

    func makeNSView(context: Context) -> ReloLoopLayerView {
        let view = ReloLoopLayerView(still: still)
        if additive {
            view.layerUsesCoreImageFilters = true
            view.layer?.compositingFilter = CIFilter(name: "CIAdditionCompositing")
        }
        update(view)
        return view
    }

    func updateNSView(_ view: ReloLoopLayerView, context: Context) { update(view) }

    private func update(_ view: ReloLoopLayerView) {
        view.configure(key: key, build: build, mask: mask, live: live && !reduceMotion, holds: live && !reduceMotion,
                       hidden: motionPaused)
    }

    static func dismantleNSView(_ view: ReloLoopLayerView, coordinator: ()) { view.teardown() }
}

final class ReloLoopLayerView: NSView {
    private let timeline: ReloMotionTimeline
    private let root = CALayer()
    private var key: Any?
    private var keyMatches: ((Any?) -> Bool)?
    private var build: ReloLoopBuild?
    private var mask: AnyView?
    private var builtSize: CGSize = .zero
    private var live = true
    private var holds = true
    private var outOfSight = false
    private var observers: [NSObjectProtocol] = []
    private var watching = false

    init(still: TimeInterval) {
        timeline = ReloMotionTimeline(still: still)
        super.init(frame: .zero)
        wantsLayer = true
        layer?.addSublayer(root)
        root.speed = 0
        root.timeOffset = still
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override var isFlipped: Bool { true }
    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    func configure<Key: Equatable>(key: Key, build: @escaping ReloLoopBuild, mask: AnyView?, live: Bool, holds: Bool, hidden: Bool) {
        let changed = !(keyMatches?(key) ?? false)
        self.key = key
        keyMatches = { ($0 as? Key) == key }
        self.build = build
        self.mask = mask
        self.live = live
        self.holds = holds
        outOfSight = hidden
        if changed {
            if root.sublayers?.isEmpty == false {
                // What it shows changed (a new colour): fade into it, as the SwiftUI views animated it.
                let fade = CATransition()
                fade.type = .fade
                fade.duration = 0.26
                layer?.add(fade, forKey: "relo-key")
            }
            rebuild()
        }
        updateRunning()
    }

    func teardown() {
        observers.forEach(NotificationCenter.default.removeObserver)
        observers = []
    }

    override func layout() {
        super.layout()
        if bounds.size != builtSize { rebuild() }
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        teardown()
        if let window {
            observers.append(NotificationCenter.default.addObserver(forName: NSWindow.didChangeOcclusionStateNotification, object: window,
                                                                    queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.updateRunning() }
            })
            watchSignal()
        }
        updateRunning()
    }

    private func rebuild() {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        defer { CATransaction.commit() }
        builtSize = bounds.size
        root.frame = bounds
        root.sublayers?.forEach { $0.removeFromSuperlayer() }
        root.mask = nil
        guard bounds.width > 0, bounds.height > 0, let build else { return }
        root.contentsScale = window?.backingScaleFactor ?? 2
        build(root, bounds.size)
        if let mask, let image = Self.rasterise(mask, size: bounds.size, scale: window?.backingScaleFactor ?? 2) {
            let layer = CALayer()
            layer.frame = root.bounds
            layer.contents = image
            layer.contentsGravity = .resize
            root.mask = layer
        }
    }

    private static func rasterise(_ view: AnyView, size: CGSize, scale: CGFloat) -> CGImage? {
        let renderer = ImageRenderer(content: view.frame(width: size.width, height: size.height).environment(\.colorScheme, .dark))
        renderer.scale = scale
        return renderer.cgImage
    }

    /// Runs the root's clock while the effect can be seen; holds it, or shows the still frame, otherwise.
    private func updateRunning() {
        let visible = window?.occlusionState.contains(.visible) ?? false
        let running = live && !outOfSight && visible && !ReloMotionSignal.shared.paused
        let now = Date()
        if running {
            guard !timeline.running else { return }
            timeline.resume(at: now)
            let t = timeline.time(at: now)
            root.timeOffset = 0
            root.speed = 1
            root.beginTime = root.superlayer.map { $0.convertTime(CACurrentMediaTime(), from: nil) } ?? CACurrentMediaTime()
            root.beginTime -= t
        } else {
            timeline.stop(holding: holds, at: now)
            root.speed = 0
            root.timeOffset = timeline.time(at: now)
        }
    }

    private func watchSignal() {
        guard !watching else { return }
        watching = true
        withObservationTracking { _ = ReloMotionSignal.shared.paused } onChange: { [weak self] in
            DispatchQueue.main.async {
                guard let self else { return }
                self.watching = false
                self.updateRunning()
                if self.window != nil { self.watchSignal() }
            }
        }
    }
}
