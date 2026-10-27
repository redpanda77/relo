import Foundation
import ReloCore

/// A plain notice (`relo notify "…"`) as Relo for Mac shows it: a title and a first line.
public struct MacNotice: Equatable, Sendable, Identifiable {
    public var id: String
    public var title: String
    public var summary: String?
    public var source: String
    public var createdAt: Date
    /// Already read on another device of the account: it never announces here.
    public var read: Bool

    public init(id: String, title: String, summary: String?, source: String, createdAt: Date, read: Bool = false) {
        self.id = id; self.title = title; self.summary = summary; self.source = source; self.createdAt = createdAt; self.read = read
    }
}

/// Notices on the Mac. On an iPhone a notice is a push; the Mac gets no push, so when the account has no phone that
/// receives them the Mac shows new notices itself, from the server's current inbox (`GET /api/inbox/current`). What
/// is current is still the server's call; this only decides whether this Mac is the one that shows them, and which
/// of the server's items are notices the owner has not been told about yet.
public enum MacNotices {
    /// The Recent list keeps this many.
    public static let maxRecent = 12
    /// A notice announces itself only while it is this young (seconds, server clock): after a restart or a long sleep,
    /// older ones sit in the Recent list without announcing again.
    public static let momentWindow: TimeInterval = 120

    /// Local mode always: Relo for Mac is the only device. A server account only once its device list is known and
    /// shows no phone that receives pushes (`nil` is not known yet: the Mac stays out of the way until it is).
    public static func shows(isLocal: Bool, phoneReceivesPushes: Bool?) -> Bool {
        if isLocal { return true }
        return phoneReceivesPushes == false
    }

    /// Whether the account has an iPhone that receives pushes, from `GET /api/devices/self/devices`: a trusted device
    /// that is not this Mac, not another Mac or owner overview, and not a simulator.
    public static func phoneReceivesPushes(inDevices data: Data) -> Bool {
        EncryptionPolicy.phoneTrusted(inDevices: data)
    }

    /// The notices among the server's current items, newest first: ordinary notices only (not a question, which the
    /// notch already shows as one; not progress; not an incident). Items already in Now (`nowIDs`: Now's notification
    /// ids and card ids) and ones the server could not open here are left out: a work's outcome notification whose card
    /// is in Now is the card's own Done moment said twice.
    public static func notices(from items: [CurrentSubjectProjection], excluding nowIDs: Set<String> = []) -> [MacNotice] {
        let found = items.compactMap { item -> MacNotice? in
            guard item.kind == .notice, item.interaction == nil, item.activity == nil, item.notificationId != nil,
                  !nowIDs.contains(item.notificationId ?? ""), !nowIDs.contains(item.outcomeOf ?? ""),
                  !isPlaceholder(title: item.title) else { return nil }
            let title = item.title.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !title.isEmpty else { return nil }
            return MacNotice(id: item.subjectId, title: title, summary: firstLine(item.summary, unlessSameAs: title),
                             source: item.source, createdAt: item.createdAt, read: item.readAt != nil)
        }
        return Array(found.sorted { $0.createdAt > $1.createdAt }.prefix(maxRecent))
    }

    /// Which of `notices` to announce: not seen before, created within the moment window, and not already read on
    /// another device. Every notice offered is marked seen, announced or not, so none announces twice.
    public static func fresh(_ notices: [MacNotice], seen: inout SeenNotices, now: Date) -> [MacNotice] {
        var fresh: [MacNotice] = []
        for notice in notices where !seen.contains(notice.id) {
            seen.mark(notice.id)
            if now.timeIntervalSince(notice.createdAt) <= momentWindow, !notice.read { fresh.append(notice) }
        }
        return fresh.sorted { $0.createdAt < $1.createdAt }
    }

    /// The server's stand-ins for a title it holds back (sealed text this Mac could not open).
    static func isPlaceholder(title: String) -> Bool {
        ReloSealedCards.isPlaceholderTitle(title) || title == ReloSealedCards.unreadableTitle || title == "Encrypted notification"
    }

    /// The server's placeholders for text it holds back are not a first line.
    static func firstLine(_ summary: String, unlessSameAs title: String) -> String? {
        let line = summary.split(whereSeparator: \.isNewline).first.map { $0.trimmingCharacters(in: .whitespaces) } ?? ""
        guard !line.isEmpty, line != title, line != "Private notification", line != "Updating…",
              !line.hasPrefix("Open Relo on") else { return nil }
        return line
    }
}

/// The notices this Mac has already told the owner about: ids in order, newest last, capped, kept in UserDefaults.
public struct SeenNotices: Equatable, Sendable {
    public static let cap = 200
    public private(set) var ids: [String]
    private var set: Set<String>

    public init(ids: [String] = []) {
        let kept = Array(ids.suffix(Self.cap))
        self.ids = kept
        self.set = Set(kept)
    }

    public func contains(_ id: String) -> Bool { set.contains(id) }

    public mutating func mark(_ id: String) {
        guard set.insert(id).inserted else { return }
        ids.append(id)
        if ids.count > Self.cap {
            let dropped = ids.prefix(ids.count - Self.cap)
            dropped.forEach { set.remove($0) }
            ids.removeFirst(dropped.count)
        }
    }

    static let defaultsKey = "relo.notch.seenNotices"

    public static func load(from defaults: UserDefaults = .standard) -> SeenNotices {
        SeenNotices(ids: defaults.stringArray(forKey: defaultsKey) ?? [])
    }

    public func save(to defaults: UserDefaults = .standard) {
        defaults.set(ids, forKey: Self.defaultsKey)
    }
}

/// The notices that just arrived, for the notch's moment: `serial` changes with every batch.
public struct NoticeArrivals: Equatable, Sendable {
    public var serial = 0
    public var notices: [MacNotice] = []

    public init(serial: Int = 0, notices: [MacNotice] = []) { self.serial = serial; self.notices = notices }
}
