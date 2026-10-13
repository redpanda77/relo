import ReloCore
import SwiftUI

struct NowView: View {
    @Bindable var model: AppModel
    @Binding var tab: ReloTab
    @State private var sheet: Sheet?
    @AppStorage(ReloHistoryPreferences.clearedAtKey) private var clearedAt: Double = 0
    private enum Sheet: String, Identifiable {
        case connection, signIn
        var id: Self { self }
    }

    private var visibleHistory: [InboxItem] {
        model.historyItems.filter { clearedAt <= 0 || $0.createdAt.timeIntervalSince1970 >= clearedAt }
    }

    private var liveNow: [LiveNowProjection.Card] {
        LiveNowProjection.make(history: visibleHistory, subjects: model.currentPresentation.running, now: model.attentionDate)
    }

    /// Today's finished work by meaning plus what is live, for the sphere's colors and the legend.
    private func todayMix(running: Int, needsYou: Int) -> NowMix {
        let rows = HistoryRowProjection.rows(InboxHistoryProjection.collapsedActivities(visibleHistory),
                                             events: visibleHistory, now: model.attentionDate)
        let start = Calendar.current.startOfDay(for: model.attentionDate)
        return NowMix.make(today: rows.filter { $0.at >= start }, needsYou: needsYou, running: running)
    }

    /// "4h 12m" of agent work today, nil when there is none worth naming.
    private var agentTimeToday: String? {
        let rows = HistoryRowProjection.rows(InboxHistoryProjection.collapsedActivities(visibleHistory),
                                             events: visibleHistory, now: model.attentionDate)
        return HistoryRowProjection.agentTimeLabel(HistoryRowProjection.agentTimeToday(rows, now: model.attentionDate))
    }

    private var deckSync: ReloDeckFooter.Sync {
        if model.currentState?.connection == .offline { return .offline }
        if model.currentState?.timeVerified != true { return .syncing }
        return .live(model.lastSyncedAt ?? model.currentTime)
    }

    @Environment(\.verticalSizeClass) private var verticalSizeClass

    /// The deck as data from the director: it shows only what the director presents.
    private func hero(topInset: CGFloat, bleed: CGFloat = 0) -> ReloNowHero {
        let shown = model.deckDirector.shown ?? rawSnapshot
        return ReloNowHero(
            summary: shown.summary,
            needsYou: shown.needsYou,
            tasks: shown.tasks,
            mix: shown.mix,
            satellites: shown.satellites,
            agentTime: agentTimeToday,
            sync: deckSync, pendingResponses: model.pendingResponseCount,
            connectionTrouble: connectionTrouble, topInset: topInset, bleed: bleed,
            showConnection: { sheet = .connection },
            director: model.deckDirector,
            pull: pull, refreshing: refreshing)
    }

