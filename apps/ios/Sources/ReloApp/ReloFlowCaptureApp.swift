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
            case "activity": "ntf_previewworking"
            case "text-request", "reply": "ntf_previewreply"
            case "long-message": "ntf_previewlong"
            default: nil
            }
            // The preview model has no remote Inbox; opening a fixture uses its cached item.
            if let id { await model.openNotification(notificationID: id) }
        }
    }
}

#endif
