//
//  ReloOrbitWings.swift
//  Relo Notch
//
//  The closed notch's wings as one canvas over the closed notch (Orbit, approved on the Notch Wing Studies page). Left:
//  Relo's mark with one satellite per live session. Right: the leading card's plan, lit from within, with +N for the
//  rest. Both wings are washed with the state's color, never over the camera housing. A moment (a finished step, a
//  question, your turn, a finish, a failure) plays its own motion and sends beams from the bottom centre up both sides.
//  What it shows comes from the server's presentation; nothing here decides state.
//

import ReloCore
import ReloNotchKit
import SwiftUI

/// What the wings show now, from the presentation.
struct ReloOrbitScene: Equatable {
    enum Lead: Equatable { case running, needs, turn, done, failed, quiet, rest }

    struct Satellite: Equatable {
        var id: String
        var quiet: Bool
        /// How fast it circles (0…1): recently moved work circles faster.
        var pace: Double
    }

    var lead: Lead
    var leadID: String?
    var satellites: [Satellite]
    var bar: [PlanBar.Segment]?
    /// Live sessions besides the lead (the right wing's +N).
    var more: Int
    var locked: Bool
    var unseen: Bool
    /// The harness of the first working session no card shows yet (Claude Code, Codex…), for the time before a plan.
    var source: String?

    static let maxSatellites = 6

    init(_ presentation: NotchPresentation, unseen: Bool, now: Date = Date()) {
        let focus = presentation.focus
        let live = presentation.sections
            .filter { [.needsYou, .waitingOnYou, .running].contains($0.kind) }
            .flatMap(\.rows)
        var seen = Set<String>()
        var rows = live.filter { seen.insert($0.id).inserted }
        if let focus, let index = rows.firstIndex(where: { $0.id == focus.id }) { rows.insert(rows.remove(at: index), at: 0) }
        let pace = { (row: NotchPresentation.Row) -> Double in
            let age = now.timeIntervalSince(row.movedAt)
            return age < 120 ? 1 : age < 600 ? 0.7 : 0.45
        }
        var satellites = rows.map { Satellite(id: $0.id, quiet: $0.tone == .quiet, pace: pace($0)) }
        satellites += (0..<presentation.workingSessionsWithoutCards).map { Satellite(id: "session-\($0)", quiet: false, pace: 0.6) }
        self.satellites = Array(satellites.prefix(Self.maxSatellites))
        more = max(0, satellites.count - 1)
        leadID = focus?.id
        locked = focus?.unreadable ?? false
        self.unseen = unseen
        source = presentation.sessions.first { $0.phase == .working && !$0.hasCard }?.source ?? focus?.source
        bar = focus?.bar?.segments
        lead = switch focus?.tone {
        case .needsYou: .needs
        case .yourTurn: .turn
        case .working: .running
        case .quiet, .paused: .quiet
        case .done: .done
        case .failed, .dropped, .leftUnfinished: .failed
        case nil: satellites.isEmpty ? .rest : .running
        }
    }
}

/// A moment the wings play once: what happened, to which card, when.
struct ReloOrbitMoment: Equatable {
    enum Kind: Equatable { case started, step, needs, turn, done, failed }

    var kind: Kind
    var rowID: String
    var bar: [PlanBar.Segment]?
    var at: Date

    /// How long it plays before the wings return to the lead's state.
    var duration: Double {
        switch kind {
        case .started: 2.6
        case .step: 2.6
        case .needs: 2.2
        case .turn, .done, .failed: 5.2
        }
    }

    init?(_ event: NotchEvent, at: Date = Date()) {
        switch event.kind {
        case .question: kind = .needs
        case .yourTurn: kind = .turn
        case .finished: kind = .done
        case .failed: kind = .failed
        case .progressed: kind = .step
        case .started: kind = .started
        }
        rowID = event.row.id
        bar = event.row.bar?.segments
        self.at = at
    }

    init(step row: NotchPresentation.Row, at: Date = Date()) {
        kind = .step
        rowID = row.id
        bar = row.bar?.segments
        self.at = at
    }
}

