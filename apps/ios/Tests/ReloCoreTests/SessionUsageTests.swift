import Foundation
import Testing
@testable import ReloCore

@Suite struct SessionUsageTests {
    let us = Locale(identifier: "en_US")

    @Test func bothFacts() {
        #expect(SessionUsage.line(contextPct: 62, costUsd: 4.1, locale: us) == "62% context · $4.10")
    }

    @Test func oneFactOrNone() {
        #expect(SessionUsage.line(contextPct: 62, costUsd: nil, locale: us) == "62% context")
        #expect(SessionUsage.line(contextPct: nil, costUsd: 4.1, locale: us) == "$4.10")
        #expect(SessionUsage.line(contextPct: nil, costUsd: nil, locale: us) == nil)
    }

    @Test func tokensWhenNoPercent() {
        #expect(SessionUsage.line(contextPct: nil, contextTokens: 282_400, costUsd: nil, locale: us) == "282k context")
        #expect(SessionUsage.line(contextPct: nil, contextTokens: 850, costUsd: 1.5, locale: us) == "850 context · $1.50")
        #expect(SessionUsage.line(contextPct: nil, contextTokens: 1_250_000, costUsd: nil, locale: us) == "1.2M context")
        #expect(SessionUsage.line(contextPct: nil, contextTokens: 2_000_000, costUsd: nil, locale: us) == "2M context")
        #expect(SessionUsage.line(contextPct: 62, contextTokens: 282_000, costUsd: nil, locale: us) == "62% context", "the percent wins")
    }

    @Test func contextIsClamped() {
        #expect(SessionUsage.line(contextPct: 140, costUsd: nil, locale: us) == "100% context")
        #expect(SessionUsage.line(contextPct: -3, costUsd: nil, locale: us) == "0% context")
    }

    @Test func costStaysDollarsInAnyLocale() {
        let line = SessionUsage.line(contextPct: nil, costUsd: 4.1, locale: Locale(identifier: "de_DE")) ?? ""
        #expect(line.contains("$") && line.contains("4,10"))
    }

    @Test func heavyFromEightyPercent() {
        #expect(SessionUsage.isHeavy(contextPct: 80))
        #expect(!SessionUsage.isHeavy(contextPct: 79))
        #expect(!SessionUsage.isHeavy(contextPct: nil))
    }

    @Test func rowDecodesWithAndWithoutFacts() throws {
        let base = #"{"id":"s1","observed":true,"lastSeenAt":"2026-10-17T10:00:00Z"__X__}"#
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let bare = try decoder.decode(SessionRow.self, from: Data(base.replacingOccurrences(of: "__X__", with: "").utf8))
        #expect(bare.contextPct == nil && bare.costUsd == nil)
        let full = try decoder.decode(SessionRow.self, from: Data(base.replacingOccurrences(of: "__X__", with: #","contextPct":62,"costUsd":4.1"#).utf8))
        #expect(full.contextPct == 62 && full.costUsd == 4.1)
        let tokens = try decoder.decode(SessionRow.self, from: Data(base.replacingOccurrences(of: "__X__", with: #","contextTokens":282000"#).utf8))
        #expect(tokens.contextTokens == 282_000 && tokens.contextPct == nil)
    }
}
