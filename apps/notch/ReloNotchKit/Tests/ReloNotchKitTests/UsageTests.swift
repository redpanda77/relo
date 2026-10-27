import Foundation
import Testing
@testable import ReloNotchKit

struct UsageTests {
    static let now = Date(timeIntervalSince1970: 1_793_112_000) // fixed instant
    static var utc: Calendar { var c = Calendar(identifier: .gregorian); c.timeZone = TimeZone(identifier: "UTC")!; return c }

    static let good = """
    { "accounts": [
      { "id": "claude", "plan": "claude", "profile": null, "configDir": "/Users/x/.claude", "email": "a@b.c",
        "planName": "max", "connected": true, "hint": null, "readAt": 1793112000000,
        "windows": [ { "kind": "seven_day", "minutes": 10080, "usedPercent": 40, "resetsAt": 1793500000 },
                     { "kind": "five_hour", "minutes": 300, "usedPercent": 73.0, "resetsAt": 1793115000 } ], "extra": 1 },
      { "id": "codex-work", "plan": "codex", "profile": "work", "email": null, "planName": null, "connected": false,
        "hint": "CODEX_HOME=... relo setup", "readAt": null, "windows": [] }
    ] }
    """

    @Test func parsesGoodInput() throws {
        let accounts = UsageAccount.parse(Data(Self.good.utf8))
        #expect(accounts.count == 2)
        let claude = accounts[0]
        #expect(claude.displayName == "Claude")
        #expect(claude.email == "a@b.c" && claude.planName == "max" && claude.connected)
        #expect(claude.readAt == Date(timeIntervalSince1970: 1_793_112_000))
        #expect(claude.windows.count == 2)
        #expect(claude.windows[1].resetsAt == Date(timeIntervalSince1970: 1_793_115_000))
        #expect(accounts[1].displayName == "Codex · work")
        #expect(!accounts[1].connected && accounts[1].hint != nil && accounts[1].readAt == nil)
    }

    @Test func parsesActivityForAPlanWithoutWindows() {
        let json = #"{"accounts":[{"id":"opencode","plan":"opencode","connected":true,"windows":[],"activity":{"tokensToday":531125,"tokens5h":0,"tokensWeek":25400322,"tokensMonth":25466362,"costMonth":0,"lastUsedAt":1793051404,"providers":[]}},{"id":"claude","activity":{}}]}"#
        let accounts = UsageAccount.parse(Data(json.utf8))
        #expect(accounts[0].activity == UsageActivity(tokensToday: 531_125, tokensWeek: 25_400_322, tokensMonth: 25_466_362,
                                                      costMonth: 0, lastUsedAt: Date(timeIntervalSince1970: 1_793_051_404)))
        #expect(accounts[1].activity == nil)
        #expect(UsageActivity.tokens(531_125) == "531K" && UsageActivity.tokens(25_466_362) == "25M"
            && UsageActivity.tokens(2_540_000) == "2.5M" && UsageActivity.tokens(980) == "980")
    }

    @Test func parsesPartialAndUnknownInput() {
        let json = #"{"accounts":[{"id":"claude-work","windows":[{"kind":"mystery","usedPercent":5},{"kind":"five_hour"},"x",{"usedPercent":true}]},{"plan":"x"},7,{"id":"claude-work"}]}"#
        let accounts = UsageAccount.parse(Data(json.utf8))
        #expect(accounts.count == 1)
        #expect(accounts[0].plan == "claude" && accounts[0].connected == false)
        #expect(accounts[0].windows.count == 1)
        #expect(accounts[0].windows[0].kind == "mystery" && accounts[0].windows[0].resetsAt == nil)
    }

    @Test func garbageGivesNothing() {
        for text in ["", "nope", "[]", #"{"accounts":3}"#, #"{"accounts":null}"#, "{}"] {
            #expect(UsageAccount.parse(Data(text.utf8)).isEmpty)
        }
    }

    @Test func labels() {
        func label(_ kind: String, _ minutes: Int?) -> String { UsageWindow(kind: kind, minutes: minutes, usedPercent: 1, resetsAt: nil).label }
        #expect(label("five_hour", 300) == "5-hour")
        #expect(label("five_hour", nil) == "5-hour")
        #expect(label("seven_day", nil) == "Week")
        #expect(label("primary", 10080) == "Week")
        #expect(label("primary", 120) == "2-hour")
        #expect(label("secondary", 4320) == "3-day")
        #expect(label("primary", nil) == "primary")
    }

    @Test func headlineIsTheShortestWindow() {
        let accounts = UsageAccount.parse(Data(Self.good.utf8))
        #expect(accounts[0].headline?.label == "5-hour")
        let week = UsageAccount(id: "a", plan: "claude", windows: [UsageWindow(kind: "seven_day", minutes: nil, usedPercent: 3, resetsAt: nil)])
        #expect(week.headline?.label == "Week")
        #expect(accounts[1].headline == nil)
    }

    @Test func bandEdges() {
        #expect(UsageBand(percent: 0) == .quiet)
        #expect(UsageBand(percent: 49.9) == .quiet)
        #expect(UsageBand(percent: 50) == .watch)
        #expect(UsageBand(percent: 79.9) == .watch)
        #expect(UsageBand(percent: 80) == .high)
        #expect(UsageBand(percent: 94.9) == .high)
        #expect(UsageBand(percent: 95) == .out)
        #expect(UsageBand(percent: 100) == .out)
    }

    @Test func staleAndAge() {
        func account(_ ago: TimeInterval?) -> UsageAccount {
            UsageAccount(id: "a", plan: "claude", readAt: ago.map { Self.now.addingTimeInterval(-$0) })
        }
        #expect(!account(900).isStale(now: Self.now))
        #expect(account(901).isStale(now: Self.now))
        #expect(account(nil).isStale(now: Self.now))
        #expect(account(nil).ageText(now: Self.now) == nil)
        #expect(account(10).ageText(now: Self.now) == "just now")
        #expect(account(26 * 60).ageText(now: Self.now) == "26 min ago")
        #expect(account(2 * 3600 + 100).ageText(now: Self.now) == "2 h ago")
        #expect(account(3 * 86400).ageText(now: Self.now) == "3 d ago")
    }

    @Test func expiredWindowsAreDropped() {
        let live = UsageWindow(kind: "five_hour", minutes: 300, usedPercent: 1, resetsAt: Self.now.addingTimeInterval(60))
        let gone = UsageWindow(kind: "seven_day", minutes: nil, usedPercent: 1, resetsAt: Self.now.addingTimeInterval(-1))
        let open = UsageWindow(kind: "primary", minutes: nil, usedPercent: 1, resetsAt: nil)
        let account = UsageAccount(id: "a", plan: "claude", windows: [live, gone, open])
        #expect(account.activeWindows(now: Self.now) == [live, open])
    }

    @Test func resetCopy() {
        func copy(_ seconds: TimeInterval) -> String {
            UsageCopy.reset(Self.now.addingTimeInterval(seconds), now: Self.now, calendar: Self.utc)
        }
        #expect(copy(-5) == "now")
        #expect(copy(51 * 60 - 20) == "in 51 min")
        #expect(copy(3 * 3600 + 12 * 60) == "in 3h 12m")
        // 1793112000 is Tue 2026-10-27 14:40 UTC.
        #expect(copy(3 * 86400) == "Fri 2:40 PM")
        #expect(copy(10 * 86400) == "Nov 6")
    }
}
