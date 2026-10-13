import ReloCore
import SwiftUI

/// The Now deck, edge to edge: a dust field across the full width, the particle sphere in the
/// middle colored by what today's work meant, an instrument ring with each running task's
/// progress, four corner readouts, one sentence, and a footer that says where the data stands
/// and what the colors mean. Touching the sphere sends a ripple through all of it.
/// Its height never changes with the numbers it shows.
struct ReloNowHero: View {
    let summary: InboxTodaySummary
    /// Requests awaiting a response; `nil` while they are being checked.
    let needsYou: Int?
    /// The live cards, with their reported progress.
    let tasks: [ReloHoloTask]
    /// The coding agents running now (mid-turn). A count of their own, never added to RUNNING;
    /// with no live card they take the centre and the ring.
    var agents: [ReloHoloTask] = []
    /// Today's work by meaning (colors the sphere, the dust and the legend).
    var mix = NowMix(counts: [:])
    /// Requests waiting for the owner, orbiting as satellites toward their deadlines.
    var satellites: [ReloOrbitSatellite] = []
    /// "4h 12m" of agent work today, shown at the footer's trailing edge.
    var agentTime: String? = nil
    var sync: ReloDeckFooter.Sync = .syncing
    var pendingResponses = 0
    var connectionTrouble: String? = nil
    /// Space for the status bar: the deck runs to the top of the screen.
    var topInset: CGFloat = 0
    /// How far the ambient layers (orbit plane, dust) run past the deck on each side. Zero when
    /// the deck spans the screen; in landscape it reaches under the Dynamic Island and beyond the
    /// deck's column, so the orbit never stops at a column edge.
    var bleed: CGFloat = 0
    var showConnection: () -> Void = {}
    /// Owns the deck's phase, the boot's reveal and the effect bus (see `ReloDeckDirector`).
    var director: ReloDeckDirector? = nil
    /// Pull-to-sync: the title prompts and the sphere swells as the page is pulled.
    var pull: ReloPullTracker? = nil
    var refreshing = false
    private var phase: ReloDeckDirector.Phase { director?.phase ?? .live }
    private var level: Int { director?.revealed ?? 6 }
    private var trace: CGFloat { director?.ringTrace ?? 1 }
    private var armed: Bool { director?.armed ?? true }
    @State private var waves: [ReloOrbWave] = []
    @State private var width: CGFloat = 393
    @State private var deckHeight: CGFloat = 460
    @State private var taps = 0
    /// While a ripple or a state change is moving, effects draw at 60 fps so motion stays smooth;
    /// at rest they drop to 30 (slow drift reads the same, at half the work).
    @State private var boosted = false
    @State private var boostTask: Task<Void, Never>?
    private var fps: Double { boosted ? 60 : 30 }
    private let stageHeight: CGFloat = 330
    @ScaledMetric(relativeTo: .largeTitle) private var countSize: CGFloat = 64
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// Which live state the centre is showing when both are live; it alternates.
    @State private var focus = 0

    /// Live cards.
    private var running: Int { tasks.count }
    /// Agents running now.
    private var agentCount: Int { agents.count }
    /// No card is live but agents are running: the centre and the ring show the agents.
    private var agentsLead: Bool { running == 0 && agentCount > 0 }
    /// The ring's arcs: the live cards, or the running agents when no card is live.
    private var ringTasks: [ReloHoloTask] { agentsLead ? agents : tasks }

    /// Everything live right now, most urgent first. The centre walks through these.
    private var live: [ReloSignalState] {
        var states: [ReloSignalState] = []
        if let needsYou, needsYou > 0 { states.append(.needsYou) }
        if running > 0 || agentCount > 0 { states.append(.running) }
        return states
    }

    private var state: ReloSignalState {
        live.isEmpty ? .clear : live[focus % live.count]
    }