    var body: some View {
        Group {
            if verticalSizeClass == .compact { landscape } else { portrait }
        }
        .onChange(of: deckInput, initial: true) { _, input in model.deckDirector.ingest(input) }
        .onChange(of: model.deckDirector.ceremonyFinishes) { _, _ in model.finishLinkCeremony() }
        .reloScreenBackground()
        .navigationTitle("Now")
        .toolbar(.hidden, for: .navigationBar)
        .sheet(item: $sheet) { destination in
            NavigationStack {
                if destination == .signIn {
                    SignInView(model: model)
                } else {
                    ScrollView {
                        recovery.padding(ReloLayout.screenInset)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .reloScreenBackground()
                    .navigationTitle("Connection")
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar {
                        ToolbarItem(placement: .confirmationAction) { Button("Done") { sheet = nil } }
                    }
                }
            }
        }
    }

    /// Phone on its side: the deck holds the left half, still, and the live work scrolls on the
    /// right, so the sphere and the list are both in view instead of one scrolling past the other.
    private var landscape: some View {
        HStack(spacing: 0) {
            // Scrolls only when the deck is taller than the screen, so nothing is ever cut off.
            ScrollView {
                hero(topInset: 8, bleed: sideInset + 40)
                    .environment(\.reloMotionPaused, tab != .now || scenePhase != .active)
            }
            .scrollBounceBehavior(.basedOnSize)
            .scrollIndicators(.hidden)
            // The deck's glow and dust fade out past its column instead of stopping at a box edge.
            .scrollClipDisabled()
            .containerRelativeFrame(.horizontal) { width, _ in width * 0.5 }
            ScrollView {
                CurrentAttentionView(model: model, viewHistory: { tab = .history })
                    .padding(.horizontal, ReloLayout.screenInset)
                    .padding(.top, 20).padding(.bottom, 24)
            }
            .refreshable { _ = await model.refresh() }
        }
        .onAppear { deckVisible = true }
        .background { GeometryReader { proxy in Color.clear
            .onAppear { sideInset = max(proxy.safeAreaInsets.leading, proxy.safeAreaInsets.trailing) }
            .onChange(of: proxy.safeAreaInsets) { _, new in sideInset = max(new.leading, new.trailing) } } }
    }

    /// The Dynamic Island side's inset in landscape, which the deck's orbit runs under.
    @State private var sideInset: CGFloat = 0

    private var portrait: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 32) {
                hero(topInset: topInset)
                    .padding(.horizontal, -ReloLayout.screenInset)
                    // Scrolled out of view, the deck stops drawing (battery); it resumes on return.
                    .background { GeometryReader { proxy in
                        let frame = proxy.frame(in: .global)
                        Color.clear.preference(key: ReloDeckBottomKey.self, value: frame.maxY)
                            .preference(key: ReloDeckTopKey.self, value: frame.minY)
                    } }
                    .onPreferenceChange(ReloDeckBottomKey.self) { bottom in
                        let visible = bottom > 80
                        if visible != deckVisible { deckVisible = visible }
                    }
                    // Pulling past the top: only the pull tracker changes per frame, never this screen.
                    .onPreferenceChange(ReloDeckTopKey.self) { top in
                        if pull.track(overscroll: top), !refreshing { syncFromPull() }
                    }
                    .environment(\.reloMotionPaused, !deckVisible)
                CurrentAttentionView(model: model, viewHistory: { tab = .history })
            }
            .padding(.horizontal, ReloLayout.screenInset)
            .padding(.bottom, 24)
        }
        // The deck is the header: no navigation bar band over it; it runs under the status bar.
        .ignoresSafeArea(.container, edges: .top)
        .background { GeometryReader { proxy in Color.clear
            .onAppear { topInset = proxy.safeAreaInsets.top }
            .onChange(of: proxy.safeAreaInsets.top) { _, new in topInset = new } } }
        .scrollBounceBehavior(.always)
    }

    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// Everything the deck shows, as one value, straight from the model.
    private var rawSnapshot: ReloDeckDirector.Snapshot {
        let screen = model.currentPresentation
        let live = liveNow
        return .init(
            // A clear resets today's count too: the hero only counts what is still shown.
            summary: InboxTodaySummary.make(items: visibleHistory + model.items, attention: model.attention,
                                            now: model.attentionDate),
            needsYou: screen.actionableCount,
            // The same live cards as the Live now section, plus agents the hooks report running
            // without a card, so the ring and RUNNING agree with Live now and Agents together.
            // A card has progress; a hook-only agent reports none and draws as a travelling arc.
            tasks: live.map { ReloHoloTask(id: $0.id, progress: $0.progress) } + cardlessAgents,
            mix: todayMix(running: live.count + cardlessAgents.count,
                          needsYou: screen.actionableCount ?? screen.needsMe.count),
            satellites: screen.needsMe.map { request in
                let window = request.interaction.expiresAt.timeIntervalSince(request.createdAt)
                let left = request.interaction.expiresAt.timeIntervalSince(model.attentionDate)
                return ReloOrbitSatellite(id: request.id, remaining: window > 0 ? left / window : 0)
            })
    }

    /// Agent sessions running now that no live card already stands for (the hooks see them;
    /// the agent never started a Relo card). Offline, the Agents list hides them, so does the HUD.
    private var cardlessAgents: [ReloHoloTask] {
        guard model.currentState?.connection != .offline else { return [] }
        let cards = Set(liveNow.map(\.id))
        return model.agentSessions
            .filter { [.working, .quiet, .noCard].contains($0.presence) }
            .filter { session in session.card.map { !cards.contains($0.id) } ?? true }
            .map { ReloHoloTask(id: "agent-\($0.id)", progress: nil) }
    }

    private var deckInput: ReloDeckDirector.Input {
        let trusted = model.credential != nil && model.currentState?.connection == .current
            && model.currentPresentation.actionableCount != nil && model.registrationState != .registering
        return .init(snapshot: rawSnapshot, trusted: trusted, reachable: !model.serverUnreachable,
                     linkPending: model.linkCeremonyPending,
                     linked: model.isRegistered,
                     visible: tab == .now && deckVisible && scenePhase == .active,
                     working: refreshing || !trusted, reduceMotion: reduceMotion)
    }

    /// Pull-to-sync drawn by the deck itself (the system spinner hid under the status bar and
    /// held the page down): the page bounces freely, and letting go past the mark syncs.
    @State private var pull = ReloPullTracker()
    @State private var refreshing = false
    private func syncFromPull() {
        refreshing = true
        Task {
            async let minimum: Void = { try? await Task.sleep(for: .milliseconds(900)) }()
            _ = await model.refresh()
            await minimum
            refreshing = false
        }
    }

    @State private var topInset: CGFloat = 59
    @State private var deckVisible = true
    /// A connection problem worth naming in the deck (sign-in needed, account disabled...).
    private var connectionTrouble: String? {
        model.requiresReauthentication ? "SIGN IN AGAIN"
            : model.accountState == .disabled ? "ACCOUNT DISABLED" : nil
    }

    private var isUpdating: Bool { model.connectionStatus.updating }
    private var connectionSymbol: String { model.connectionStatus.symbol }
    private var connectionLabel: String { model.connectionStatus.label }
    @ViewBuilder private var recovery: some View {
        if model.requiresReauthentication {
            Group {
                ReloNotice(title: "Sign in again", detail: "Your saved history is available. Sign in to reconnect.",
                           symbol: "person.crop.circle.badge.exclamationmark", actionTitle: "Sign in") { sheet = .signIn }
            }
        } else if model.accountState == .disabled {
            Group {
                ReloNotice(title: "Account needs attention", detail: "Open your dashboard to recover access.",
                           symbol: "person.crop.circle.badge.exclamationmark", actionTitle: "Open dashboard") {
                    UIApplication.shared.open(model.dashboardURL)
                }
            }
        } else if case .offline = model.syncState {
            Group {
                ReloNotice(title: "You're offline", detail: model.lastSyncedAt.map {
                    "Showing saved activity from \($0.formatted(date: .abbreviated, time: .shortened))."
                } ?? "No saved activity yet. Connect to load your Inbox.",
                           symbol: "wifi.slash", actionTitle: "Try again") { Task { _ = await model.refresh() } }
            }
        } else if case .failed = model.registrationState {
            Group {
                ReloNotice(title: "Connection needs attention", detail: "This iPhone could not register with your server.",
                           symbol: "iphone.badge.exclamationmark", actionTitle: "Review connection") { sheet = nil; tab = .settings }
            }
        } else if model.isRegistered && (model.permission != .allowed || model.pushRegistrationError != nil || !model.liveActivitiesAuthorized) {
            Group {
                ReloNotice(title: "Notification settings", detail: "History is available. Review permissions to receive alerts and Live Activities.",
                           symbol: "bell.badge", actionTitle: "Review settings") { sheet = nil; tab = .settings }
            }
        } else if !model.isRegistered {
            ReloNotice(title: "Connecting this iPhone", detail: "Saved activity is available while Relo reconnects.",
                       symbol: "iphone", actionTitle: "Review connection") { sheet = nil; tab = .settings }
        } else {
            ReloNotice(title: isUpdating ? "Updating notifications" : "Connected", detail: model.lastSyncedAt.map {
                "Last updated \($0.formatted(date: .abbreviated, time: .shortened))."
            } ?? "Relo is connected. New activity will appear in Now.",
                       symbol: "checkmark.icloud", actionTitle: "Refresh") { Task { _ = await model.refresh() } }
        }
    }
}

