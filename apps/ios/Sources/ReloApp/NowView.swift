import ReloCore
import ReloTransport
import ReloNotificationSupport
import SwiftUI

struct NowView: View {
    @Bindable var model: AppModel
    @Binding var tab: ReloTab
    @State private var sheet: Sheet?
    @State private var nowController = NowSummaryController()
    @AppStorage(ReloHistoryPreferences.clearedAtKey) private var clearedAt: Double = 0
    private enum Sheet: String, Identifiable {
        case connection, signIn
        var id: Self { self }
    }

    private var visibleHistory: [InboxItem] {
        model.historyItems.filter { clearedAt <= 0 || $0.createdAt.timeIntervalSince1970 >= clearedAt }
    }

    /// Everything the screen derives from the model, worked out once per update and shared by the
    /// deck and the list, so both count the same cards and agents (and a scroll-driven redraw
    /// does not re-project History several times over).
    struct Derived {
        var rows: [HistoryRow]
        /// The Now lists the screen renders (1.14), shared by the deck and the list.
        var now: NowScreenInput
    }

    /// One answer to "is Now current?" for the deck, the list and the connection sheet: offline
    /// when either feed behind the screen (current work, or the Now summary) can't be reached.
    private var isOffline: Bool {
        if case .offline = model.syncState { return true }
        return nowController.isOffline || model.currentState?.connection == .offline
    }

    /// The current-state feed's server time when it can decide alone what is live: connected,
    /// clock verified and the whole inventory on hand.
    private var runningAsOf: Date? {
        guard let state = model.currentState, state.connection == .current, state.timeVerified,
              let metadata = state.snapshot.metadata, metadata.hasMore != true else { return nil }
        return metadata.serverTime
    }

    /// Remembers the last derivation and what it was made from. A class that is not observed: it only holds values,
    /// so reading it in the body never invalidates the screen. Without it every body (and every scroll-driven redraw)
    /// projected the whole history and the summary again.
    @MainActor
    final class DerivedCache {
        struct Key: Equatable {
            var history: [InboxItem]
            var clearedAt: Double
            var summary: NowSummary?
            /// Time moves the derivation on by the minute; only the summary-less fallback reads the clock itself.
            var minute: Int
        }
        struct SummaryKey: Equatable {
            var derived: Key
            var items: [InboxItem]
            var attention: InboxAttentionProjection.Snapshot
        }
        var derivedKey: Key?
        var derived: Derived?
        var summaryKey: SummaryKey?
        var summary: InboxTodaySummary?
    }
    @State private var derivedCache = DerivedCache()

    private var derivedKey: DerivedCache.Key {
        DerivedCache.Key(history: model.historyItems, clearedAt: clearedAt, summary: model.nowSummary,
                         minute: Int(model.attentionDate.timeIntervalSince1970 / 60))
    }

    private func derive() -> Derived {
        let key = derivedKey
        if derivedCache.derivedKey == key, let derived = derivedCache.derived { return derived }
        let now = model.attentionDate
        let history = visibleHistory
        let derived = Derived(
            rows: HistoryRowProjection.rows(InboxHistoryProjection.readable(history), events: history, now: now),
            now: model.nowSummary.map(NowScreenInput.init(summary:))
                ?? NowScreenInput(serverTime: model.currentTime, sinceYouLooked: nil))
        derivedCache.derivedKey = key
        derivedCache.derived = derived
        return derived
    }

    /// Today's count for the hero, from the history and the live items: the heaviest part of the deck's snapshot,
    /// so it is made again only when its inputs change.
    private func todaySummary(_ derived: Derived) -> InboxTodaySummary {
        let key = DerivedCache.SummaryKey(derived: derivedKey, items: model.items, attention: model.attention)
        if derivedCache.summaryKey == key, let summary = derivedCache.summary { return summary }
        let summary = InboxTodaySummary.make(items: visibleHistory + model.items, attention: model.attention,
                                             now: model.attentionDate)
            .counting(TodayActivity.settled(rows: derived.rows, now: model.attentionDate).rows.count)
        derivedCache.summaryKey = key
        derivedCache.summary = summary
        return summary
    }

    /// Today's finished work by meaning plus what is live, for the sphere's colors and the legend.
    private func todayMix(_ derived: Derived, needsYou: Int) -> NowMix {
        let start = Calendar.current.startOfDay(for: model.attentionDate)
        return NowMix.make(today: derived.rows.filter { $0.at >= start }, needsYou: needsYou, running: derived.now.running.count)
    }

