import ReloCore
import SwiftUI

/// The Now deck, edge to edge: the particle sphere in the middle, an instrument ring with each running task's
/// progress, a gauge ring with four readouts docked on it (needs you, your turn, running, sessions), the sessions as
/// satellites on an outer orbit and the machines beneath; the title row above carries where the data stands, at its
/// trailing end. The lead state washes the top of the screen in its colour. Touching the sphere sends a ripple through all of it.
/// Its height never changes with the numbers it shows.
struct ReloNowHero: View {
    let summary: InboxTodaySummary
    /// Requests awaiting a response; `nil` while they are being checked.
    let needsYou: Int?
    /// The live cards, with their reported progress.
    let tasks: [ReloHoloTask]
    /// The sessions working now (mid-turn). A count of their own, never added to RUNNING;
    /// with no live card they take the centre and the ring.
    var sessionsWorking: [ReloHoloTask] = []
    /// Work waiting on the owner (the Waiting on you fold), never in SESSIONS.
    var waitingOnYou = 0
    /// The sessions at work, by phase, machine and harness: the satellites and the machines line.
    var sessions: [ReloHUDSession] = []
    /// Machines with no session at work (idle or ended sessions only): listed dim on the machines line.
    var idleMachines: [String] = []
    /// Today's work by meaning (colors the sphere and the dust).
    var mix = NowMix(counts: [:])
    var sync: ReloDeckFooter.Sync = .syncing
    var pendingResponses = 0
    var connectionTrouble: String? = nil
    /// Space for the status bar: the deck runs to the top of the screen.
    var topInset: CGFloat = 0
    var showConnection: () -> Void = {}
    /// Owns the deck's phase, the boot's reveal and the effect bus (see `ReloDeckDirector`).
    var director: ReloDeckDirector? = nil
    /// Pull-to-sync: the title prompts and the sphere swells as the page is pulled.
    var pull: ReloPullTracker? = nil
    var refreshing = false
    /// Captures only: forces the header's lead (the connecting state needs a booting director, which a gallery
    /// cannot make). `nil` in the app.
    var leadOverride: ReloHUDLead? = nil
    private var phase: ReloDeckDirector.Phase { director?.phase ?? .live }
    private var level: Int { director?.revealed ?? 6 }
    private var trace: CGFloat { director?.ringTrace ?? 1 }
    private var armed: Bool { director?.armed ?? true }
    @State private var waves: [ReloOrbWave] = []
    @State private var width: CGFloat = 393
    @State private var taps = 0
    /// While a ripple or a state change is moving, effects draw at 60 fps so motion stays smooth;
    /// at rest they drop to 30 (slow drift reads the same, at half the work).
    @State private var boosted = false
    @State private var boostTask: Task<Void, Never>?
    private var fps: Double { boosted ? 60 : 30 }
    /// The gauge ring the readouts dock on, and the orbit the satellites ride.
    private let gaugeRadius: CGFloat = 128
    private let orbitRadius: CGFloat = 164
    /// The satellites' canvas is the orbit plus 20 pt each side, which holds the parked ring's full swell; the
    /// stage is exactly that tall, so nothing at the top or bottom of the header clips.
    private var satelliteSide: CGFloat { orbitRadius * 2 + 40 }
    private var stageHeight: CGFloat { satelliteSide }
    /// How far the stage rises under the title row: the canvas's transparent margin is free to overlap it.
    private let stageLift: CGFloat = 14
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.reloMotionPaused) private var motionPaused

    /// Live cards.
    private var running: Int { tasks.count }
    /// Sessions working now.
    private var sessionCount: Int { max(sessions.count, sessionsWorking.count) }
    /// No card is live but sessions are working: the ring shows the sessions.
    private var sessionsLead: Bool { running == 0 && sessionCount > 0 }
    /// The ring's arcs: the live cards, or the working sessions when no card is live.
    private var ringTasks: [ReloHoloTask] { sessionsLead ? sessionsWorking : tasks }
    private var offline: Bool { if case .offline = sync { true } else { false } }

    /// The orb's state, as it always was: needs you over anything live, else calm. The owner's turn is an ask too.
    private var state: ReloSignalState {
        if (needsYou ?? 0) > 0 || waitingOnYou > 0 { return .needsYou }
        return running > 0 || sessionCount > 0 ? .running : .clear
    }

    /// What the header leads with: the system layer when the counts can't be trusted, else the first true state.
    private var lead: ReloHUDLead {
        if let leadOverride { return leadOverride }
        if phase != .live || director?.greeting != nil { return .connecting }
        if offline { return .offline }
        guard let needsYou else { return .checking }
        if needsYou > 0 { return .needsYou }
        if waitingOnYou > 0 { return .yourTurn }
        if running > 0 { return .running }
        return sessionCount > 0 ? .quiet : .clear
    }

    /// The centre: the lead's count still (it never alternates), or the wordmark when there is nothing to count.
    private var readout: (value: String?, label: String) {
        if let greeting = director?.greeting { return (nil, greeting) }
        switch lead {
        case .connecting: return (nil, director?.linking == true ? "LINKING" : "CONNECTING")
        case .offline: return (nil, "OFFLINE")
        case .checking: return ("–", "CHECKING")
        case .needsYou: return ((needsYou ?? 0).formatted(), "NEEDS YOU")
        case .yourTurn: return (waitingOnYou.formatted(), "YOUR TURN")
        case .running: return (running.formatted(), "RUNNING")
        case .quiet: return (sessionCount.formatted(), "SESSIONS")
        case .clear: return (nil, "ALL CLEAR")
        }
    }

    /// The satellites: the sessions as reported, or quiet ones standing in when only a count is known.
    private var satellites: [ReloHUDSession] {
        sessions.isEmpty ? sessionsWorking.map { ReloHUDSession(id: $0.id, phase: .quiet) } : sessions
    }

    var body: some View {
        VStack(spacing: 0) {
            // The page's title, in the deck's own voice rather than a navigation bar band, with where the data
            // stands at its trailing end.
            HStack(spacing: 8) {
                ReloPullTitle(pull: pull, refreshing: refreshing, accent: lead.accent)
                    .accessibilityLabel("Now").accessibilityAddTraits(.isHeader)
                ReloDeckFooter(sync: sync, pendingResponses: pendingResponses,
                               trouble: connectionTrouble, showConnection: showConnection)
            }
            .frame(height: 14)
            .padding(.horizontal, ReloLayout.screenInset)
            .padding(.top, topInset + 4)
            .zIndex(1)
            ZStack {
                if lead == .needsYou && !reduceMotion {
                    ReloNeedsPulse(diameter: 186, color: lead.accent)
                }
                ReloPullStretch(pull: pull) {
                    orb
                }
                .saturation(offline ? 0.12 : 1)
                .brightness(offline ? -0.4 : 0)
                .animation(.smooth(duration: 1.2), value: offline)
                // Offline the orb is still: its clocks hold their frame.
                .environment(\.reloMotionPaused, offline || motionPaused)
                ReloHoloRing(state: state, tasks: ringTasks, pulse: summary.total, finished: summary.finished, framesPerSecond: fps)
                    .frame(width: 256, height: 256)
                    // Booting, the ring draws itself around the sphere over a faint outline of itself.
                    .mask { if trace < 1 { ReloRingTrace(progress: trace) } else { Rectangle() } }
                    .background { if trace < 1 { Circle().stroke(Color.white.opacity(0.08), lineWidth: 1).frame(width: 252, height: 252) } }
                ReloGaugeRing(gauges: gauges, radius: gaugeRadius)
                    .frame(width: gaugeRadius * 2 + 12, height: gaugeRadius * 2 + 12)
                    .opacity(level >= 1 ? 1 : 0)
                ReloSatellites(sessions: satellites, radius: orbitRadius, frozen: offline || reduceMotion)
                    .frame(width: satelliteSide, height: satelliteSide)
                    .opacity(level >= 6 ? 1 : 0)
                ReloCentreReadout(value: readout.value, label: readout.label, lead: lead)
                    .frame(width: 180)
                    .opacity(director?.badge == nil ? 1 : 0)
                    .animation(.smooth(duration: 0.3), value: director?.badge == nil)
                if let badge = director?.badge {
                    ReloHUDBadge(badge: badge, color: badge.warning ? ReloHoloTheme.amber : lead.accent)
                        .id(badge.id)
                        .transition(.opacity)
                }
                tags
            }
            .frame(maxWidth: .infinity)
            .frame(height: stageHeight)
            .padding(.top, -stageLift)
            ReloFleetLegend(fleet: ReloFleetMachine.fleet(sessions, idle: idleMachines), frozen: offline)
                .padding(.horizontal, ReloLayout.screenInset)
                .opacity(level >= 6 ? 1 : 0)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 4)
        .background(alignment: .top) { ReloStateWash(lead: lead, center: CGPoint(x: width / 2, y: orbCenter.y)) }
        .background { GeometryReader { proxy in Color.clear
            .onAppear { width = proxy.size.width }
            .onChange(of: proxy.size.width) { _, new in width = new } } }
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
        .onChange(of: lead) { _, _ in boost(for: 1.6) }
        .dynamicTypeSize(...DynamicTypeSize.accessibility2)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Today")
        .accessibilityValue("\(headline). \(running) running, \(sessionsPhrase(sessionCount)), \(waitingOnYou) waiting on you, "
            + "\(needsYou.map { "\($0) need you" } ?? "requests still being checked"). \(detail)")
    }

    /// The sphere and the dust field around it.
    private var orb: some View {
        ZStack {
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
    }

    /// The stage starts below the status bar and the title row, less the lift.
    private var stageTop: CGFloat { topInset + 22 - stageLift }
    private var orbCenter: CGPoint { CGPoint(x: width / 2, y: stageTop + stageHeight / 2) }

    /// The four gauges: how full each readout is, lit only when it counts something.
    private var gauges: [ReloHUDSlot: ReloGaugeRing.Gauge] {
        // Connecting, no count is known yet: every gauge is unlit.
        if lead == .connecting { return [:] }
        let progress = tasks.compactMap(\.progress)
        let runFill = progress.isEmpty ? 0.5 : progress.reduce(0, +) / Double(progress.count)
        return [
            .needsYou: .init(fill: Double(needsYou ?? 0) / 5, lit: (needsYou ?? 0) > 0, dimmed: offline),
            .yourTurn: .init(fill: Double(waitingOnYou) / 5, lit: waitingOnYou > 0, dimmed: offline),
            .running: .init(fill: runFill, lit: running > 0, dimmed: offline),
            .sessions: .init(fill: Double(sessionCount) / 6, lit: sessionCount > 0, dimmed: offline),
        ]
    }

    /// The readouts, each docked where its gauge meets the ring: the leading ones end at the ring, the trailing
    /// ones start at it, so the number always sits nearest the instrument.
    private var tags: some View {
        // Connecting, all four read "–" and stay unlit and dashed.
        let unknown = lead == .connecting
        let values: [ReloHUDSlot: (String, Bool)] = unknown ? [:] : [
            .needsYou: (needsYou.map { $0.formatted() } ?? "–", (needsYou ?? 0) > 0),
            .yourTurn: (waitingOnYou.formatted(), waitingOnYou > 0),
            .running: (running.formatted(), running > 0),
            .sessions: (sessionCount.formatted(), sessionCount > 0),
        ]
        return ZStack {
            ForEach(ReloHUDSlot.allCases, id: \.self) { slot in
                let angle = slot.angle * .pi / 180
                let dock = CGPoint(x: width / 2 + cos(angle) * (gaugeRadius + 6), y: stageHeight / 2 + sin(angle) * (gaugeRadius + 6))
                let value = values[slot] ?? ("–", false)
                ReloDockedTag(slot: slot, value: value.0, lit: value.1 && !offline, dimmed: offline && value.1)
                    .frame(width: 180, alignment: slot.leading ? .trailing : .leading)
                    .position(x: slot.leading ? dock.x + 16 - 90 : dock.x - 16 + 90, y: dock.y)
                    .modifier(ReloBootIn(on: level >= 2 + slot.rawValue, corner: CGPoint(x: slot.leading ? 1 : -1, y: slot.angle > 180 ? 1 : -1)))
            }
        }
        .frame(width: width, height: stageHeight)
    }

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

    private var headline: String {
        guard let needsYou else { return "Checking requests…" }
        if needsYou > 0 { return needsYou == 1 ? "1 request needs you" : "\(needsYou) requests need you" }
        if waitingOnYou > 0 { return waitingOnYou == 1 ? "1 session waits for your reply" : "\(waitingOnYou) sessions wait for your reply" }
        if running > 0 { return running == 1 ? "1 task running" : "\(running) tasks running" }
        if sessionCount > 0 { return sessionsPhrase(sessionCount) }
        return "All clear"
    }

    /// "1 session working", "3 sessions working", "no sessions working".
    private func sessionsPhrase(_ count: Int) -> String {
        count == 0 ? "no sessions working" : count == 1 ? "1 session working" : "\(count) sessions working"
    }

    /// One calm sentence that says what the numbers mean, never repeating them.
    private var detail: String {
        guard let needsYou else { return "Checking for requests…" }
        if needsYou > 0 {
            let waiting = needsYou == 1 ? "A request is waiting for your answer below" : "Requests are waiting for your answer below"
            return running > 0 || sessionCount > 0 ? "\(waiting), and work is still running." : "\(waiting)."
        }
        if waitingOnYou > 0 { return "A session finished its turn and waits for you." }
        if running > 0 { return running == 1 ? "One task is running. Its progress is on the ring." : "\(running) tasks are running. Their progress is on the ring." }
        if sessionCount > 0 {
            return sessionCount == 1 ? "A session is working without a card. It circles the orbit."
                : "\(sessionCount) sessions are working without a card. They circle the orbit."
        }
        return "All clear. Nothing needs you right now."
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
            .font(.system(size: 9, weight: .semibold, design: .monospaced)).tracking(2.4)
            .foregroundStyle(text == "RELO · NOW" ? Color(red: 0x98 / 255, green: 0xA2 / 255, blue: 0xB6 / 255) : accent)
            .lineLimit(1)
            .contentTransition(.opacity)
            .animation(.smooth(duration: 0.25), value: text)
            // A fixed box: the words change while the page is being pulled, and a title that
            // changed width re-laid out the scrolled content mid-bounce.
            .frame(maxWidth: .infinity, alignment: .leading)
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

/// The director's effects on the deck: its cues (a question, a failure, your turn, a finish, the sign-in landing),
/// one ripple per tick of its effect bus, and whether changes are news for the parts below.
private struct ReloDeckEffects: ViewModifier {
    let director: ReloDeckDirector?
    let armed: Bool
    let ripple: (Double) -> Void

    func body(content: Content) -> some View {
        content
            // One moment, one cue: the haptic of ADR 0013's table and Relo's sound, together, from the director's bus.
            .sensoryFeedback(trigger: director?.cueTicks ?? 0) { _, _ in director?.cue?.feedback }
            .onChange(of: director?.cueTicks ?? 0) { _, _ in
                if let cue = director?.cue { ReloCuePlayer.shared.play(cue) }
            }
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
