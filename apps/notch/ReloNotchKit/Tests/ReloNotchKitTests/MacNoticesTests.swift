import Foundation
import Testing
import ReloCore
@testable import ReloNotchKit

@Suite struct MacNoticesTests {
    private static let uuid = "00000000-0000-4000-8000-0000000000"

    /// One current item as the server sends it.
    private static func item(_ n: Int, kind: String = "notice", title: String = "Build finished", summary: String = "All 42 tests passed",
                             createdAt: String = "2026-10-23T10:00:00.000Z", interaction: Bool = false, read: Bool = false,
                             outcomeOf: String? = nil) -> String {
        let id = "\(uuid)\(String(format: "%02d", n))"
        let decision = interaction
            ? #","interaction":{"id":"int_\#(id)","type":"yes_no","state":"pending","expiresAt":"2026-10-23T10:15:00.000Z"}"# : ""
        let readAt = read ? "\"2026-10-23T10:00:05.000Z\"" : "null"
        let outcome = outcomeOf.map { #","outcomeOf":"\#($0)""# } ?? ""
        return #"""
        {"subjectId":"sub_\#(id)","notificationId":"ntf_\#(id)","kind":"\#(kind)","version":{"generation":1,"revision":1},
         "title":"\#(title)","summary":"\#(summary)","source":"Claude Code","createdAt":"\#(createdAt)","updatedAt":"\#(createdAt)",
         "occurredAt":null,"acceptedAt":"\#(createdAt)","readAt":\#(readAt),
         "currentUntil":"2026-10-23T10:15:00.000Z","freshUntil":null,"deliverUntil":"2026-10-23T10:01:00.000Z","freshness":"unknown",
         "activity":null,"resources":null\#(decision)\#(outcome)}
        """#
    }

    private static func items(_ rows: String...) throws -> [CurrentSubjectProjection] {
        let json = #"{"items":[\#(rows.joined(separator: ","))],"retired":[],"total":\#(rows.count),"cursor":null,"hasMore":false,"counts":{"actionable":0,"currentUnread":0},"nextExpiryAt":null,"serverTime":"2026-10-23T10:00:10.000Z"}"#
        return try ReloWireJSON.decoder().decode(CurrentInboxResponse.self, from: Data(json.utf8)).items
    }

    private static let now = ISO8601DateFormatter().date(from: "2026-10-23T10:00:10Z")!

    // MARK: Should the Mac show notices

    @Test func localModeAlwaysShowsNotices() {
        #expect(MacNotices.shows(isLocal: true, phoneReceivesPushes: nil))
        #expect(MacNotices.shows(isLocal: true, phoneReceivesPushes: true))
        #expect(MacNotices.shows(isLocal: true, phoneReceivesPushes: false))
    }

    @Test func aServerAccountShowsThemOnlyWhenKnownToHaveNoPhone() {
        #expect(MacNotices.shows(isLocal: false, phoneReceivesPushes: false))
        #expect(!MacNotices.shows(isLocal: false, phoneReceivesPushes: true))
        // Not read yet: stay out of the way.
        #expect(!MacNotices.shows(isLocal: false, phoneReceivesPushes: nil))
    }

    @Test func onlyATrustedRealPhoneReceivesPushes() {
        func phone(_ devices: String) -> Bool { MacNotices.phoneReceivesPushes(inDevices: Data(#"{"devices":[\#(devices)]}"#.utf8)) }
        let mac = #"{"deviceId":"dev_1","trusted":true,"isCurrent":true,"ownerOverview":true}"#
        #expect(!phone(mac))
        #expect(!phone(mac + #",{"deviceId":"dev_2","trusted":true,"isCurrent":false,"ownerOverview":true}"#))
        #expect(!phone(mac + #",{"deviceId":"dev_3","trusted":true,"isCurrent":false,"isSimulator":true}"#))
        #expect(!phone(mac + #",{"deviceId":"dev_4","trusted":false,"isCurrent":false}"#))
        #expect(phone(mac + #",{"deviceId":"dev_5","trusted":true,"isCurrent":false,"isSimulator":false}"#))
        #expect(!MacNotices.phoneReceivesPushes(inDevices: Data("nope".utf8)))
    }

    // MARK: Which items are notices

    @Test func onlyOrdinaryNoticesAreShown() throws {
        let rows = try Self.items(
            Self.item(1),
            Self.item(2, kind: "decision", title: "Deploy?", interaction: true),
            Self.item(3, kind: "progress", title: "Running tests"),
            Self.item(4, kind: "incident", title: "Disk full"))
        let notices = MacNotices.notices(from: rows)
        #expect(notices.map(\.title) == ["Build finished"])
        #expect(notices.first?.summary == "All 42 tests passed")
        #expect(notices.first?.source == "Claude Code")
    }

    @Test func aNoticeAlreadyInNowIsNotListedTwice() throws {
        let rows = try Self.items(Self.item(1), Self.item(2, title: "Second"))
        let shown = MacNotices.notices(from: rows, excluding: ["ntf_\(Self.uuid)01"])
        #expect(shown.map(\.title) == ["Second"])
    }

    @Test func aWorksOutcomeIsLeftOutWhileNowShowsItsCard() throws {
        let rows = try Self.items(Self.item(1, title: "Ship works", outcomeOf: "act_card"), Self.item(2, title: "Second"))
        #expect(MacNotices.notices(from: rows, excluding: ["act_card"]).map(\.title) == ["Second"])
        // The card already left Now: the outcome is the only trace, so it shows.
        #expect(MacNotices.notices(from: rows, excluding: ["act_other"]).map(\.title).sorted() == ["Second", "Ship works"])
    }

    @Test func placeholdersAreNeverShown() throws {
        let rows = try Self.items(
            Self.item(1, title: "Encrypted notification"),
            Self.item(2, title: "Real title", summary: "Private notification"),
            Self.item(3, title: "Other", summary: "Open Relo on your iPhone to read this."))
        let notices = MacNotices.notices(from: rows)
        #expect(notices.map(\.title).sorted() == ["Other", "Real title"])
        #expect(notices.allSatisfy { $0.summary == nil })
    }

    @Test func theFirstLineIsTheSummary() throws {
        let rows = try Self.items(Self.item(1, summary: "First line\\nsecond line"))
        #expect(MacNotices.notices(from: rows).first?.summary == "First line")
        #expect(MacNotices.firstLine("Same", unlessSameAs: "Same") == nil)
    }

    @Test func recentIsNewestFirstAndCapped() throws {
        let many = (1...(MacNotices.maxRecent + 5)).map { Self.item($0, title: "n\($0)", createdAt: "2026-10-23T10:00:\(String(format: "%02d", $0))Z") }
        let json = #"{"items":[\#(many.joined(separator: ","))],"retired":[],"total":\#(many.count),"cursor":null,"hasMore":false,"counts":{"actionable":0,"currentUnread":0},"nextExpiryAt":null,"serverTime":"2026-10-23T10:01:00.000Z"}"#
        let rows = try ReloWireJSON.decoder().decode(CurrentInboxResponse.self, from: Data(json.utf8)).items
        let notices = MacNotices.notices(from: rows)
        #expect(notices.count == MacNotices.maxRecent)
        #expect(notices.first?.title == "n\(MacNotices.maxRecent + 5)")
    }

    // MARK: The seen set

    @Test func aNoticeAnnouncesOnce() throws {
        var seen = SeenNotices()
        let notices = MacNotices.notices(from: try Self.items(Self.item(1)))
        #expect(MacNotices.fresh(notices, seen: &seen, now: Self.now).map(\.title) == ["Build finished"])
        #expect(MacNotices.fresh(notices, seen: &seen, now: Self.now).isEmpty)
    }

    @Test func anOldNoticeIsMarkedSeenWithoutAnnouncing() throws {
        var seen = SeenNotices()
        let old = MacNotices.notices(from: try Self.items(Self.item(1, createdAt: "2026-10-23T09:50:00.000Z")))
        #expect(MacNotices.fresh(old, seen: &seen, now: Self.now).isEmpty)
        #expect(seen.contains(old[0].id))
    }

    @Test func aNoticeReadElsewhereDoesNotAnnounce() throws {
        var seen = SeenNotices()
        let read = MacNotices.notices(from: try Self.items(Self.item(1, read: true)))
        #expect(MacNotices.fresh(read, seen: &seen, now: Self.now).isEmpty)
    }

    @Test func newNoticesAnnounceOldestFirst() throws {
        var seen = SeenNotices()
        let rows = try Self.items(Self.item(1, title: "later", createdAt: "2026-10-23T10:00:08.000Z"),
                                  Self.item(2, title: "earlier", createdAt: "2026-10-23T10:00:02.000Z"))
        #expect(MacNotices.fresh(MacNotices.notices(from: rows), seen: &seen, now: Self.now).map(\.title) == ["earlier", "later"])
    }

    @Test func theSeenSetIsCappedKeepingTheNewest() {
        var seen = SeenNotices()
        for n in 0..<(SeenNotices.cap + 25) { seen.mark("sub_\(n)") }
        #expect(seen.ids.count == SeenNotices.cap)
        #expect(!seen.contains("sub_0"))
        #expect(seen.contains("sub_\(SeenNotices.cap + 24)"))
        // Marking one already there changes nothing.
        let before = seen.ids
        seen.mark("sub_\(SeenNotices.cap + 24)")
        #expect(seen.ids == before)
    }

    @Test func theSeenSetSurvivesARestart() throws {
        let suite = "relo.test.seenNotices.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        var seen = SeenNotices()
        seen.mark("sub_a"); seen.mark("sub_b")
        seen.save(to: defaults)
        let loaded = SeenNotices.load(from: defaults)
        #expect(loaded.contains("sub_a") && loaded.contains("sub_b") && !loaded.contains("sub_c"))
        #expect(SeenNotices.load(from: UserDefaults(suiteName: suite + ".empty")!).ids.isEmpty)
    }
}