    /// The centre shows what matters most right now; when nothing is live, how today went.
    private var readout: (value: String, label: String) {
        if let greeting = director?.greeting { return ("relo", greeting) }
        // Until the director hands over, the lens keeps the wordmark: no flash of the live count.
        if phase != .live { return ("relo", director?.linking == true ? "LINKING" : "CONNECTING") }
        guard let needsYou else { return ("–", "CHECKING") }
        switch state {
        case .needsYou: return (needsYou.formatted(), "NEEDS YOU")
        case .running: return agentsLead ? (agentCount.formatted(), "AGENTS") : (running.formatted(), "RUNNING")
        case .clear: return (summary.total.formatted(), "TODAY")
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            // The page's title, in the deck's own voice rather than a navigation bar band.
            ReloPullTitle(pull: pull, refreshing: refreshing, accent: ReloHoloTheme.accent(for: state))
                .padding(.top, topInset + 4)
                .accessibilityLabel("Now").accessibilityAddTraits(.isHeader)
            ZStack {
                // Far half of the orbital plane, then the plasma core and its particle shell,
                // then the near half crossing in front: the orb sits inside the plane.
                ReloOrbitPlane(half: .far, state: state, mix: mix, satellites: satellites, framesPerSecond: fps,
                               waves: waves, center: CGPoint(x: stageCenter.x + bleed, y: stageCenter.y),
                               deckOffset: CGPoint(x: -bleed, y: stageTop))
                    // Drawn wider than the deck, laid out at the deck's width: only the drawing bleeds.
                    .frame(width: width + bleed * 2).frame(width: max(width, 1))
                ReloPullStretch(pull: pull) {
                    ReloPlasmaOrb(state: state, mix: mix, wave: waves.last,
                                  waveOffset: CGPoint(x: width / 2 - 150, y: stageTop + stageHeight / 2 - 150),
                                  framesPerSecond: fps)
                        .frame(width: 300, height: 300)
                    ReloSignalOrb(state: state, emissionTrigger: summary.total, mix: mix, waves: waves,
                                  waveOffset: CGPoint(x: width / 2 - 165, y: stageTop + stageHeight / 2 - 165), sparse: true,
                                  framesPerSecond: fps)
                        .frame(width: 330, height: 330)
                        .opacity(0.75)
                }
                ReloOrbitPlane(half: .near, state: state, mix: mix, satellites: satellites, framesPerSecond: fps,
                               waves: waves, center: CGPoint(x: stageCenter.x + bleed, y: stageCenter.y),
                               deckOffset: CGPoint(x: -bleed, y: stageTop))
                    // Drawn wider than the deck, laid out at the deck's width: only the drawing bleeds.
                    .frame(width: width + bleed * 2).frame(width: max(width, 1))
                ReloHoloRing(state: state, tasks: ringTasks, pulse: summary.total, finished: summary.finished, framesPerSecond: fps)
                    .frame(width: 286, height: 286)
                    // Booting, the ring draws itself around the sphere over a faint outline of itself.
                    .mask { if trace < 1 { ReloRingTrace(progress: trace) } else { Rectangle() } }
                    .background { if trace < 1 { Circle().stroke(Color.white.opacity(0.08), lineWidth: 1).frame(width: 282, height: 282) } }
                leaders
                    .opacity(level >= 6 ? 1 : 0)
                centre
                    .opacity(director?.badge == nil ? 1 : 0)
                    .animation(.smooth(duration: 0.3), value: director?.badge == nil)
                if let badge = director?.badge {
                    ReloHUDBadge(badge: badge, color: badge.warning ? ReloHoloTheme.amber : ReloHoloTheme.accent(for: state))
                        .id(badge.id)
                        .transition(.opacity)
                }
                corners.padding(.horizontal, ReloLayout.screenInset)
            }
            .frame(maxWidth: .infinity)
            .frame(height: stageHeight)
            ReloDeckFooter(sync: sync, pendingResponses: pendingResponses, mix: mix, agentTime: agentTime,
                           trouble: connectionTrouble, showConnection: showConnection)
                .padding(.horizontal, ReloLayout.screenInset)
                .padding(.top, 8)
                .padding(.bottom, 18)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 4)
        .background(alignment: .top) { deckBackground }
        .background { GeometryReader { proxy in Color.clear
            .onAppear { width = proxy.size.width; deckHeight = proxy.size.height }
            .onChange(of: proxy.size) { _, new in width = new.width; deckHeight = new.height } } }
        .coordinateSpace(name: "deck")
        .contentShape(Rectangle())
        // Tap the deck and a ripple runs through the sphere and the dust. Taps only: any drag
        // recognizer on content inside a ScrollView competes with scrolling (iOS 18) and made the
        // pull-down feel stuck.
        .onTapGesture(coordinateSpace: .named("deck")) { location in
            guard !reduceMotion else { return }
            addWave(at: location, strength: 1.3); taps += 1
        }
        .sensoryFeedback(.impact(weight: .light, intensity: 0.6), trigger: taps)
        .modifier(ReloDeckEffects(director: director, armed: armed) { strength in
            addWave(at: orbCenter, strength: strength)
        })
        .onChange(of: state) { _, _ in boost(for: 1.6) }
        .dynamicTypeSize(...DynamicTypeSize.accessibility2)
        .animation(reduceMotion ? nil : .smooth(duration: 0.5), value: summary.total)
        // With both a request and running work, the centre alternates between them.
        .task(id: live.count) {
            focus = 0
            guard live.count > 1, !reduceMotion else { return }
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(3.6))
                withAnimation(.smooth(duration: 0.7)) { focus += 1 }
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Today")
        .accessibilityValue("\(headline). \(summary.total) today, \(running) running, \(agentsPhrase(agentCount)), "
            + "\(needsYou.map { "\($0) need you" } ?? "requests still being checked"). \(detail)")
    }

