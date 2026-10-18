import SwiftUI

/// The question a work asked and how it was answered, on one line when it fits: `? Deploy to prod?   You approved · 14:02`.
struct CardDecisionLine: View {
    let prompt: String
    let answer: String
    let tint: Color
    var at: Date? = nil

    var body: some View {
        let answerText = HStack(spacing: 4) {
            Text(answer).foregroundStyle(tint).fontWeight(.semibold)
            if let at {
                Text("· \(at.formatted(date: .omitted, time: .shortened))").foregroundStyle(Color.reloSecondaryText).monospacedDigit()
            }
        }
        let promptText = Label(prompt, systemImage: "questionmark.bubble").foregroundStyle(.primary)
        ViewThatFits(in: .horizontal) {
            HStack(spacing: ReloLayout.inlineGap) { promptText.fixedSize(); Spacer(minLength: ReloLayout.inlineGap); answerText.fixedSize() }
            VStack(alignment: .leading, spacing: 3) {
                promptText.fixedSize(horizontal: false, vertical: true)
                answerText.fixedSize(horizontal: false, vertical: true)
            }
        }
        .font(ReloLayout.cardMeta)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
