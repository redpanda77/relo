import Foundation

/// How full a usage window is, from its percent. The app maps each band to a colour.
public enum UsageBand: Sendable, Equatable {
    case quiet, watch, high, out

    public init(percent: Double) {
        switch percent {
        case ..<50: self = .quiet
        case ..<80: self = .watch
        case ..<95: self = .high
        default: self = .out
        }
    }
}

/// One rate-limit window of an account (the 5-hour or the weekly limit), as `relo usage --json` reports it.
public struct UsageWindow: Sendable, Equatable {
    public var kind: String
    public var minutes: Int?
    public var usedPercent: Double
    public var resetsAt: Date?
    /// The name the command gives the window ("Gemini 5-hour"), when it names one.
    public var title: String?

    public init(kind: String, minutes: Int?, usedPercent: Double, resetsAt: Date?, title: String? = nil) {
        self.kind = kind; self.minutes = minutes; self.usedPercent = usedPercent; self.resetsAt = resetsAt; self.title = title
    }

    /// The window's length: the reported minutes, else the one its kind implies.
    public var effectiveMinutes: Int? {
        if let minutes, minutes > 0 { return minutes }
        switch kind {
        case "five_hour": return 300
        case "seven_day": return 10080
        default: return nil
        }
    }

    public var label: String {
        if let title, !title.isEmpty { return title }
        guard let m = effectiveMinutes else { return kind.isEmpty ? "Limit" : kind.replacingOccurrences(of: "_", with: " ") }
        if m == 300 { return "5-hour" }
        if m == 10080 { return "Week" }
        if m < 60 { return "\(m)-min" }
        if m < 1440 { return "\(m / 60)-hour" }
        return "\(m / 1440)-day"
    }

    public var band: UsageBand { UsageBand(percent: usedPercent) }

    public func isExpired(now: Date) -> Bool {
        if let resetsAt { return resetsAt <= now }
        return false
    }

    /// "in 51 min", "in 3h 12m", "Thu 12:00 AM" within the week, "Sep 28" beyond.
    public func resetCopy(now: Date, calendar: Calendar = .current) -> String? {
        guard let resetsAt else { return nil }
        return UsageCopy.reset(resetsAt, now: now, calendar: calendar)
    }
}

/// Local token counts for a plan with no limit to read (OpenCode on API keys or Zen): what was used, not what is left.
public struct UsageActivity: Sendable, Equatable {
    public var tokensToday: Double?
    public var tokensWeek: Double?
    public var tokensMonth: Double?
    /// US dollars, when the provider records a cost.
    public var costMonth: Double?
    public var lastUsedAt: Date?

    public init(tokensToday: Double? = nil, tokensWeek: Double? = nil, tokensMonth: Double? = nil, costMonth: Double? = nil,
                lastUsedAt: Date? = nil) {
        self.tokensToday = tokensToday; self.tokensWeek = tokensWeek; self.tokensMonth = tokensMonth
        self.costMonth = costMonth; self.lastUsedAt = lastUsedAt
    }

    /// "531K", "25.4M", "980".
    public static func tokens(_ value: Double) -> String {
        if value >= 1_000_000 { return String(format: value >= 10_000_000 ? "%.0fM" : "%.1fM", value / 1_000_000) }
        if value >= 1_000 { return String(format: "%.0fK", value / 1_000) }
        return String(Int(value))
    }
}

/// One account's usage: a plan (Claude, Codex) and optionally a named profile (a second login).
public struct UsageAccount: Sendable, Equatable, Identifiable {
    public static let staleAfter: TimeInterval = 15 * 60

    public var id: String
    public var plan: String
    public var profile: String?
    public var email: String?
    public var planName: String?
    public var connected: Bool
    public var hint: String?
    public var readAt: Date?
    public var windows: [UsageWindow]
    /// The name the command gives the account ("Antigravity", "Claude · work"), when it names one.
    public var name: String?
    /// Token counts from the agent's own data, for a plan without windows.
    public var activity: UsageActivity?

    public init(id: String, plan: String, profile: String? = nil, email: String? = nil, planName: String? = nil,
                connected: Bool = true, hint: String? = nil, readAt: Date? = nil, windows: [UsageWindow] = []) {
        self.id = id; self.plan = plan; self.profile = profile; self.email = email; self.planName = planName
        self.connected = connected; self.hint = hint; self.readAt = readAt; self.windows = windows
    }

    public var displayName: String {
        if let name, !name.isEmpty { return name }
        let known = ["claude": "Claude", "codex": "Codex", "antigravity": "Antigravity", "opencode": "OpenCode"]
        let base = known[plan] ?? (plan.isEmpty ? id : plan.prefix(1).uppercased() + plan.dropFirst())
        if let profile, !profile.isEmpty { return "\(base) · \(profile)" }
        return base
    }