    /// The stage starts below the status bar and the title line.
    private var stageTop: CGFloat { topInset + 22 }
    private var orbCenter: CGPoint { CGPoint(x: width / 2, y: stageTop + stageHeight / 2) }
    private var stageCenter: CGPoint { CGPoint(x: width / 2, y: stageHeight / 2) }

    /// Draw at 60 fps for the next few seconds, while motion is fast.
    private func boost(for seconds: Double = 2.8) {
        boosted = true
        boostTask?.cancel()
        boostTask = Task { @MainActor in
            try? await Task.sleep(for: .seconds(seconds))
            if !Task.isCancelled { boosted = false }
        }
    }

    private func addWave(at point: CGPoint, strength: Double) {
        let now = Date.now
        boost()
        waves = waves.filter { now.timeIntervalSince($0.at) < 2.6 }.suffix(7) + [ReloOrbWave(origin: point, at: now, strength: strength)]
    }

    /// Full-width light behind the sphere in the state's color, falling to ink at the edges, with
    /// the dust field over it. It fades out at the bottom into the page.
    private var deckBackground: some View {
        // Neither layer stops at the deck's edges, so the deck never shows where it ends: the glow
        // is a circle centred on the sphere that fades to nothing above (under a pull) and below,
        // and the dust runs past the deck's bottom, fading out over the page. No mask over the
        // animated layer: masking it forced the whole deck to re-rasterize every frame.
        ZStack(alignment: .top) {
            RadialGradient(colors: [ReloHoloTheme.accent(for: state).opacity(0.16),
                                    ReloHoloTheme.accent(for: state).opacity(0.05), .clear],
                           center: .center, startRadius: 40, endRadius: 360)
                // The whole circle, never cut to the deck's width: in landscape the deck is half
                // the screen, and a width-clipped glow showed as a lit box around it.
                .frame(width: max(width, 760), height: 760)
                .offset(y: orbCenter.y - 380)
                .animation(reduceMotion ? nil : .smooth(duration: 0.9), value: state)
            ReloDeckField(state: state, mix: mix, waves: waves, deckOffsetX: -bleed)
                .frame(width: max(width + bleed * 2, 1), height: deckHeight + 220)
        }
        .allowsHitTesting(false)
    }