    private var deckSync: ReloDeckFooter.Sync {
        if isOffline { return .offline(model.lastSyncedAt ?? model.nowSummary?.serverTime) }
        if model.currentState?.timeVerified != true { return .syncing }
        return .live(model.lastSyncedAt ?? model.currentTime)
    }

    @Environment(\.verticalSizeClass) private var verticalSizeClass

    /// The deck as data from the director: it shows only what the director presents.
    private func hero(_ derived: Derived, topInset: CGFloat) -> ReloNowHero {
        let shown = model.deckDirector.shown ?? rawSnapshot(derived)
        return ReloNowHero(
            summary: shown.summary,
            needsYou: shown.needsYou,
            tasks: shown.tasks,
            sessionsWorking: shown.sessionsWorking,
            waitingOnYou: shown.waitingOnYou,
            sessions: shown.sessions,
            // Machines whose sessions are all idle or ended: the header's machines line lists them dim.
            idleMachines: derived.now.sessions.filter { $0.phase == .idle || $0.phase == .ended }.compactMap(\.computer),
            mix: shown.mix,
            // While an answer is in flight its card says "Sending…"; the deck counts only answers left waiting.
            sync: deckSync, pendingResponses: model.respondingNotificationID == nil ? model.pendingResponseCount : 0,
            connectionTrouble: connectionTrouble, topInset: topInset,
            showConnection: { sheet = .connection },
            director: model.deckDirector,
            pull: pull, refreshing: refreshing)
    }

