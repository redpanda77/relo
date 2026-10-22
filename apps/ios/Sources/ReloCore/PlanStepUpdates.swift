import Foundation

/// One card update the work sent while a step was current (plan 12b 4.6, "Updates").
public struct PlanStepUpdate: Equatable, Identifiable, Sendable {
    public let id: String
    public let at: Date
    public let text: String
}

public enum PlanStepUpdates {
    /// The server keeps card updates for this long; older ones are gone (the sheet says so).
    public static let retention: TimeInterval = 10 * 3600

    /// The work's card updates whose step is `stepID`, newest first. A step comes from the update's frame
    /// (`work.phase.stepId`: the server's, or the sealed text's `stepId`); items with no step data are left out.
    public static func updates(stepID: String, workID: String?, in items: [InboxItem]) -> [PlanStepUpdate] {
        var seen = Set<String>()
        let matching = items.compactMap { item -> PlanStepUpdate? in
            guard item.kind == .liveActivity else { return nil }
            let work = item.activity?.work ?? item.work
            guard let work, work.phase?.stepId == stepID, workID == nil || work.id == workID else { return nil }
            guard let text = ReloWork.text(item.detail ?? item.activitySummary?.status ?? item.activity?.status),
                  text != "Updating…", !ReloSealedCards.isPlaceholderTitle(text) else { return nil }
            return PlanStepUpdate(id: item.id, at: item.activitySummary?.updatedAt ?? item.createdAt, text: text)
        }
        return matching.sorted { $0.at > $1.at }.filter { seen.insert($0.id).inserted }
    }

    /// Whether the sheet should say older updates are deleted: the step started before the retention window.
    public static func mayBeTrimmed(stepStartedAt: Date?, now: Date) -> Bool {
        stepStartedAt.map { now.timeIntervalSince($0) > retention } ?? false
    }
}
