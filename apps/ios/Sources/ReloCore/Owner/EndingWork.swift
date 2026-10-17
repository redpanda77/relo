import Foundation

// Plan 12b, 4.11: why a work went quiet, the words for it, and when the owner may end a work.
// Display only: the server derives the state and refuses an end it should not allow.

/// Why a work is Quiet, as the server derived it. An unknown value (a newer server) is kept, never fatal.
public enum QuietReason: Equatable, Hashable, Sendable, Codable {
    case sessionIdle, sessionEnded, noUpdate
    case unknown(String)

    public init(rawValue: String) {
        switch rawValue {
        case "session_idle": self = .sessionIdle
        case "session_ended": self = .sessionEnded
        case "no_update": self = .noUpdate
        default: self = .unknown(rawValue)
        }
    }

    public var rawValue: String {
        switch self {
        case .sessionIdle: "session_idle"
        case .sessionEnded: "session_ended"
        case .noUpdate: "no_update"
        case .unknown(let raw): raw
        }
    }

    public init(from decoder: Decoder) throws {
        self.init(rawValue: try decoder.singleValueContainer().decode(String.self))
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }
}

/// The status line of a Quiet work: `Session idle since 3:12 PM`, `Session ended at 3:12 PM`,
/// `No update since 3:12 PM`. Nil for a reason this build does not know (the caller keeps its own words).
public enum QuietWording {
    public static func line(reason: QuietReason?, since: Date, locale: Locale = .current, timeZone: TimeZone = .current) -> String? {
        var style = Date.FormatStyle(time: .shortened).locale(locale)
        style.timeZone = timeZone
        let time = since.formatted(style)
        switch reason {
        case .sessionIdle?: return "Session idle since \(time)"
        case .sessionEnded?: return "Session ended at \(time)"
        case .noUpdate?: return "No update since \(time)"
        case .unknown?, nil: return nil
        }
    }
}

/// When the owner may end a work from the phone: Quiet, Paused or Your turn. Never a moving work
/// (the server refuses it with `work_running`), a question, or a work that already finished.
public enum WorkEnding {
    public static func isOffered(for state: OwnerState) -> Bool {
        switch state {
        case .stale, .stoppedResponding, .noSignal, .paused, .waitingOnYou: true
        case .needsYou, .failed, .done, .dropped, .leftUnfinished, .moving, .workingQuietly, .unknown: false
        }
    }

    public static func confirmationTitle(goal: String) -> String { "End \"\(goal)\"?" }
    public static let confirmationMessage = "It moves to History as ended by you. The agent's session keeps running."
    public static let runningRefusal = "This work is moving again; it can't be ended now."
}

/// Why an item left the screen or dimmed, as the server derived it (workstream 6). An unknown value is kept, never fatal.
public enum AbsenceReason: Equatable, Hashable, Sendable, Codable {
    case sessionEnded, computerOffline, sessionIdle, noUpdate, stoppedResponding, leftUnfinished, failed
    case unknown(String)

    public init(rawValue: String) {
        switch rawValue {
        case "session_ended": self = .sessionEnded
        case "computer_offline": self = .computerOffline
        case "session_idle": self = .sessionIdle
        case "no_update": self = .noUpdate
        case "stopped_responding": self = .stoppedResponding
        case "left_unfinished": self = .leftUnfinished
        case "failed": self = .failed
        default: self = .unknown(rawValue)
        }
    }

    public init(from decoder: Decoder) throws {
        self.init(rawValue: try decoder.singleValueContainer().decode(String.self))
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }

    public var rawValue: String {
        switch self {
        case .sessionEnded: "session_ended"
        case .computerOffline: "computer_offline"
        case .sessionIdle: "session_idle"
        case .noUpdate: "no_update"
        case .stoppedResponding: "stopped_responding"
        case .leftUnfinished: "left_unfinished"
        case .failed: "failed"
        case .unknown(let raw): raw
        }
    }
}

public struct Absence: Codable, Equatable, Hashable, Sendable {
    public var reason: AbsenceReason
    public var since: Date

    public init(reason: AbsenceReason, since: Date) {
        self.reason = reason; self.since = since
    }
}

/// The words for an absence; the same copy as the contracts' `absenceText`. Nil for a reason this build does not know.
public enum AbsenceWording {
    public static func line(_ absence: Absence, computer: String? = nil,
                            locale: Locale = .current, timeZone: TimeZone = .current) -> String? {
        switch absence.reason {
        case .sessionEnded: return "Session ended"
        case .sessionIdle: return "Session idle"
        case .stoppedResponding: return "Stopped responding"
        case .leftUnfinished: return "Left unfinished"
        case .failed: return "Failed"
        case .computerOffline:
            let name = computer?.trimmingCharacters(in: .whitespaces)
            return "\(name?.isEmpty == false ? name! : "Computer") offline since \(clock(absence.since, locale, timeZone))"
        case .noUpdate:
            // A clock time, never a duration: the words come from the server's fact alone.
            return "No update since \(clock(absence.since, locale, timeZone))"
        case .unknown: return nil
        }
    }

    private static func clock(_ date: Date, _ locale: Locale, _ timeZone: TimeZone) -> String {
        var style = Date.FormatStyle(time: .shortened).locale(locale)
        style.timeZone = timeZone
        return date.formatted(style)
    }
}
