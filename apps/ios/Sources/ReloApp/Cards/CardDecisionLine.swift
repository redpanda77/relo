import SwiftUI

/// The question a work asked and how it was answered, on one line when it fits: `? Deploy to prod?   You approved · 14:02`.
struct CardDecisionLine: View {
    let prompt: String
    let answer: String
    let tint: Color
    var at: Date? = nil
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        let answerText = HStack(spacing: 4) {
            Text(answer).foregroundStyle(tint).fontWeight(.semibold)
            if let at {
                Text("· \(at.formatted(date: .omitted, time: .shortened))").foregroundStyle(Color.reloSecondaryText).monospacedDigit()
            }
        }
        // One row: the prompt wraps to two lines and the answer keeps its width. No ViewThatFits: in a List cell
        // it measured the unwrapped prompt and reserved the stacked layout's height around the one-line one.
        HStack(alignment: .firstTextBaseline, spacing: ReloLayout.inlineGap) {
            Label(prompt, systemImage: "questionmark.bubble").foregroundStyle(.primary)
                .lineLimit(typeSize.isAccessibilitySize ? nil : 2)
                .frame(maxWidth: .infinity, alignment: .leading)
            answerText.lineLimit(1).fixedSize()
        }
        .font(ReloLayout.cardMeta)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
