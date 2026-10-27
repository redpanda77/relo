import Foundation
import Testing
@testable import ReloNotchKit

@Suite struct QuestionReadabilityTests {
    @Test func theServersPlaceholderIsNotAPrompt() {
        #expect(!QuestionReadability.isReadable(prompt: "Open Relo on your iPhone to read this question."))
        #expect(!QuestionReadability.isReadable(prompt: "Private notification"))
        #expect(!QuestionReadability.isReadable(prompt: "  "))
        #expect(QuestionReadability.isReadable(prompt: "Allow Bash: npm test?"))
    }

    @Test func anUnreadableRowOrQuestionCannotBeAnsweredHere() {
        let sealed = ReloNotchStore.Question(prompt: "", kind: .approval, options: [], expiresAt: .distantFuture, isReadable: false)
        let plain = ReloNotchStore.Question(prompt: "Deploy?", kind: .approval, options: [], expiresAt: .distantFuture)
        #expect(!QuestionReadability.canAnswerHere(rowUnreadable: true, question: plain))
        #expect(!QuestionReadability.canAnswerHere(rowUnreadable: false, question: sealed))
        #expect(QuestionReadability.canAnswerHere(rowUnreadable: false, question: plain))
        #expect(QuestionReadability.canAnswerHere(rowUnreadable: false, question: nil))
    }
}