    /// Four fixed corner readouts, so a number never moves; the one the centre shows lights up.
    private var corners: some View {
        let asks = needsYou.map { $0.formatted() } ?? "–"
        return VStack {
            HStack(alignment: .top) {
                ReloHUDModule(corner: .topLeading, index: "01", label: "TODAY", value: summary.total.formatted(),
                              color: .white, lit: false, focused: state == .clear, gauge: .mix(mix), buildStart: director?.moduleBuilds[2])
                    .modifier(ReloBootIn(on: level >= 2, corner: CGPoint(x: 1, y: 1)))
                Spacer(minLength: 0)
                ReloHUDModule(corner: .topTrailing, index: "02", label: "AGENTS", value: agentCount.formatted(),
                              color: ReloHoloTheme.agents, lit: agentCount > 0, focused: state == .running && agentsLead,
                              gauge: .items(agentCount), buildStart: director?.moduleBuilds[3])
                    .modifier(ReloBootIn(on: level >= 3, corner: CGPoint(x: -1, y: 1)))
            }
            Spacer(minLength: 0)
            HStack(alignment: .bottom) {
                ReloHUDModule(corner: .bottomLeading, index: "03", label: "RUNNING", value: running.formatted(),
                              color: ReloHoloTheme.color(.running), lit: running > 0, focused: state == .running && !agentsLead,
                              gauge: .items(running), buildStart: director?.moduleBuilds[5])
                    .modifier(ReloBootIn(on: level >= 5, corner: CGPoint(x: 1, y: -1)))
                Spacer(minLength: 0)
                ReloHUDModule(corner: .bottomTrailing, index: "04", label: "NEEDS YOU", value: asks,
                              color: ReloHoloTheme.color(.needsYou), lit: (needsYou ?? 0) > 0,
                              focused: state == .needsYou, gauge: .items(needsYou ?? 0), buildStart: director?.moduleBuilds[4])
                    .modifier(ReloBootIn(on: level >= 4, corner: CGPoint(x: -1, y: -1)))
            }
        }
        .padding(.vertical, 6)
    }

    /// Leaders from each module's gauge to the ring, so the corners read as one instrument.
    private var leaders: some View {
        let inset = ReloLayout.screenInset
        let near: CGFloat = inset + 82, far = width - inset - 82
        let topY: CGFloat = 66, bottomY = stageHeight - 12
        return ReloHUDLeaders(center: stageCenter, ringRadius: 141, anchors: [
            (.topLeading, CGPoint(x: near, y: topY), Color.white, false, summary.total),
            (.topTrailing, CGPoint(x: far, y: topY), ReloHoloTheme.agents, agentCount > 0, agentCount),
            (.bottomLeading, CGPoint(x: near, y: bottomY), ReloHoloTheme.color(.running), running > 0, running),
            (.bottomTrailing, CGPoint(x: far, y: bottomY), ReloHoloTheme.color(.needsYou), (needsYou ?? 0) > 0, needsYou ?? 0),
        ])
    }

    /// The count over the sphere's dark lens, with a status line whose dot breathes while live.
    private var centre: some View {
        let accent = needsYou == nil ? Color.reloSecondaryText
            : state == .running && agentsLead ? ReloHoloTheme.agents : ReloHoloTheme.accent(for: state)
        let isLive = state != .clear && needsYou != nil
        let colors = ReloHoloTheme.colors(for: state)
        return VStack(spacing: 2) {
            // While something is live the count breathes and its light drifts through the state's colors.
            ReloMotionClock(live: isLive, framesPerSecond: 30, still: 0) { time in
                let wave = isLive ? (sin(time * (state == .needsYou ? 3.4 : 2.2)) + 1) / 2 : 0
                Text(readout.value)
                    .font(.system(size: countSize, weight: .light, design: .rounded))
                    .tracking(-1)
                    .foregroundStyle(isLive
                        ? AnyShapeStyle(LinearGradient(colors: [.white, colors[Int(time * 0.5) % 3 + 1]],
                                                       startPoint: .top, endPoint: .bottom))
                        : AnyShapeStyle(Color.white))
                    .shadow(color: accent.opacity(0.4 + 0.45 * wave), radius: 10 + 12 * wave)
                    .scaleEffect(1 + 0.03 * wave)
                    .lineLimit(1).minimumScaleFactor(0.4)
            }
            .contentTransition(.numericText())
            .animation(reduceMotion ? nil : .smooth(duration: 0.5), value: readout.value)
            .id(readout.label)
            .transition(.reloSoftSwap)
            HStack(spacing: 6) {
                ReloStatusDot(color: accent, live: state != .clear || needsYou == nil)
                Text(readout.label)
                    .font(.system(.caption2, design: .monospaced).weight(.semibold)).tracking(2)
                    .foregroundStyle(accent)
            }
            .lineLimit(1).minimumScaleFactor(0.6)
        }
        .frame(width: 160)
    }

    private var headline: String {
        guard let needsYou else { return "Checking requests…" }
        if needsYou > 0 { return needsYou == 1 ? "1 request needs you" : "\(needsYou) requests need you" }
        if running > 0 { return running == 1 ? "1 task running" : "\(running) tasks running" }
        if agentCount > 0 { return agentsPhrase(agentCount) }
        return "All clear"
    }

