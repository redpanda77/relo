import SwiftUI

/// Constrains disclosure without reserving the entire height budget.
struct LiveActivityFittingLayout: Layout {
    let maximumHeight: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        guard let content = subviews.first else { return .zero }
        // A finite proposal selects disclosure. Returning its allocation instead of the
        // child's measured size would recreate the mostly empty expanded card.
        return content.sizeThatFits(ProposedViewSize(
            width: proposal.width,
            height: min(proposal.height ?? maximumHeight, maximumHeight)))
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        subviews.first?.place(at: bounds.origin, anchor: .topLeading,
            proposal: ProposedViewSize(width: bounds.width,
                height: min(proposal.height ?? maximumHeight, maximumHeight)))
    }
}
