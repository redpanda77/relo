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
            state: requested == "welcome" || requested == "signin" ? .signedOut : requested == "long-message" ? .longContent : .ready
        )
        if requested == "now" || requested == "now-clear" { model.seedPreviewCurrentWork(clear: requested == "now-clear") }
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
        }
    }
}

private struct ReloFlowCaptureScreen: View {
    @Bindable var model: AppModel
    let screen: String

    var body: some View {
        Group {
            switch screen {
            case let deck where deck.hasPrefix("deck-"): ReloDeckGallery(variant: String(deck.dropFirst(5)))
            case let plan where plan.hasPrefix("plan-"): PlanFixtureGallery(model: model, variant: String(plan.dropFirst(5)))
            case let sheet where sheet.hasPrefix("sheet-"): ReloSheetGallery(model: model, variant: String(sheet.dropFirst(6)))
            case "welcome": OnboardingView(model: model)
            case "signin": NavigationStack { SignInView(model: model) }
            default:
                ReloRootView(model: model, initialTab: screen == "history" ? .history : screen == "settings" ? .settings : .now)
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
        let (summary, needsYou, tasks, mix, satellites) = scenario
        VStack(spacing: 0) {
            ReloNowHero(summary: summary, needsYou: needsYou, tasks: tasks, mix: mix, satellites: satellites,
                        agentTime: "4h 12m",
                        sync: .live(.now), topInset: 59)
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
        case "needs": "NEEDS YOU · two requests orbiting toward their deadlines"
        case "trouble": "TROUBLE · stopped and expired work"
        case "messages": "MESSAGES · a day of notifications"
        default: "MIXED · every meaning at once"
        }
    }

    private var scenario: (InboxTodaySummary, Int, [ReloHoloTask], NowMix, [ReloOrbitSatellite]) {
        switch variant {
        case "clear":
            return (.init(notifications: 3, liveActivities: 20, active: 0, finished: 20), 0, [],
                    NowMix(counts: [.done: 20, .message: 3]), [])
        case "running":
            return (.init(notifications: 2, liveActivities: 8, active: 3, finished: 5), 0,
                    [.init(id: "a", progress: 0.72), .init(id: "b", progress: 0.35), .init(id: "c", progress: nil)],
                    NowMix(counts: [.running: 3, .done: 5, .message: 2]), [])
        case "needs":
            return (.init(notifications: 5, liveActivities: 5, active: 1, finished: 4), 2, [.init(id: "a", progress: 0.4)],
                    NowMix(counts: [.needsYou: 2, .running: 1, .done: 4, .message: 3]),
                    [.init(id: "s1", remaining: 0.7), .init(id: "s2", remaining: 0.12)])
        case "trouble":
            return (.init(notifications: 1, liveActivities: 9, active: 0, finished: 9), 0, [],
                    NowMix(counts: [.failed: 3, .attention: 4, .done: 2, .message: 1]), [])
        case "messages":
            return (.init(notifications: 12, liveActivities: 1, active: 0, finished: 1), 0, [],
                    NowMix(counts: [.message: 12, .done: 1]), [])
        default:
            return (.init(notifications: 4, liveActivities: 10, active: 2, finished: 6), 1,
                    [.init(id: "a", progress: 0.6), .init(id: "b", progress: 0.2)],
                    NowMix(counts: [.done: 4, .running: 2, .needsYou: 1, .attention: 2, .failed: 1, .message: 4]),
                    [.init(id: "s1", remaining: 0.45)])
        }
    }
}

#endif
