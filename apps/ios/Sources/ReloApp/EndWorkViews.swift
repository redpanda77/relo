import ReloCore
import SwiftUI

// Plan 12b, 4.11: ending a work from the phone. One confirmation, shared by the detail's End work
// button and Now's swipe action; the server decides whether it may end (a moving work is refused).

/// The work to end: its id and the goal the owner sees in the confirmation.
struct EndWorkTarget: Identifiable, Equatable, Sendable {
    let id: String
    let title: String
}

extension View {
    /// A native confirmation dialog: `End "<goal>"?`, what happens, Cancel and End work (destructive).
    func endWorkConfirmation(_ target: Binding<EndWorkTarget?>, model: AppModel) -> some View {
        reloConfirmation(item: target) { work in
            ReloConfirmSpec(
                title: WorkEnding.confirmationTitle(goal: work.title), message: WorkEnding.confirmationMessage,
                symbol: "stop.circle", actionTitle: "End work",
                action: { await model.endWork(workID: work.id) })
        }
    }
}

/// The detail screen's destructive button, below the Details card. After the end, it says so.
struct EndWorkSection: View {
    @Bindable var model: AppModel
    let target: EndWorkTarget
    var ended = false
    @State private var confirming: EndWorkTarget?

    private var ending: Bool { model.endingWorkIDs.contains(target.id) }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if ended {
                Label("Ended by you. It moved to History.", systemImage: "checkmark.circle")
                    .font(.subheadline.weight(.medium)).foregroundStyle(Color.reloSecondaryText)
                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                    .accessibilityElement(children: .combine)
            } else {
                Button(role: .destructive) { confirming = target } label: {
                    HStack(spacing: 8) {
                        if ending { ProgressView().controlSize(.small) } else { Image(systemName: "stop.circle") }
                        Text("End work")
                    }
                }
                .buttonStyle(.reloDestructive)
                .disabled(ending)
                .accessibilityLabel("End work")
                .accessibilityHint("Moves this work to History as ended by you. The agent's session keeps running.")
                if let error = model.endWorkError, model.endWorkErrorWorkID == target.id {
                    Text(error).font(.footnote).foregroundStyle(Color.reloErrorText)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .endWorkConfirmation($confirming, model: model)
    }
}

/// Now's trailing swipe action for a card in a scroll view (a `List` swipe is not available here): drag left
/// to reveal a 44-pt-plus "End" target. VoiceOver gets a named action instead of the gesture.
struct ReloSwipeToEnd: ViewModifier {
    let enabled: Bool
    let action: () -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var offset: CGFloat = 0
    @State private var start: CGFloat?
    private let revealed: CGFloat = 84

    func body(content: Content) -> some View {
        if enabled {
            content
                .offset(x: offset)
                .background(alignment: .trailing) {
                    Button { close(); action() } label: {
                        VStack(spacing: 4) {
                            Image(systemName: "stop.circle").font(.title3)
                            Text("End").font(.caption.weight(.semibold))
                        }
                        .foregroundStyle(.white)
                        .frame(width: max(0, -offset), alignment: .center)
                        .frame(maxHeight: .infinity)
                        .clipped()
                    }
                    .buttonStyle(.plain)
                    .background(Color.reloDestructive.opacity(0.9), in: RoundedRectangle(cornerRadius: ReloLayout.cardRadius, style: .continuous))
                    .opacity(offset < -8 ? 1 : 0)
                    .accessibilityHidden(true)
                }
                .simultaneousGesture(
                    DragGesture(minimumDistance: 24)
                        .onChanged { drag in
                            if start == nil {
                                guard abs(drag.translation.width) > abs(drag.translation.height) * 1.5 else { return }
                                start = offset
                            }
                            offset = min(0, max(-revealed - 16, (start ?? 0) + drag.translation.width))
                        }
                        .onEnded { _ in
                            guard start != nil else { return }
                            start = nil
                            withAnimation(reduceMotion ? nil : .snappy(duration: 0.22)) { offset = offset < -revealed / 2 ? -revealed : 0 }
                        }
                )
                .accessibilityAction(named: "End work", action)
        } else {
            content
        }
    }

    private func close() { withAnimation(reduceMotion ? nil : .snappy(duration: 0.22)) { offset = 0 } }
}

extension View {
    func swipeToEnd(enabled: Bool, action: @escaping () -> Void) -> some View {
        modifier(ReloSwipeToEnd(enabled: enabled, action: action))
    }
}
