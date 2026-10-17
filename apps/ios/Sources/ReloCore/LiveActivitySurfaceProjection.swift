import Foundation

/// A bounded, deterministic view of the payload. Never changes response authority or lifecycle.
public struct LiveActivitySurfaceProjection: Equatable, Sendable {
    public enum Fact: Equatable, Sendable {
        case symbol(String, String)
        case percentage(Double, LiveActivityPresentation.IdentityRole)
        /// One "n of m": the current step's own count when it reports one, else the step position.
        case stages(Int, Int)
    }

    /// "6 of 9" or "6/9" in a progress label: the current step's own count.
    public static func stepCount(_ label: String?) -> (Int, Int)? {
        guard let label else { return nil }
        let pattern = #/(\d+)\s*(?:of|/)\s*(\d+)/#
        guard let match = label.firstMatch(of: pattern), let n = Int(match.1), let m = Int(match.2), m > 0 else { return nil }
        return (n, m)
    }

    public struct Phase: Equatable, Sendable {
        public let current: Int?
        public let completed: Int
        public let total: Int
        public let label: String

        public init(items: [LiveActivityDisplayPresentation.Step], window: LiveActivityDisplayPresentation.StepWindow = .whole) {
            // The one count (U1): the card's own when it carries it, else counted from the shown steps.
            let counted = LiveActivityPlanDisplay.progress(LiveActivityPlanDisplay.steps(items), window: window)
            completed = counted?.done ?? 0
            total = counted?.total ?? 0
            if let index = items.firstIndex(where: { $0.state == .current }) {
                current = window.before + index + 1
                label = items[index].label
            } else {
                current = nil
                label = completed == 0 ? "Not started" : "\(completed) of \(total) stages complete"
            }
        }
    }

    public struct ResponseStatus: Equatable, Sendable {
        public let label: String
        public let symbol: String?
        public let permitsResponse: Bool

        /// `chosenLabel` names an answered choice's option; without it a choice reads "Answered".
        public static func make(
            interaction: LiveActivityContentInteraction, now: Date, chosenLabel: String? = nil
        ) -> Self {
            // Accepted transport evidence may outlive the request deadline. It never means
            // the affirmative choice: the canonical outcome determines both text and glyph.
            if interaction.responsePhase == .accepted || interaction.state != "pending" {
                if interaction.kind == "choice", interaction.state == "replied" {
                    return .init(label: chosenLabel ?? "Answered", symbol: "checkmark.circle.fill", permitsResponse: false)
                }
                return outcome(interaction.state)
            }
            // Submit guard only (category D): the server keeps a missed question under Needs you.
            if interaction.expiresAt <= now { return missed }
            switch interaction.responsePhase {
            case .sending: return .init(label: "Sending response…", symbol: nil, permitsResponse: false)
            case .queued:
                return .init(
                    label: "Waiting to send", symbol: "clock.arrow.circlepath", permitsResponse: false)
            case .rejected:
                return .init(
                    label: "Response not recorded", symbol: "exclamationmark.triangle.fill",
                    permitsResponse: false)
            case .accepted: return outcome(interaction.state)
            case nil:
                let label = switch interaction.kind {
                case "text": "Reply needed"
                case "yes_no", "choice": "Response needed"
                default: "Approval needed"
                }
                return .init(
                    label: label,
                    symbol: "questionmark.circle.fill", permitsResponse: true)
            }
        }

        /// A question past its deadline: answered only in the app (the server may accept it late).
        public static let missed = Self(
            label: "Missed · open Relo to answer", symbol: "clock.badge.exclamationmark", permitsResponse: false)

        private static func outcome(_ state: String) -> Self {
            let pair: (String, String) =
                switch state {
                case "approved": ("Approved", "checkmark.circle.fill")
                case "denied": ("Denied", "xmark.circle.fill")
                case "yes": ("Answered Yes", "checkmark.circle.fill")
                case "no": ("Answered No", "xmark.circle.fill")
                case "replied": ("Reply sent", "checkmark.circle.fill")
                case "expired": ("Missed · open Relo to answer", "clock.badge.exclamationmark")
                case "canceled", "cancelled": ("Request canceled", "xmark.circle.fill")
                case "superseded": ("Request replaced", "arrow.triangle.2.circlepath")
                default: ("Response unavailable", "exclamationmark.triangle.fill")
                }
            return .init(label: pair.0, symbol: pair.1, permitsResponse: false)
        }
    }

    public let fact: Fact
    public let status: String
    public let components: [LiveActivityPresentation.Component]
    public let phase: Phase?
    public let measuredProgress: Double?
    public let isDecision: Bool
    public let isStale: Bool
    public let permitsInlineResponse: Bool
    /// The owner-state header chip (NEEDS YOU, MISSED, YOUR TURN, WORKING, QUIET, DONE, FAILED).
    public var chip: OwnerChip? = nil
    /// The account's needs-you count for the island's compact and minimal regions; nil when zero.
    public var needsYouCount: Int? = nil

