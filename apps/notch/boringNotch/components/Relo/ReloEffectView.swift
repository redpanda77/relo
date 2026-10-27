//
//  ReloEffectView.swift
//  Relo for Mac
//
//  An effect painter on screen without SwiftUI redrawing it: a CAMetalLayer whose display link (30 fps by default) asks
//  the painter for this instant's shapes and draws them through ReloEffectRenderer. SwiftUI only hands it a new painter
//  when what it shows changes; nothing in the view hierarchy is evaluated per frame. It draws only while it can be seen:
//  paused, its window covered or the Mac asleep (ReloMotionSignal), it holds its last frame.
//

import AppKit
import SwiftUI

/// One frame being drawn: the painter asks for a sink (with the notch's shape when it clips to it) and paints into it.
/// `size` is the view's own; the layer reaches `outset` past it on every side, as a Canvas draws past its bounds.
final class ReloEffectCanvas {
    let size: CGSize
    let outset: CGFloat
    let now: Date
    /// The effect's own time (a ReloMotionTimeline's) for effects on the motion clock; else seconds since 2001.
    var time: TimeInterval
    let scale: CGFloat
    private let renderer: ReloEffectRenderer
    private(set) var recording: ReloEffectRecording?

    init(size: CGSize, outset: CGFloat = 0, now: Date, scale: CGFloat, renderer: ReloEffectRenderer) {
        self.size = size
        self.outset = outset
        self.now = now
        self.time = now.timeIntervalSinceReferenceDate
        self.scale = scale
        self.renderer = renderer
    }

    func sink(body: Path? = nil) -> ReloMetalSink {
        let recording = renderer.recording(size: CGSize(width: size.width + 2 * outset, height: size.height + 2 * outset), scale: scale,
                                           body: body?.offsetBy(dx: outset, dy: outset))
        self.recording = recording
        var sink = ReloMetalSink(recording)
        if outset != 0 { sink.translate(x: outset, y: outset) }
        return sink
    }
}

/// Whether the effects draw through Metal: `--relo-wings-canvas` keeps the SwiftUI Canvas, to compare the two.
enum ReloEffects {
    static let metal = ReloEffectRenderer.shared != nil && !ProcessInfo.processInfo.arguments.contains("--relo-wings-canvas")
    /// `--relo-bench-metal`: the snapshot bench draws the effects through Metal, to compare with the Canvas.
    static let bench = ProcessInfo.processInfo.arguments.contains("--relo-bench-metal")
}

/// An effect on the motion clock (ReloMotionClock's rules): `live` false or Reduce Motion shows the `still` frame; out of
/// sight it holds where it was.
struct ReloEffectMotion: Equatable {
    var live = true
    var still: TimeInterval = 0
}

struct ReloEffectView: View {
    var framesPerSecond: Float = 30
    /// How far past its frame it may draw (a glow or a blur reaching over the edge).
    var outset: CGFloat = 0
    /// Holds the frame (wall-clock effects): nothing moves.
    var paused = false
    /// Runs on the motion clock instead of the wall clock.
    var motion: ReloEffectMotion?
    /// Added onto what is under it (plusLighter), as a light is.
    var additive = false
    let paint: (ReloEffectCanvas) -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let still = motion.map { !$0.live || reduceMotion } ?? false
        ReloEffectLayer(framesPerSecond: framesPerSecond, outset: outset, paused: paused || still, motion: motion,
                        holds: motion.map { $0.live && !reduceMotion } ?? true, additive: additive, paint: paint)
            .padding(-outset)
    }
}

private struct ReloEffectLayer: NSViewRepresentable {
    var framesPerSecond: Float
    var outset: CGFloat
    /// Holds the frame: nothing moves (Reduce Motion, frozen, or the painter is still).
    var paused: Bool
    var motion: ReloEffectMotion?
    var holds: Bool
    var additive: Bool
    let paint: (ReloEffectCanvas) -> Void
    @Environment(\.reloMotionPaused) private var motionPaused

    func makeNSView(context: Context) -> ReloEffectLayerView {
        let view = ReloEffectLayerView()
        if additive {
            view.layerUsesCoreImageFilters = true
            view.layer?.compositingFilter = CIFilter(name: "CIAdditionCompositing")
        }
        view.timeline = motion.map { ReloMotionTimeline(still: $0.still) }
        view.holds = holds
        view.outset = outset
        view.framesPerSecond = framesPerSecond
        view.paint = paint
        view.paused = paused || motionPaused
        return view
    }

    func updateNSView(_ view: ReloEffectLayerView, context: Context) {
        if let motion, view.timeline?.still != motion.still { view.timeline = ReloMotionTimeline(still: motion.still) }
        view.holds = holds
        view.outset = outset
        view.framesPerSecond = framesPerSecond
        view.paint = paint
        view.paused = paused || motionPaused
        view.redraw()
    }

    static func dismantleNSView(_ view: ReloEffectLayerView, coordinator: ()) { view.stop() }
}

