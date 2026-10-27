import Foundation
import ReloCore

/// A question this Mac can answer is one it can read: a sealed card it could not open, or the server's placeholder
/// prompt, gets no answer buttons (the answer is signed against the question's text) and is never read aloud.
public enum QuestionReadability {
    public static let line = "Read and answer it on your iPhone"

    /// The prompts that stand in for a question's text.
    public static func isReadable(prompt: String) -> Bool {
        let trimmed = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        return !trimmed.isEmpty && !["Private notification", "Encrypted question", ReloSealedCards.promptPlaceholder].contains(trimmed)
    }

    /// True when this Mac can show the question and send an answer to it.
    public static func canAnswerHere(rowUnreadable: Bool, question: ReloNotchStore.Question?) -> Bool {
        !rowUnreadable && (question?.isReadable ?? true)
    }
}