    var body: some View {
        let derived = derive()
        Group {
            if verticalSizeClass == .compact { landscape(derived) } else { portrait(derived) }
        }
        .onChange(of: deckInput(derived), initial: true) { _, input in model.deckDirector.ingest(input) }
        // The app's foreground presentation of a question push reads this: with Now on screen the in-app cue carries it.
        .onChange(of: tab == .now && scenePhase == .active, initial: true) { _, onScreen in
            ReloCuePlayer.shared.nowOnScreen = onScreen
        }
        // While Now is on screen, time-based states (quiet cards, lost agents, the last hour of
        // ended ones) move on by themselves, and the inbox (agent sessions, History) is re-read.
        .task(id: tab == .now && scenePhase == .active) {
            guard tab == .now, scenePhase == .active else { nowController.disappeared(model); return }
            nowController.appeared(model)
            await nowController.fetch(model)
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(nowController.nextWait(model)))
                guard !Task.isCancelled else { return }
                await nowController.fetch(model)
                model.updateAttentionClock()
                model.followInbox(maxAge: 55)
            }
        }
        .onChange(of: model.currentState?.snapshot.metadata?.serverTime) { _, _ in nowController.wake(model) }
        .onChange(of: model.nowRefetchRequest) { _, _ in Task { await nowController.fetch(model) } }
        .onChange(of: model.deckDirector.ceremonyFinishes) { _, _ in model.finishLinkCeremony() }
        .reloScreenBackground()
        .navigationTitle("Now")
        // Inline, though the bar is hidden: a large title keeps its navigation bar tracking this
        // scroll view, and pulling down expanded the hidden title's area, changed the content
        // inset and snapped the page back up mid-pull.
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.hidden, for: .navigationBar)
        .sheet(item: $sheet) { destination in
            if destination == .signIn {
                NavigationStack { SignInView(model: model) }
            } else {
                ReloConnectionSheet(recovery: recovery, details: connectionDetails)
            }
        }
    }

    /// Phone on its side: the deck holds the left half, still, and the live work scrolls on the
    /// right, so the sphere and the list are both in view instead of one scrolling past the other.
    private func landscape(_ derived: Derived) -> some View {
        HStack(spacing: 0) {
            // Scrolls only when the deck is taller than the screen, so nothing is ever cut off.
            ScrollView {
                hero(derived, topInset: 8)
                    .environment(\.reloMotionPaused, tab != .now || scenePhase != .active)
            }
            .scrollBounceBehavior(.basedOnSize)
            .scrollIndicators(.hidden)
            // The deck's glow fades out past its column instead of stopping at a box edge.
            .scrollClipDisabled()
            .containerRelativeFrame(.horizontal) { width, _ in width * 0.5 }
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    NowSystemSection(model: model, showConnection: { sheet = .connection })
                    CurrentAttentionView(model: model, input: derived.now, offline: isOffline,
                                         viewHistory: { tab = .history })
                }
                .padding(.horizontal, ReloLayout.screenInset)
                .padding(.top, 20).padding(.bottom, 24)
            }
            .scrollIndicators(.hidden)
            .refreshable { _ = await model.refresh() }
        }
        .onAppear { deckVisible = true }
    }

    private func portrait(_ derived: Derived) -> some View {
        ScrollView {
            // The first section sits close under the deck's sync line; sections keep their own spacing.
            VStack(alignment: .leading, spacing: 12) {
                hero(derived, topInset: topInset)
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
                    // iOS 17 only: pulling past the top read from the deck's frame. iOS 18 and later
                    // read it from the scroll view itself (below), outside layout.
                    .onPreferenceChange(ReloDeckTopKey.self) { top in
                        guard !Self.readsScrollGeometry else { return }
                        trackPull(top)
                    }
                    .environment(\.reloMotionPaused, !deckVisible)
                VStack(alignment: .leading, spacing: 32) {
                    NowSystemSection(model: model, showConnection: { sheet = .connection })
                    CurrentAttentionView(model: model, input: derived.now, offline: isOffline,
                                         viewHistory: { tab = .history })
                }
            }
            .padding(.horizontal, ReloLayout.screenInset)
            .padding(.bottom, 24)
        }
        // The deck is the header: no navigation bar band over it; it runs under the status bar.
        .modifier(ReloOverscrollReader { trackPull($0) })
        .ignoresSafeArea(.container, edges: .top)
        .scrollIndicators(.hidden)
        .background { GeometryReader { proxy in Color.clear
            .onAppear { topInset = proxy.safeAreaInsets.top }
            .onChange(of: proxy.safeAreaInsets.top) { _, new in topInset = new } } }
        // Vertical only: the default covers both axes and let the page rubber-band sideways.
        .scrollBounceBehavior(.always, axes: .vertical)
    }

    private static var readsScrollGeometry: Bool {
        if #available(iOS 18, *) { true } else { false }
    }

    /// Only the pull tracker changes per frame, never this screen; the sync starts once the page
    /// has sprung back.
    private func trackPull(_ overscroll: CGFloat) {
        if pull.track(overscroll: overscroll), !refreshing { syncFromPull() }
    }

    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// Everything the deck shows, as one value, straight from the model.
    private func rawSnapshot(_ derived: Derived) -> ReloDeckDirector.Snapshot {
        let screen = model.currentPresentation
        let live = derived.now.running
        let found = moments(derived, needsMe: screen.needsMe)
        return .init(
            // A clear resets today's count too: the hero only counts what is still shown.
            summary: todaySummary(derived),
            needsYou: screen.actionableCount,
            // RUNNING is the live cards only (the Live now section); the agents running now are
            // their own count (AGENTS, the Agents section), never added to it.
            tasks: live.map { item in ReloHoloTask(id: item.id, progress: item.steps.map { Double($0.done) / Double(max($0.total, 1)) }) },
            sessionsWorking: derived.now.sessions.filter { $0.phase == .working }
                .map { ReloHoloTask(id: "session-\($0.id)", progress: nil) },
            sessions: derived.now.sessions.compactMap { ReloHUDSession.make($0, movingWork: Set(live.map(\.id))) },
            waitingOnYou: derived.now.waitingOnYou.count,
            mix: todayMix(derived, needsYou: screen.actionableCount ?? screen.needsMe.count),
            moments: found.ids, looking: found.looking)
    }

    /// The moments the screen shows now (ADR 0013, section 1), keyed so each is its own: a question by its
    /// interaction, a finish or failure by the work and when it settled, your turn by the work's round.
    /// Dropped, paused, quiet and left-unfinished work is silent. `looking` holds those whose page is open.
    private func moments(_ derived: Derived, needsMe: [PendingCurrentDecision])
        -> (ids: [ReloCue: Set<String>], looking: Set<String>) {
        var ids: [ReloCue: Set<String>] = [:]
        var looking = Set<String>()
        let open = model.selectedNotificationID
        func add(_ cue: ReloCue, _ id: String, notificationID: String?) {
            ids[cue, default: []].insert(id)
            if let open, notificationID == open { looking.insert(id) }
        }
        for decision in needsMe { add(.needsYou, decision.id, notificationID: decision.notificationId) }
        for item in derived.now.recent {
            let settled = "\(item.id)|\(Int(item.evidenceAt.timeIntervalSince1970))"
            if item.state == .failed { add(.failed, settled, notificationID: item.notificationID) }
            else if item.state == .done { add(.done, settled, notificationID: item.notificationID) }
        }
        for item in derived.now.waitingOnYou {
            add(.yourTurn, "\(item.id)|r\(item.roundNumber ?? 0)", notificationID: item.notificationID)
        }
        return (ids, looking)
    }

    private func deckInput(_ derived: Derived) -> ReloDeckDirector.Input {
        let trusted = model.credential != nil && model.currentState?.connection == .current
            && model.currentPresentation.actionableCount != nil && model.registrationState != .registering
        return .init(snapshot: rawSnapshot(derived), trusted: trusted, reachable: !model.serverUnreachable,
                     linkPending: model.linkCeremonyPending,
                     linked: model.isRegistered,
                     visible: tab == .now && deckVisible && scenePhase == .active,
                     onScreen: tab == .now && scenePhase == .active,
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
            : model.accountState == .disabled ? "ACCOUNT DISABLED"
            : isUnreadable ? "CAN\u{2019}T READ SERVER" : nil
    }

    /// The server answered but its answer couldn't be read (too large, or a shape this build doesn't know): the
    /// network is fine, so the deck must not say offline (27 Oct: an oversized sync read as "Offline" all morning).
    private var isUnreadable: Bool {
        guard isOffline, model.currentState?.connection != .offline else { return false }
        return nowController.isUnreadable || model.syncUnreadable
    }

    private var isUpdating: Bool { model.connectionStatus.updating }
    private var connectionSymbol: String { model.connectionStatus.symbol }
    private var connectionLabel: String { model.connectionStatus.label }
    /// What the connection sheet leads with: the one state that matters most, and its fix.
    private var recovery: ReloConnectionSheet.Recovery {
        let attention = ReloHoloTheme.color(.attention)
        if model.requiresReauthentication {
            return .init(title: "Sign in again", detail: "Your saved history is still here. Sign in to reconnect.",
                         symbol: "person.crop.circle.badge.exclamationmark", tint: attention,
                         actionTitle: "Sign in") { sheet = .signIn }
        } else if model.accountState == .disabled {
            return .init(title: "Account needs attention", detail: "Open your dashboard to recover access.",
                         symbol: "person.crop.circle.badge.exclamationmark", tint: attention,
                         actionTitle: "Open dashboard") { UIApplication.shared.open(model.dashboardURL) }
        } else if isUnreadable {
            return .init(title: "Relo can\u{2019}t read the server", detail: "The server answered, but this app couldn\u{2019}t read it; an update may be needed. Showing what was saved at the last sync.",
                         symbol: "exclamationmark.icloud", tint: attention,
                         actionTitle: "Try again") { Task { _ = await model.refresh() } }
        } else if isOffline {
            return .init(title: "You're offline", detail: model.lastSyncedAt == nil
                            ? "No saved activity yet. Connect to load Now." : "Showing what was saved at the last sync.",
                         symbol: "wifi.slash", tint: attention,
                         actionTitle: "Try again") { Task { _ = await model.refresh() } }
        } else if case .failed = model.registrationState {
            return .init(title: "Connection needs attention", detail: "This iPhone couldn't register with your server.",
                         symbol: "iphone.badge.exclamationmark", tint: attention,
                         actionTitle: "Review connection") { sheet = nil; tab = .settings }
        } else if model.isRegistered && (model.permission != .allowed || model.pushRegistrationError != nil || !model.liveActivitiesAuthorized) {
            return .init(title: "Check notification settings", detail: "Now is current, but alerts or Live Activities may not reach you.",
                         symbol: "bell.badge", tint: attention,
                         actionTitle: "Review settings") { sheet = nil; tab = .settings }
        } else if !model.isRegistered {
            return .init(title: "Connecting this iPhone", detail: "Saved activity stays available while Relo reconnects.",
                         symbol: "iphone", tint: ReloHoloTheme.color(.running),
                         actionTitle: "Review connection") { sheet = nil; tab = .settings }
        }
        return .init(title: isUpdating ? "Syncing" : "Live", detail: "Now, alerts and Live Activities are up to date.",
                     symbol: "checkmark.icloud", tint: ReloHoloTheme.color(.done),
                     actionTitle: "Sync now") { Task { _ = await model.refresh() } }
    }

    private var connectionDetails: [ReloConnectionSheet.Detail] {
        var rows: [ReloConnectionSheet.Detail] = [
            .init(label: "Server", value: model.serverURL.host() ?? model.serverURL.absoluteString),
            .init(label: "Last synced", value: model.lastSyncedAt.map {
                Calendar.current.isDateInToday($0) ? $0.formatted(date: .omitted, time: .shortened)
                    : $0.formatted(date: .abbreviated, time: .shortened)
            } ?? "Not yet"),
        ]
        let alerts = model.permission == .allowed && model.pushRegistrationError == nil
        rows.append(.init(label: "Notifications", value: alerts ? "On" : "Off", warning: !alerts))
        rows.append(.init(label: "Live Activities", value: model.liveActivitiesAuthorized ? "On" : "Off",
                          warning: !model.liveActivitiesAuthorized))
        if model.pendingResponseCount > 0 {
            rows.append(.init(label: "Sending", value: model.pendingResponseCount == 1 ? "1 answer" : "\(model.pendingResponseCount) answers"))
        }
        return rows
    }
}