struct ReloOrbitWings: View {
    let scene: ReloOrbitScene
    let moment: ReloOrbitMoment?
    /// Each wing's content width and the mark's side, as ReloWing lays them out.
    let wing: CGFloat
    let side: CGFloat
    /// The connection is down: past the server's `refreshAt` the wings stop orbiting, as old data must not look live.
    var offline = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        if offline {
            TimelineView(.periodic(from: .now, by: 15)) { context in
                let store = ReloNotch.store
                wings(frozen: store.presentation.isFrozen(offline: true, lastUpdated: store.lastUpdated, now: context.date))
            }
        } else {
            wings(frozen: false)
        }
    }

    @ViewBuilder
    private func wings(frozen: Bool) -> some View {
        // 30 fps is plenty for this size and keeps the closed notch cheap.
        let still = reduceMotion || frozen
        Group {
            if ReloEffects.metal {
                ReloEffectView(outset: ReloEffectOutset.wings, paused: still) { [scene, moment, wing, side] canvas in
                    var painter = ReloOrbitPainter(scene: scene, moment: moment, wing: wing, side: side, size: canvas.size,
                                                   reduceMotion: still, now: canvas.now)
                    var sink = canvas.sink(body: painter.body)
                    painter.paint(&sink)
                }
            } else {
                TimelineView(.animation(minimumInterval: 1.0 / 30, paused: still)) { timeline in
                    Canvas { context, size in
                        var painter = ReloOrbitPainter(scene: scene, moment: moment, wing: wing, side: side, size: size,
                                                       reduceMotion: still, now: timeline.date)
                        var sink = GraphicsContextSink(ctx: context, body: painter.body)
                        painter.paint(&sink)
                    }
                }
            }
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

// MARK: - Painting

enum Ease {
    static func clamp(_ x: Double) -> Double { min(1, max(0, x)) }
    static func seg(_ s: Double, _ a: Double, _ b: Double) -> Double { clamp((s - a) / (b - a)) }
    static func out(_ x: Double) -> Double { 1 - pow(1 - x, 3) }
    static func inOut(_ x: Double) -> Double { x < 0.5 ? 4 * x * x * x : 1 - pow(-2 * x + 2, 3) / 2 }
    static func outBack(_ x: Double) -> Double { let c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * pow(x - 1, 3) + c1 * pow(x - 1, 2) }
    static func spring(_ x: Double) -> Double { x <= 0 ? 0 : 1 - exp(-7 * x) * cos(12 * x) }
    static func decay(_ s: Double, _ at: Double, _ k: Double = 3) -> Double { s < at ? 0 : exp(-(s - at) * k) }
}

/// The closed notch's lower outline (sides and bottom), a hair inside the black, as a track the beams run along.
struct EdgeTrack {
    var points: [CGPoint] = []
    var lengths: [Double] = []
    var length: Double = 0

    init(size: CGSize, top: CGFloat, bottom: CGFloat, inset e: CGFloat = 1.2) {
        let h = size.height, w = size.width
        let x0 = top + e, y1 = h - e
        var pts = [CGPoint(x: x0, y: top), CGPoint(x: x0, y: h - bottom)]
        let quad = { (p0: CGPoint, c: CGPoint, p1: CGPoint) in
            (1...8).map { i -> CGPoint in
                let t = CGFloat(i) / 8, u = 1 - t
                return CGPoint(x: u * u * p0.x + 2 * u * t * c.x + t * t * p1.x, y: u * u * p0.y + 2 * u * t * c.y + t * t * p1.y)
            }
        }
        pts += quad(CGPoint(x: x0, y: h - bottom), CGPoint(x: x0, y: y1), CGPoint(x: top + bottom, y: y1))
        pts.append(CGPoint(x: w - top - bottom, y: y1))
        pts += quad(CGPoint(x: w - top - bottom, y: y1), CGPoint(x: w - x0, y: y1), CGPoint(x: w - x0, y: h - bottom))
        pts.append(CGPoint(x: w - x0, y: top))
        points = pts
        var total = 0.0
        lengths = [0]
        for i in 1..<pts.count {
            total += hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)
            lengths.append(total)
        }
        length = total
    }

    func point(_ d: Double) -> CGPoint {
        guard var i = lengths.firstIndex(where: { $0 >= d }) else { return points.last ?? .zero }
        i = max(1, i)
        let span = lengths[i] - lengths[i - 1], f = span > 0 ? (d - lengths[i - 1]) / span : 0
        let a = points[i - 1], b = points[i]
        return CGPoint(x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f)
    }

    var path: Path {
        var path = Path()
        path.addLines(points)
        return path
    }
}

struct ReloOrbitPainter {
    let scene: ReloOrbitScene
    let moment: ReloOrbitMoment?
    let wing: CGFloat
    let side: CGFloat
    let size: CGSize
    let reduceMotion: Bool
    let t: Double
    /// Seconds into the moment, while it plays.
    let s: Double?

    // Geometry, in the closed notch's own frame (its black shape, rounded corners included).
    let mid: CGFloat
    let leftX: CGFloat
    let rightX: CGFloat
    let wingL: CGRect
    let wingR: CGRect
    let body: Path
    let edge: EdgeTrack
    let orbitR: CGFloat
    let center: CGPoint

    static let run = ReloNotchTheme.color(.working)
    static let needs = ReloNotchTheme.color(.needsYou)
    static let turn = ReloNotchTheme.color(.yourTurn)
    static let done = ReloNotchTheme.color(.done)
    static let failed = ReloNotchTheme.color(.failed)
    static let quiet = Color(white: 0.42)

    init(scene: ReloOrbitScene, moment: ReloOrbitMoment?, wing: CGFloat, side: CGFloat, size: CGSize,
         reduceMotion: Bool, now: Date) {
        self.scene = scene
        self.wing = wing
        self.side = side
        self.size = size
        self.reduceMotion = reduceMotion
        t = now.timeIntervalSinceReferenceDate
        if let moment, now.timeIntervalSince(moment.at) < moment.duration, !reduceMotion {
            self.moment = moment
            s = max(0, now.timeIntervalSince(moment.at))
        } else {
            self.moment = nil
            s = nil
        }
        let inset = cornerRadiusInsets.closed.bottom, top = cornerRadiusInsets.closed.top
        mid = size.height / 2
        leftX = inset + ReloWing.outer
        rightX = size.width - inset - ReloWing.outer - wing
        let housingL = inset + ReloWing.outer + wing + ReloWing.gap
        wingL = CGRect(x: top, y: 0, width: max(0, housingL - top), height: size.height)
        wingR = CGRect(x: size.width - housingL, y: 0, width: max(0, housingL - top), height: size.height)
        let shape = Self.shape(size: size, top: top, inset: inset)
        body = shape.body
        edge = shape.edge
        orbitR = side * 0.4
        center = CGPoint(x: leftX + side / 2, y: size.height / 2)
    }

    /// The notch's outline and edge track depend only on its size, so they are built once, not every frame.
    private static var shapeCache: (key: [CGFloat], body: Path, edge: EdgeTrack)?
    private static func shape(size: CGSize, top: CGFloat, inset: CGFloat) -> (body: Path, edge: EdgeTrack) {
        let key = [size.width, size.height, top, inset]
        if let c = shapeCache, c.key == key { return (c.body, c.edge) }
        let body = NotchShape(topCornerRadius: top, bottomCornerRadius: inset).path(in: CGRect(origin: .zero, size: size))
        let edge = EdgeTrack(size: size, top: top, bottom: inset)
        shapeCache = (key, body, edge)
        return (body, edge)
    }

    mutating func paint<S: ReloPaintSink>(_ ctx: inout S) {
        if let moment, let s {
            switch moment.kind {
            case .step: running(&ctx, step: s, bar: moment.bar)
            case .needs: needs(&ctx, arrival: s)
            case .turn: turn(&ctx, s: s, rowID: moment.rowID)
            case .done: done(&ctx, s: s, bar: moment.bar)
            case .failed: failed(&ctx, s: s)
            case .started: started(&ctx, s: s, rowID: moment.rowID, bar: moment.bar)
            }
            return
        }
        switch scene.lead {
        case .running where (scene.bar ?? []).isEmpty: prePlan(&ctx)
        case .running: running(&ctx, step: nil, bar: scene.bar)
        case .needs: needs(&ctx, arrival: nil)
        case .turn: turn(&ctx, s: 9, rowID: scene.leadID ?? "")
        case .done: done(&ctx, s: 9, bar: scene.bar)
        case .failed: failed(&ctx, s: 9)
        case .quiet: quietState(&ctx)
        case .rest: rest(&ctx)
        }
    }

    // MARK: States

    private func running<S: ReloPaintSink>(_ ctx: inout S, step: Double?, bar: [PlanBar.Segment]?) {
        let breath = (reduceMotion ? 0.3 : 0.32 + 0.16 * sin(t * 1.5)) + (scene.unseen ? 0.25 : 0)
        let flash = step.map { Ease.decay($0, 0, 2.6) } ?? 0
        glow(&ctx, Self.run, 0.4 + 0.35 * flash, right: false)
        glow(&ctx, Self.run, 0.4 + 0.9 * flash, left: false)
        // The step that just finished is the last done one.
        let flashIndex = bar.flatMap { segments in segments.lastIndex { $0.state == .done } }
        rightWing(&ctx, bar: bar, color: Self.run, flashIndex: flashIndex, flash: flash)
        orbit(&ctx, pulse: max(breath, 0.3 + 0.7 * flash), coreGrow: 0.24 * flash)
        if let step { beams(&ctx, Ease.seg(step, 0, 1.5), Self.run) }
    }

    /// The mark itself pulses coral and sends rings; its satellites keep circling; beams repeat.
    private func needs<S: ReloPaintSink>(_ ctx: inout S, arrival: Double?) {
        let p = reduceMotion ? 0.8 : 0.6 + 0.4 * sin(t * 3)
        rim(&ctx, Self.needs, 0.3 + 0.35 * p)
        glow(&ctx, Self.needs, 0.35 + 0.2 * p)
        chip(&ctx, "Answer", Self.needs, scale: 1 + 0.04 * p)
        orbit(&ctx, core: Self.needs, pulse: p, coreGrow: 0.09, leadColor: Self.needs)
        if !reduceMotion {
            // One ring per beat, eased out and thinning as it spreads.
            let e = t.truncatingRemainder(dividingBy: 1.8) / 1.8
            ring(&ctx, radius: side * 0.2 + Ease.out(e) * side * 0.72, color: Self.needs, alpha: 0.5 * pow(1 - e, 1.5),
                 width: 1.1 - 0.5 * e)
        }
        beams(&ctx, Ease.seg(arrival ?? t.truncatingRemainder(dividingBy: 2.8), 0, 1.9), Self.needs)
    }

    /// A start: the core gathers itself and pulses once, a ring leaves it, and the new work's satellite is born at the
    /// core and spirals out into its orbit, landing exactly where it then keeps circling; the plan draws into the right
    /// wing from the left behind a bright head; violet beams rise. The mirror of a finish, which spirals in.
    private func started<S: ReloPaintSink>(_ ctx: inout S, s: Double, rowID: String, bar: [PlanBar.Segment]?) {
        let gather = Ease.seg(s, 0, 0.3), burst = Ease.decay(s, 0.3, 3.2)
        glow(&ctx, Self.run, 0.25 + 0.15 * gather + 0.55 * burst)
        // The plan draws in from the left, behind a bright head.
        let drawn = Ease.inOut(Ease.seg(s, 0.5, 1.4))
        if drawn > 0 {
            var c = ctx
            c.clip(rect: CGRect(x: rightX - 4, y: 0, width: (wing + 8) * drawn, height: size.height))
            rightWing(&c, bar: bar ?? scene.bar, color: Self.run, live: drawn >= 1)
            if drawn < 1, !reduceMotion {
                var glow = ctx
                glow.blend = .plusLighter
                let o = CGPoint(x: rightX + wing * drawn, y: mid)
                glow.fillEllipse(CGRect(x: o.x - 6, y: o.y - 6, width: 12, height: 12), .radial(Gradient(colors: [.white.opacity(0.75), Self.run.opacity(0.35), Self.run.opacity(0)]),
                                                center: o, startRadius: 0, endRadius: 6))
            }
        }
        // The core draws in a little, then pulses once as the satellite leaves it.
        let coreGrow = -0.12 * Ease.inOut(gather) * (1 - Ease.seg(s, 0.3, 0.45)) + 0.3 * burst * Ease.spring(Ease.seg(s, 0.3, 0.8))
        orbit(&ctx, core: Self.run, pulse: 0.25 + 0.75 * burst, coreGrow: coreGrow, skip: rowID)
        let rip = Ease.seg(s, 0.3, 1.2)
        if rip > 0, rip < 1 { ring(&ctx, radius: side * 0.2 + Ease.out(rip) * side * 0.9, color: Self.run, alpha: 0.5 * pow(1 - rip, 1.4), width: 1.1 - 0.6 * rip) }
        // The new satellite: born at the core, spiralling out to the very point of its orbit where it carries on.
        let sats = scene.satellites
        let index = sats.firstIndex { $0.id == rowID }
        let target = index.map { angle(of: sats[$0], at: $0, in: sats.count, dim: false) } ?? (-Double.pi / 2 + t * 1.5)
        let out = Ease.out(Ease.seg(s, 0.3, 1.3))
        if s >= 0.3 {
            let a = target - (1 - out) * 3.4, r = 0.15 + 0.85 * out
            if !reduceMotion {
                for k in 1...10 {
                    let back = Ease.out(Ease.clamp(Ease.seg(s, 0.3, 1.3) - Double(k) * 0.025))
                    dot(&ctx, onOrbit(target - (1 - back) * 3.4 - Double(k) * 0.05, scale: 0.15 + 0.85 * back),
                        1.5 - 0.06 * Double(k), Self.run, 0.3 * pow(1 - Double(k) / 11, 1.5))
                }
            }
            dot(&ctx, onOrbit(a, scale: r), 2, Self.run)
        }
        beams(&ctx, Ease.seg(s, 0.4, 1.9), Self.run)
    }

    /// Its satellite glides to the top and settles; the plan gives way to the chip; amber beams rise.
    private func turn<S: ReloPaintSink>(_ ctx: inout S, s: Double, rowID: String) {
        let settle = Ease.out(Ease.seg(s, 0, 1.1))
        let breathe = reduceMotion ? 0 : Ease.seg(s, 1.1, 1.6) * sin((s - 1.1) * 2.6)
        let sweep = Ease.seg(s, 0.9, 2.4)
        rim(&ctx, Self.turn, 0.12 + 0.2 * sin(sweep * .pi))
        glow(&ctx, Self.turn, 0.15 + 0.3 * settle + 0.1 * breathe)
        rightWing(&ctx, bar: scene.bar, color: Self.run, alpha: 1 - Ease.seg(s, 0.2, 0.7))
        let slide = Ease.outBack(Ease.seg(s, 0.7, 1.3))
        chip(&ctx, "Your turn", Self.turn, alpha: Ease.seg(s, 0.7, 1.0), dx: -14 * (1 - slide))
        let corePulse = Ease.decay(s, 1.1, 2.2) * Ease.spring(Ease.seg(s, 1.1, 1.6))
        orbit(&ctx, core: s < 1.1 ? Self.run : Self.turn, pulse: corePulse + 0.2 * max(0, breathe), skip: rowID)
        let target = -Double.pi / 2, start = target - 3.2, angle = start + (target - start) * settle
        if !reduceMotion, settle < 1 {
            for k in 1...7 {
                let b = angle - Double(k) * 0.14 * (1 - settle)
                dot(&ctx, onOrbit(b), 1.5, Self.turn, 0.3 - Double(k) * 0.04)
            }
        }
        var p = onOrbit(angle)
        p.y -= 0.6 * breathe
        dot(&ctx, p, 5.5, Self.turn, 0.18 * (0.6 + 0.4 * breathe) * settle)
        dot(&ctx, p, 2.3 + 0.35 * breathe, Self.turn)
        beams(&ctx, sweep, Self.turn)
    }

    /// The satellite spirals in, the mark pops mint and draws the one check, a ripple spreads, the bar sweeps full;
    /// mint beams rise.
    private func done<S: ReloPaintSink>(_ ctx: inout S, s: Double, bar: [PlanBar.Segment]?) {
        let inT = Ease.inOut(Ease.seg(s, 0, 1.0))
        let land = Ease.seg(s, 1.0, 1.9)
        let flash = Ease.decay(s, 1.0, 1.8)
        glow(&ctx, s < 1 ? Self.run : Self.done, s < 1 ? 0.4 : 0.3 + 0.9 * flash)
        rightWing(&ctx, bar: bar ?? [], color: Self.run, live: s < 0.5, full: Ease.inOut(Ease.seg(s, 0.5, 1.3)), hidesMore: true)
        let landed = s >= 1
        orbit(&ctx, core: landed ? Self.done : Self.run, pulse: flash * 0.8,
              coreGrow: landed ? 0.7 * Ease.spring(land) : 0, skip: moment?.rowID ?? scene.leadID)
        if !landed {
            let angle = t * 1.5 + inT * 5, r = 1 - inT
            for k in 1...6 {
                let b = angle - Double(k) * 0.16, rk = 1 - Ease.inOut(Ease.clamp(Ease.seg(s, 0, 1.0) - Double(k) * 0.02))
                dot(&ctx, onOrbit(b, scale: rk), 1.5, Self.done, 0.28 - Double(k) * 0.04)
            }
            dot(&ctx, onOrbit(angle, scale: r), 2.2, Self.done)
        } else {
            drawCheckOnCore(&ctx, Ease.out(Ease.seg(s, 1.25, 1.8)))
            let rip = Ease.seg(s, 1.0, 2.0)
            if rip < 1 { ring(&ctx, radius: side * 0.25 + Ease.out(rip) * side * 1.2, color: Self.done, alpha: 0.7 * (1 - rip), width: 1.4 * (1 - rip) + 0.3) }
        }
        beams(&ctx, Ease.seg(s, 1.0, 2.5), Self.done)
    }

    /// The satellite trembles, drops out of orbit and pools; the plan gives way to a shaking chip; the edge flashes
    /// twice and red beams rise.
    private func failed<S: ReloPaintSink>(_ ctx: inout S, s: Double) {
        let flash = max(Ease.decay(s, 0.75, 9), 0.8 * Ease.decay(s, 1.05, 9))
        rim(&ctx, Self.failed, 0.95 * flash)
        glow(&ctx, s < 0.75 ? Self.run : Self.failed, s < 0.75 ? 0.4 : 0.25 + 0.7 * Ease.decay(s, 0.75, 1.4))
        rightWing(&ctx, bar: scene.bar, color: Self.run, alpha: 1 - Ease.seg(s, 0.55, 0.8))
        let e = s - 0.8, shake = e > 0 ? sin(e * 42) * 3.2 * exp(-e * 5.5) : 0
        chip(&ctx, "Failed", Self.failed, alpha: Ease.seg(s, 0.75, 0.95), dx: shake, scale: 0.9 + 0.1 * Ease.outBack(Ease.seg(s, 0.75, 1.0)))
        orbit(&ctx, core: s < 0.75 ? Self.run : Self.failed, pulse: 0.9 * Ease.decay(s, 0.75, 2.5), skip: moment?.rowID ?? scene.leadID)
        var p = onOrbit(.pi * 0.2), alpha = 1.0
        if s < 0.7 {
            p.x += sin(s * 70) * 1.4 * Ease.seg(s, 0.1, 0.7)
        } else {
            let fall = s - 0.7
            p.y = min(size.height - 2.5, p.y + 45 * fall * fall)
            p.x += fall * 6
            alpha = 1 - Ease.seg(s, 1.1, 1.9)
            if p.y >= size.height - 2.5 {
                let pool = Ease.seg(s, 1.0, 2.2)
                var c = ctx
                c.clip(rect: wingL)
                c.fillEllipse(CGRect(x: p.x - 2 - pool * 10, y: size.height - 2.9, width: 4 + pool * 20, height: 2.8), .color(Self.failed.opacity(0.45 * (1 - pool))))
            }
        }
        if alpha > 0 { dot(&ctx, p, 2.1, Self.failed, alpha) }
        beams(&ctx, Ease.seg(s, 0.75, 2.2), Self.failed)
    }

    private func quietState<S: ReloPaintSink>(_ ctx: inout S) {
        rightWing(&ctx, bar: scene.bar, color: Self.quiet, alpha: 0.45, live: false)
        orbit(&ctx, core: Self.quiet, pulse: 0, quiet: true)
    }

    /// Nothing live (or signed out): a pilot light, one small slate dot breathing over seven seconds, so the notch says
    /// Relo is here; when work starts, the orbit's core grows from this spot.
    private func rest<S: ReloPaintSink>(_ ctx: inout S) {
        let slate = ReloNotchTheme.info
        let breath = reduceMotion ? 0.5 : 0.5 + 0.5 * sin(t * 2 * .pi / 7)
        var halo = ctx
        halo.blend = .plusLighter
        halo.fillEllipse(CGRect(x: center.x - 6, y: center.y - 6, width: 12, height: 12), .radial(Gradient(colors: [slate.opacity(0.22 * breath), slate.opacity(0)]), center: center,
                                        startRadius: 1, endRadius: 6))
        dot(&ctx, center, 2.4, slate, 0.45 + 0.3 * breath)
    }

    /// A session works but has no plan yet: the orbit says so, and the right wing says who is working (the harness's
    /// own mark and a small live waveform) instead of an empty plan.
    private func prePlan<S: ReloPaintSink>(_ ctx: inout S) {
        let breath = reduceMotion ? 0.3 : 0.32 + 0.16 * sin(t * 1.5)
        glow(&ctx, Self.run, 0.4)
        orbit(&ctx, pulse: breath)
        let right = rightX + wing
        var x = right
        if let logo = scene.source.flatMap(ReloSourceLogo.init(sourceName:)) {
            ctx.drawTemplate(logo.assetName, tint: logo.tint ?? .white.opacity(0.8), in: CGRect(x: right - 11, y: mid - 5.5, width: 11, height: 11))
            x -= 17
        }
        for k in 0..<4 {
            let h = reduceMotion ? 5 : 3 + 6 * (0.5 + 0.5 * sin(t * 4.2 + Double(k) * 1.3))
            let bx = x - 3 - CGFloat(3 - k) * 3.6
            ctx.fillRoundedRect(CGRect(x: bx, y: mid - h / 2, width: 2, height: h), cornerRadius: 1, .color(Self.run))
        }
    }

    // MARK: Pieces

    private var bars: ReloBarPainter { ReloBarPainter(t: t, reduceMotion: reduceMotion) }

    private func onOrbit(_ angle: Double, scale: Double = 1) -> CGPoint {
        CGPoint(x: center.x + cos(angle) * orbitR * scale, y: center.y + sin(angle) * orbitR * scale)
    }

    private func dot<S: ReloPaintSink>(_ ctx: inout S, _ p: CGPoint, _ r: CGFloat, _ color: Color, _ alpha: Double = 1) {
        guard alpha > 0 else { return }
        ctx.fillEllipse(CGRect(x: p.x - r, y: p.y - r, width: 2 * r, height: 2 * r), .color(color.opacity(alpha)))
    }

    /// The mark and the satellites that keep circling; `skip` leaves out the one a moment is about.
    private func orbit<S: ReloPaintSink>(_ ctx: inout S, core: Color = ReloOrbitPainter.run, pulse: Double, coreGrow: Double = 0,
                       leadColor: Color? = nil, skip: String? = nil, quiet: Bool = false) {
        let coreR = side * 0.165 * (1 + coreGrow)
        ctx.strokeEllipse(CGRect(x: center.x - orbitR, y: center.y - orbitR, width: 2 * orbitR, height: 2 * orbitR),
                          .white.opacity(0.09), lineWidth: 1)
        if scene.locked {
            // This Mac is not approved yet: the work is real but private here.
            ctx.draw(ReloPaintLabel(content: .symbol("lock.fill"), size: max(8, side * 0.42), weight: .semibold, color: ReloNotchTheme.yellow),
                     at: center, anchor: .center)
        } else {
            if pulse > 0 {
                var glow = ctx
                glow.blend = .plusLighter
                let hr = coreR + 3 + 4 * pulse
                glow.fillEllipse(CGRect(x: center.x - hr, y: center.y - hr, width: 2 * hr, height: 2 * hr), .radial(Gradient(colors: [core.opacity(0.55 * pulse), core.opacity(0)]),
                                                center: center, startRadius: coreR * 0.5, endRadius: hr))
            }
            let r = coreR * (1 + 0.2 * pulse)
            ctx.fillEllipse(CGRect(x: center.x - r, y: center.y - r, width: 2 * r, height: 2 * r), .color(core))
        }
        let sats = scene.satellites
        for (i, sat) in sats.enumerated() where sat.id != skip {
            let dim = quiet || sat.quiet
            let color = dim ? Self.quiet : (sat.id == scene.leadID ? leadColor : nil) ?? Self.run
            let alpha = dim ? 0.45 : 1
            let base = angle(of: sat, at: i, in: sats.count, dim: dim)
            if !reduceMotion {
                // A tail of close, shrinking dots that reads as one soft streak, and a faint halo on the head.
                for k in 1...12 {
                    let f = Double(k) / 13
                    dot(&ctx, onOrbit(base - Double(k) * 0.055 * (0.6 + 0.4 * sat.pace)), 1.55 - 0.65 * f, color,
                        0.32 * pow(1 - f, 1.6) * alpha)
                }
                var halo = ctx
                halo.blend = .plusLighter
                let h = onOrbit(base)
                halo.fillEllipse(CGRect(x: h.x - 3.6, y: h.y - 3.6, width: 7.2, height: 7.2), .radial(Gradient(colors: [color.opacity(0.3 * alpha), color.opacity(0)]), center: h,
                                                startRadius: 1.5, endRadius: 3.6))
            }
            dot(&ctx, onOrbit(base), 2, color, alpha)
        }
    }

    /// A stable 0…1 from an id (FNV-1a), for each satellite's own pace.
    private static func unit(_ id: String) -> Double {
        var hash: UInt64 = 0xcbf29ce484222325
        for byte in id.utf8 { hash = (hash ^ UInt64(byte)) &* 0x100000001b3 }
        return Double(hash % 10_000) / 10_000
    }

    /// Where a satellite is on its orbit now: its own pace (tuned) and its share of the circle.
    private func angle(of sat: ReloOrbitScene.Satellite, at i: Int, in count: Int, dim: Bool) -> Double {
        // Each satellite keeps its own pace (from its id), so they drift like bodies in orbit, never in step.
        let own = 0.72 + 0.56 * Self.unit(sat.id)
        let speed = dim ? 0.15 * own : 1.5 * sat.pace * own
        return (reduceMotion ? 0 : t * speed) + Double(i) * 2 * .pi / Double(max(1, count))
    }

    private func drawCheckOnCore<S: ReloPaintSink>(_ ctx: inout S, _ draw: Double) {
        guard draw > 0 else { return }
        let k = side / 20
        let a = CGPoint(x: center.x - 2.4 * k, y: center.y), b = CGPoint(x: center.x - 0.7 * k, y: center.y + 1.8 * k),
            c = CGPoint(x: center.x + 2.6 * k, y: center.y - 1.8 * k)
        let l1 = hypot(b.x - a.x, b.y - a.y), l2 = hypot(c.x - b.x, c.y - b.y), d = draw * (l1 + l2)
        var points = [a]
        if d <= l1 { points.append(CGPoint(x: a.x + (b.x - a.x) * d / l1, y: a.y + (b.y - a.y) * d / l1)) }
        else {
            points.append(b)
            let f = (d - l1) / l2
            points.append(CGPoint(x: b.x + (c.x - b.x) * f, y: b.y + (c.y - b.y) * f))
        }
        ctx.strokeLines(points, .color(.black.opacity(0.8)), lineWidth: 1.4 * k, round: true)
    }

    /// A ring spreading from the mark, inside the left wing only.
    private func ring<S: ReloPaintSink>(_ ctx: inout S, radius: CGFloat, color: Color, alpha: Double, width: CGFloat = 1.2) {
        guard alpha > 0 else { return }
        var c = ctx
        c.clip(rect: wingL)
        c.strokeEllipse(CGRect(x: center.x - radius, y: center.y - radius, width: 2 * radius, height: 2 * radius),
                        color.opacity(alpha), lineWidth: width)
    }

    /// The state's light in each wing, lit as a surface: strongest at the notch's outer edge and diffusing toward the
    /// camera (a little brighter low), pooled in the outer corner along the notch's curve, with a thin line on the bottom
    /// edge. A slow Metal noise flows through it from the outer edges inward (the light layer only, never the content).
    private func glow<S: ReloPaintSink>(_ ctx: inout S, _ color: Color, _ strength: Double, left: Bool = true, right: Bool = true) {
        guard strength > 0.001 else { return }
        for rect in [left ? wingL : nil, right ? wingR : nil].compactMap({ $0 }) {
            var c = ctx
            c.clipToBody()
            c.clip(rect: rect)
            c.blend = .plusLighter
            let leftWing = rect.minX < size.width / 2
            let inner = leftWing ? rect.maxX : rect.minX
            let outerEdge = leftWing ? rect.minX : rect.maxX
            c.wingLight(ReloWingLightSpec(
                rect: rect,
                band: Gradient(stops: [.init(color: color.opacity(0.62 * strength), location: 0),
                                       .init(color: color.opacity(0.3 * strength), location: 0.3),
                                       .init(color: color.opacity(0.08 * strength), location: 0.65),
                                       .init(color: color.opacity(0), location: 1)]),
                bandFrom: CGPoint(x: outerEdge, y: 0), bandTo: CGPoint(x: inner, y: 0),
                mask: Gradient(stops: [.init(color: .black, location: 0), .init(color: .black.opacity(0.55), location: 1)]),
                maskFrom: CGPoint(x: 0, y: size.height), maskTo: CGPoint(x: 0, y: 0),
                pool: Gradient(stops: [.init(color: color.opacity(0.45 * strength), location: 0),
                                       .init(color: color.opacity(0.12 * strength), location: 0.5),
                                       .init(color: color.opacity(0), location: 1)]),
                poolCenter: CGPoint(x: outerEdge + (leftWing ? 4 : -4), y: size.height - 2), poolRadius: rect.width * 0.55,
                canvas: size, noise: reduceMotion ? nil : Float(t.truncatingRemainder(dividingBy: 1000))))
            let fade = Gradient(stops: [.init(color: color.opacity(1), location: 0), .init(color: color.opacity(0.6), location: 0.35),
                                        .init(color: color.opacity(0), location: 0.85)])
            var line = c
            line.opacity = min(1, 1.3 * strength)
            line.strokeLines(edge.points, .linear(fade, start: CGPoint(x: outerEdge, y: 0), end: CGPoint(x: inner, y: 0)),
                             lineWidth: 1, round: false)
        }
    }

    /// Light along the notch's own edge, inside the black.
    private func rim<S: ReloPaintSink>(_ ctx: inout S, _ color: Color, _ alpha: Double) {
        guard alpha > 0.01 else { return }
        ctx.blurredLines(edge.points, .color(color.opacity(alpha * 0.85)), lineWidth: 2, blur: 3)
    }

    /// Two lights leave the bottom centre together, run outward and climb both sides; p is 0…1.
    private func beams<S: ReloPaintSink>(_ ctx: inout S, _ p: Double, _ color: Color) {
        guard !reduceMotion, p > 0, p < 1 else { return }
        let half = edge.length / 2, d = Ease.inOut(p) * half, alpha = sin(p * .pi)
        var c = ctx
        c.blend = .plusLighter
        for dir in [1.0, -1.0] {
            let head = half + dir * d
            // Dots close enough to read as one tapered line, and a small bloom at the head.
            for k in 0..<48 {
                let at = head - dir * Double(k) * 0.7
                guard at >= 0, at <= edge.length else { continue }
                let f = Double(k) / 48, point = edge.point(at), r = 1.45 - 0.95 * f
                c.fillEllipse(CGRect(x: point.x - r, y: point.y - r, width: 2 * r, height: 2 * r), .color(color.opacity(pow(1 - f, 1.4) * 0.9 * alpha)))
            }
            if head >= 0, head <= edge.length {
                let o = edge.point(head)
                c.fillEllipse(CGRect(x: o.x - 4.5, y: o.y - 4.5, width: 9, height: 9), .radial(Gradient(colors: [Color.white.opacity(0.55 * alpha), color.opacity(0.25 * alpha), color.opacity(0)]),
                                             center: o, startRadius: 0, endRadius: 4.5))
            }
        }
        if p < 0.25 { // a flat flare where they leave, along the edge
            let f = 1 - p / 0.25, o = CGPoint(x: size.width / 2, y: size.height - 1)
            c.fillEllipse(CGRect(x: o.x - 20, y: o.y - 3.5, width: 40, height: 7), .radial(Gradient(colors: [Color.white.opacity(0.5 * f), color.opacity(0.4 * f), color.opacity(0)]),
                                         center: o, startRadius: 0, endRadius: 20))
        }
    }

    private func chip<S: ReloPaintSink>(_ ctx: inout S, _ text: String, _ color: Color, alpha: Double = 1, dx: CGFloat = 0, scale: CGFloat = 1) {
        guard alpha > 0 else { return }
        let label = ReloPaintLabel(content: .text(text), size: 10, weight: .bold, rounded: true, color: color.opacity(alpha))
        let measured = ctx.measure(label)
        let w = measured.width + 12, h: CGFloat = 15
        let cx = rightX + wing - w / 2 + dx
        var c = ctx
        c.translate(x: cx, y: mid)
        c.scale(x: scale, y: scale)
        let pill = CGRect(x: -w / 2, y: -h / 2, width: w, height: h)
        c.fillRoundedRect(pill, cornerRadius: h / 2, .color(color.opacity(0.17 * alpha)))
        c.pillBorder(pill, cornerRadius: h / 2, color.opacity(0.32 * alpha))
        c.draw(label, at: CGPoint(x: 0, y: 0.5), anchor: .center)
    }

    /// The lead's plan with +N for the rest; `hidesMore` leaves out +N (a finish is about the one card).
    private func rightWing<S: ReloPaintSink>(_ ctx: inout S, bar: [PlanBar.Segment]?, color: Color, alpha: Double = 1,
                           live: Bool = true, flashIndex: Int? = nil, flash: Double = 0, full: Double = 0, hidesMore: Bool = false) {
        guard alpha > 0.01 else { return }
        let showMore = scene.more > 0 && !hidesMore
        let width = showMore ? wing - 16 : wing
        var c = ctx
        c.opacity = alpha
        bars.planBar(&c, x: rightX, y: mid - 1.5, width: width, segments: bar ?? [], color: color, live: live,
                flashIndex: flashIndex, flash: flash, full: full)
        if showMore {
            c.draw(ReloPaintLabel(content: .text("+\(scene.more)"), size: 8.5, weight: .semibold, color: .white.opacity(0.5)),
                   at: CGPoint(x: rightX + wing, y: mid + 0.5), anchor: .trailing)
        }
    }

}

/// The plan bar as the wings paint it, shared with the expanded notch so both are one object.
struct ReloBarPainter {
    let t: Double
    let reduceMotion: Bool

    /// Done steps solid; the current one fills toward a glowing head, and light travels only through what is filled.
    /// No plan: a track with a light passing along it.
    func planBar<S: ReloPaintSink>(_ ctx: inout S, x: CGFloat, y: CGFloat, width w: CGFloat, segments input: [PlanBar.Segment],
                         color: Color, live: Bool, flashIndex: Int?, flash: Double, full: Double) {
        let h: CGFloat = 3
        let track = Color.white.opacity(0.13)
        // A long plan reads as one continuous bar; a finish with no plan sweeps a single one.
        let long = input.count > ReloWing.maxSegments
        var segments: [BarSegment] = long
            ? [BarSegment(done: input.allSatisfy { $0.state == .done }, current: input.contains { $0.state == .current },
                          fill: input.reduce(0) { $0 + ($1.state == .done ? 1 : $1.fill) } / Double(input.count))]
            : input.map { BarSegment(done: $0.state == .done, current: $0.state == .current, fill: $0.fill) }
        if segments.isEmpty, full > 0 { segments = [BarSegment(done: false, current: false, fill: 0)] }
        guard !segments.isEmpty else {
            ctx.fillRoundedRect(CGRect(x: x, y: y, width: w, height: h), cornerRadius: h / 2, .color(track))
            if live, !reduceMotion {
                let lx = x + CGFloat((t * 0.5).truncatingRemainder(dividingBy: 1.3)) * w
                lightWindow(&ctx, clip: CGRect(x: x, y: y, width: w, height: h), at: lx, half: 12, alpha: 0.45,
                            tint: color, soft: true)
            }
            return
        }
        let gap: CGFloat = long ? 0 : 3
        let segW = (w - gap * CGFloat(segments.count - 1)) / CGFloat(segments.count)
        for (i, segment) in segments.enumerated() {
            let sx = x + CGFloat(i) * (segW + gap)
            let rect = CGRect(x: sx, y: y, width: segW, height: h)
            ctx.fillRoundedRect(rect, cornerRadius: h / 2, .color(track))
            let f = segment.done ? 1 : segment.fill
            guard f > 0 else { continue }
            let fw = max(h, segW * CGFloat(f))
            let filled = CGRect(x: sx, y: y, width: fw, height: h)
            let current = segment.current
            let flashing = i == flashIndex && flash > 0
            if flashing {
                ctx.glowingRoundedRect(filled, cornerRadius: h / 2, color, shadow: color.opacity(flash), radius: 4.5)
                ctx.fillRoundedRect(filled, cornerRadius: h / 2, .color(.white.opacity(0.75 * flash)))
            } else if current, live, f < 1 {
                ctx.fillRoundedRect(filled, cornerRadius: h / 2, .linear(Gradient(colors: [color.opacity(0.4), color]),
                                                                         start: CGPoint(x: sx, y: y), end: CGPoint(x: sx + fw, y: y)))
            } else {
                ctx.fillRoundedRect(filled, cornerRadius: h / 2, .color(color))
            }
            guard current, live, f < 1 else { continue }
            let head = sx + fw
            if !reduceMotion {
                // One soft pass across the filled part, then a rest (the iPhone's LiveSweep rhythm).
                let local = t.truncatingRemainder(dividingBy: 2.8) / 1.9
                if local < 1 {
                    lightWindow(&ctx, clip: CGRect(x: sx, y: y, width: fw, height: h),
                                at: sx - 10 + CGFloat(Ease.inOut(local)) * (fw + 20), half: 11, alpha: 0.42, tint: .white, soft: true)
                }
            }
            let b = reduceMotion ? 0.6 : 0.55 + 0.14 * sin(t * 1.8)
            var glow = ctx
            glow.blend = .plusLighter
            let o = CGPoint(x: head, y: y + h / 2)
            glow.fillEllipse(CGRect(x: o.x - 5, y: o.y - 5, width: 10, height: 10), .radial(Gradient(stops: [.init(color: .white.opacity(b), location: 0),
                                                             .init(color: color.opacity(0.5 * b), location: 0.4),
                                                             .init(color: color.opacity(0), location: 1)]),
                                            center: o, startRadius: 0, endRadius: 5))
        }
        if full > 0 { // a mint sweep to full, over the bar
            var sweep = ctx
            sweep.clip(rect: CGRect(x: x, y: y - 1, width: w * CGFloat(full), height: h + 2))
            for i in segments.indices {
                sweep.fillRoundedRect(CGRect(x: x + CGFloat(i) * (segW + gap), y: y, width: segW, height: h), cornerRadius: h / 2,
                           .color(ReloOrbitPainter.done))
            }
            if full < 1 {
                var glow = ctx
                glow.blend = .plusLighter
                let o = CGPoint(x: x + w * CGFloat(full), y: y + h / 2)
                glow.fillEllipse(CGRect(x: o.x - 6, y: o.y - 6, width: 12, height: 12), .radial(Gradient(colors: [.white.opacity(0.8), ReloOrbitPainter.done.opacity(0)]), center: o, startRadius: 0, endRadius: 6))
            }
        }
    }

    private struct BarSegment {
        var done: Bool
        var current: Bool
        var fill: Double
    }

    private func lightWindow<S: ReloPaintSink>(_ ctx: inout S, clip: CGRect, at lx: CGFloat, half: CGFloat, alpha: Double, tint: Color,
                             soft: Bool = false) {
        var c = ctx
        c.clip(roundedRect: clip, cornerRadius: clip.height / 2)
        c.blend = .plusLighter
        let gradient = soft
            ? Gradient(stops: [.init(color: tint.opacity(0), location: 0), .init(color: .white.opacity(alpha * 0.35), location: 0.3),
                               .init(color: .white.opacity(alpha), location: 0.5), .init(color: .white.opacity(alpha * 0.35), location: 0.7),
                               .init(color: tint.opacity(0), location: 1)])
            : Gradient(colors: [tint.opacity(0), .white.opacity(alpha), tint.opacity(0)])
        c.fillRect(CGRect(x: lx - half, y: clip.minY, width: 2 * half, height: clip.height),
               .linear(gradient, start: CGPoint(x: lx - half, y: 0), end: CGPoint(x: lx + half, y: 0)))
    }
}

// MARK: - The expanded notch

/// A frozen clock for the expanded notch (the snapshot bench renders it frame by frame); nil runs on real time.
private struct ReloFrozenNowKey: EnvironmentKey { static let defaultValue: Date? = nil }

extension EnvironmentValues {
    var reloFrozenNow: Date? {
        get { self[ReloFrozenNowKey.self] }
        set { self[ReloFrozenNowKey.self] = newValue }
    }
}

/// What the expanded notch is showing, for its light and its entrance.
enum ReloOpenKind: Equatable {
    case needs, turn, running, failed, started, done

    var color: Color {
        switch self {
        case .needs, .turn: ReloNotchTheme.signalCoral
        case .running, .started: ReloNotchTheme.running
        case .failed: ReloNotchTheme.problem
        case .done: ReloNotchTheme.done
        }
    }

    /// A wings moment hands off to this expansion: its beams come down into the card (every update has one).
    var handsOff: Bool { true }
}

/// Seconds since the expansion opened, frame by frame while its entrance plays, then still (only the light keeps
/// moving). Reduce Motion skips straight to the settled state.
struct ReloOpenClock<Content: View>: View {
    let openedAt: Date
    var settle: Double = 1.6
    @ViewBuilder let content: (Double) -> Content
    @Environment(\.reloFrozenNow) private var frozen
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        if reduceMotion {
            content(60)
        } else if let frozen {
            content(frozen.timeIntervalSince(openedAt))
        } else {
            TimelineView(ReloEntranceSchedule(end: openedAt.addingTimeInterval(settle))) { context in
                content(context.date.timeIntervalSince(openedAt))
            }
        }
    }
}

