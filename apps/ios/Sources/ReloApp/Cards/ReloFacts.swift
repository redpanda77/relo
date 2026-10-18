import ReloCore
import SwiftUI
import UIKit

/// One label and its value for `ReloFacts`.
struct ReloFact: Identifiable {
    var label: String
    var value: String
    var monospaced = false
    /// Draws a computer's mark before the value (the Computer fact).
    var isComputer = false
    var id: String { label }
}

/// Facts as a two-column grid: labels in a quiet column, values beside them. A long value wraps in its own
/// column; hold a value to copy it.
struct ReloFacts: View {
    let facts: [ReloFact]
    var computerIcon: ComputerIcon? = nil

    var body: some View {
        Grid(alignment: .topLeading, horizontalSpacing: ReloLayout.itemSpacing + 4, verticalSpacing: ReloLayout.inlineGap) {
            ForEach(facts) { fact in
                GridRow {
                    Text(fact.label).font(ReloLayout.cardMeta).foregroundStyle(Color.reloSecondaryText)
                        .gridColumnAlignment(.leading)
                    (fact.isComputer ? ComputerMark.text(icon: computerIcon, name: fact.value) : Text(fact.value))
                        .font(fact.monospaced ? ReloLayout.cardMeta.monospaced() : ReloLayout.cardStatus)
                        .foregroundStyle(.primary)
                        .lineLimit(fact.monospaced ? 1 : nil)
                        .truncationMode(.middle)
                        .fixedSize(horizontal: false, vertical: !fact.monospaced)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .contextMenu {
                            Button { UIPasteboard.general.string = fact.value } label: {
                                Label("Copy \(fact.label)", systemImage: "doc.on.doc")
                            }
                        }
                }
                .accessibilityElement(children: .combine)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
