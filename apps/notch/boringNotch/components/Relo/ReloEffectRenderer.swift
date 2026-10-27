//
//  ReloEffectRenderer.swift
//  Relo for Mac
//
//  The effect painters on the GPU. `ReloMetalSink` records what a painter draws as instanced quads (ReloEffects.metal
//  works out each one's coverage, shading and clips), and `ReloEffectRenderer` draws a recording into a CAMetalLayer's
//  drawable or, for the snapshot bench, into an image. Labels and logos are rasterised once and drawn as textures; the
//  notch's own shape is a mask texture made once per size.
//

import AppKit
import Metal
import SwiftUI

/// One shape, as ReloEffects.metal reads it (`Quad`, field for field).
struct ReloEffectQuad {
    var rect = SIMD4<Float>()
    var m = SIMD4<Float>(1, 0, 0, 1)
    var t = SIMD4<Float>(0, 0, 1, 1)
    var shape = SIMD4<Float>()
    var p = SIMD4<Float>(0, 0, 0, -1)
    var k = SIMD4<UInt32>()
    var line = SIMD4<UInt32>()
    var clip = SIMD4<Float>()
    var rclip = SIMD4<Float>()
    var rclipR = SIMD4<Float>()
    var g = SIMD4<Float>()
    var colors = (SIMD4<Float>(), SIMD4<Float>(), SIMD4<Float>(), SIMD4<Float>(),
                  SIMD4<Float>(), SIMD4<Float>(), SIMD4<Float>(), SIMD4<Float>())
    var locs0 = SIMD4<Float>()
    var locs1 = SIMD4<Float>()
    var g2 = SIMD4<Float>()
    var maskA = SIMD4<Float>()
    var g3 = SIMD4<Float>()

    enum Kind: UInt32 { case ellipseFill, ellipseStroke, roundedRectFill, pillBorder, glowRect, lines, blurredLines, wingLight, texture, arc }

    subscript(color i: Int) -> SIMD4<Float> {
        get { withUnsafeBytes(of: colors) { $0.load(fromByteOffset: i * 16, as: SIMD4<Float>.self) } }
        set { withUnsafeMutableBytes(of: &colors) { $0.storeBytes(of: newValue, toByteOffset: i * 16, as: SIMD4<Float>.self) } }
    }
}

/// What one painter drew this frame, in order. Recorded and drawn on the main thread.
final class ReloEffectRecording {
    struct Run {
        var blend: ReloPaintBlend
        var texture: MTLTexture?
        var range: Range<Int>
    }

    let renderer: ReloEffectRenderer
    let size: CGSize
    let scale: CGFloat
    let body: Path?
    private(set) var quads: [ReloEffectQuad] = []
    private(set) var points: [SIMD2<Float>] = []
    private(set) var runs: [Run] = []
    /// Drawn after the shapes: an effect with its own pipeline (the orb).
    var custom: ((MTLRenderCommandEncoder) -> Void)?

    init(renderer: ReloEffectRenderer, size: CGSize, scale: CGFloat, body: Path?) {
        self.renderer = renderer
        self.size = size
        self.scale = scale
        self.body = body
    }

    func add(_ quad: ReloEffectQuad, blend: ReloPaintBlend, texture: MTLTexture? = nil) {
        if let last = runs.last, last.blend == blend, last.texture === texture, last.range.upperBound == quads.count {
            runs[runs.count - 1].range = last.range.lowerBound..<(quads.count + 1)
        } else {
            runs.append(Run(blend: blend, texture: texture, range: quads.count..<(quads.count + 1)))
        }
        quads.append(quad)
    }

    func add(points new: [CGPoint]) -> SIMD4<UInt32> {
        let first = UInt32(points.count)
        points += new.map { SIMD2(Float($0.x), Float($0.y)) }
        return SIMD4(first, UInt32(new.count), 0, 0)
    }
}

// MARK: - The sink

/// Records a painter's shapes for the GPU. A copy carries its own clips, blend, opacity and transform, as
/// GraphicsContext does.
struct ReloMetalSink: ReloPaintSink {
    let recording: ReloEffectRecording
    var opacity: Double = 1
    var blend: ReloPaintBlend = .normal
    private var clipRect = CGRect(x: -1e5, y: -1e5, width: 2e5, height: 2e5)
    private var roundedClip: (rect: CGRect, radius: CGFloat)?
    private var bodyClip = false
    private var transform = CGAffineTransform.identity

