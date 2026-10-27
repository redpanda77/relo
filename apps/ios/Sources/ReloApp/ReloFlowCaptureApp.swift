#if DEBUG && RELO_FLOW_CAPTURE
import ReloCore
import SwiftUI

/// A separately built capture entry point. Regular app builds never compile this host.
/// Uses the real product views with in-memory, fictional preview accounts and clients.
@main
struct ReloFlowCaptureApp: App {
    @State private var model: AppModel
    private let screen: String
    private let largeType: Bool

    init() {
        let arguments = ProcessInfo.processInfo.arguments
        let requested = arguments.firstIndex(of: "--screen").flatMap { index in
            arguments.indices.contains(index + 1) ? arguments[index + 1] : nil
        } ?? "now"
        screen = requested
        largeType = arguments.contains("--large-type")
        let model = AppModel.preview(
            state: requested == "welcome" || requested == "signin" ? .signedOut : requested == "long-message" ? .longContent
                : requested == "history-dense" ? .denseHistory : .ready
        )
        if requested == "now" || requested == "now-clear" || requested == "cards" {
            model.seedPreviewCurrentWork(clear: requested == "now-clear")
        }
        if requested == "sessions" || requested == "since" {
            // Capture only: just the sessions, or just Since you looked and the Quiet/Paused fold, on a still page.
            model.seedPreviewSessions()
            model.seedPreviewSettled()
            ReloCaptureFlags.opensFailedPanels = true
        }
        if requested == "system" { ReloCaptureFlags.systemCards = true }
        if requested == "cards" { model.seedPreviewCards(); ReloCaptureFlags.decisionsReady = true }
        if requested == "quiet-activity" || requested == "quiet-now" { model.seedPreviewQuietWork() }
        _model = State(initialValue: model)
    }

    var body: some Scene {
        WindowGroup {
            ReloFlowCaptureScreen(model: model, screen: screen)
                .preferredColorScheme(.dark)
                .transformEnvironment(\.dynamicTypeSize) { value in
                    if largeType { value = .accessibility5 }
                }
                .tint(.reloInteractive)
                .task {
                    // `--landscape`: the same screen sideways, for the History timeline's two-column layout.
                    guard ProcessInfo.processInfo.arguments.contains("--landscape"),
                          let scene = UIApplication.shared.connectedScenes.first as? UIWindowScene else { return }
                    scene.requestGeometryUpdate(.iOS(interfaceOrientations: .landscapeRight))
                }
        }
    }
}

private struct ReloFlowCaptureScreen: View {
    @Bindable var model: AppModel
    let screen: String

    /// The Now input with only the sections under review: sessions, or since-you-looked with the fold.
    private var settledInput: NowScreenInput {
        var input = NowScreenInput(summary: model.nowSummary!)
        input.needsYou = []; input.waitingOnYou = []; input.running = []
        if screen == "sessions" {
            input.recent = []; input.quiet = []; input.paused = []; input.sinceYouLooked = nil
        } else {
            input.sessions = []
        }
        return input
    }

    /// Empty Now with sessions from idle machines: MacBook and the build server seen lately, Studio an hour ago.
    private var standbyInput: NowScreenInput {
        var input = NowScreenInput(serverTime: .now, sinceYouLooked: nil)
        func idle(_ id: String, _ computer: String, _ icon: ComputerIcon, minutes: Double) -> NowSessionInput {
            NowSessionInput(id: id, title: computer, computer: computer, computerIcon: icon, phase: .idle, waitingFor: nil,
                            lastSeenAt: .now.addingTimeInterval(-minutes * 60), workID: nil, folded: true)
        }
        input.sessions = [idle("s1", "MacBook", .laptop, minutes: 2), idle("s2", "Build Server", .server, minutes: 4),
                          idle("s3", "Studio", .desktop, minutes: 70)]
        return input
    }