/// Frames at 30 fps until `end`, then none: the entrance animates, the settled view costs nothing.
struct ReloEntranceSchedule: TimelineSchedule {
    let end: Date

    func entries(from startDate: Date, mode: TimelineScheduleMode) -> AnyIterator<Date> {
        var next = startDate
        return AnyIterator {
            guard next <= end.addingTimeInterval(1.0 / 30) else { return nil }
            defer { next = next.addingTimeInterval(1.0 / 30) }
            return next
        }
    }
}

/// One element's arrival: it rises 6 pt and fades in on a short ease-out, `delay` seconds after the opening.
struct ReloArrival: ViewModifier {
    let e: Double
    let delay: Double

    func body(content: Content) -> some View {
        let q = Ease.out(Ease.seg(e, delay, delay + 0.35))
        content.opacity(q).offset(y: 6 * (1 - q))
    }
}

extension View {
    func reloArrival(_ e: Double, _ delay: Double) -> some View { modifier(ReloArrival(e: e, delay: delay)) }

    /// How each state's badge arrives: a question drops in, your turn slides in from the wing, a failure shakes once.
    func reloBadgeArrival(_ kind: ReloOpenKind, _ e: Double) -> some View {
        let s = Ease.seg(e, 0.1, kind == .turn ? 0.55 : 0.45)
        let dy: CGFloat = kind == .needs ? -8 * (1 - Ease.outBack(s)) : kind == .started ? 6 * (1 - Ease.outBack(s)) : 0
        let shake = e > 0.1 ? sin((e - 0.1) * 42) * 2 * exp(-(e - 0.1) * 5.5) : 0
        let dx: CGFloat = kind == .turn ? 14 * (1 - Ease.outBack(s)) : kind == .failed ? shake : 0
        return opacity(Ease.out(Ease.seg(e, 0.1, 0.4))).offset(x: dx, y: dy)
    }
}