    init(_ recording: ReloEffectRecording) { self.recording = recording }

    mutating func clip(rect: CGRect) { clipRect = clipRect.intersection(rect.applying(transform)) }
    mutating func clip(roundedRect: CGRect, cornerRadius: CGFloat) {
        roundedClip = (roundedRect.applying(transform), cornerRadius)
    }
    mutating func clipToBody() { bodyClip = recording.body != nil }
    mutating func translate(x: CGFloat, y: CGFloat) { transform = CGAffineTransform(translationX: x, y: y).concatenating(transform) }
    mutating func scale(x: CGFloat, y: CGFloat) { transform = CGAffineTransform(scaleX: x, y: y).concatenating(transform) }

    // MARK: Shapes

    func fillEllipse(_ rect: CGRect, _ shading: ReloShading) { shape(.ellipseFill, rect, shading) }
    func strokeEllipse(_ rect: CGRect, _ color: Color, lineWidth: CGFloat) {
        shape(.ellipseStroke, rect, .color(color), lineWidth: lineWidth, margin: lineWidth / 2)
    }
    func fillRect(_ rect: CGRect, _ shading: ReloShading) { shape(.roundedRectFill, rect, shading) }
    func fillRoundedRect(_ rect: CGRect, cornerRadius: CGFloat, _ shading: ReloShading) {
        shape(.roundedRectFill, rect, shading, radius: cornerRadius)
    }
    func pillBorder(_ rect: CGRect, cornerRadius: CGFloat, _ color: Color) {
        shape(.pillBorder, rect, .color(color), radius: cornerRadius, margin: 1)
    }
    func glowingRoundedRect(_ rect: CGRect, cornerRadius: CGFloat, _ color: Color, shadow: Color, radius: CGFloat) {
        let sigma = ReloEffectRenderer.sigma(forShadowRadius: radius)
        var quad = base(.glowRect, rect, radius: cornerRadius, margin: 3 * sigma)
        quad.p.z = Float(sigma)
        quad[color: 0] = Self.rgba(color)
        quad[color: 1] = Self.rgba(shadow)
        emit(quad)
    }
    func strokeLines(_ points: [CGPoint], _ shading: ReloShading, lineWidth: CGFloat, round: Bool) {
        guard points.count > 1 else { return }
        var quad = base(.lines, Self.bounds(points), margin: lineWidth / 2)
        quad.p.y = Float(lineWidth)
        if !round { quad.k.z |= 4 }
        quad.line = recording.add(points: points)
        Self.apply(shading, to: &quad)
        emit(quad)
    }
    func strokeArc(center: CGPoint, radius: CGFloat, from: Double, to: Double, _ color: Color, lineWidth: CGFloat, round: Bool) {
        let r = radius + lineWidth / 2
        var quad = base(.arc, CGRect(x: center.x - r, y: center.y - r, width: 2 * r, height: 2 * r))
        quad.shape = SIMD4(Float(center.x), Float(center.y), Float(radius), 0)
        quad.p = SIMD4(0, Float(lineWidth), Float(from * .pi / 180), Float(to * .pi / 180))
        if !round { quad.k.z |= 4 }
        Self.apply(.color(color), to: &quad)
        emit(quad)
    }
    func blurredLines(_ points: [CGPoint], _ shading: ReloShading, lineWidth: CGFloat, blur: CGFloat) {
        guard points.count > 1 else { return }
        let sigma = ReloEffectRenderer.sigma(forBlurRadius: blur)
        var quad = base(.blurredLines, Self.bounds(points), margin: lineWidth / 2 + 3 * sigma)
        quad.p.y = Float(lineWidth)
        quad.p.z = Float(sigma)
        quad.line = recording.add(points: points)
        Self.apply(shading, to: &quad)
        emit(quad)
    }
    func wingLight(_ spec: ReloWingLightSpec) {
        var quad = base(.wingLight, spec.rect)
        quad.p = SIMD4(Float(spec.canvas.width), Float(spec.canvas.height), 0, spec.noise ?? -1)
        let band = spec.band.stops, pool = spec.pool.stops, mask = spec.mask.stops
        quad.g = Self.vector(spec.bandFrom, spec.bandTo)
        for (i, stop) in band.prefix(4).enumerated() {
            quad[color: i] = Self.rgba(stop.color)
            quad.locs0[i] = Float(stop.location)
        }
        quad.g3 = SIMD4(Float(spec.poolCenter.x), Float(spec.poolCenter.y), 0, Float(spec.poolRadius))
        for (i, stop) in pool.prefix(3).enumerated() {
            quad[color: 4 + i] = Self.rgba(stop.color)
            quad.locs1[i] = Float(stop.location)
        }
        quad.g2 = Self.vector(spec.maskFrom, spec.maskTo)
        if let a = mask.first, let b = mask.last {
            quad.maskA = SIMD4(Self.rgba(a.color).w, Self.rgba(b.color).w, Float(a.location), Float(b.location))
        }
        emit(quad)
    }