    var body: some View {
        Group {
            switch screen {
            case let deck where deck.hasPrefix("deck-"): ReloDeckGallery(variant: String(deck.dropFirst(5)))
            case let plan where plan.hasPrefix("plan-"): PlanFixtureGallery(model: model, variant: String(plan.dropFirst(5)))
            case let sheet where sheet.hasPrefix("sheet-"): ReloSheetGallery(model: model, variant: String(sheet.dropFirst(6)))
            case "card-quiet": QuietCardGallery()
            case "history-decision": HistoryDecisionGallery()
            case "cards":
                // The Now page without its deck, so the cards sit at the top of a still capture.
                ScrollView {
                    CurrentAttentionView(model: model, input: NowScreenInput(summary: model.nowSummary!))
                        .padding(.horizontal, 31).padding(.top, 70)
                }
                .background { ReloAppBackdrop() }
            case "system":
                // Every system card with fixture state, as C4 shows them.
                ScrollView {
                    NowSystemSection(model: model, showConnection: {})
                        .padding(.horizontal, 16).padding(.top, 28)
                }
                .background { ReloAppBackdrop() }
            case "standby":
                // An empty Now: the only sessions are on idle machines.
                ScrollView {
                    CurrentAttentionView(model: model, input: standbyInput)
                        .padding(.horizontal, 16).padding(.top, 28)
                }
                .background { ReloAppBackdrop() }
            case "sessions", "since":
                ScrollView {
                    CurrentAttentionView(model: model, input: settledInput)
                        .padding(.horizontal, 16).padding(.top, 28)
                }
                .background { ReloAppBackdrop() }
            case "welcome": OnboardingView(model: model)
            case "signin": NavigationStack { SignInView(model: model) }
            default:
                ReloRootView(model: model, initialTab: screen.hasPrefix("history") ? .history : screen == "settings" ? .settings : .now)
            }
        }
        .task {
            // Let the native tab stacks attach before exercising a detail deep link.
            try? await Task.sleep(for: .milliseconds(750))
            guard !Task.isCancelled else { return }
            let id: String? = switch screen {
            case "message": "ntf_previewmessage"
            case "approval": "ntf_previewapproval"
            case "activity", "quiet-activity": "ntf_previewworking"
            case "text-request", "reply": "ntf_previewreply"
            case "long-message": "ntf_previewlong"
            default: nil
            }
            // The preview model has no remote Inbox; opening a fixture uses its cached item.
            if let id { await model.openNotification(notificationID: id) }
        }
    }
}

/// Capture only: the quiet work card of the C1 design (Quiet sits in a fold on Now, closed by default).
private struct QuietCardGallery: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ReloWorkCard(origin: ReloCardOrigin(source: "api", project: "api", topic: "Rate limits"), at: nil,
                         title: "Add per-key rate limits to the public API",
                         summary: "No update since 6:27 PM. The session is still open.", quiet: true,
                         steps: .init(done: 1, total: 5, current: "Limits", currentIndex: 2, fill: 0),
                         progressCaption: "Step 2 of 5", color: ReloStateStyle.quiet.color,
                         state: ReloStateStyle.quiet.labelled("Quiet 14 min"), computer: "MacBook")
            Spacer()
        }
        .padding(.horizontal, 31).padding(.top, 80)
        .background { ReloAppBackdrop() }
    }
}

/// Capture only: a finished work on History with the question it asked and how it was answered, beside a plain
/// message row, to check the answered-question panel's place and spacing.
private struct HistoryDecisionGallery: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ReloWorkCard(origin: ReloCardOrigin(source: "Claude Code", project: "relo", topic: "Canvas header UI analysis"),
                         at: Date.now.addingTimeInterval(-600), title: "Fix the clipped satellite and bring the iPhone cards up to the canvas designs",
                         summary: "Relo 0.10.43 (106) with the notch-style cards, header fixes and the step bar and stale-time fixes is installed on the iPhone.",
                         steps: .init(done: 8, total: 8, current: "Install", currentIndex: 8, fill: 0),
                         progressCaption: "8 of 8 done · 4 hr, 6 min", color: ReloStateStyle.done.color,
                         state: ReloStateStyle.done, computer: "MacBook Pro", surface: .listCell) {
                CardDecisionLine(prompt: "Your iPhone is out of the Mac's reach. Unlock it near the Mac on the same Wi-Fi. Ready for me to install the new build?",
                                 answer: "You said yes", tint: ReloStateStyle.done.color, at: Date.now.addingTimeInterval(-3_000))
                    .cardGap(above: 12)
            }
            .padding(.horizontal, 16).padding(.vertical, 14)
        }
        .frame(maxWidth: .infinity)
        .reloCard()
        .padding(.horizontal, 16).padding(.top, 90)
        .frame(maxHeight: .infinity, alignment: .top)
        .background { ReloAppBackdrop() }
    }
}

/// Capture only: each sheet template over the Now screen, to review them side by side.
private struct ReloSheetGallery: View {
    @Bindable var model: AppModel
    let variant: String
    @State private var shown = true

    var body: some View {
        ReloRootView(model: model, initialTab: .settings)
            .sheet(isPresented: $shown) {
                switch variant {
                case "access": AccessRequestSheet(model: model, id: "dev_preview")
                default: ReloConfirmSheet(spec: spec)
                }
            }
    }

    private var spec: ReloConfirmSpec {
        switch variant {
        case "approve":
            ReloConfirmSpec(title: "Approve Studio Mac?", message: "It will read and send encrypted items for this account.",
                            symbol: "laptopcomputer", actionTitle: "Approve", destructive: false,
                            alternative: .init(title: "Deny", destructive: true, action: {}), action: {})
        case "notice":
            ReloConfirmSpec(title: "Export unavailable",
                            message: "The diagnostic file could not be saved. Your responses and current state are unchanged.",
                            symbol: "exclamationmark.triangle", actionTitle: "OK", destructive: false, cancelTitle: nil, action: {})
        default:
            ReloConfirmSpec(title: "Sign out Studio Mac?",
                            message: "It stops reading encrypted items until you approve it again.",
                            symbol: "rectangle.portrait.and.arrow.right", actionTitle: "Sign out", action: {})
        }
    }
}

