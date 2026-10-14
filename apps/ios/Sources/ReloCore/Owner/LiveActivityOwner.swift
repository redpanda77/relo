import Foundation

/// The owner state a Live Activity card carries (spec 6.2, plan 1.13a). The server writes it on every
/// card push and command; each card renders alone in the widget process, so the cross-card needs-you
/// count arrives in every card. Display only: no widget code compares a clock to pick a placement.
public struct LiveActivityOwner: Codable, Hashable, Sendable {
    /// Owner state raw value (contracts `OwnerState`); unknown values render with the `shown` layout.
    public var state: String
    /// Lock Screen placement raw value (contracts `LockScreenPlacement`).
    public var placement: String
    /// Needs-you count across the owner's account, at push time.
    public var needsYouCount: Int
    /// The work's last declared write ("updated 35 min ago").
    public var declaredAt: Date
    /// When the work finished (done / failed).
    public var finishedAt: Date?
    /// "question" / "missed_question" / "permission" when the state is needs_you.
    public var needsYou: String?

    public init(state: String, placement: String, needsYouCount: Int, declaredAt: Date,
                finishedAt: Date? = nil, needsYou: String? = nil) {
        self.state = state; self.placement = placement; self.needsYouCount = max(needsYouCount, 0)
        self.declaredAt = declaredAt; self.finishedAt = finishedAt; self.needsYou = needsYou
    }

    public var ownerState: OwnerState { OwnerState(rawValue: state) }
    public var lockScreen: LockScreenPlacement { LockScreenPlacement(rawValue: placement) ?? .shown }
    public var needsYouReason: NeedsYouReason? { needsYou.flatMap(NeedsYouReason.init(rawValue:)) }
    public var chip: OwnerChip? { OwnerChip.of(state: ownerState, needsYou: needsYouReason) }
    public var isMissedQuestion: Bool { chip == .missed }
    public var isPermission: Bool { ownerState == .needsYou && needsYouReason == .permission }

    /// Dynamic Island minimal/compact count text: "1"…"9", "9+".
    public var needsYouCountLabel: String? {
        guard needsYouCount > 0 else { return nil }
        return needsYouCount > 9 ? "9+" : "\(needsYouCount)"
    }

    private enum CodingKeys: String, CodingKey {
        case state, placement, needsYouCount, declaredAt, finishedAt, needsYou
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        state = try values.decode(String.self, forKey: .state)
        placement = try values.decodeIfPresent(String.self, forKey: .placement) ?? LockScreenPlacement.shown.rawValue
        needsYouCount = max(try values.decodeIfPresent(Int.self, forKey: .needsYouCount) ?? 0, 0)
        declaredAt = Self.date(.declaredAt, values) ?? Date(timeIntervalSince1970: 0)
        finishedAt = Self.date(.finishedAt, values)
        needsYou = try values.decodeIfPresent(String.self, forKey: .needsYou)
    }

    /// Dates travel as Unix seconds (APNs content-state) or ISO 8601 (command feed).
    public func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(state, forKey: .state)
        try values.encode(placement, forKey: .placement)
        try values.encode(needsYouCount, forKey: .needsYouCount)
        try values.encode(declaredAt.timeIntervalSince1970, forKey: .declaredAt)
        try values.encodeIfPresent(finishedAt?.timeIntervalSince1970, forKey: .finishedAt)
        try values.encodeIfPresent(needsYou, forKey: .needsYou)
    }

    private static func date(_ key: CodingKeys, _ values: KeyedDecodingContainer<CodingKeys>) -> Date? {
        if let seconds = try? values.decode(Double.self, forKey: key) {
            return ActivityKitTimestamp.date(fromUnixSeconds: seconds)
        }
        guard let string = try? values.decode(String.self, forKey: key) else { return nil }
        return ActivityKitTimestamp.date(fromISO8601: string)
    }
}