    // MARK: Labels and images

    func measure(_ label: ReloPaintLabel) -> CGSize { recording.renderer.measure(label, scale: recording.scale) }

    func draw(_ label: ReloPaintLabel, at point: CGPoint, anchor: UnitPoint) {
        let color = Self.rgba(label.color)
        guard color.w > 0, !ReloPaintLabel.benchHidden, let image = recording.renderer.texture(for: label, scale: recording.scale) else { return }
        let size = measure(label)
        let origin = CGPoint(x: point.x - anchor.x * size.width, y: point.y - anchor.y * size.height)
        texture(image, origin: origin, alpha: Double(color.w))
    }

    func drawTemplate(_ asset: String, tint: Color, in rect: CGRect) {
        let color = Self.rgba(tint)
        guard color.w > 0, !ReloPaintLabel.benchHidden,
              let image = recording.renderer.texture(template: asset, tint: tint, size: rect.size, scale: recording.scale) else { return }
        texture(image, origin: rect.origin, alpha: Double(color.w))
    }

    private func texture(_ image: ReloEffectRenderer.Texture, origin: CGPoint, alpha: Double) {
        var origin = origin
        if transform.a == 1, transform.d == 1, transform.b == 0, transform.c == 0 {
            // Unscaled: on whole pixels, so the label stays as sharp as it was rasterised.
            let s = recording.scale
            origin.x = ((origin.x + transform.tx) * s).rounded() / s - transform.tx
            origin.y = ((origin.y + transform.ty) * s).rounded() / s - transform.ty
        }
        let rect = CGRect(origin: origin, size: image.size)
        var quad = base(.texture, rect, margin: 0)
        quad.t.w *= Float(alpha)
        recording.add(quad, blend: blend, texture: image.texture)
    }

    // MARK: Building quads

    private func shape(_ kind: ReloEffectQuad.Kind, _ rect: CGRect, _ shading: ReloShading, radius: CGFloat = 0, lineWidth: CGFloat = 0,
                       margin: CGFloat = 0) {
        var quad = base(kind, rect, radius: radius, margin: margin)
        quad.p.y = Float(lineWidth)
        Self.apply(shading, to: &quad)
        emit(quad)
    }

    /// A quad over `rect` (local), widened by `margin` and a pixel and a half for the edge's antialiasing.
    private func base(_ kind: ReloEffectQuad.Kind, _ rect: CGRect, radius: CGFloat = 0, margin: CGFloat = 0) -> ReloEffectQuad {
        let det = abs(transform.a * transform.d - transform.b * transform.c)
        let pixels = recording.scale * max(1e-3, det.squareRoot())
        let aa = kind == .texture ? 0 : 1.5 / pixels
        let cover = rect.insetBy(dx: -(margin + aa), dy: -(margin + aa))
        var quad = ReloEffectQuad()
        quad.rect = SIMD4(Float(cover.minX), Float(cover.minY), Float(cover.width), Float(cover.height))
        quad.m = SIMD4(Float(transform.a), Float(transform.b), Float(transform.c), Float(transform.d))
        quad.t = SIMD4(Float(transform.tx), Float(transform.ty), Float(pixels), Float(min(1, max(0, opacity))))
        quad.shape = SIMD4(Float(rect.minX), Float(rect.minY), Float(rect.width), Float(rect.height))
        quad.p.x = Float(radius)
        quad.k.x = kind.rawValue
        let clip = clipRect.isNull ? .zero : clipRect
        quad.clip = SIMD4(Float(clip.minX), Float(clip.minY), Float(clip.maxX), Float(clip.maxY))
        if let roundedClip {
            quad.k.z |= 2
            let r = roundedClip.rect
            quad.rclip = SIMD4(Float(r.minX), Float(r.minY), Float(r.width), Float(r.height))
            quad.rclipR.x = Float(roundedClip.radius)
        }
        if bodyClip { quad.k.z |= 1 }
        quad.rclipR.y = Float(recording.size.width)
        quad.rclipR.z = Float(recording.size.height)
        quad.rclipR.w = Float(recording.scale)
        return quad
    }