/// Capture only: the Now deck in each state with synthetic numbers, to review the colors.
private struct ReloDeckGallery: View {
    let variant: String

    var body: some View {
        let (summary, needsYou, tasks, mix) = scenario
        VStack(spacing: 0) {
            ReloNowHero(summary: summary, needsYou: needsYou, tasks: tasks,
                        waitingOnYou: sessions.filter { $0.phase == .yourTurn }.count, sessions: sessions,
                        idleMachines: idleMachines, mix: mix,
                        sync: sync, topInset: 59,
                        leadOverride: variant == "connecting" ? .connecting : nil)
            Text(caption).font(.system(.footnote, design: .monospaced)).foregroundStyle(Color.reloSecondaryText)
                .padding(.top, 24)
            Spacer()
        }
        .reloScreenBackground()
        .ignoresSafeArea(edges: .top)
    }

    private var caption: String {
        switch variant {
        case "clear": "ALL CLEAR · mostly done, a few messages"
        case "running": "RUNNING · three tasks with progress"
        case "needs": "NEEDS YOU · two requests waiting"
        case "trouble": "TROUBLE · stopped and expired work"
        case "turn": "YOUR TURN · one session waits, one runs"
        case "quiet": "SESSIONS · quiet sessions only"
        case "offline": "OFFLINE · as of the last sync"
        case "connecting": "CONNECTING · counts unknown"
        case "messages": "MESSAGES · a day of notifications"
        default: "MIXED · every meaning at once"
        }
    }

    /// The sessions at work in the variant: the satellites and the machines line.
    private var sessions: [ReloHUDSession] {
        switch variant {
        case "turn":
            [.init(id: "t1", phase: .yourTurn, computer: "MacBook Pro", computerIcon: .laptop, source: "claude-code"),
             .init(id: "t2", phase: .running, computer: "Build Server", computerIcon: .server, source: "claude-code")]
        case "quiet":
            [.init(id: "q1", phase: .quiet, computer: "MacBook Pro", computerIcon: .laptop, source: "codex")]
        case "offline":
            [.init(id: "o1", phase: .running, computer: "MacBook Pro", computerIcon: .laptop, source: "claude-code"),
             .init(id: "o2", phase: .running, computer: "Build Server", computerIcon: .server, source: "claude-code")]
        default: []
        }
    }

    /// Machines with nothing at work, listed dim.
    private var idleMachines: [String] { variant == "turn" || variant == "quiet" ? ["Studio"] : [] }

    private var sync: ReloDeckFooter.Sync {
        switch variant {
        case "offline": .offline(Date.now.addingTimeInterval(-300))
        case "connecting": .syncing
        default: .live(Date.now)
        }
    }

    private var scenario: (InboxTodaySummary, Int, [ReloHoloTask], NowMix) {
        switch variant {
        case "turn":
            return (.init(notifications: 2, liveActivities: 4, active: 1, finished: 3), 0, [.init(id: "a", progress: 0.66)],
                    NowMix(counts: [.running: 1, .done: 3]))
        case "quiet":
            return (.init(notifications: 1, liveActivities: 2, active: 0, finished: 2), 0, [],
                    NowMix(counts: [.done: 2, .message: 1]))
        case "offline":
            return (.init(notifications: 1, liveActivities: 3, active: 2, finished: 1), 0,
                    [.init(id: "a", progress: 0.66), .init(id: "b", progress: 0.4)],
                    NowMix(counts: [.running: 2, .done: 1]))
        case "connecting":
            return (.init(notifications: 0, liveActivities: 0, active: 0, finished: 0), 0, [], NowMix(counts: [:]))
        case "clear":
            return (.init(notifications: 3, liveActivities: 20, active: 0, finished: 20), 0, [],
                    NowMix(counts: [.done: 20, .message: 3]))
        case "running":
            return (.init(notifications: 2, liveActivities: 8, active: 3, finished: 5), 0,
                    [.init(id: "a", progress: 0.72), .init(id: "b", progress: 0.35), .init(id: "c", progress: nil)],
                    NowMix(counts: [.running: 3, .done: 5, .message: 2]))
        case "needs":
            return (.init(notifications: 5, liveActivities: 5, active: 1, finished: 4), 2, [.init(id: "a", progress: 0.4)],
                    NowMix(counts: [.needsYou: 2, .running: 1, .done: 4, .message: 3]))
        case "trouble":
            return (.init(notifications: 1, liveActivities: 9, active: 0, finished: 9), 0, [],
                    NowMix(counts: [.failed: 3, .attention: 4, .done: 2, .message: 1]))
        case "messages":
            return (.init(notifications: 12, liveActivities: 1, active: 0, finished: 1), 0, [],
                    NowMix(counts: [.message: 12, .done: 1]))
        default:
            return (.init(notifications: 4, liveActivities: 10, active: 2, finished: 6), 1,
                    [.init(id: "a", progress: 0.6), .init(id: "b", progress: 0.2)],
                    NowMix(counts: [.done: 4, .running: 2, .needsYou: 1, .attention: 2, .failed: 1, .message: 4]))
        }
    }
}

#endif
