import Foundation

/// A card must show once. If the system holds two native activities for the same card (the
/// server's push-to-start and the app's own start can race), keep the one furthest along and
/// end the rest.
public enum LiveActivityDuplicates {
    public struct Entry: Equatable, Sendable {
        public let nativeID: String
        public let identity: LiveActivityIdentity
        public let sequence: Int
        public let updatedAt: Date

        public init(nativeID: String, identity: LiveActivityIdentity, sequence: Int, updatedAt: Date) {
            self.nativeID = nativeID; self.identity = identity; self.sequence = sequence; self.updatedAt = updatedAt
        }
    }

    /// Native IDs to end: every copy of a card except the one with the highest sequence
    /// (newest update on a tie, then the smallest native ID so the choice is stable).
    public static func redundant(_ entries: [Entry]) -> [String] {
        Dictionary(grouping: entries, by: \.identity).values.flatMap { copies -> [String] in
            guard copies.count > 1 else { return [] }
            let keep = copies.max { a, b in
                if a.sequence != b.sequence { return a.sequence < b.sequence }
                if a.updatedAt != b.updatedAt { return a.updatedAt < b.updatedAt }
                return a.nativeID > b.nativeID
            }
            return copies.filter { $0.nativeID != keep?.nativeID }.map(\.nativeID)
        }.sorted()
    }
}