    /// "1 agent running", "3 agents running", "no agents running".
    private func agentsPhrase(_ count: Int) -> String {
        count == 0 ? "no agents running" : count == 1 ? "1 agent running" : "\(count) agents running"
    }

    /// One calm sentence that says what the numbers mean, never repeating them.
    private var detail: String {
        guard let needsYou else { return "Checking for requests…" }
        if needsYou > 0 {
            let waiting = needsYou == 1 ? "A request is waiting for your answer below" : "Requests are waiting for your answer below"
            return running > 0 || agentCount > 0 ? "\(waiting), and work is still running." : "\(waiting)."
        }
        if running > 0 { return running == 1 ? "One task is running. Its progress is on the ring." : "\(running) tasks are running. Their progress is on the ring." }
        if agentCount > 0 {
            return agentCount == 1 ? "An agent is working without a live card. It circles the ring."
                : "\(agentCount) agents are working without a live card. They circle the ring."
        }
        if summary.total == 0 { return "New requests from your agents arrive here." }
        return "All clear. Nothing needs you right now."
    }
}

/// A small status light: steady when idle, breathing while something is live.
private struct ReloStatusDot: View {
    let color: Color
    let live: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var lit = false

    var body: some View {
        Circle().fill(color).frame(width: 6, height: 6)
            .background { Circle().fill(color.opacity(0.5)).frame(width: 12, height: 12).blur(radius: 3)
                .opacity(live && lit ? 1 : 0.35) }
            .opacity(live && !lit ? 0.55 : 1)
            .onAppear { if live && !reduceMotion { withAnimation(.easeInOut(duration: 1.1).repeatForever()) { lit = true } } }
            .accessibilityHidden(true)
    }
}

/// A corner module powering on, like a display warming up: it flickers once, then settles in
/// from just inside its corner as it comes into focus. No overshoot, no bounce. Plain timed
/// steps rather than keyframes: a cubic keyframe after a zero-length one produced NaN geometry.
private struct ReloBootIn: ViewModifier {
    let on: Bool
    /// The direction toward the deck's centre, so modules arrive from their own corner.
    let corner: CGPoint
    /// The ceremony powers modules on with a flicker; any other change is a quiet fade.
    var flicker = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var shown: Double?
    /// 1 out of focus and just inside the corner, 0 settled.
    @State private var settle: Double?

    func body(content: Content) -> some View {
        let opacity = shown ?? (on ? 1 : 0), unsettled = settle ?? (on ? 0 : 1)
        content
            .opacity(opacity)
            .blur(radius: 5 * unsettled)
            .offset(x: -corner.x * 10 * unsettled, y: -corner.y * 8 * unsettled)
            .task(id: on) {
                guard on else {
                    withAnimation(reduceMotion ? nil : .smooth(duration: 0.6)) { shown = 0; settle = 1 }
                    return
                }
                // Already on (a rebuilt view, or the first appearance): nothing to replay.
                guard shown == 0, !reduceMotion else { shown = 1; settle = 0; return }
                guard flicker else {
                    // The module builds its own parts; this only brings it onto the deck.
                    withAnimation(.easeOut(duration: 0.2)) { shown = 1; settle = 0 }
                    return
                }
                withAnimation(.easeOut(duration: 0.55)) { settle = 0 }
                for (value, ms) in [(0.55, 70), (0.15, 70), (0.7, 60)] {
                    withAnimation(.linear(duration: Double(ms) / 1000)) { shown = value }
                    try? await Task.sleep(for: .milliseconds(ms))
                    if Task.isCancelled { return }
                }
                withAnimation(.easeOut(duration: 0.35)) { shown = 1 }
            }
    }
}

/// The boot's ring reveal: a sweep from twelve o'clock round the sphere.
private struct ReloRingTrace: View {
    var progress: CGFloat
    var body: some View {
        Circle().trim(from: 0, to: progress)
            .stroke(Color.black, style: StrokeStyle(lineWidth: 160, lineCap: .butt))
            .rotationEffect(.degrees(-90))
            .frame(width: 160, height: 160)
    }
}

extension AnyTransition {
    /// Readouts swap by softly dissolving through a blur, never popping in scale.
    static var reloSoftSwap: AnyTransition {
        .modifier(active: ReloSoftSwap(amount: 1), identity: ReloSoftSwap(amount: 0))
    }
}

