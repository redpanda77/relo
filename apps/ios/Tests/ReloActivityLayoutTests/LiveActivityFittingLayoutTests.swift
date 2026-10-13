import SwiftUI
import Testing
@testable import ReloActivityLayout

@Suite("Live Activity intrinsic-height regression")
struct LiveActivityFittingLayoutTests {
    @MainActor
    @Test("A short fallback does not retain the full reserved height", arguments: [96.0, 132.0])
    func shortFallback(maximumHeight: Double) throws {
        let content = LiveActivityFittingLayout(maximumHeight: maximumHeight) {
            ViewThatFits(in: .vertical) {
                Color.red.frame(height: 200)
                Color.green.frame(height: 32)
            }
        }
        let renderer = ImageRenderer(content: content)
        renderer.proposedSize = ProposedViewSize(width: 300, height: 160)
        let image = try #require(renderer.cgImage)
        #expect(image.height == 32)
        #expect(image.width == 300)
    }

    @MainActor
    @Test("A fitting primary layout is retained instead of the smaller fallback")
    func retainsPrimary() throws {
        let renderer = ImageRenderer(content: LiveActivityFittingLayout(maximumHeight: 96) {
            ViewThatFits(in: .vertical) {
                Color.green.frame(height: 80)
                Color.red.frame(height: 32)
            }
        })
        renderer.proposedSize = ProposedViewSize(width: 300, height: 160)
        let image = try #require(renderer.cgImage)
        #expect(image.height == 80)
    }

    @MainActor
    @Test("A smaller host proposal still forces safe disclosure")
    func respectsHost() throws {
        let renderer = ImageRenderer(content: LiveActivityFittingLayout(maximumHeight: 96) {
            ViewThatFits(in: .vertical) {
                Color.red.frame(height: 80)
                Color.green.frame(height: 32)
            }
        })
        renderer.proposedSize = ProposedViewSize(width: 300, height: 50)
        let image = try #require(renderer.cgImage)
        #expect(image.height == 32)
    }

    @MainActor
    @Test("An unbounded height proposal cannot bypass disclosure")
    func unboundedHost() throws {
        let renderer = ImageRenderer(content: LiveActivityFittingLayout(maximumHeight: 96) {
            ViewThatFits(in: .vertical) {
                Color.red.frame(height: 240)
                Color.green.frame(height: 44)
            }
        })
        renderer.proposedSize = ProposedViewSize(width: 300, height: nil)
        let image = try #require(renderer.cgImage)
        #expect(image.height == 44)
    }

    /// The production question card's fallbacks, in order: each keeps the 44 pt answer buttons and
    /// shortens only the text. There is no fallback without buttons.
    @MainActor
    private static func questionCandidates(title: String, question: String) -> some View {
        func candidate(showsTitle: Bool, questionLines: Int) -> some View {
            VStack(alignment: .leading, spacing: 6) {
                if showsTitle { Text(title).font(.subheadline.weight(.semibold)).lineLimit(1) }
                if questionLines > 0 {
                    Text(question).font(showsTitle ? .caption : .subheadline.weight(.semibold)).lineLimit(questionLines)
                }
                HStack(spacing: 8) {
                    Text("No").frame(maxWidth: .infinity, minHeight: 44)
                    Text("Yes").frame(maxWidth: .infinity, minHeight: 44)
                }
            }.fixedSize(horizontal: false, vertical: true)
        }
        return ViewThatFits(in: .vertical) {
            candidate(showsTitle: true, questionLines: 2)
            candidate(showsTitle: true, questionLines: 1)
            candidate(showsTitle: false, questionLines: 2)
            candidate(showsTitle: false, questionLines: 1)
            candidate(showsTitle: false, questionLines: 0)
        }
    }

    @MainActor
    @Test("A question always keeps its answer buttons, on the Lock Screen and in the island",
          arguments: [(110.0, 240.0), (110.0, 300.0), (110.0, 380.0), (84.0, 240.0), (84.0, 300.0)])
    func questionKeepsButtons(budget: (Double, Double)) throws {
        let (maximumHeight, width) = budget
        for question in ["Continue?", String(repeating: "Deploy 0.8.1 to production after the migration? ", count: 5).prefix(240).description] {
            let renderer = ImageRenderer(content: LiveActivityFittingLayout(maximumHeight: maximumHeight) {
                Self.questionCandidates(title: String(repeating: "Relo 0.8.1 rollout ", count: 4), question: question)
            })
            renderer.proposedSize = ProposedViewSize(width: width, height: nil)
            let image = try #require(renderer.cgImage)
            // The buttons alone are 44 pt; anything shorter means they were dropped.
            #expect(image.height >= 44)
            #expect(Double(image.height) <= maximumHeight)
        }
    }

    /// The production choice row for 3–4 options: compact caption2 labels that wrap to two lines
    /// inside the same 44 pt row, so a choice uses the question card's fallbacks unchanged.
    @MainActor
    private static func choiceCandidates(title: String, question: String, labels: [String]) -> some View {
        func candidate(showsTitle: Bool, questionLines: Int) -> some View {
            VStack(alignment: .leading, spacing: 6) {
                if showsTitle { Text(title).font(.subheadline.weight(.semibold)).lineLimit(1) }
                if questionLines > 0 {
                    Text(question).font(showsTitle ? .caption : .subheadline.weight(.semibold)).lineLimit(questionLines)
                }
                HStack(spacing: 6) {
                    ForEach(labels, id: \.self) { label in
                        Text(label).font(.caption2.weight(.bold)).multilineTextAlignment(.center)
                            .lineLimit(2).minimumScaleFactor(0.8).padding(.horizontal, 4)
                            .frame(maxWidth: .infinity, minHeight: 44)
                    }
                }
            }.fixedSize(horizontal: false, vertical: true)
        }
        return ViewThatFits(in: .vertical) {
            candidate(showsTitle: true, questionLines: 2)
            candidate(showsTitle: true, questionLines: 1)
            candidate(showsTitle: false, questionLines: 2)
            candidate(showsTitle: false, questionLines: 1)
            candidate(showsTitle: false, questionLines: 0)
        }
    }

    @MainActor
    @Test("A 3–4 option choice keeps one row of answer buttons within the height budget",
          arguments: [(110.0, 300.0), (110.0, 380.0), (84.0, 300.0), (84.0, 340.0)])
    func choiceKeepsButtons(budget: (Double, Double)) throws {
        let (maximumHeight, width) = budget
        let labelSets = [
            ["Ship", "Wait", "Roll back"],
            ["Ship it now", "Wait for QA", "Roll back", "Ask the team"],
            Array(repeating: String(repeating: "W", count: 24), count: 4),
        ]
        for labels in labelSets {
            let renderer = ImageRenderer(content: LiveActivityFittingLayout(maximumHeight: maximumHeight) {
                Self.choiceCandidates(
                    title: String(repeating: "Relo 0.8.1 rollout ", count: 4),
                    question: "Which release goes out tonight?", labels: labels)
            })
            renderer.proposedSize = ProposedViewSize(width: width, height: nil)
            let image = try #require(renderer.cgImage)
            #expect(image.height >= 44)
            #expect(Double(image.height) <= maximumHeight)
        }
    }
}
