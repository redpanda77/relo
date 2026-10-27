import Foundation
import OSLog

/// Local mode (plan 16): Relo runs on this Mac and nothing leaves it. From the owner's view there is no account, no
/// sign-in, no server address, no iPhone and no encryption, so the words for those never appear. The flag is the app's
/// (`relo.localMode`); the words are here so they are tested.
public enum LocalMode {
    public static let defaultsKey = "relo.localMode"

    public static func isOn(_ defaults: UserDefaults = .standard) -> Bool { defaults.bool(forKey: defaultsKey) }
    public static func set(_ on: Bool, _ defaults: UserDefaults = .standard) { defaults.set(on, forKey: defaultsKey) }

    /// What the notch says when the link is lost or the credential is refused: the owner has nothing to type.
    public static let needsRepair = "Relo needs a quick repair on this Mac."
    public static let repair = "Repair"
    public static let hoverToRepair = "Relo · hover here to repair"
    public static let hoverStartFailed = "Relo couldn't start · hover here"
    public static let startFailedTitle = "Relo couldn't start on this Mac"
    public static let notAnswering = "Relo isn't answering on this Mac."
    public static let notAnsweringShort = "Not answering"
    public static let starting = "Starting Relo…"
    public static let replyInTerminal = "Reply in your terminal"
    public static let privateWorkFallback = "Work"
    public static let onThisMac = "On this Mac"

    /// A card's title when it has none the notch can read.
    public static func untitled(local: Bool) -> String { local ? privateWorkFallback : "Private work" }

    /// The line on a card whose text this Mac could not open; local cards are never sealed.
    public static func unreadable(local: Bool) -> String {
        local ? "Relo could not read this card." : "Approve this Mac on your iPhone to read it"
    }

    public static func offlineAnswer(local: Bool) -> String {
        local ? notAnswering : "Offline: answer on your iPhone"
    }

    public static func textReply(local: Bool) -> String {
        local ? replyInTerminal : "Reply on your iPhone or in the Dashboard"
    }

    /// The capsule and chip for a feed that is not answering: "Offline" with the wifi symbol for a server, "Not
    /// answering" with an exclamation for Relo on this Mac (there is no network to lose).
    public static func offlineLabel(local: Bool) -> String { local ? notAnsweringShort : "Offline" }
    public static func offlineSymbol(local: Bool) -> String { local ? "exclamationmark.circle" : "wifi.slash" }

    /// What the owner confirms before this Mac's agents move to Relo on this Mac.
    public static func replaceLoginConfirmation(host: String) -> String {
        "Relo will sign out of \(host) and run on this Mac instead: your agents report here, and nothing leaves this Mac. You can sign in to \(host) again later from Settings."
    }

    /// What the owner confirms before Relo on this Mac stops for a server of their own.
    public static let leaveConfirmation = "Relo on this Mac stops. Your cards stay on this Mac. To have your agents report to your server, add this Mac in your server's Dashboard (Add a computer)."

    public static let removed = "Relo was removed from this Mac. You can quit Relo and delete the app."
}

/// The last Now this Mac read from Relo on this Mac, kept so the notch draws at once at the next launch (local mode:
/// its cards are never sealed). It is the server's own response, written owner-only, and ignored when it is old, so a
/// card that stopped long ago is never shown as running.
public struct NowCache: Sendable {
    public let url: URL
    public let maxAge: TimeInterval

    public init(url: URL, maxAge: TimeInterval = 600) { self.url = url; self.maxAge = maxAge }

    public static let standard: NowCache = {
        let base = (try? FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: false))
            ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support")
        return NowCache(url: base.appendingPathComponent("Relo/notch/now-cache.json"))
    }()

    public func save(_ data: Data) {
        let folder = url.deletingLastPathComponent()
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        guard (try? data.write(to: url, options: .atomic)) != nil else { return }
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }

    /// The cached response, or nil when there is none or it is older than `maxAge`.
    public func load(now: Date = Date()) -> Data? {
        guard let modified = (try? FileManager.default.attributesOfItem(atPath: url.path))?[.modificationDate] as? Date,
              now.timeIntervalSince(modified) <= maxAge, modified <= now.addingTimeInterval(60) else { return nil }
        return try? Data(contentsOf: url)
    }

    public func clear() { try? FileManager.default.removeItem(at: url) }
}

/// Launch timing, logged with os_log (subsystem `relo.notch`, category `launch`): milliseconds from the process start.
public enum LaunchClock {
    private static let log = Logger(subsystem: "relo.notch", category: "launch")
    private static let seen = LockedSet()

    /// Seconds since this process started, or nil when macOS will not say.
    public static func sinceProcessStart(now: Date = Date()) -> TimeInterval? {
        var info = kinfo_proc()
        var size = MemoryLayout<kinfo_proc>.stride
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, getpid()]
        guard sysctl(&mib, 4, &info, &size, nil, 0) == 0 else { return nil }
        let started = info.kp_proc.p_un.__p_starttime
        return now.timeIntervalSince1970 - (Double(started.tv_sec) + Double(started.tv_usec) / 1_000_000)
    }

    /// Logs `what` once, with the time since launch.
    public static func mark(_ what: String) {
        guard seen.insert(what), let elapsed = sinceProcessStart() else { return }
        log.notice("launch: \(what, privacy: .public) after \(Int(elapsed * 1000)) ms")
    }
}

private final class LockedSet: @unchecked Sendable {
    private let lock = NSLock()
    private var items = Set<String>()
    func insert(_ item: String) -> Bool { lock.lock(); defer { lock.unlock() }; return items.insert(item).inserted }
}