    private func emit(_ quad: ReloEffectQuad) {
        guard quad.t.w > 0, !clipRect.isNull else { return }
        recording.add(quad, blend: blend)
    }

    private static func apply(_ shading: ReloShading, to quad: inout ReloEffectQuad) {
        let stops: [Gradient.Stop]
        switch shading {
        case .color(let color):
            quad.k.y = 0
            quad[color: 0] = rgba(color)
            quad.k.w = 1
            return
        case .linear(let gradient, let start, let end):
            quad.k.y = 1
            quad.g = vector(start, end)
            stops = gradient.stops
        case .radial(let gradient, let center, let startRadius, let endRadius):
            quad.k.y = 2
            quad.g = SIMD4(Float(center.x), Float(center.y), Float(startRadius), Float(endRadius))
            stops = gradient.stops
        }
        quad.k.w = UInt32(min(4, stops.count))
        for (i, stop) in stops.prefix(4).enumerated() {
            quad[color: i] = rgba(stop.color)
            quad.locs0[i] = Float(stop.location)
        }
    }

    private static func vector(_ a: CGPoint, _ b: CGPoint) -> SIMD4<Float> { SIMD4(Float(a.x), Float(a.y), Float(b.x), Float(b.y)) }

    private static func bounds(_ points: [CGPoint]) -> CGRect {
        var minX = CGFloat.infinity, minY = CGFloat.infinity, maxX = -CGFloat.infinity, maxY = -CGFloat.infinity
        for p in points {
            minX = min(minX, p.x); minY = min(minY, p.y); maxX = max(maxX, p.x); maxY = max(maxY, p.y)
        }
        return CGRect(x: minX, y: minY, width: maxX - minX, height: maxY - minY)
    }

    static func rgba(_ color: Color) -> SIMD4<Float> { ReloEffectRenderer.resolve(color) }
}

// MARK: - The renderer

/// Used on the main thread only (labels rasterise through SwiftUI).
final class ReloEffectRenderer: @unchecked Sendable {
    /// Nil on a Mac without Metal (none Relo supports), or if the library fails to load: the Canvas draws instead.
    static let shared = ReloEffectRenderer()

    struct Texture {
        let texture: MTLTexture
        /// In points.
        let size: CGSize
    }

    let device: MTLDevice
    let queue: MTLCommandQueue
    private let over: MTLRenderPipelineState
    private let add: MTLRenderPipelineState
    private let blank: MTLTexture
    private var labels: [String: Texture] = [:]
    private var measures: [ReloPaintLabel: [CGFloat: CGSize]] = [:]
    private var masks: [String: MTLTexture] = [:]