final class ReloEffectLayerView: NSView {
    var paint: ((ReloEffectCanvas) -> Void)?
    var outset: CGFloat = 0
    /// The motion clock, for effects on it.
    var timeline: ReloMotionTimeline?
    /// Stopping holds the frame (only out of sight) rather than returning to the still one.
    var holds = true
    var framesPerSecond: Float = 30 {
        didSet { if framesPerSecond != oldValue { link?.preferredFrameRateRange = Self.range(framesPerSecond) } }
    }
    var paused = false {
        didSet { if paused != oldValue { updateRunning() } }
    }

    private var link: CADisplayLink?
    private var observers: [NSObjectProtocol] = []
    private var signalWatch: Bool = false
    private var metalLayer: CAMetalLayer { layer as! CAMetalLayer }

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layerContentsRedrawPolicy = .never
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override func makeBackingLayer() -> CALayer {
        let layer = CAMetalLayer()
        layer.device = ReloEffectRenderer.shared?.device
        layer.pixelFormat = .bgra8Unorm
        layer.colorspace = CGColorSpace(name: CGColorSpace.sRGB)
        layer.isOpaque = false
        layer.framebufferOnly = true
        layer.backgroundColor = .clear
        return layer
    }

    override func hitTest(_ point: NSPoint) -> NSView? { nil }
    override var isFlipped: Bool { true }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        observers.forEach(NotificationCenter.default.removeObserver)
        observers = []
        guard let window else { stop(); return }
        observers.append(NotificationCenter.default.addObserver(forName: NSWindow.didChangeOcclusionStateNotification, object: window,
                                                                queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.updateRunning() }
        })
        observers.append(NotificationCenter.default.addObserver(forName: NSWindow.didChangeBackingPropertiesNotification, object: window,
                                                                queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.layoutDrawable() }
        })
        if link == nil {
            let link = displayLink(target: self, selector: #selector(tick))
            link.preferredFrameRateRange = Self.range(framesPerSecond)
            link.add(to: .main, forMode: .common)
            self.link = link
        }
        watchSignal()
        layoutDrawable()
        updateRunning()
    }

    override func layout() {
        super.layout()
        layoutDrawable()
    }

    func stop() {
        link?.invalidate()
        link = nil
        observers.forEach(NotificationCenter.default.removeObserver)
        observers = []
    }

    /// Draws now, whatever the clock: a new painter or size while the frame is held.
    func redraw() {
        if link?.isPaused ?? true { draw(at: Date()) }
    }

    private static func range(_ fps: Float) -> CAFrameRateRange { CAFrameRateRange(minimum: fps / 2, maximum: fps, preferred: fps) }

    private var visible: Bool { window?.occlusionState.contains(.visible) ?? false }

    private func updateRunning() {
        let running = !paused && visible && !ReloMotionSignal.shared.paused
        link?.isPaused = !running
        if let timeline {
            if running { timeline.resume() } else { timeline.stop(holding: holds) }
        }
        if !running { redraw() }
    }

    /// Follows the app-wide pause (displays asleep, screen locked, Low Power Mode, a hot Mac).
    private func watchSignal() {
        guard !signalWatch else { return }
        signalWatch = true
        withObservationTracking { _ = ReloMotionSignal.shared.paused } onChange: { [weak self] in
            DispatchQueue.main.async {
                guard let self else { return }
                self.signalWatch = false
                self.updateRunning()
                if self.window != nil { self.watchSignal() }
            }
        }
    }

    private func layoutDrawable() {
        let scale = window?.backingScaleFactor ?? NSScreen.main?.backingScaleFactor ?? 2
        metalLayer.contentsScale = scale
        let size = CGSize(width: max(1, bounds.width * scale), height: max(1, bounds.height * scale))
        if metalLayer.drawableSize != size {
            metalLayer.drawableSize = size
            draw(at: Date())
        }
    }

    @objc private func tick(_ link: CADisplayLink) { draw(at: Date()) }

    private func draw(at now: Date) {
        guard let renderer = ReloEffectRenderer.shared, let paint, bounds.width > 0, bounds.height > 0, window != nil else { return }
        let inner = CGSize(width: max(0, bounds.width - 2 * outset), height: max(0, bounds.height - 2 * outset))
        let canvas = ReloEffectCanvas(size: inner, outset: outset, now: now, scale: metalLayer.contentsScale, renderer: renderer)
        if let timeline { canvas.time = timeline.time(at: now) }
        paint(canvas)
        // A painter that drew nothing still clears the last frame.
        let recording = canvas.recording ?? renderer.recording(size: bounds.size, scale: metalLayer.contentsScale)
        guard let drawable = metalLayer.nextDrawable(),
              let commands = renderer.queue.makeCommandBuffer() else { return }
        renderer.encode(recording, into: drawable.texture, commands: commands)
        commands.present(drawable)
        commands.commit()
    }
}
