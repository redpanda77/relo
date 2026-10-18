import SwiftUI

/// The icon, title and message every sheet opens with: one symbol size, centered.
struct ReloSheetHeader: View {
    let symbol: String
    var tint: Color = .reloAttention
    let title: String
    var message: String?

    var body: some View {
        VStack(spacing: 12) {
            Image(systemName: symbol)
                .font(.system(size: 36, weight: .light))
                .foregroundStyle(tint)
                .accessibilityHidden(true)
            VStack(spacing: 6) {
                Text(title).font(.title3.weight(.bold)).multilineTextAlignment(.center)
                    .accessibilityAddTraits(.isHeader)
                if let message {
                    Text(message).font(.subheadline).foregroundStyle(Color.reloSecondaryText)
                        .multilineTextAlignment(.center)
                }
            }
        }
        .frame(maxWidth: .infinity)
    }
}

/// How a sheet sizes: to its content (confirmations, requests) or to standard detents (forms and lists).
enum ReloSheetSizing {
    case fitted
    case detents(Set<PresentationDetent>)
}

/// The bottom-sheet scaffold: header, optional body, a vertical action stack (or, for a confirmation with one
/// action, Cancel and the action side by side), a built-in Cancel. It sits on
/// the surface color (the backdrop belongs to full pages) and shows the drag indicator. Fitted sheets measure
/// their unstretched content, so the sheet ends where the last button does.
struct ReloSheet<Header: View, Content: View, Actions: View>: View {
    var cancelTitle: String? = "Cancel"
    var cancelIdentifier = "sheet-cancel"
    var busy = false
    var sizing: ReloSheetSizing = .fitted
    /// Two actions in one row: Cancel beside the sheet's single action. Stacked at accessibility sizes.
    var pairsActions = false
    @ViewBuilder var header: Header
    @ViewBuilder var content: Content
    @ViewBuilder var actions: Actions
    @Environment(\.dismiss) private var dismiss
    @Environment(\.dynamicTypeSize) private var typeSize
    @State private var contentHeight: CGFloat?

    var body: some View {
        ScrollView {
            VStack(spacing: ReloLayout.sectionSpacing) {
                header
                content
                actionStack
                    .disabled(busy)
            }
            .padding(.horizontal, 24).padding(.top, 32).padding(.bottom, 12)
            .background(GeometryReader { proxy in
                Color.clear.preference(key: ReloSheetHeightKey.self, value: proxy.size.height)
            })
        }
        .scrollBounceBehavior(.basedOnSize)
        .onPreferenceChange(ReloSheetHeightKey.self) { height in
            if abs((contentHeight ?? 0) - height) > 1 { contentHeight = height }
        }
        .presentationDetents(detents)
        .presentationDragIndicator(.visible)
        .presentationBackground(Color.reloSurface)
        .interactiveDismissDisabled(busy)
    }

    @ViewBuilder private var actionStack: some View {
        if pairsActions, !typeSize.isAccessibilitySize, cancelTitle != nil {
            HStack(spacing: ReloLayout.footerGap) {
                cancelButton
                actions
            }
        } else {
            VStack(spacing: ReloLayout.footerGap) {
                actions
                cancelButton
            }
        }
    }

    @ViewBuilder private var cancelButton: some View {
        if let cancelTitle {
            Button(cancelTitle) { dismiss() }
                .buttonStyle(.reloSecondary)
                .accessibilityIdentifier(cancelIdentifier)
        }
    }

    private var detents: Set<PresentationDetent> {
        switch sizing {
        case .fitted: [contentHeight.map { .height($0) } ?? .medium]
        case .detents(let detents): detents
        }
    }
}

extension ReloSheet where Content == EmptyView {
    init(cancelTitle: String? = "Cancel", cancelIdentifier: String = "sheet-cancel", busy: Bool = false,
         sizing: ReloSheetSizing = .fitted, pairsActions: Bool = false,
         @ViewBuilder header: () -> Header, @ViewBuilder actions: () -> Actions) {
        self.init(cancelTitle: cancelTitle, cancelIdentifier: cancelIdentifier, busy: busy, sizing: sizing,
                  pairsActions: pairsActions, header: header, content: { EmptyView() }, actions: actions)
    }
}

private struct ReloSheetHeightKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = max(value, nextValue()) }
}

/// An error line under a sheet's body.
struct ReloSheetProblem: View {
    let text: String
    var body: some View {
        Text(text).font(.footnote).foregroundStyle(Color.reloDestructive).multilineTextAlignment(.center)
    }
}

/// A quiet line under a sheet's actions: what the choice does.
struct ReloSheetFootnote: View {
    let text: String
    var body: some View {
        Text(text).font(.footnote).foregroundStyle(Color.reloSecondaryText).multilineTextAlignment(.center)
    }
}
