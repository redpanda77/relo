//
//  ReloPaint.swift
//  Relo for Mac
//
//  What the effect painters draw with. The wings, the plan bar and the open light compute their motion in Swift once and
//  draw a handful of shapes through a sink: a SwiftUI Canvas (`GraphicsContextSink`, the reference the snapshot bench
//  pins) or the Metal renderer (`ReloEffectRenderer`), which draws the same shapes on the GPU without SwiftUI re-encoding
//  every path each frame. A sink is a value like GraphicsContext: copy it to clip, blend or fade a part.
//

import SwiftUI

enum ReloPaintBlend: Equatable { case normal, plusLighter }

/// How a shape is filled or stroked.
enum ReloShading {
    case color(Color)
    case linear(Gradient, start: CGPoint, end: CGPoint)
    case radial(Gradient, center: CGPoint, startRadius: CGFloat, endRadius: CGFloat)
}

/// A label the painters draw: a word or an SF Symbol, in one font and colour.
struct ReloPaintLabel: Hashable {
    enum Content: Hashable { case text(String), symbol(String) }

    var content: Content
    var size: CGFloat
    var weight: Font.Weight
    var rounded = false
    var color: Color

    #if DEBUG
    /// `--relo-bench-nolabels`: the bench leaves labels out of both renderers, so their parity gate covers shapes only.
    static let benchHidden = ProcessInfo.processInfo.arguments.contains("--relo-bench-nolabels")
    #else
    static let benchHidden = false
    #endif

    var text: Text {
        let font = Font.system(size: size, weight: weight, design: rounded ? .rounded : .default)
        return switch content {
        case .text(let string): Text(string).font(font).foregroundStyle(color)
        case .symbol(let name): Text(Image(systemName: name)).font(font).foregroundStyle(color)
        }
    }
}

/// The wings' light in one wing: a band of colour across it (from the outer edge toward the camera) faded by a vertical
/// mask, plus a pool in the outer corner, both moving with the slow noise (`noise` is its time; nil holds it off).
struct ReloWingLightSpec {
    var rect: CGRect
    var band: Gradient
    var bandFrom: CGPoint
    var bandTo: CGPoint
    var mask: Gradient
    var maskFrom: CGPoint
    var maskTo: CGPoint
    var pool: Gradient
    var poolCenter: CGPoint
    var poolRadius: CGFloat
    var canvas: CGSize
    var noise: Float?
}

protocol ReloPaintSink {
    /// Multiplies every later draw's alpha (each draw on its own, as GraphicsContext does).
    var opacity: Double { get set }
    var blend: ReloPaintBlend { get set }

    mutating func clip(rect: CGRect)
    mutating func clip(roundedRect: CGRect, cornerRadius: CGFloat)
    /// The notch's own black shape, as the sink was made with.
    mutating func clipToBody()
    mutating func translate(x: CGFloat, y: CGFloat)
    mutating func scale(x: CGFloat, y: CGFloat)

    func fillEllipse(_ rect: CGRect, _ shading: ReloShading)
    func strokeEllipse(_ rect: CGRect, _ color: Color, lineWidth: CGFloat)
    func fillRect(_ rect: CGRect, _ shading: ReloShading)
    func fillRoundedRect(_ rect: CGRect, cornerRadius: CGFloat, _ shading: ReloShading)
    /// A pill's hairline border: the outline of a 0.75 pt stroke, itself stroked 1 pt (as the chips always drew it).
    func pillBorder(_ rect: CGRect, cornerRadius: CGFloat, _ color: Color)
    /// A filled rounded rect with its own soft shadow in `shadow` (the bar's flashing step).
    func glowingRoundedRect(_ rect: CGRect, cornerRadius: CGFloat, _ color: Color, shadow: Color, radius: CGFloat)
    func strokeLines(_ points: [CGPoint], _ shading: ReloShading, lineWidth: CGFloat, round: Bool)
    /// An arc from `from` to `to` degrees (increasing clockwise on screen), as Path.addArc(clockwise: false) draws it.
    func strokeArc(center: CGPoint, radius: CGFloat, from: Double, to: Double, _ color: Color, lineWidth: CGFloat, round: Bool)
    /// A line blurred as a layer (`blur` is SwiftUI's blur radius).
    func blurredLines(_ points: [CGPoint], _ shading: ReloShading, lineWidth: CGFloat, blur: CGFloat)
    func wingLight(_ spec: ReloWingLightSpec)

    func measure(_ label: ReloPaintLabel) -> CGSize
    func draw(_ label: ReloPaintLabel, at point: CGPoint, anchor: UnitPoint)
    /// A template image from the asset catalogue, tinted.
    func drawTemplate(_ asset: String, tint: Color, in rect: CGRect)
}

extension ReloPaintSink {
    func disc(_ center: CGPoint, _ r: CGFloat, _ color: Color) {
        fillEllipse(CGRect(x: center.x - r, y: center.y - r, width: 2 * r, height: 2 * r), .color(color))
    }
}

// MARK: - SwiftUI Canvas

/// Draws into a SwiftUI Canvas: the reference look.
struct GraphicsContextSink: ReloPaintSink {
    var ctx: GraphicsContext
    var body: Path?

    var opacity: Double {
        get { ctx.opacity }
        set { ctx.opacity = newValue }
    }

    var blend: ReloPaintBlend {
        get { ctx.blendMode == .plusLighter ? .plusLighter : .normal }
        set { ctx.blendMode = newValue == .plusLighter ? .plusLighter : .normal }
    }