/// How far the page is pulled past its top, from the scroll view's own geometry (iOS 18 and
/// later): read after scrolling, never as a layout pass inside the scrolled content.
private struct ReloOverscrollReader: ViewModifier {
    let changed: (CGFloat) -> Void
    func body(content: Content) -> some View {
        if #available(iOS 18, *) {
            content.onScrollGeometryChange(for: CGFloat.self) { geometry in
                max(0, -(geometry.contentOffset.y + geometry.contentInsets.top))
            } action: { _, overscroll in
                changed(overscroll)
            }
        } else {
            content
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
/// - One snapshot: the counts, tasks and colours update together, only from trusted
///   state, coalesced (latest wins); untrusted moments (reconnecting, counts unknown,
///   registering) hold the last good snapshot instead of dipping and rebounding.
/// - The first observation is never news: after the deck appears, wakes or reconnects, the first
///   trusted snapshot becomes the baseline; effects arm a moment later and disarm when unseen.
/// - Hysteresis: the deck goes dormant only after the server has been out of reach for a while
///   in the foreground, and comes back only once the connection has held, with a quiet fade.
/// - The sign-in ceremony runs once, on fixed deadlines from its start; interrupted, it jumps
///   to its end rather than restarting.
/// - One effect bus: at most one ripple per change; the loading pulse never stacks on a ripple.
///   Cues (sound and haptic, ADR 0013) only for moments new by id: a question, a failure, your turn, a finish,
///   and the sign-in landing on its LINKED plate; one per batch, spaced, never on the first observation.
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
        /// The live cards.
        var tasks: [ReloHoloTask]
        /// The sessions working now, a count of their own.
        var sessionsWorking: [ReloHoloTask] = []
        /// The sessions at work by phase, machine and harness (the deck's satellites and machines line).
        var sessions: [ReloHUDSession] = []
        /// Work waiting on the owner (the Waiting on you fold).
        var waitingOnYou = 0
        var mix: NowMix
        /// The owner-meaningful moments present now, ids by cue (ADR 0013): the cue gate cues each once.
        var moments: [ReloCue: Set<String>] = [:]
        /// Ids among `moments` whose page the owner has open: seen, so never cued.
        var looking: Set<String> = []
    }

