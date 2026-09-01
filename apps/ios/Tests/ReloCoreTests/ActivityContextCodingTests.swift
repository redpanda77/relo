import XCTest
@testable import ReloCore

final class ActivityContextCodingTests: XCTestCase {
    func testProviderConversationAndInstructionIdentityRoundTrips() throws {
        let context = InboxContext(
            providerName: "Codex",
            producerKind: "agent",
            computer: "developer-mac-codex",
            project: "Relo notifications",
            providerThreadId: "019fe2d8-9b96-7f03-8b2c-83101432f6a4",
            providerWorkItemId: "turn-42",
            threadName: "Audit live activity delivery",
            taskTitle: "Group lifecycle evidence by instruction",
            threadNameSource: "provider",
            taskTitleSource: "prompt_summary"
        )
        let summary = InboxActivitySummary(
            id: "act_66666666-6666-4666-8666-666666666666",
            originThreadId: "org_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            conversationId: "cnv_77777777-7777-4777-8777-777777777777",
            workItemId: "wrk_88888888-8888-4888-8888-888888888888",
            generation: 2,
            sequence: 6,
            state: "active",
            title: "Codex · Relo notifications",
            status: "Working",
            context: context
        )
        let data = try JSONEncoder().encode(summary)
        XCTAssertEqual(try JSONDecoder().decode(InboxActivitySummary.self, from: data), summary)
    }
}