    mutating func clip(rect: CGRect) { ctx.clip(to: Path(rect)) }
    mutating func clip(roundedRect: CGRect, cornerRadius: CGFloat) { ctx.clip(to: Path(roundedRect: roundedRect, cornerRadius: cornerRadius)) }
    mutating func clipToBody() { if let body { ctx.clip(to: body) } }
    mutating func translate(x: CGFloat, y: CGFloat) { ctx.translateBy(x: x, y: y) }
    mutating func scale(x: CGFloat, y: CGFloat) { ctx.scaleBy(x: x, y: y) }

    private static func shading(_ shading: ReloShading) -> GraphicsContext.Shading {
        switch shading {
        case .color(let color): .color(color)
        case .linear(let gradient, let start, let end): .linearGradient(gradient, startPoint: start, endPoint: end)
        case .radial(let gradient, let center, let startRadius, let endRadius):
            .radialGradient(gradient, center: center, startRadius: startRadius, endRadius: endRadius)
        }
    }

    func fillEllipse(_ rect: CGRect, _ shading: ReloShading) { ctx.fill(Path(ellipseIn: rect), with: Self.shading(shading)) }
    func strokeEllipse(_ rect: CGRect, _ color: Color, lineWidth: CGFloat) {
        ctx.stroke(Path(ellipseIn: rect), with: .color(color), lineWidth: lineWidth)
    }
    func fillRect(_ rect: CGRect, _ shading: ReloShading) { ctx.fill(Path(rect), with: Self.shading(shading)) }
    func fillRoundedRect(_ rect: CGRect, cornerRadius: CGFloat, _ shading: ReloShading) {
        ctx.fill(Path(roundedRect: rect, cornerRadius: cornerRadius), with: Self.shading(shading))
    }
    func pillBorder(_ rect: CGRect, cornerRadius: CGFloat, _ color: Color) {
        ctx.stroke(Path(roundedRect: rect, cornerRadius: cornerRadius).strokedPath(StrokeStyle(lineWidth: 0.75)), with: .color(color))
    }
    func glowingRoundedRect(_ rect: CGRect, cornerRadius: CGFloat, _ color: Color, shadow: Color, radius: CGFloat) {
        ctx.drawLayer { layer in
            layer.addFilter(.shadow(color: shadow, radius: radius))
            layer.fill(Path(roundedRect: rect, cornerRadius: cornerRadius), with: .color(color))
        }
    }
    func strokeLines(_ points: [CGPoint], _ shading: ReloShading, lineWidth: CGFloat, round: Bool) {
        var path = Path()
        path.addLines(points)
        if round {
            ctx.stroke(path, with: Self.shading(shading), style: StrokeStyle(lineWidth: lineWidth, lineCap: .round, lineJoin: .round))
        } else {
            ctx.stroke(path, with: Self.shading(shading), lineWidth: lineWidth)
        }
    }
    func strokeArc(center: CGPoint, radius: CGFloat, from: Double, to: Double, _ color: Color, lineWidth: CGFloat, round: Bool) {
        var path = Path()
        path.addArc(center: center, radius: radius, startAngle: .degrees(from), endAngle: .degrees(to), clockwise: false)
        if round {
            ctx.stroke(path, with: .color(color), style: StrokeStyle(lineWidth: lineWidth, lineCap: .round))
        } else {
            ctx.stroke(path, with: .color(color), lineWidth: lineWidth)
        }
    }
    func blurredLines(_ points: [CGPoint], _ shading: ReloShading, lineWidth: CGFloat, blur: CGFloat) {
        var path = Path()
        path.addLines(points)
        ctx.drawLayer { layer in
            layer.addFilter(.blur(radius: blur))
            layer.stroke(path, with: Self.shading(shading), lineWidth: lineWidth)
        }
    }
    func wingLight(_ spec: ReloWingLightSpec) {
        var lit = ctx
        if let noise = spec.noise {
            lit.addFilter(.colorShader(ShaderLibrary.reloWingLight(.float2(Float(spec.canvas.width), Float(spec.canvas.height)), .float(noise))))
        }
        lit.drawLayer { layer in
            layer.fill(Path(spec.rect), with: .linearGradient(spec.band, startPoint: spec.bandFrom, endPoint: spec.bandTo))
            layer.blendMode = .destinationIn
            layer.fill(Path(spec.rect), with: .linearGradient(spec.mask, startPoint: spec.maskFrom, endPoint: spec.maskTo))
        }
        lit.fill(Path(spec.rect), with: .radialGradient(spec.pool, center: spec.poolCenter, startRadius: 0, endRadius: spec.poolRadius))
    }

    func measure(_ label: ReloPaintLabel) -> CGSize { ctx.resolve(label.text).measure(in: CGSize(width: 200, height: 40)) }
    func draw(_ label: ReloPaintLabel, at point: CGPoint, anchor: UnitPoint) {
        guard !ReloPaintLabel.benchHidden else { return }
        ctx.draw(ctx.resolve(label.text), at: point, anchor: anchor)
    }
    func drawTemplate(_ asset: String, tint: Color, in rect: CGRect) {
        guard !ReloPaintLabel.benchHidden else { return }
        var image = ctx.resolve(Image(asset).renderingMode(.template))
        image.shading = .color(tint)
        ctx.draw(image, in: rect)
    }
}