private struct ReloSoftSwap: ViewModifier {
    let amount: Double
    func body(content: Content) -> some View {
        content.opacity(1 - amount).blur(radius: 6 * amount).scaleEffect(1 - 0.03 * amount)
    }
}

/// The deck's title, which doubles as the pull-to-sync prompt.
private struct ReloPullTitle: View {
    let pull: ReloPullTracker?
    let refreshing: Bool
    let accent: Color

    var body: some View {
        let distance = pull?.distance ?? 0
        let armed = pull?.armed ?? false
        let text = refreshing || (pull?.released ?? false) ? "SYNCING"
            : armed ? "RELEASE TO SYNC" : distance > 18 ? "PULL TO SYNC" : "RELO · NOW"
        Text(text)
            .font(.system(.caption2, design: .monospaced).weight(.semibold)).tracking(3)
            .foregroundStyle(text == "RELO · NOW" ? Color.reloSecondaryText : accent)
            .contentTransition(.opacity)
            .animation(.smooth(duration: 0.25), value: text)
            .sensoryFeedback(.impact(weight: .light, intensity: 0.7), trigger: pull?.armings ?? 0)
    }
}

/// The sphere swelling a little as the page is pulled, as if drawn toward the finger.
private struct ReloPullStretch<Content: View>: View {
    let pull: ReloPullTracker?
    @ViewBuilder let content: Content
    var body: some View {
        let distance = min(pull?.distance ?? 0, 160)
        content.scaleEffect(1 + distance / 900)
    }
}

/// The director's effects on the deck: its haptics (the finished sign-in, a genuinely new request),
/// one ripple per tick of its effect bus, and whether changes are news for the parts below.
private struct ReloDeckEffects: ViewModifier {
    let director: ReloDeckDirector?
    let armed: Bool
    let ripple: (Double) -> Void

    func body(content: Content) -> some View {
        content
            .sensoryFeedback(.success, trigger: director?.successTicks ?? 0)
            .sensoryFeedback(.impact(weight: .light), trigger: director?.newsTicks ?? 0)
            .onChange(of: director?.waves ?? 0) { _, _ in ripple(director?.waveStrength ?? 0.8) }
            .environment(\.reloEffectsArmed, armed)
    }
}