/// The plan bar inside the expanded notch: the wings' own bar, full width. A step that just finished flashes; a start
/// draws the plan in from the left behind a bright head; a finish sweeps it full in mint.
struct ReloLightBar: View {
    let segments: [PlanBar.Segment]
    let kind: ReloOpenKind
    let openedAt: Date
    var color = ReloNotchTheme.running
    var live = true
    @Environment(\.reloFrozenNow) private var frozen
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Group {
            if let frozen {
                if ReloEffects.bench { ReloBenchMetal(outset: ReloEffectOutset.bar) { painter($0, frozen).paint(&$1) } } else { canvas(frozen) }
            } else if ReloEffects.metal {
                ReloEffectView(outset: ReloEffectOutset.bar, paused: reduceMotion) { canvas in
                    var sink = canvas.sink()
                    painter(canvas.size, canvas.now).paint(&sink)
                }
            } else {
                TimelineView(.animation(minimumInterval: 1.0 / 30, paused: reduceMotion)) { canvas($0.date) }
            }
        }
        .frame(height: 11)
        .accessibilityHidden(true)
    }

    private func painter(_ size: CGSize, _ now: Date) -> ReloLightBarPainter {
        ReloLightBarPainter(segments: segments, kind: kind, color: color, live: live, size: size, reduceMotion: reduceMotion,
                            t: now.timeIntervalSinceReferenceDate, e: reduceMotion ? 60 : now.timeIntervalSince(openedAt))
    }

    private func canvas(_ now: Date) -> some View {
        Canvas { ctx, size in
            var sink = GraphicsContextSink(ctx: ctx)
            painter(size, now).paint(&sink)
        }
    }
}