private struct ReloDeckTopKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
}

/// How far the page is pulled past its top, read only by the deck's title and sphere.
@Observable final class ReloPullTracker {
    static let mark: CGFloat = 86
    private(set) var distance: CGFloat = 0
    private(set) var armed = false
    private(set) var armings = 0

    /// Feeds the deck's top edge; true once, when a pull past the mark has been let go and the
    /// page has finished springing back. Syncing earlier changed the content mid-bounce, which
    /// cut the scroll view's spring short and snapped the page into place.
    func track(overscroll top: CGFloat) -> Bool {
        let next = max(0, top)
        if abs(next - distance) > 0.5 || (next == 0 && distance != 0) { distance = next }
        if !armed, next >= Self.mark { armed = true; armings += 1 }
        if armed, next < 1 { armed = false; return true }
        return false
    }
    /// Let go past the mark and springing back: the title already says it will sync.
    var released: Bool { armed && distance < Self.mark }
}

private struct ReloDeckBottomKey: PreferenceKey {
    static let defaultValue: CGFloat = .infinity
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
}

/// Owns what the Now deck presents, outside every view, so a rebuilt view never replays anything.
/// The source state (connection, registration, counts) changes fast and in bursts; the director
/// turns it into calm presented state with a few rules:
/// - One snapshot: the counts, tasks, colours and satellites update together, only from trusted
///   state, coalesced (latest wins); untrusted moments (reconnecting, counts unknown,
///   registering) hold the last good snapshot instead of dipping and rebounding.
/// - The first observation is never news: after the deck appears, wakes or reconnects, the first
///   trusted snapshot becomes the baseline; effects arm a moment later and disarm when unseen.
/// - Hysteresis: the deck goes dormant only after the server has been out of reach for a while
///   in the foreground, and comes back only once the connection has held, with a quiet fade.
/// - The sign-in ceremony runs once, on fixed deadlines from its start; interrupted, it jumps
///   to its end rather than restarting.
/// - One effect bus: at most one ripple per change; the loading pulse never stacks on a ripple.
///   Haptics only for the finished sign-in and a genuinely new request, with a cooldown.
@MainActor @Observable final class ReloDeckDirector {
    enum Phase: Equatable { case live, dormant, booting }

