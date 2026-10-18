import SwiftUI

/// A card's last row: metadata leading (parts joined by " · "), the actions trailing on the same row. When
/// both do not fit beside each other, or at accessibility sizes, the actions drop under the metadata.
struct CardFooter<Actions: View>: View {
    var meta: Text?
    /// A short trailing fact (the time) on a footer without actions.
    var trailing: Text?
    private let hasActions: Bool
    private let actions: Actions
    @Environment(\.dynamicTypeSize) private var typeSize

    init(meta: Text?, @ViewBuilder actions: () -> Actions) {
        self.meta = meta; self.trailing = nil; self.hasActions = true; self.actions = actions()
    }

    var body: some View {
        if hasActions {
            if typeSize.isAccessibilitySize {
                stacked
            } else {
                ViewThatFits(in: .horizontal) {
                    HStack(alignment: .center, spacing: ReloLayout.footerGap) {
                        metaView(lines: 1)
                        Spacer(minLength: 0)
                        HStack(spacing: ReloLayout.inlineGap) { actions }.fixedSize()
                    }
                    stacked
                }
            }
        } else if meta != nil || trailing != nil {
            HStack(alignment: .firstTextBaseline, spacing: ReloLayout.inlineGap) {
                metaView(lines: typeSize.isAccessibilitySize ? nil : 2)
                if meta == nil { Spacer(minLength: 0) }
                if let trailing {
                    trailing.font(ReloLayout.cardMeta).foregroundStyle(Color.reloSecondaryText).lineLimit(1).fixedSize()
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var stacked: some View {
        VStack(alignment: .leading, spacing: ReloLayout.footerGap) {
            if meta != nil { metaView(lines: nil) }
            HStack(spacing: ReloLayout.inlineGap) { actions }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder private func metaView(lines: Int?) -> some View {
        if let meta {
            meta.font(ReloLayout.cardMeta).lineLimit(lines).fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: lines == 1 ? nil : .infinity, alignment: .leading)
        }
    }
}

extension CardFooter where Actions == EmptyView {
    init(meta: Text?, trailing: Text? = nil) {
        self.meta = meta; self.trailing = trailing; self.hasActions = false; self.actions = EmptyView()
    }
}