/// The expanded notch's plan bar at one instant.
struct ReloLightBarPainter {
    let segments: [PlanBar.Segment]
    let kind: ReloOpenKind
    let color: Color
    let live: Bool
    let size: CGSize
    let reduceMotion: Bool
    let t: Double
    /// Seconds since the expansion opened.
    let e: Double

    func paint<S: ReloPaintSink>(_ ctx: inout S) {
        let bars = ReloBarPainter(t: t, reduceMotion: reduceMotion)
        let y = size.height / 2 - 1.5
        switch kind {
        case .done:
            // The finish sweeps mint over an empty track (the plan's own colour would flash first).
            let track = PlanBar.make(done: 0, total: segments.count, current: nil, fill: nil).segments
            bars.planBar(&ctx, x: 0, y: y, width: size.width, segments: track.isEmpty ? segments : track, color: color,
                         live: false, flashIndex: nil, flash: 0, full: Ease.inOut(Ease.seg(e, 0.2, 1.1)))
        case .started:
            // The wing's own gesture, wider: the plan draws in from the left behind a bright head.
            let drawn = Ease.inOut(Ease.seg(e, 0.3, 1.1))
            var c = ctx
            c.clip(rect: CGRect(x: -2, y: 0, width: size.width * drawn + 2, height: size.height))
            bars.planBar(&c, x: 0, y: y, width: size.width, segments: segments, color: color, live: drawn >= 1,
                         flashIndex: nil, flash: 0, full: 0)
            if drawn > 0, drawn < 1, !reduceMotion {
                var glow = ctx
                glow.blend = .plusLighter
                let o = CGPoint(x: size.width * drawn, y: size.height / 2)
                glow.fillEllipse(CGRect(x: o.x - 6, y: o.y - 6, width: 12, height: 12),
                                 .radial(Gradient(colors: [.white.opacity(0.8), color.opacity(0.35), color.opacity(0)]),
                                         center: o, startRadius: 0, endRadius: 6))
            }
        default:
            let flashIndex = kind == .running ? segments.lastIndex { $0.state == .done } : nil
            bars.planBar(&ctx, x: 0, y: y, width: size.width, segments: segments, color: color, live: live,
                         flashIndex: flashIndex, flash: kind == .running ? Ease.decay(e, 0.36, 2.6) : 0, full: 0)
        }
    }
}