    /// A HUD status plate shown over the sphere at a state change.
    struct Badge: Equatable {
        let id: Int
        let word: String
        let left: String
        let right: String
        var warning = false
        let start: Date
        var duration: TimeInterval = 2.2
    }

    struct Snapshot: Equatable {
        var summary: InboxTodaySummary
        var needsYou: Int?
        var tasks: [ReloHoloTask]
        var mix: NowMix
        var satellites: [ReloOrbitSatellite]
    }

    struct Input: Equatable {
        var snapshot: Snapshot
        /// Connected, counts known, not mid-registration: safe to show.
        var trusted: Bool
        /// False only when the server is out of reach (offline, Tailscale off); reconnecting is fine.
        var reachable: Bool
        /// A fresh sign-in is waiting for its ceremony.
        var linkPending: Bool
        /// This iPhone holds a device credential and is registered: linking is done, even if the
        /// live counts are still on their way (they settle quietly after the ceremony).
        var linked: Bool = false
        /// Now is the selected tab, the deck is on screen and the app is active.
        var visible: Bool
        /// Something is loading: the sphere pulses gently.
        var working: Bool
        var reduceMotion: Bool
    }

    struct Timing {
        /// Out of reach this long in the foreground before the deck goes dormant.
        var offlineHold: Duration = .seconds(5)
        /// Reachable and trusted this long before a dormant deck fades back.
        var returnHold: Duration = .seconds(1)
        /// Trusted changes within this window collapse into one (latest wins).
        var coalesce: Duration = .milliseconds(300)
        /// Seen and trusted this long before changes count as news.
        var armAfter: Duration = .milliseconds(1200)
        var hapticCooldown: TimeInterval = 2
        /// Multiplies the ceremony's timeline (tests run it fast).
        var ceremonyScale: Double = 1
        /// Away at least this long, and the HUD powers on again when it is next seen.
        var powerOnAfterAway: TimeInterval = 30
        /// The first time the deck is seen in a run, the HUD powers on.
        var powerOnAtLaunch = true
    }
    let timing: Timing
    init(timing: Timing = Timing()) {
        self.timing = timing
        // Powering on at launch: start dark, so the full HUD never flashes before it builds.
        if timing.powerOnAtLaunch { revealed = 0; ringTrace = 0 }
    }