    struct Input: Equatable {
        var snapshot: Snapshot
        /// Connected, counts known, not mid-registration: safe to show.
        var trusted: Bool
        /// False only when the server is out of reach (offline, VPN off, server down); reconnecting is fine.
        var reachable: Bool
        /// A fresh sign-in is waiting for its ceremony.
        var linkPending: Bool
        /// This iPhone holds a device credential and is registered: linking is done, even if the
        /// live counts are still on their way (they settle quietly after the ceremony).
        var linked: Bool = false
        /// Now is the selected tab, the deck is on screen and the app is active.
        var visible: Bool
        /// Now is the selected tab and the app is active, wherever the page is scrolled; nil means
        /// the same as `visible`. Scrolling the deck out of view pauses its effects but is not
        /// time away: coming back to it never replays the power-on.
        var onScreen: Bool? = nil
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
        /// At most one cue this often (seconds).
        var hapticCooldown: TimeInterval = 2
        /// Multiplies the ceremony's timeline (tests run it fast).
        var ceremonyScale: Double = 1
        /// Away at least this long, and the HUD powers on again when it is next seen.
        var powerOnAfterAway: TimeInterval = 30
        /// The first time the deck is seen in a run, the HUD powers on.
        var powerOnAtLaunch = true
        /// Now on screen and trusted this long before a new moment is cued (what arrives while waking was
        /// told by the push or is already on the cards: it is the baseline, not news).
        var cueSettle: Duration = .seconds(2)
    }
    let timing: Timing
    init(timing: Timing = Timing()) {
        self.timing = timing
        gate = ReloCueGate(spacing: timing.hapticCooldown)
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
    /// The cue effect bus: each tick is one moment (sound and haptic) for the view to play; `cue` is which.
    private(set) var cueTicks = 0
    private(set) var cue: ReloCue?
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
    private var gate = ReloCueGate()
    /// When cues may start (Now on screen and trusted, plus `cueSettle`); nil while away.
    private var cueReadyAt: Date?

    func ingest(_ next: Input) {
        let previous = input
        input = next
        let becameVisible = next.visible && previous?.visible != true
        let onScreen = next.onScreen ?? next.visible

        if !next.visible {
            disarm()
            if phase == .booting { finishCeremony() }
            if powerTask != nil { finishPowerOn() }
        }
        if !onScreen, hiddenAt == nil, previous.map({ $0.onScreen ?? $0.visible }) == true { hiddenAt = .now }
        // Seen for the first time in this run, or again after a while away: the HUD powers on.
        if becameVisible && !next.linkPending && phase == .live {
            let away = hiddenAt.map { Date.now.timeIntervalSince($0) } ?? 0
            if (!hasBeenSeen && timing.powerOnAtLaunch) || (hasBeenSeen && away >= timing.powerOnAfterAway) {
                powerOn(badge: ("ACTIVE", "RELO · NOW", "FEED . LIVE"))
            }
        }
        if next.visible { hasBeenSeen = true; hiddenAt = nil }
        // Cues follow Now being on screen (scrolled or not), not the deck: a question lands whatever is in view.
        if !onScreen { cueReadyAt = nil }
        else if next.trusted, cueReadyAt == nil {
            let settle = timing.cueSettle.components
            cueReadyAt = Date.now.addingTimeInterval(Double(settle.seconds) + Double(settle.attoseconds) / 1e18)
        }

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
            observeMoments(next.snapshot)
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
        observeMoments(next)
        guard armed, phase == .live, let old else { return }
        let newRequest = (next.needsYou ?? 0) > (old.needsYou ?? 0)
        let news = newRequest || next.summary.total > old.summary.total
            || next.summary.finished > old.summary.finished || next.tasks.count != old.tasks.count
            || next.sessionsWorking.count != old.sessionsWorking.count
        if news { emitWave(1.0) }
    }

    // MARK: Cues

    /// Finds the moments that are new by id and cues the highest one. Until Now has been on screen and trusted
    /// for `cueSettle`, and whenever the deck is not live, ids are still consumed (the baseline) but make no sound.
    private func observeMoments(_ snapshot: Snapshot) {
        let ready = phase == .live && (cueReadyAt.map { Date.now >= $0 } ?? false)
        if let cue = gate.observe(snapshot.moments, quiet: !ready, looking: snapshot.looking) { emit(cue) }
    }

    private func emit(_ cue: ReloCue) {
        self.cue = cue
        cueTicks += 1
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
                self.emit(.linked)
                guard await at(2.0) else { return }
                self.finishCeremony(); return
            }
            // One focal point at a time: the link confirms on a status plate, the ring traces,
            // the four corner modules build their parts together, the leaders tie them in, then
            // the welcome.
            guard await at(0.15) else { return }
            // The link lands here: the plate, the ripple, Relo's bloom and the success haptic on one beat.
            self.show(("LINKED", "RELO · ACCOUNT", "LINK . OK"), warning: false)
            self.emitWave(0.9)
            self.emit(.linked)
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
        withAnimation(.easeOut(duration: ReloMotion.fast)) { badge = next }
        badgeTask?.cancel()
        let duration = next.duration
        badgeTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(duration))
            guard let self, !Task.isCancelled, self.badge?.id == next.id else { return }
            withAnimation(.easeOut(duration: ReloMotion.fast)) { self.badge = nil }
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

// MARK: - Now summary controller (1.13 / 1.14)

/// Fetches `GET /api/now`, keeps the last summary per account for offline, and refetches on
/// foreground, on a current-state wake (coalesced), every 60 s while Now is visible and once at
/// the server's `refreshAt`. It decides no state: the summary is the server's derivation.
/// `lastLookedAt` (a device fact) is read once per foreground session as `since` and written when
/// the scene leaves `.active` after Now was on screen for at least 2 s.
@MainActor
@Observable
final class NowSummaryController {
    private(set) var isOffline = false
    /// The last fetch reached the server but couldn't read its answer: shown as unreadable, not offline.
    private(set) var isUnreadable = false
    @ObservationIgnored private var since: Date?
    @ObservationIgnored private var visibleSince: Date?
    @ObservationIgnored private var wakeTask: Task<Void, Never>?
    @ObservationIgnored private var fetching = false
    @ObservationIgnored private var refetchAfter = false
    @ObservationIgnored private lazy var sealed = ReloSealedContent.live()
    @ObservationIgnored private lazy var nameResolver = sealed.nameResolver