/// The expanded notch's light, painted behind its content: the wings' beams come down the sides and meet at the bottom,
/// a flat flare where they meet turns into the state's wash rising from the bottom edge, and each state keeps its own
/// idle life (a question breathes and asks again, running work breathes, a failure flashes the edge and goes still).
/// The wash is centred at the bottom and gone well before the sides, so the notch's outline never cuts it off.
struct ReloOpenLight: View {
    let kind: ReloOpenKind
    let openedAt: Date
    var bottomRadius: CGFloat = 14
    @Environment(\.reloFrozenNow) private var frozen
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Group {
            if let frozen {
                if ReloEffects.bench {
                    ReloBenchMetal(outset: ReloEffectOutset.openLight) { size, sink in
                        var painter = painter(size, frozen)
                        painter.paint(&sink)
                    }
                } else {
                    canvas(frozen)
                }
            } else if ReloEffects.metal {
                ReloEffectView(outset: ReloEffectOutset.openLight, paused: reduceMotion) { canvas in
                    var painter = painter(canvas.size, canvas.now)
                    var sink = canvas.sink()
                    painter.paint(&sink)
                }
            } else {
                TimelineView(.animation(minimumInterval: 1.0 / 30, paused: reduceMotion)) { canvas($0.date) }
            }
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    private func painter(_ size: CGSize, _ now: Date) -> ReloOpenLightPainter {
        ReloOpenLightPainter(kind: kind, size: size, bottomRadius: bottomRadius, reduceMotion: reduceMotion,
                             t: now.timeIntervalSinceReferenceDate, e: reduceMotion ? 60 : now.timeIntervalSince(openedAt))
    }

    private func canvas(_ now: Date) -> some View {
        Canvas { ctx, size in
            var painter = painter(size, now)
            var sink = GraphicsContextSink(ctx: ctx)
            painter.paint(&sink)
        }
    }
}

struct ReloOpenLightPainter {
    let kind: ReloOpenKind
    let size: CGSize
    let bottomRadius: CGFloat
    let reduceMotion: Bool
    let t: Double
    let e: Double