    private(set) var phase: Phase = .live
    /// Dormant because this iPhone is linking after a sign-in (else: out of reach).
    private(set) var linking = false
    private(set) var shown: Snapshot?
    /// Changes are news; see `reloEffectsArmed`.
    private(set) var armed = false
    /// How much of the HUD is lit: 0 core only, 1 ring, 2–5 the corner modules, 6 the leaders.
    private(set) var revealed = 6
    private(set) var ringTrace: CGFloat = 1
    private(set) var greeting: String?
    /// The status plate showing now, if any.
    private(set) var badge: Badge?
    /// When each corner module (by reveal level 2–5) started building, for its own build-up.
    private(set) var moduleBuilds: [Int: Date] = [:]
    /// The effect bus: each tick is one ripple through the sphere, of `waveStrength`.
    private(set) var waves = 0
    private(set) var waveStrength = 0.8
    private(set) var successTicks = 0
    private(set) var newsTicks = 0
    /// Ticks once when a ceremony finishes, so the owner can clear its pending flag.
    private(set) var ceremonyFinishes = 0

    private var input: Input?
    private var ceremonyStarted = false
    private var applyTask: Task<Void, Never>?
    private var armTask: Task<Void, Never>?
    private var offlineTask: Task<Void, Never>?
    private var returnTask: Task<Void, Never>?
    private var ceremonyTask: Task<Void, Never>?
    private var pulseTask: Task<Void, Never>?
    private var lastWaveAt = Date.distantPast
    private var badgeTask: Task<Void, Never>?
    private var powerTask: Task<Void, Never>?
    private var badgeCount = 0
    private var hiddenAt: Date?
    private var hasBeenSeen = false
    private var lastHapticAt = Date.distantPast

    func ingest(_ next: Input) {
        let previous = input
        input = next
        let becameVisible = next.visible && previous?.visible != true

        if !next.visible {
            disarm()
            if phase == .booting { finishCeremony() }
            if powerTask != nil { finishPowerOn() }
            if previous?.visible == true { hiddenAt = .now }
        }
        // Seen for the first time in this run, or again after a while away: the HUD powers on.
        if becameVisible && !next.linkPending && phase == .live {
            let away = hiddenAt.map { Date.now.timeIntervalSince($0) } ?? .infinity
            if (!hasBeenSeen && timing.powerOnAtLaunch) || (hasBeenSeen && away >= timing.powerOnAfterAway) {
                powerOn(badge: ("ACTIVE", "RELO · NOW", "FEED . LIVE"))
            }
        }
        if next.visible { hasBeenSeen = true; hiddenAt = nil }

        // A fresh sign-in: dormant (LINKING) until linked, then the ceremony once, when seen.
        if next.linkPending {
            if !ceremonyStarted {
                if phase != .dormant || !linking { goDormant(linking: true) }
                if (next.linked || next.trusted) && next.visible { startCeremony() }
            }
        } else {
            ceremonyStarted = false
            if linking && phase == .dormant { linking = false }
        }

        // Out of reach: dormant only after it has held in the foreground; back after it holds.
        if !next.linkPending && phase != .booting {
            if next.reachable {
                offlineTask?.cancel(); offlineTask = nil
                if phase == .dormant && returnTask == nil { scheduleReturn() }
            } else {
                returnTask?.cancel(); returnTask = nil
                // Waking restarts the clock: time asleep is not time out of reach.
                if becameVisible { offlineTask?.cancel(); offlineTask = nil }
                if phase == .live && offlineTask == nil && next.visible { scheduleOffline() }
            }
        }

        // The snapshot: first ever shows at once; later only trusted, coalesced, latest wins.
        if shown == nil {
            shown = next.snapshot
        } else if next.trusted && next.snapshot != shown {
            scheduleApply()
        }

        if next.visible && next.trusted && phase == .live && powerTask == nil && !armed && armTask == nil { scheduleArm() }
        updatePulse()
    }

    // MARK: Snapshot

    private func scheduleApply() {
        applyTask?.cancel()
        let delay = timing.coalesce
        applyTask = Task { [weak self] in
            try? await Task.sleep(for: delay)
            guard let self, !Task.isCancelled else { return }
            self.applyTask = nil
            guard let input = self.input, input.trusted else { return }
            self.apply(input.snapshot)
        }
    }

