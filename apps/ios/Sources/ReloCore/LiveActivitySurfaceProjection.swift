import Foundation

/// A bounded, deterministic view of the payload. Never changes response authority or lifecycle.
public struct LiveActivitySurfaceProjection: Equatable, Sendable {
    public enum Fact: Equatable, Sendable {
        case symbol(String, String)
        case percentage(Double, LiveActivityPresentation.IdentityRole)
        case stages(Int, Int)
    }

    public struct Phase: Equatable, Sendable {
        public let current: Int?
        public let completed: Int
        public let total: Int
        public let label: String

        public init(items: [LiveActivityDisplayPresentation.Step]) {
            completed = items.filter { $0.state == .complete }.count
            total = items.count
            if let index = items.firstIndex(where: { $0.state == .current }) {
                current = index + 1
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

        public static func make(interaction: LiveActivityContentInteraction, now: Date) -> Self {
            // Accepted transport evidence may outlive the request deadline. It never means
            // the affirmative choice: the canonical outcome determines both text and glyph.
            if interaction.responsePhase == .accepted || interaction.state != "pending" {
                return outcome(interaction.state)
            }
            if interaction.expiresAt <= now { return outcome("expired") }
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
                return .init(
                    label: interaction.kind == "text"
                        ? "Reply needed"
                        : interaction.kind == "yes_no" ? "Response needed" : "Approval needed",
                    symbol: "questionmark.circle.fill", permitsResponse: true)
            }
        }

        private static func outcome(_ state: String) -> Self {
            let pair: (String, String) =
                switch state {
                case "approved": ("Approved", "checkmark.circle.fill")
                case "denied": ("Denied", "xmark.circle.fill")
                case "yes": ("Answered Yes", "checkmark.circle.fill")
                case "no": ("Answered No", "xmark.circle.fill")
                case "replied": ("Reply sent", "checkmark.circle.fill")
                case "expired": ("Request expired", "clock.badge.xmark")
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
        isStale: Bool = false, now: Date
    ) -> Self {
        if presentation.privacy == .private {
            return .init(
                fact: .symbol("lock.fill", "Private activity"), status: "Open Relo to view",
                components: [], phase: nil, measuredProgress: nil, isDecision: false,
                isStale: false, permitsInlineResponse: false)
        }
        let assigned = presentation.components(for: surface)
        let step = assigned.first { if case .steps = $0 { true } else { false } }
        let progress = assigned.first { if case .progressBar = $0 { true } else { false } }
        let phase: Phase? = if case .steps(_, _, let items) = step { Phase(items: items) } else { nil }
        let measured: Double? =
            if case .progressBar(_, _, let value, _) = progress { value } else { nil }
        let decision: Bool =
            switch presentation.behavior {
            case .approval, .yesNo, .unsupportedTextReply: true
            case .informational, .progress: false
            }
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
            let response = ResponseStatus.make(interaction: interaction, now: now)
            status = response.label
            fact = .symbol(response.symbol ?? "arrow.up.circle", status)
        } else if let terminal {
            status = terminal.0
            fact = .symbol(terminal.1, status)
        } else if presentation.state.kind == "needs_action" || decision {
            fact = .symbol("questionmark.circle.fill", status)
        } else if isStale {
            status = "Update overdue"
            fact = .symbol("exclamationmark.clock.fill", status)
        } else if case .progressBar(_, let role, let value, _) = progress {
            fact = .percentage(value, role)
        } else if let phase {
            fact = .stages(phase.completed, phase.total)
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
        return .init(
            fact: fact, status: status, components: visible, phase: phase,
            measuredProgress: measured, isDecision: decision,
            isStale: isStale && terminal == nil,
            permitsInlineResponse: decision && terminal == nil
                && interaction.map { ResponseStatus.make(interaction: $0, now: now).permitsResponse }
                    == true
        )
    }
}