    /// The agent the reading comes through, for "via …" lines.
    public var agentName: String {
        ["claude": "Claude Code", "codex": "Codex", "antigravity": "Antigravity", "opencode": "OpenCode"][plan] ?? displayName
    }

    /// The shortest window present: the 5-hour one when it exists, else the week.
    public var headline: UsageWindow? {
        windows.min { ($0.effectiveMinutes ?? .max) < ($1.effectiveMinutes ?? .max) }
    }

    /// The windows still running: one whose reset time passed is dropped.
    public func activeWindows(now: Date) -> [UsageWindow] { windows.filter { !$0.isExpired(now: now) } }

    public func live(now: Date) -> UsageAccount {
        var copy = self
        copy.windows = activeWindows(now: now)
        return copy
    }

    /// A reading older than 15 minutes, or none at all, is stale.
    public func isStale(now: Date) -> Bool {
        guard let readAt else { return true }
        return now.timeIntervalSince(readAt) > Self.staleAfter
    }

    /// "just now", "26 min ago", "2 h ago", "3 d ago"; nil without a reading.
    public func ageText(now: Date) -> String? {
        guard let readAt else { return nil }
        let seconds = max(0, now.timeIntervalSince(readAt))
        if seconds < 60 { return "just now" }
        if seconds < 3600 { return "\(Int(seconds / 60)) min ago" }
        if seconds < 86400 { return "\(Int(seconds / 3600)) h ago" }
        return "\(Int(seconds / 86400)) d ago"
    }

    /// Parses `relo usage --json`. Every field is optional; entries without an id and windows without a
    /// percent are skipped; anything that is not the expected shape gives no accounts.
    public static func parse(_ data: Data) -> [UsageAccount] {
        guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let list = root["accounts"] as? [Any] else { return [] }
        var seen = Set<String>()
        return list.compactMap { item -> UsageAccount? in
            guard let o = item as? [String: Any], let id = o["id"] as? String, !id.isEmpty, seen.insert(id).inserted else { return nil }
            let plan = (o["plan"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? String(id.split(separator: "-").first ?? "")
            let profile = (o["profile"] as? String).flatMap { $0.isEmpty ? nil : $0 }
            let windows = (o["windows"] as? [Any] ?? []).compactMap(parseWindow)
            let readAtMs = number(o["readAt"])
            var account = UsageAccount(
                id: id, plan: plan, profile: profile,
                email: o["email"] as? String, planName: o["planName"] as? String,
                connected: (o["connected"] as? Bool) ?? false, hint: o["hint"] as? String,
                readAt: readAtMs.map { Date(timeIntervalSince1970: $0 / 1000) }, windows: windows)
            account.name = o["displayName"] as? String
            if let a = o["activity"] as? [String: Any] {
                let activity = UsageActivity(
                    tokensToday: number(a["tokensToday"]), tokensWeek: number(a["tokensWeek"]),
                    tokensMonth: number(a["tokensMonth"]), costMonth: number(a["costMonth"]),
                    lastUsedAt: number(a["lastUsedAt"]).map { Date(timeIntervalSince1970: $0) })
                if activity != UsageActivity() { account.activity = activity }
            }
            return account
        }
    }

    private static func parseWindow(_ item: Any) -> UsageWindow? {
        guard let o = item as? [String: Any], let percent = number(o["usedPercent"]), percent.isFinite else { return nil }
        return UsageWindow(
            kind: (o["kind"] as? String) ?? "", minutes: number(o["minutes"]).map { Int($0) },
            usedPercent: percent, resetsAt: number(o["resetsAt"]).map { Date(timeIntervalSince1970: $0) },
            title: o["label"] as? String)
    }

    private static func number(_ value: Any?) -> Double? {
        guard let n = value as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() else { return nil }
        return n.doubleValue
    }
}

enum UsageCopy {
    static func reset(_ date: Date, now: Date, calendar: Calendar) -> String {
        let seconds = date.timeIntervalSince(now)
        if seconds <= 0 { return "now" }
        let minutes = Int((seconds / 60).rounded(.up))
        if minutes < 60 { return "in \(minutes) min" }
        if minutes < 24 * 60 { return "in \(minutes / 60)h \(minutes % 60)m" }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.calendar = calendar
        formatter.timeZone = calendar.timeZone
        formatter.dateFormat = seconds < 7 * 86400 ? "EEE h:mm a" : "MMM d"
        return formatter.string(from: date)
    }
}