/// A HUD status plate for state changes (LINKED, ONLINE, ACTIVE, OFFLINE): a header line with
/// two small labels, a bracketed frame, the word with chevrons closing in on it, and a segmented
/// bar beneath. It builds in, holds, and collapses out on its own clock.
struct ReloHUDBadge: View {
    let badge: ReloDeckDirector.Badge
    let color: Color
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        TimelineView(.animation(paused: reduceMotion)) { context in
            let t = reduceMotion ? 0.6 : context.date.timeIntervalSince(badge.start)
            plate(t: t)
        }
        .allowsHitTesting(false)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(badge.word.capitalized)
    }

    private static func window(_ t: Double, _ from: Double, _ to: Double) -> Double {
        min(max((t - from) / (to - from), 0), 1)
    }

    private func plate(t: Double) -> some View {
        let open = Self.window(t, 0, 0.35), out = Self.window(t, badge.duration - 0.35, badge.duration)
        let eased = 1 - pow(1 - open, 3)
        let word = Self.window(t, 0.25, 0.55)
        let wordOpacity = word >= 1 ? 1.0 : [0, 0.7, 0.2, 0.85, 0.4, 1][min(Int(word * 6), 5)]
        return VStack(spacing: 4) {
            HStack(spacing: 6) {
                Text(badge.left)
                Rectangle().fill(color.opacity(0.45)).frame(height: 0.5)
                Text(badge.right)
            }
            .font(.system(size: 7.5, weight: .semibold, design: .monospaced)).tracking(1.1)
            .foregroundStyle(color.opacity(0.85))
            .opacity(Self.window(t, 0.15, 0.45))
            ZStack {
                ReloBadgeFrame().stroke(Color.white.opacity(0.4), lineWidth: 1)
                ReloBadgeTicks().stroke(color.opacity(0.7), lineWidth: 1)
                    .opacity(Self.window(t, 0.3, 0.5))
                HStack(spacing: 10) {
                    chevrons(t: t, leading: true)
                    Text(badge.word)
                        .font(.system(size: 25, weight: .medium, design: .rounded)).tracking(1.5)
                        .foregroundStyle(color)
                        .shadow(color: color.opacity(0.5), radius: 8)
                        .opacity(wordOpacity)
                    chevrons(t: t, leading: false)
                }
            }
            .frame(width: 224, height: 42)
            .scaleEffect(x: 0.25 + 0.75 * eased, y: 1)
            HStack(spacing: 3) {
                Rectangle().fill(Color.white.opacity(0.18))
                Rectangle().fill(color.opacity(0.85)).scaleEffect(x: Self.window(t, 0.45, 0.85), anchor: .leading)
                Rectangle().fill(Color.white.opacity(0.18))
            }
            .frame(width: 200, height: 3)
            .overlay(alignment: .leading) { Rectangle().fill(color).frame(width: 1, height: 7) }
            .overlay(alignment: .trailing) { Rectangle().fill(color).frame(width: 1, height: 7) }
            .opacity(Self.window(t, 0.3, 0.5))
        }
        .frame(width: 224)
        .padding(.horizontal, 10).padding(.vertical, 8)
        .background(Color.black.opacity(0.55 * eased), in: RoundedRectangle(cornerRadius: 6))
        .fixedSize()
        .opacity(1 - out)
        .scaleEffect(x: 1 - 0.2 * out, y: 1 - 0.4 * out)
    }

    /// Two chevrons each side, sliding in toward the word and fading, on a loop.
    private func chevrons(t: Double, leading: Bool) -> some View {
        let phase = max(t - 0.55, 0).truncatingRemainder(dividingBy: 1.1) / 1.1
        let travel = 10 * (1 - phase), fade = sin(phase * .pi)
        return HStack(spacing: -3) {
            Image(systemName: leading ? "chevron.left" : "chevron.right").opacity(leading ? 0.5 : 1)
            Image(systemName: leading ? "chevron.left" : "chevron.right").opacity(leading ? 1 : 0.5)
        }
        .font(.system(size: 13, weight: .bold))
        .foregroundStyle(color)
        .offset(x: leading ? -travel : travel)
        .opacity(t < 0.55 || reduceMotion ? 0 : fade)
    }
}

/// The plate's frame: rounded brackets at each end joined by short top and bottom runs.
private struct ReloBadgeFrame: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        let r: CGFloat = 6, run: CGFloat = 18
        path.move(to: CGPoint(x: rect.minX + run, y: rect.minY))
        path.addLine(to: CGPoint(x: rect.minX + r, y: rect.minY))
        path.addQuadCurve(to: CGPoint(x: rect.minX, y: rect.minY + r), control: CGPoint(x: rect.minX, y: rect.minY))
        path.addLine(to: CGPoint(x: rect.minX, y: rect.maxY - r))
        path.addQuadCurve(to: CGPoint(x: rect.minX + r, y: rect.maxY), control: CGPoint(x: rect.minX, y: rect.maxY))
        path.addLine(to: CGPoint(x: rect.minX + run, y: rect.maxY))
        path.move(to: CGPoint(x: rect.maxX - run, y: rect.minY))
        path.addLine(to: CGPoint(x: rect.maxX - r, y: rect.minY))
        path.addQuadCurve(to: CGPoint(x: rect.maxX, y: rect.minY + r), control: CGPoint(x: rect.maxX, y: rect.minY))
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY - r))
        path.addQuadCurve(to: CGPoint(x: rect.maxX - r, y: rect.maxY), control: CGPoint(x: rect.maxX, y: rect.maxY))
        path.addLine(to: CGPoint(x: rect.maxX - run, y: rect.maxY))
        return path
    }
}

/// Small dashes inside the plate's corners, like the reference's registration marks.
private struct ReloBadgeTicks: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        let inset: CGFloat = 8
        for (x, dir) in [(rect.minX + inset, CGFloat(1)), (rect.maxX - inset, CGFloat(-1))] {
            for y in [rect.minY + inset, rect.maxY - inset] {
                path.move(to: CGPoint(x: x, y: y)); path.addLine(to: CGPoint(x: x + 3 * dir, y: y))
                path.move(to: CGPoint(x: x + 6 * dir, y: y)); path.addLine(to: CGPoint(x: x + 9 * dir, y: y))
            }
        }
        return path
    }
}