    mutating func paint<S: ReloPaintSink>(_ ctx: inout S) {
        let color = kind.color
        wash(&ctx, color, strength)
        rimLight(&ctx, color)
        guard !reduceMotion else { return }
        if kind.handsOff, e < 0.7 { beams(&ctx, Ease.seg(e, 0, 0.6), color, alpha: 1) }
        if kind == .needs, e > 7.8 {
            let local = (e - 7.8).truncatingRemainder(dividingBy: 7.2)
            if local < 0.6 { beams(&ctx, local / 0.6, color, alpha: 0.5) }
        }
        let flare = kind.handsOff ? Ease.decay(e, 0.6, 3) : 0
        if flare > 0.01 {
            var c = ctx
            c.blend = .plusLighter
            let o = CGPoint(x: size.width / 2, y: size.height - 1)
            c.fillEllipse(CGRect(x: o.x - 20, y: o.y - 3.5, width: 40, height: 7), .radial(Gradient(colors: [Color.white.opacity(0.5 * flare), color.opacity(0.4 * flare), color.opacity(0)]),
                                         center: o, startRadius: 0, endRadius: 20))
        }
    }

    /// The wash's strength over time: it rises once the beams meet, then each state's idle level.
    private var strength: Double {
        let rise = kind.handsOff ? Ease.out(Ease.seg(e, 0.6, 1.1)) : Ease.out(Ease.seg(e, 0.1, 0.6))
        let breathe = { (period: Double) in self.reduceMotion ? 0 : sin(2 * .pi * self.t / period) }
        let idle: Double = switch kind {
        case .needs: 0.85 + 0.15 * breathe(3.6)
        case .turn: 0.7 + 0.2 * breathe(4.2)
        case .running: 0.65 + 0.1 * breathe(3.5)
        case .failed: 0.45 + 0.55 * Ease.decay(e, 0.6, 1.4)
        case .started: 0.55
        case .done: 0.5 + 0.5 * Ease.decay(e, 1.1, 1.2)
        }
        return rise * idle
    }

