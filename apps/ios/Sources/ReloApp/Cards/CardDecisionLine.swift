import SwiftUI

/// The question a work asked and how it was answered, as its own inset panel on a card: the prompt (up to two lines)
/// beside its mark, and under it how it was answered in the answer's colour with the time:
/// `? Deploy to prod?` / `You approved · 14:02`.
struct CardDecisionLine: View {
    let prompt: String
    let answer: String
    let tint: Color
    var at: Date? = nil
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "questionmark.bubble")
                .font(.system(size: 13, weight: .regular))
                .foregroundStyle(Color.reloSecondaryText)
                .frame(width: 16)
                .padding(.top, 1)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                Text(prompt)
                    .font(.system(size: 12.5, weight: .regular))
                    .foregroundStyle(Color.white.opacity(0.75))
                    .lineLimit(typeSize.isAccessibilitySize ? nil : 2)
                    .frame(maxWidth: .infinity, alignment: .leading)
                HStack(spacing: 5) {
                    Text(answer).font(.system(size: 12, weight: .semibold)).foregroundStyle(tint)
                    if let at {
                        Text("· \(at.formatted(date: .omitted, time: .shortened))")
                            .font(.system(size: 10.5, design: .monospaced))
                            .foregroundStyle(Color.white.opacity(0.42)).monospacedDigit()
                    }
                }
                .lineLimit(1)
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Color.white.opacity(0.05)))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Color.white.opacity(0.08), lineWidth: 0.5))
        .accessibilityElement(children: .combine)
    }
}