    private static func scopeKey(_ model: AppModel) -> String? {
        guard let credential = model.credential else { return nil }
        return "\(model.serverOrigin)|\(credential.accountId)"
    }

    private static func lookedKey(_ scope: String) -> String { "now.lastLookedAt|\(scope)" }

    /// The cache holds the summary exactly as the server sent it (sealed text still sealed), so no
    /// plaintext reaches Caches; it is opened again on every load, like a fresh fetch.
    private static func cacheURL(_ scope: String, version: Int = 2) -> URL? {
        let safe = scope.data(using: .utf8)!.base64EncodedString()
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "+", with: "-")
        return FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first?
            .appendingPathComponent("now-summary-v\(version)-\(safe).json")
    }

    private func source(_ model: AppModel, token: String) -> HTTPNowSource {
        HTTPNowSource(baseURL: model.serverURL, token: token, nameResolver: nameResolver)
    }

    /// A summary as the server sent it, decoded with names and opened on this phone: session names
    /// first (they teach the name book), then each row's card and question. Off the main actor: the
    /// decode and the opens (Keychain, crypto) run every fetch and must never hold up a frame.
    private func opened(_ data: Data, source: HTTPNowSource) async throws -> NowSummary {
        let sealed = self.sealed
        return try await Task.detached(priority: .userInitiated) {
            try source.decode(data)
                .openingSessionNames(sealed.opener)
                .openingSealed(sealed.displayOpener, diagnose: sealed.diagnoser)
        }.value
    }