    /// One wide ellipse of the state's colour from below the bottom edge, peaking at 0.4 and fading to nothing
    /// long before the sides.
    private func wash<S: ReloPaintSink>(_ ctx: inout S, _ color: Color, _ strength: Double) {
        guard strength > 0.001 else { return }
        let radius: CGFloat = 260, center = CGPoint(x: size.width / 2, y: size.height + 12)
        var c = ctx
        c.clip(rect: CGRect(origin: .zero, size: size))
        c.blend = .plusLighter
        c.translate(x: center.x, y: center.y)
        c.scale(x: 1, y: max(0.2, size.height * 1.1 / radius))
        c.fillEllipse(CGRect(x: -radius, y: -radius, width: 2 * radius, height: 2 * radius), .radial(
            Gradient(stops: [.init(color: color.opacity(0.4 * strength), location: 0),
                             .init(color: color.opacity(0.17 * strength), location: 0.35),
                             .init(color: color.opacity(0.035 * strength), location: 0.7),
                             .init(color: color.opacity(0), location: 1)]),
            center: .zero, startRadius: 0, endRadius: radius))
    }

    /// A short line of light along the bottom edge: a question's slow pulse, a failure's two flashes.
    private func rimLight<S: ReloPaintSink>(_ ctx: inout S, _ color: Color) {
        let alpha: Double = switch kind {
        case .needs: Ease.seg(e, 0.6, 1.1) * (0.10 + (reduceMotion ? 0 : 0.08 * sin(2 * .pi * t / 3.6)))
        case .failed: reduceMotion ? 0 : 0.6 * max(Ease.decay(e, 0.36, 9), 0.8 * Ease.decay(e, 0.66, 9))
        default: 0
        }
        guard alpha > 0.005 else { return }
        let y = size.height - 1.2
        ctx.blurredLines([CGPoint(x: size.width / 2 - 60, y: y), CGPoint(x: size.width / 2 + 60, y: y)],
                         .linear(Gradient(colors: [color.opacity(0), color.opacity(alpha * 2.5), color.opacity(0)]),
                                 start: CGPoint(x: size.width / 2 - 60, y: y), end: CGPoint(x: size.width / 2 + 60, y: y)),
                         lineWidth: 1.6, blur: 3)
    }

    /// Two lights start at the top corners (where the wings' beams ended), run down the sides and along the bottom, and
    /// meet in the middle: the closed notch sent the light up, the open one brings it back down.
    private func beams<S: ReloPaintSink>(_ ctx: inout S, _ p: Double, _ color: Color, alpha: Double) {
        guard p > 0, p < 1 else { return }
        let edge = EdgeTrack(size: size, top: 0, bottom: bottomRadius)
        let half = edge.length / 2, d = Ease.inOut(p) * half
        let fade = alpha * (p < 0.85 ? 1 : (1 - p) / 0.15)
        var c = ctx
        c.blend = .plusLighter
        for (head, dir) in [(d, -1.0), (edge.length - d, 1.0)] {
            for k in 0..<48 {
                let at = head + dir * Double(k) * 0.7
                guard at >= 0, at <= edge.length else { continue }
                let f = Double(k) / 48, point = edge.point(at), r = 1.45 - 0.95 * f
                c.fillEllipse(CGRect(x: point.x - r, y: point.y - r, width: 2 * r, height: 2 * r), .color(color.opacity(pow(1 - f, 1.4) * 0.9 * fade)))
            }
            let o = edge.point(head)
            c.fillEllipse(CGRect(x: o.x - 4.5, y: o.y - 4.5, width: 9, height: 9), .radial(Gradient(colors: [Color.white.opacity(0.55 * fade), color.opacity(0.25 * fade), color.opacity(0)]),
                                         center: o, startRadius: 0, endRadius: 4.5))
        }
    }
}

/// The bench's Metal frames: a painter drawn through ReloEffectRenderer into an image, placed in a Canvas.
struct ReloBenchMetal: View {
    var outset: CGFloat = 0
    let paint: (CGSize, inout ReloMetalSink) -> Void

    var body: some View {
        Canvas { context, size in Self.draw(in: context, size: size, outset: outset, body: nil, paint) }
    }

    /// Draws past the canvas by `outset`, as the live layer does.
    static func draw(in context: GraphicsContext, size: CGSize, outset: CGFloat, body: Path?, _ paint: (CGSize, inout ReloMetalSink) -> Void) {
        guard let renderer = ReloEffectRenderer.shared else { return }
        let canvas = ReloEffectCanvas(size: size, outset: outset, now: .distantPast, scale: ReloEffectRenderer.benchScale, renderer: renderer)
        var sink = canvas.sink(body: body)
        paint(size, &sink)
        if let recording = canvas.recording, let image = renderer.image(recording) {
            context.draw(Image(decorative: image, scale: ReloEffectRenderer.benchScale),
                         in: CGRect(x: -outset, y: -outset, width: size.width + 2 * outset, height: size.height + 2 * outset))
        }
    }
}

/// How far each effect may draw past its frame: the rim's blur and the beams' blooms (wings, open light), the bar's
/// finishing glow.
enum ReloEffectOutset {
    static let wings: CGFloat = 10
    static let openLight: CGFloat = 6
    static let bar: CGFloat = 8
}

#if DEBUG
extension ReloOrbitMoment {
    /// A moment built directly, for the snapshot bench.
    init(kind: Kind, rowID: String, bar: [PlanBar.Segment]?, at: Date) {
        self.kind = kind
        self.rowID = rowID
        self.bar = bar
        self.at = at
    }
}

/// The wings at one instant, for the snapshot bench's frame-by-frame recordings.
struct ReloOrbitFrame: View {
    let scene: ReloOrbitScene
    let moment: ReloOrbitMoment?
    let wing: CGFloat
    let side: CGFloat
    let now: Date

    var body: some View {
        Canvas { context, size in
            var painter = ReloOrbitPainter(scene: scene, moment: moment, wing: wing, side: side, size: size,
                                           reduceMotion: false, now: now)
            if ReloEffects.bench {
                ReloBenchMetal.draw(in: context, size: size, outset: ReloEffectOutset.wings, body: painter.body) { painter.paint(&$1) }
            } else {
                var sink = GraphicsContextSink(ctx: context, body: painter.body)
                painter.paint(&sink)
            }
        }
    }
}
#endif