    private func apply(_ next: Snapshot) {
        let old = shown
        shown = next
        guard armed, phase == .live, let old else { return }
        let newRequest = (next.needsYou ?? 0) > (old.needsYou ?? 0)
        let news = newRequest || next.summary.total > old.summary.total
            || next.summary.finished > old.summary.finished || next.tasks.count != old.tasks.count
        if news { emitWave(1.0) }
        if newRequest, Date.now.timeIntervalSince(lastHapticAt) > timing.hapticCooldown {
            lastHapticAt = .now; newsTicks += 1
        }
    }

    // MARK: Arming

    private func scheduleArm() {
        let delay = timing.armAfter
        armTask = Task { [weak self] in
            try? await Task.sleep(for: delay)
            guard let self, !Task.isCancelled else { return }
            self.armTask = nil
            if let input = self.input, input.visible, input.trusted, self.phase == .live, self.applyTask == nil,
               self.powerTask == nil {
                self.armed = true
            }
        }
    }

    private func disarm() {
        armTask?.cancel(); armTask = nil
        armed = false
    }

    // MARK: Dormancy

    private func goDormant(linking: Bool) {
        disarm()
        offlineTask?.cancel(); offlineTask = nil
        returnTask?.cancel(); returnTask = nil
        self.linking = linking
        powerTask?.cancel(); powerTask = nil
        if !linking { show(("OFFLINE", "RELO · LINK", "SERVER . LOST"), warning: true) }
        withAnimation(.smooth(duration: 0.8)) { phase = .dormant; revealed = 0; ringTrace = 0; greeting = nil }
    }

    private func scheduleOffline() {
        let delay = timing.offlineHold
        offlineTask = Task { [weak self] in
            try? await Task.sleep(for: delay)
            guard let self, !Task.isCancelled else { return }
            self.offlineTask = nil
            if let input = self.input, !input.reachable, input.visible, self.phase == .live { self.goDormant(linking: false) }
        }
    }

    private func scheduleReturn() {
        let delay = timing.returnHold
        returnTask = Task { [weak self] in
            try? await Task.sleep(for: delay)
            guard let self, !Task.isCancelled else { return }
            self.returnTask = nil
            guard let input = self.input, input.reachable, input.trusted, self.phase == .dormant, !self.linking else {
                if let input = self.input, input.reachable, self.phase == .dormant, !self.linking { self.scheduleReturn() }
                return
            }
            // Back: the HUD powers on again, part by part. No haptic.
            self.shown = input.snapshot
            self.phase = .live
            if input.visible { self.powerOn(badge: ("ONLINE", "RELO · LINK", "SERVER . OK")) }
            else { self.revealed = 6; self.ringTrace = 1 }
            self.ingest(input)
        }
    }

    // MARK: Ceremony

    private func startCeremony() {
        guard !ceremonyStarted else { return }
        ceremonyStarted = true
        phase = .booting
        revealed = 0; ringTrace = 0; greeting = nil
        shown = input?.snapshot ?? shown
        successTicks += 1
        let reduceMotion = input?.reduceMotion ?? false
        let start = ContinuousClock.now, scale = timing.ceremonyScale
        ceremonyTask = Task { [weak self] in
            func at(_ seconds: Double) async -> Bool {
                try? await Task.sleep(until: start + .milliseconds(Int(seconds * 1000 * scale)), clock: .continuous)
                return !Task.isCancelled
            }
            guard let self else { return }
            if reduceMotion {
                self.revealed = 6; self.ringTrace = 1; self.greeting = "ACCOUNT LINKED"
                guard await at(2.0) else { return }
                self.finishCeremony(); return
            }
            // One focal point at a time: the link confirms on a status plate, the ring traces,
            // the four corner modules build their parts together, the leaders tie them in, then
            // the welcome.
            guard await at(0.15) else { return }
            self.show(("LINKED", "RELO · ACCOUNT", "LINK . OK"), warning: false)
            self.emitWave(0.9)
            guard await at(0.55) else { return }
            withAnimation(.easeInOut(duration: 0.75)) { self.revealed = 1; self.ringTrace = 1 }
            guard await at(1.3) else { return }
            self.revealModules()
            guard await at(1.3 + Self.moduleBuild) else { return }
            withAnimation(.easeOut(duration: 0.5)) { self.revealed = 6 }
            guard await at(1.3 + Self.moduleBuild + 0.5) else { return }
            withAnimation(.smooth(duration: 0.6)) { self.greeting = "WELCOME TO RELO" }
            guard await at(1.3 + Self.moduleBuild + 2.2) else { return }
            self.finishCeremony()
        }
    }