    /// Now came on screen in an active scene: capture `since` for this session and load the cache.
    func appeared(_ model: AppModel) {
        visibleSince = .now
        guard let scope = Self.scopeKey(model), let credential = model.credential else { return }
        since = UserDefaults.standard.object(forKey: Self.lookedKey(scope)) as? Date
        // v1 held opened text; it is gone for good.
        if let old = Self.cacheURL(scope, version: 1) { try? FileManager.default.removeItem(at: old) }
        guard model.nowSummary == nil, let url = Self.cacheURL(scope) else { return }
        let source = source(model, token: credential.accessToken)
        Task { [weak self] in
            // Read and open off the main actor; a fetch that landed meanwhile is fresher and is kept.
            guard let self, let data = try? await Task.detached(operation: { try Data(contentsOf: url) }).value,
                  let summary = try? await self.opened(data, source: source),
                  model.nowSummary == nil, Self.scopeKey(model) == scope else { return }
            model.receiveNowSummary(summary)
        }
    }

    /// The scene left `.active` (or Now left the screen): the owner looked, if Now was up ≥ 2 s.
    func disappeared(_ model: AppModel) {
        defer { visibleSince = nil }
        guard let shown = visibleSince, Date.now.timeIntervalSince(shown) >= 2,
              let scope = Self.scopeKey(model) else { return }
        UserDefaults.standard.set(Date.now, forKey: Self.lookedKey(scope))
    }

