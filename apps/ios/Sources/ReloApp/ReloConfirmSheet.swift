import ReloCore
import SwiftUI

/// What a confirmation sheet asks: a symbol, a title, what happens, the main button, an optional second
/// choice (Approve / Deny), and the work to do. A device-owner check can run first.
struct ReloConfirmSpec {
    struct Alternative {
        var title: String
        var destructive = false
        var action: () async throws -> Void
    }

    var title: String
    var message: String
    var symbol = "exclamationmark.triangle"
    var actionTitle: String
    var destructive = true
    /// nil for a notice: the action button is the only way out.
    var cancelTitle: String? = "Cancel"
    /// Face ID / passcode reason shown before the action runs; nil asks nothing.
    var ownerCheckReason: String?
    var alternative: Alternative?
    var action: () async throws -> Void
}

/// The one confirmation of the app: a fitted bottom sheet on the shared scaffold. Shows progress while the
/// action runs and its error inline.
struct ReloConfirmSheet: View {
    let spec: ReloConfirmSpec
    @Environment(\.dismiss) private var dismiss
    @State private var working = false
    @State private var problem: String?

    var body: some View {
        ReloSheet(cancelTitle: spec.cancelTitle, busy: working) {
            ReloSheetHeader(symbol: spec.symbol, tint: spec.destructive ? .reloDestructive : .reloAttention,
                            title: spec.title, message: spec.message)
        } content: {
            if let problem { ReloSheetProblem(text: problem) }
        } actions: {
            Button { run(spec.action, check: spec.ownerCheckReason) } label: {
                if working { ProgressView().tint(spec.destructive ? .reloDestructive : .reloOnAction) } else { Text(spec.actionTitle) }
            }
            .buttonStyle(.relo(spec.destructive ? .destructive : .primary))
            .accessibilityIdentifier("confirm-sheet-action")
            if let alternative = spec.alternative {
                Button(alternative.title) { run(alternative.action, check: nil) }
                    .buttonStyle(.relo(alternative.destructive ? .destructive : .secondary))
            }
        }
    }

    private func run(_ action: @escaping () async throws -> Void, check reason: String?) {
        problem = nil
        working = true
        Task {
            defer { working = false }
            if let reason, !(await DeviceOwnerCheck.confirm(reason: reason)) {
                problem = "Not confirmed. Try again."
                return
            }
            do {
                try await action()
                dismiss()
            } catch {
                problem = error.localizedDescription
            }
        }
    }
}

extension ReloBrowserLink.Code: @retroactive Identifiable { public var id: String { browserID } }
extension ReloComputerSignIn.Request: @retroactive Identifiable { public var id: String { userCode } }

extension View {
    /// A confirmation bottom sheet shown while `isPresented` holds.
    func reloConfirmation(isPresented: Binding<Bool>, spec: @escaping () -> ReloConfirmSpec) -> some View {
        sheet(isPresented: isPresented) { ReloConfirmSheet(spec: spec()) }
    }

    /// A confirmation bottom sheet for the item being confirmed; nil closes it.
    func reloConfirmation<Item: Identifiable>(item: Binding<Item?>, spec: @escaping (Item) -> ReloConfirmSpec) -> some View {
        sheet(item: item) { ReloConfirmSheet(spec: spec($0)) }
    }
}