    /// Ask ActivityKit to invalidate by the earliest relevant deadline. The renderer still
    /// distinguishes expired decisions from overdue progress; a stale flag is not failure.
    public static func invalidationDate(staleAt: Date?, interaction: LiveActivityContentInteraction?)
        -> Date?
    {
        guard let interaction, interaction.state == "pending", interaction.responsePhase != .accepted
        else {
            return staleAt
        }
        return staleAt.map { min($0, interaction.expiresAt) } ?? interaction.expiresAt
    }

    public static func make(
        presentation: LiveActivityPresentation,
        surface: LiveActivityPresentation.Surface,
        interaction: LiveActivityContentInteraction? = nil,
        isStale: Bool = false, owner: LiveActivityOwner? = nil, now: Date
    ) -> Self {
        let count = owner.flatMap { $0.needsYouCount > 0 ? $0.needsYouCount : nil }
        if presentation.privacy == .private {
            // A private card keeps its lock glyph and shows only the count or the fact.
            var hidden = Self(
                fact: .symbol("lock.fill", "Private activity"), status: "Open Relo to view",
                components: [], phase: nil, measuredProgress: nil, isDecision: false,
                isStale: false, permitsInlineResponse: false)
            hidden.chip = owner?.chip
            hidden.needsYouCount = count
            return hidden
        }
        let assigned = presentation.components(for: surface)
        let step = assigned.first { if case .steps = $0 { true } else { false } }
        let progress = assigned.first { if case .progressBar = $0 { true } else { false } }
        let phase: Phase? = if case .steps(_, _, let items, let window) = step { Phase(items: items, window: window) } else { nil }
        // A card with steps carries no percentage of its own: the count is the plan's, and a fraction beside it
        // ("0/4" next to "75%") would measure something else (plan 14, workstream 7).
        let measured: Double? =
            if step != nil { nil } else if case .progressBar(_, _, let value, _) = progress { value } else { nil }
        let decision: Bool =
            switch presentation.behavior {
            case .approval, .yesNo, .choice, .unsupportedTextReply: true
            case .informational, .progress: false
            }
        let chosenLabel = chosenLabel(presentation: presentation, interaction: interaction)
        let terminal: (String, String)? =
            switch presentation.state.kind {
            case "completed": ("Completed", "checkmark.circle.fill")
            case "failed": ("Failed", "exclamationmark.triangle.fill")
            case "cancelled", "canceled": ("Canceled", "xmark.circle.fill")
            case "expired": ("Expired", "clock.badge.xmark")
            case "superseded": ("Replaced", "arrow.triangle.2.circlepath")
            default: nil
            }
        var status = presentation.status
        let fact: Fact
        if let terminal, interaction?.responsePhase != .accepted {
            status = terminal.0
            fact = .symbol(terminal.1, status)
        } else if let interaction, decision {
            let response = ResponseStatus.make(interaction: interaction, now: now, chosenLabel: chosenLabel)
            status = response.label
            fact = .symbol(response.symbol ?? "arrow.up.circle", status)
        } else if let terminal {
            status = terminal.0
            fact = .symbol(terminal.1, status)
        } else if presentation.state.kind == "needs_action" || decision {
            fact = .symbol("questionmark.circle.fill", status)
        } else if owner?.isMissedQuestion == true {
            status = ResponseStatus.missed.label
            fact = .symbol(ResponseStatus.missed.symbol ?? "clock.badge.exclamationmark", status)
        } else if isStale {
            status = "Quiet"
            fact = .symbol("moon.zzz.fill", status)
        } else if let phase {
            // With steps the compact count is the plan's: done of total ("2/5"), never a card-wide percent.
            fact = .stages(phase.completed, phase.total)
        } else if case .progressBar(_, let role, let value, _) = progress {
            fact = .percentage(value, role)
        } else {
            fact = .symbol(presentation.state.icon.systemImageName, status)
        }
        // Never let decoration crowd decision context. For work, pair one phase context
        // with one measured bar; otherwise show just one assigned component.
        let visible: [LiveActivityPresentation.Component]
        if decision {
            visible = []
        } else if progress != nil || step != nil {
            visible = [step, progress].compactMap { $0 }
        } else {
            visible = Array(assigned.prefix(1))
        }
        var projection = Self(
            fact: fact, status: status, components: visible, phase: phase,
            measuredProgress: measured, isDecision: decision,
            isStale: isStale && terminal == nil,
            permitsInlineResponse: decision && terminal == nil && owner?.isMissedQuestion != true
                && interaction.map { ResponseStatus.make(interaction: $0, now: now).permitsResponse }
                    == true
        )
        projection.chip = owner?.chip
        projection.needsYouCount = count
        return projection
    }

    /// The option this phone picked; for a choice answered elsewhere, the server's status line,
    /// which names the chosen option when the card ends.
    public static func chosenLabel(
        presentation: LiveActivityPresentation, interaction: LiveActivityContentInteraction?
    ) -> String? {
        guard case .choice(let options) = presentation.behavior else { return nil }
        if let id = interaction?.selectedOptionID, let option = options.first(where: { $0.id == id }) {
            return option.label
        }
        let status = presentation.status.trimmingCharacters(in: .whitespacesAndNewlines)
        return status.isEmpty ? nil : status
    }
}