    /// The current-state stream woke: fetch, at most once per 2 s.
    func wake(_ model: AppModel) {
        guard wakeTask == nil else { return }
        wakeTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(2))
            guard let self, !Task.isCancelled else { return }
            self.wakeTask = nil
            await self.fetch(model)
        }
    }

    func fetch(_ model: AppModel) async {
        // A fetch asked for mid-flight runs right after, so it sees what changed meanwhile (a dismissal).
        guard !fetching else { refetchAfter = true; return }
        fetching = true
        repeat {
            refetchAfter = false
            await fetchOnce(model)
        } while refetchAfter && !Task.isCancelled
        fetching = false
    }

    private func fetchOnce(_ model: AppModel) async {
        guard let credential = model.credential, let scope = Self.scopeKey(model) else { return }
        let source = source(model, token: credential.accessToken)
        do {
            // A clock change can put `since` past the server's time; the server clamps it too.
            let data = try await source.fetchNowData(since: since.map { min($0, model.currentTime) })
            let summary = try await opened(data, source: source)
            guard Self.scopeKey(model) == scope else { return }
            model.receiveNowSummary(summary)
            isOffline = false
            isUnreadable = false
            if let url = Self.cacheURL(scope) {
                try? data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            }
        } catch is CancellationError {
        } catch {
            // Keep the cached summary; Now shows it as last known, and names an unreadable answer as such.
            isOffline = true
            isUnreadable = (error as? InboxRemoteError) == .incompatibleResponse
        }
    }

    /// Seconds until the next scheduled fetch: the 60 s tick, or sooner at the server's `refreshAt`.
    func nextWait(_ model: AppModel) -> TimeInterval {
        guard let summary = model.nowSummary, let refreshAt = summary.refreshAt else { return 60 }
        let wait = refreshAt.timeIntervalSince(summary.serverTime) + 1
        return wait > 0 && wait < 60 ? wait : 60
    }
}

/// Opened from the deck's sync line: a half-height sheet that says where the data stands,
/// the few facts behind it, and the one thing to do about it.
struct ReloConnectionSheet: View {
    struct Recovery {
        var title: String
        var detail: String
        var symbol: String
        var tint: Color
        var actionTitle: String
        var action: () -> Void
    }

    struct Detail: Identifiable {
        var label: String
        var value: String
        var warning = false
        var id: String { label }
    }

    let recovery: Recovery
    let details: [Detail]

    var body: some View {
        ScrollView {
            VStack(spacing: 24) {
                VStack(spacing: 10) {
                    Image(systemName: recovery.symbol)
                        .font(.system(size: 26, weight: .semibold))
                        .foregroundStyle(recovery.tint)
                        .frame(width: 60, height: 60)
                        .background(recovery.tint.opacity(0.14), in: Circle())
                        .accessibilityHidden(true)
                    Text(recovery.title).font(.title3.weight(.semibold))
                    Text(recovery.detail)
                        .font(.subheadline).foregroundStyle(Color.reloSecondaryText)
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .frame(maxWidth: .infinity)
                .accessibilityElement(children: .combine)

                VStack(spacing: 0) {
                    ForEach(Array(details.enumerated()), id: \.element.id) { index, row in
                        if index > 0 { Divider().padding(.leading, 16) }
                        HStack(spacing: 12) {
                            Text(row.label).foregroundStyle(Color.reloSecondaryText)
                            Spacer(minLength: 12)
                            Text(row.value)
                                .foregroundStyle(row.warning ? ReloHoloTheme.color(.attention) : Color.primary)
                                .lineLimit(1).truncationMode(.middle)
                        }
                        .font(.subheadline)
                        .padding(.horizontal, 16)
                        .frame(minHeight: 44)
                        .accessibilityElement(children: .combine)
                    }
                }
                .reloCard()

                Button(action: recovery.action) {
                    Text(recovery.actionTitle).font(.body.weight(.semibold)).frame(maxWidth: .infinity, minHeight: 34)
                }
                .buttonStyle(.borderedProminent).controlSize(.large).tint(.reloInteractive)
            }
            .padding(.horizontal, ReloLayout.screenInset)
            .padding(.top, 28).padding(.bottom, 16)
        }
        .scrollBounceBehavior(.basedOnSize)
        .reloScreenBackground()
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }
}