    /// The four corner modules build together, each atom by atom, over this long.
    static let moduleBuild = 1.7

    private func revealModules() {
        let now = Date.now
        for level in 2...5 { moduleBuilds[level] = now }
        revealed = 5
    }

    /// The HUD powering on after a reconnect or a while away: a status plate, the ring traces,
    /// the modules build together, atom by atom, the leaders draw. No welcome, no haptic.
    private func powerOn(badge plate: (String, String, String)) {
        powerTask?.cancel()
        disarm()
        let reduceMotion = input?.reduceMotion ?? false
        show(plate, warning: false)
        guard !reduceMotion else { revealed = 6; ringTrace = 1; return }
        revealed = 0; ringTrace = 0
        let start = ContinuousClock.now, scale = timing.ceremonyScale
        powerTask = Task { [weak self] in
            func at(_ seconds: Double) async -> Bool {
                try? await Task.sleep(until: start + .milliseconds(Int(seconds * 1000 * scale)), clock: .continuous)
                return !Task.isCancelled
            }
            guard let self else { return }
            guard await at(0.35) else { return }
            withAnimation(.easeInOut(duration: 0.7)) { self.revealed = 1; self.ringTrace = 1 }
            guard await at(0.9) else { return }
            self.revealModules()
            guard await at(0.9 + Self.moduleBuild) else { return }
            withAnimation(.easeOut(duration: 0.5)) { self.revealed = 6 }
            self.powerTask = nil
            if let input = self.input { self.ingest(input) }
        }
    }

    /// Ends a power-on at its final state (the screen went away mid-way).
    private func finishPowerOn() {
        powerTask?.cancel(); powerTask = nil
        revealed = 6; ringTrace = 1
    }

    private func show(_ plate: (String, String, String), warning: Bool) {
        badgeCount += 1
        let next = Badge(id: badgeCount, word: plate.0, left: plate.1, right: plate.2, warning: warning,
                         start: .now, duration: 2.2 * max(timing.ceremonyScale, 0.05))
        withAnimation(.easeOut(duration: 0.15)) { badge = next }
        badgeTask?.cancel()
        let duration = next.duration
        badgeTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(duration))
            guard let self, !Task.isCancelled, self.badge?.id == next.id else { return }
            withAnimation(.easeOut(duration: 0.2)) { self.badge = nil }
        }
    }

    /// Ends the ceremony at its final state, whether it ran to the end or was interrupted.
    private func finishCeremony() {
        ceremonyTask?.cancel(); ceremonyTask = nil
        withAnimation(.smooth(duration: 0.7)) {
            greeting = nil; revealed = 6; ringTrace = 1; phase = .live; linking = false
        }
        if let input { shown = input.snapshot }
        ceremonyFinishes += 1
    }

    // MARK: Effect bus

    private func emitWave(_ strength: Double) {
        guard !(input?.reduceMotion ?? false) else { return }
        waveStrength = strength
        lastWaveAt = .now
        waves += 1
    }

    /// While loading, a gentle pulse: the first a beat after work starts, never on top of a
    /// ripple that just ran.
    private func updatePulse() {
        let wanted = (input?.working ?? false) && (input?.visible ?? false) && !(input?.reduceMotion ?? false)
        guard wanted != (pulseTask != nil) else { return }
        if !wanted { pulseTask?.cancel(); pulseTask = nil; return }
        pulseTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(800))
            while !Task.isCancelled {
                guard let self else { return }
                if Date.now.timeIntervalSince(self.lastWaveAt) > 1.6 { self.emitWave(0.75) }
                try? await Task.sleep(for: .milliseconds(1800))
            }
        }
    }
}