    private init?() {
        guard let device = MTLCreateSystemDefaultDevice(), let queue = device.makeCommandQueue(),
              let library = device.makeDefaultLibrary(),
              let vertex = library.makeFunction(name: "reloEffectVertex"),
              let fragment = library.makeFunction(name: "reloEffectFragment") else { return nil }
        func pipeline(additive: Bool) -> MTLRenderPipelineState? {
            let descriptor = MTLRenderPipelineDescriptor()
            descriptor.vertexFunction = vertex
            descriptor.fragmentFunction = fragment
            let attachment = descriptor.colorAttachments[0]!
            attachment.pixelFormat = .bgra8Unorm
            attachment.isBlendingEnabled = true
            attachment.sourceRGBBlendFactor = .one
            attachment.sourceAlphaBlendFactor = .one
            attachment.destinationRGBBlendFactor = additive ? .one : .oneMinusSourceAlpha
            attachment.destinationAlphaBlendFactor = additive ? .one : .oneMinusSourceAlpha
            return try? device.makeRenderPipelineState(descriptor: descriptor)
        }
        let blankDescriptor = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .bgra8Unorm, width: 1, height: 1, mipmapped: false)
        guard let over = pipeline(additive: false), let add = pipeline(additive: true),
              let blank = device.makeTexture(descriptor: blankDescriptor) else { return nil }
        assert(MemoryLayout<ReloEffectQuad>.stride == 384, "ReloEffectQuad must match Quad in ReloEffects.metal")
        self.device = device
        self.queue = queue
        self.over = over
        self.add = add
        self.blank = blank
    }

    // MARK: The orb

    /// ReloOrbUniforms in ReloPlasmaOrb.metal.
    struct OrbUniforms {
        var rect: SIMD4<Float>
        var canvas: SIMD2<Float>
        var time: Float
        var energy: Float
        var colors: (SIMD4<Float>, SIMD4<Float>, SIMD4<Float>, SIMD4<Float>)
        var weights: SIMD4<Float>
    }

    private lazy var orbPipeline: MTLRenderPipelineState? = {
        guard let library = device.makeDefaultLibrary(), let vertex = library.makeFunction(name: "reloOrbVertex"),
              let fragment = library.makeFunction(name: "reloOrbFragment"),
              let plasma = library.makeFunction(name: "reloPlasmaOrb") else { return nil }
        let descriptor = MTLRenderPipelineDescriptor()
        descriptor.vertexFunction = vertex
        descriptor.fragmentFunction = fragment
        // The plasma is SwiftUI's stitchable shader, a visible function: the pipeline links it.
        let linked = MTLLinkedFunctions()
        linked.functions = [plasma]
        descriptor.fragmentLinkedFunctions = linked
        let attachment = descriptor.colorAttachments[0]!
        attachment.pixelFormat = .bgra8Unorm
        attachment.isBlendingEnabled = true
        attachment.sourceRGBBlendFactor = .one
        attachment.sourceAlphaBlendFactor = .one
        attachment.destinationRGBBlendFactor = .oneMinusSourceAlpha
        attachment.destinationAlphaBlendFactor = .oneMinusSourceAlpha
        return try? device.makeRenderPipelineState(descriptor: descriptor)
    }()

    /// The plasma orb over `rect`, with its palette (up to four colours) and energy, at `time`.
    func orb(in recording: ReloEffectRecording, rect: CGRect, time: Double, energy: Double, palette: [Color]) {
        guard let pipeline = orbPipeline, !palette.isEmpty else { return }
        let c = palette.map(Self.resolve)
        var uniforms = OrbUniforms(rect: SIMD4(Float(rect.minX), Float(rect.minY), Float(rect.width), Float(rect.height)),
                                   canvas: SIMD2(Float(recording.size.width), Float(recording.size.height)),
                                   time: Float(time), energy: Float(energy),
                                   colors: (c[0], c[min(1, c.count - 1)], c[min(2, c.count - 1)], c[min(3, c.count - 1)]),
                                   weights: SIMD4(0.34, 0.67, 0.9, 1))
        recording.custom = { encoder in
            encoder.setRenderPipelineState(pipeline)
            encoder.setVertexBytes(&uniforms, length: MemoryLayout<OrbUniforms>.stride, index: 0)
            encoder.setFragmentBytes(&uniforms, length: MemoryLayout<OrbUniforms>.stride, index: 0)
            encoder.drawPrimitives(type: .triangleStrip, vertexStart: 0, vertexCount: 4)
        }
    }

    /// The snapshot bench renders at 3x.
    static let benchScale: CGFloat = 3

    /// SwiftUI's blur radius as a Gaussian's sigma (fitted on the snapshot bench).
    nonisolated static func sigma(forBlurRadius radius: CGFloat) -> CGFloat { radius * 0.88 }
    /// A drop shadow's radius as a Gaussian's sigma (fitted on the snapshot bench).
    nonisolated static func sigma(forShadowRadius radius: CGFloat) -> CGFloat { radius }

    // MARK: Colours

    nonisolated(unsafe) private static let environment = EnvironmentValues()
    nonisolated(unsafe) private static var resolved: [Color: SIMD4<Float>] = [:]

    /// A colour as straight sRGB with alpha, cached (painters use a few colours at many opacities).
    static func resolve(_ color: Color) -> SIMD4<Float> {
        if let hit = resolved[color] { return hit }
        let r = color.resolve(in: environment)
        let value = SIMD4(r.red, r.green, r.blue, r.opacity)
        if resolved.count > 4096 { resolved.removeAll(keepingCapacity: true) }
        resolved[color] = value
        return value
    }

    // MARK: Drawing

    func recording(size: CGSize, scale: CGFloat, body: Path? = nil) -> ReloEffectRecording {
        ReloEffectRecording(renderer: self, size: size, scale: scale, body: body)
    }

    /// Draws a recording into `target`, cleared first.
    func encode(_ recording: ReloEffectRecording, into target: MTLTexture, commands: MTLCommandBuffer) {
        let pass = MTLRenderPassDescriptor()
        pass.colorAttachments[0].texture = target
        pass.colorAttachments[0].loadAction = .clear
        pass.colorAttachments[0].clearColor = MTLClearColor(red: 0, green: 0, blue: 0, alpha: 0)
        pass.colorAttachments[0].storeAction = .store
        guard let encoder = commands.makeRenderCommandEncoder(descriptor: pass) else { return }
        defer {
            recording.custom?(encoder)
            encoder.endEncoding()
        }
        let quads = recording.quads
        guard !quads.isEmpty,
              let quadBuffer = quads.withUnsafeBytes({ device.makeBuffer(bytes: $0.baseAddress!, length: $0.count, options: .storageModeShared) })
        else { return }
        var points = recording.points
        if points.isEmpty { points = [.zero] }
        guard let pointBuffer = points.withUnsafeBytes({ device.makeBuffer(bytes: $0.baseAddress!, length: $0.count, options: .storageModeShared) })
        else { return }
        var canvas = SIMD2(Float(recording.size.width), Float(recording.size.height))
        encoder.setVertexBuffer(quadBuffer, offset: 0, index: 0)
        encoder.setVertexBytes(&canvas, length: MemoryLayout<SIMD2<Float>>.stride, index: 1)
        encoder.setFragmentBuffer(quadBuffer, offset: 0, index: 0)
        encoder.setFragmentBuffer(pointBuffer, offset: 0, index: 1)
        encoder.setFragmentTexture(bodyMask(recording) ?? blank, index: 1)
        var current: ReloPaintBlend?
        for run in recording.runs {
            if run.blend != current {
                encoder.setRenderPipelineState(run.blend == .plusLighter ? add : over)
                current = run.blend
            }
            encoder.setFragmentTexture(run.texture ?? blank, index: 0)
            encoder.drawPrimitives(type: .triangleStrip, vertexStart: 0, vertexCount: 4, instanceCount: run.range.count,
                                   baseInstance: run.range.lowerBound)
        }
    }

    /// A recording as an image, for the snapshot bench.
    func image(_ recording: ReloEffectRecording) -> CGImage? {
        let width = Int((recording.size.width * recording.scale).rounded()), height = Int((recording.size.height * recording.scale).rounded())
        guard width > 0, height > 0 else { return nil }
        let descriptor = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .bgra8Unorm, width: width, height: height, mipmapped: false)
        descriptor.usage = [.renderTarget, .shaderRead]
        descriptor.storageMode = .shared
        guard let target = device.makeTexture(descriptor: descriptor), let commands = queue.makeCommandBuffer() else { return nil }
        encode(recording, into: target, commands: commands)
        commands.commit()
        commands.waitUntilCompleted()
        var bytes = [UInt8](repeating: 0, count: width * height * 4)
        target.getBytes(&bytes, bytesPerRow: width * 4, from: MTLRegionMake2D(0, 0, width, height), mipmapLevel: 0)
        guard let space = CGColorSpace(name: CGColorSpace.sRGB),
              let context = CGContext(data: &bytes, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4, space: space,
                                      bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)
        else { return nil }
        return context.makeImage()
    }

    // MARK: Textures

    /// The notch's shape as a coverage mask, once per size.
    private func bodyMask(_ recording: ReloEffectRecording) -> MTLTexture? {
        guard let body = recording.body else { return nil }
        let width = Int((recording.size.width * recording.scale).rounded()), height = Int((recording.size.height * recording.scale).rounded())
        let key = "\(width)x\(height)@\(recording.scale):\(body.boundingRect)"
        if let hit = masks[key] { return hit }
        guard width > 0, height > 0,
              let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width,
                                      space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue) else { return nil }
        context.translateBy(x: 0, y: CGFloat(height))
        context.scaleBy(x: recording.scale, y: -recording.scale)
        context.addPath(body.cgPath)
        context.setFillColor(gray: 1, alpha: 1)
        context.fillPath()
        let descriptor = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .r8Unorm, width: width, height: height, mipmapped: false)
        guard let texture = device.makeTexture(descriptor: descriptor), let data = context.data else { return nil }
        texture.replace(region: MTLRegionMake2D(0, 0, width, height), mipmapLevel: 0, withBytes: data, bytesPerRow: width)
        if masks.count > 8 { masks.removeAll() }
        masks[key] = texture
        return texture
    }

    /// A label's size, as GraphicsContext measures it: rounded up to the canvas's pixels.
    func measure(_ label: ReloPaintLabel, scale: CGFloat) -> CGSize {
        var key = label
        key.color = .white
        if let hit = measures[key]?[scale] { return hit }
        // Measured the way the Canvas does, by a Canvas: a hosting view's fitting size differs by a fraction.
        let size = MainActor.assumeIsolated { () -> CGSize in
            var measured = CGSize.zero
            let text = key.text
            let renderer = ImageRenderer(content: Canvas { context, _ in
                measured = context.resolve(text).measure(in: CGSize(width: 200, height: 40))
            }.frame(width: 1, height: 1))
            renderer.scale = scale
            _ = renderer.cgImage
            return measured
        }
        measures[key, default: [:]][scale] = size
        return size
    }

    /// A label drawn once at full opacity (its opacity is applied when it is drawn).
    func texture(for label: ReloPaintLabel, scale: CGFloat) -> Texture? {
        let c = Self.resolve(label.color)
        var opaque = label
        opaque.color = Color(.sRGB, red: Double(c.x), green: Double(c.y), blue: Double(c.z))
        let key = "label:\(label.content):\(label.size):\(label.weight):\(label.rounded):\(c.x),\(c.y),\(c.z)@\(scale)"
        if let hit = labels[key] { return hit }
        return rasterise(key, opaque.text.fixedSize(), scale: scale)
    }

    func texture(template asset: String, tint: Color, size: CGSize, scale: CGFloat) -> Texture? {
        let c = Self.resolve(tint)
        let key = "template:\(asset):\(size.width)x\(size.height):\(c.x),\(c.y),\(c.z)@\(scale)"
        if let hit = labels[key] { return hit }
        let image = Image(asset).renderingMode(.template).resizable()
            .foregroundStyle(Color(.sRGB, red: Double(c.x), green: Double(c.y), blue: Double(c.z)))
            .frame(width: size.width, height: size.height)
        return rasterise(key, image, scale: scale)
    }

    private func rasterise(_ key: String, _ view: some View, scale: CGFloat) -> Texture? {
        let rendered = MainActor.assumeIsolated { () -> CGImage? in
            let renderer = ImageRenderer(content: view.environment(\.colorScheme, .dark))
            renderer.scale = scale
            return renderer.cgImage
        }
        guard let image = rendered else { return nil }
        let width = image.width, height = image.height
        var bytes = [UInt8](repeating: 0, count: width * height * 4)
        guard let space = CGColorSpace(name: CGColorSpace.sRGB),
              let context = CGContext(data: &bytes, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4, space: space,
                                      bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)
        else { return nil }
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        let descriptor = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .bgra8Unorm, width: width, height: height, mipmapped: false)
        guard let texture = device.makeTexture(descriptor: descriptor) else { return nil }
        texture.replace(region: MTLRegionMake2D(0, 0, width, height), mipmapLevel: 0, withBytes: bytes, bytesPerRow: width * 4)
        let result = Texture(texture: texture, size: CGSize(width: CGFloat(width) / scale, height: CGFloat(height) / scale))
        if labels.count > 256 { labels.removeAll() }
        labels[key] = result
        return result
    }
}
