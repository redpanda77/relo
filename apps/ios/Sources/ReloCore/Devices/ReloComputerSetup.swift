import CryptoKit
import Foundation

/// Connect a computer from the iPhone (docs/internal/product/plan/13-onboarding-wizard.md, journey E).
///
/// The phone makes a one-time code. The code also vouches for the key that redeems it (docs/ENCRYPTION-PROTOCOL.md,
/// "Key binding"): `rci_<redeem>.<bind>`, where `<bind>` is made here, never sent to the server and kept for the code's
/// 30 minutes. The computer publishes its identity key with an HMAC keyed by `<bind>`; this phone checks it before it
/// signs `approve-computer`, so a key the server swapped in is never approved.

// MARK: Binding

public enum ReloComputerBind {
    /// 16 random bytes, base64url: 22 characters.
    public static let length = 22

    public static func generate() -> String {
        var generator = SystemRandomNumberGenerator()
        return encode(Data((0..<16).map { _ in UInt8.random(in: .min ... .max, using: &generator) }))
    }

    public static func encode(_ bytes: Data) -> String { ReloE2EE.base64URL(bytes) }

    /// A bind half as `generate` makes it: 22 base64url characters of 16 bytes.
    public static func isValid(_ bind: String) -> Bool {
        bind.count == length && (try? ReloE2EE.data(base64URL: bind, length: 16, field: "bind")) != nil
    }

    /// `rci_<redeem>.<bind>`, what goes into the command and the agent prompt.
    public static func fullCode(code: String, bind: String) -> String { "\(code).\(bind)" }

    /// The message the computer MACs: `relo.e2e.v1 computer-binding\n<clientId>\n<identityKey>`.
    static func message(clientID: String, identityKey: String) -> Data {
        Data("\(ReloE2EE.version) computer-binding\n\(clientID)\n\(identityKey)".utf8)
    }

    /// `b64url(HMAC-SHA256(key: b64url-decode(bind), message))`, 43 characters; nil for a malformed bind.
    public static func binding(bind: String, clientID: String, identityKey: String) -> String? {
        guard let key = try? ReloE2EE.data(base64URL: bind, length: 16, field: "bind") else { return nil }
        let mac = HMAC<SHA256>.authenticationCode(for: message(clientID: clientID, identityKey: identityKey),
                                                  using: SymmetricKey(data: key))
        return ReloE2EE.base64URL(Data(mac))
    }

    /// Whether `binding` is the MAC of this login id and key under `bind` (compared in constant time).
    public static func verifies(bind: String, clientID: String, identityKey: String, binding: String) -> Bool {
        guard let key = try? ReloE2EE.data(base64URL: bind, length: 16, field: "bind"),
              let mac = try? ReloE2EE.data(base64URL: binding, length: 32, field: "binding") else { return false }
        return HMAC<SHA256>.isValidAuthenticationCode(mac, authenticating: message(clientID: clientID, identityKey: identityKey),
                                                      using: SymmetricKey(data: key))
    }
}

// MARK: Invite and its status

/// How the owner starts the computer: a command to paste, or a prompt for their agent.
public enum ReloSetupMode: String, Codable, Equatable, Sendable {
    case command
    case agent
}

/// Add a computer (docs/site/guides/servers.md): the one-time code the server made for this phone, and its command.
public struct ReloComputerInvite: Decodable, Equatable, Sendable {
    /// `cin_…`, what the status is read by.
    public let inviteId: String
    /// `rci_<32>`: the redeem half alone; the bind half is made on this phone.
    public let code: String
    /// The server's command, carrying `code` alone.
    public let command: String
    public let expiresAt: String
    public let level: String
    public let approvals: Bool
    /// The agents relo setup sets up there; nil: every agent it has.
    public let agents: [String]?

    public init(inviteId: String, code: String, command: String, expiresAt: String, level: String, approvals: Bool, agents: [String]? = nil) {
        self.inviteId = inviteId
        self.code = code
        self.command = command
        self.expiresAt = expiresAt
        self.level = level
        self.approvals = approvals
        self.agents = agents
    }
}

/// Where a one-time code is in its journey (`GET /api/devices/self/computer-invites/:inviteId`, packages/contracts/src/computers.ts).
public struct ReloComputerInviteStatus: Decodable, Equatable, Sendable {
    public enum State: String, Decodable, Equatable, Sendable {
        case waiting
        case redeemed
        case keyPublished = "key_published"
        case reported
        case tested
        case expired
    }

    public struct Harness: Decodable, Equatable, Sendable {
        public let id: String
        public let detected: Bool
        /// notify, track, guide, optimize, custom, or none (found, not set up).
        public let level: String

        public init(id: String, detected: Bool, level: String) {
            self.id = id
            self.detected = detected
            self.level = level
        }
    }

    public struct Check: Decodable, Equatable, Sendable {
        public let ok: Bool
        public let failing: [String]

        public init(ok: Bool, failing: [String]) {
            self.ok = ok
            self.failing = failing
        }
    }

    /// Whether the owner's devices can read what the computer sends (`computer.approval`).
    public enum Approval: String, Decodable, Equatable, Sendable {
        case approved
        case waiting
        case notNeeded = "not_needed"
    }

    public struct Computer: Decodable, Equatable, Sendable {
        public let clientId: String
        public let name: String
        public let cliVersion: String?
        public let identityKey: String?
        public let binding: String?
        public let harnesses: [Harness]
        public let check: Check?
        /// nil from a server that does not send it: treated as nothing to approve.
        public let approval: Approval?

        public init(clientId: String, name: String, cliVersion: String? = nil, identityKey: String? = nil, binding: String? = nil,
                    harnesses: [Harness] = [], check: Check? = nil, approval: Approval? = nil) {
            self.approval = approval
            self.clientId = clientId
            self.name = name
            self.cliVersion = cliVersion
            self.identityKey = identityKey
            self.binding = binding
            self.harnesses = harnesses
            self.check = check
        }
    }

    public let inviteId: String
    public let state: State
    public let expiresAt: String
    public let computer: Computer?

    public init(inviteId: String, state: State, expiresAt: String, computer: Computer? = nil) {
        self.inviteId = inviteId
        self.state = state
        self.expiresAt = expiresAt
        self.computer = computer
    }
}

/// Reading a code's status and giving the server this phone's Live Activity push token for it.
public protocol ComputerInviteTracking: Sendable {
    /// nil when the server no longer knows the invite (404).
    func inviteStatus(credential: DeviceCredential, inviteId: String) async throws -> ReloComputerInviteStatus?
    func registerSetupActivity(credential: DeviceCredential, inviteId: String, pushToken: String) async throws
}

/// What the wizard keeps for the code it showed, until the computer is approved or the code expires. Held in the
/// Keychain (the bind half is the secret), so the check still happens when the app returns from the background.
public struct ReloPendingComputerInvite: Codable, Equatable, Sendable {
    public var inviteId: String
    /// `rci_<32>`, the half the server knows.
    public var code: String
    public var bind: String
    /// The command with the full code (`rci_….<bind>`).
    public var command: String
    public var level: String
    public var mode: ReloSetupMode
    public var expiresAt: Date
    /// The computer whose key this phone already signed for (login id and key), so it is never signed twice.
    public var approved: String?

    public init(inviteId: String, code: String, bind: String, command: String, level: String, mode: ReloSetupMode, expiresAt: Date,
                approved: String? = nil) {
        self.inviteId = inviteId
        self.code = code
        self.bind = bind
        self.command = command
        self.level = level
        self.mode = mode
        self.expiresAt = expiresAt
        self.approved = approved
    }

    /// `rci_<32>.<bind>`, what a command or an agent prompt carries.
    public var fullCode: String { ReloComputerBind.fullCode(code: code, bind: bind) }

    public func isExpired(_ now: Date) -> Bool { expiresAt <= now }
}

public protocol ComputerInviteStoring: Sendable {
    func load() throws -> ReloPendingComputerInvite?
    func save(_ invite: ReloPendingComputerInvite) throws
    func delete() throws
}

public final class InMemoryComputerInviteStore: ComputerInviteStoring, @unchecked Sendable {
    private let lock = NSLock()
    private var invite: ReloPendingComputerInvite?

    public init(_ invite: ReloPendingComputerInvite? = nil) { self.invite = invite }

    public func load() throws -> ReloPendingComputerInvite? { lock.withLock { invite } }
    public func save(_ invite: ReloPendingComputerInvite) throws { lock.withLock { self.invite = invite } }
    public func delete() throws { lock.withLock { invite = nil } }
}

// MARK: The wizard's words

public enum ReloComputerSetup {
    /// The expiry as the server sends it (ISO 8601, with or without fractions).
    public static func expiry(_ value: String) -> Date? { ActivityKitTimestamp.date(fromISO8601: value) }

    /// The invite with the bind half in the command, as shown and copied.
    public static func command(for invite: ReloComputerInvite, bind: String) -> String {
        invite.command.replacingOccurrences(of: invite.code, with: ReloComputerBind.fullCode(code: invite.code, bind: bind))
    }

    /// What the owner hands to their agent: it reads the install page with the full code, never signs in.
    public static func agentPrompt(origin: URL, fullCode: String, level: String) -> String {
        let base = origin.absoluteString.hasSuffix("/") ? String(origin.absoluteString.dropLast()) : origin.absoluteString
        return "Read \(base)/install.md?code=\(fullCode) and set up Relo on this computer at the \(level) level. "
            + "It sends me a first notification when it is done."
    }

    /// "Claude Code" for `claude-code`; an unknown harness keeps its id.
    public static func agentName(_ id: String) -> String {
        switch id {
        case "claude-code": "Claude Code"
        case "codex": "Codex"
        case "opencode": "OpenCode"
        case "gemini": "Gemini CLI"
        case "cursor": "Cursor"
        case "copilot": "GitHub Copilot"
        case "amp": "Amp"
        default: id
        }
    }

    /// The agents Relo sets up, in the order the options list them.
    public static let agentIDs = ["claude-code", "codex", "opencode", "gemini", "cursor", "copilot", "amp"]

    /// What goes to the server as `agents`: empty for every agent found (the default), else the chosen ones in a fixed order.
    /// nil when "chosen" was picked and nothing is chosen (the wizard keeps that from being made).
    public static func agentsOption(all: Bool, chosen: Set<String>) -> [String]? {
        if all { return [] }
        let picked = agentIDs.filter(chosen.contains)
        return picked.isEmpty ? nil : picked
    }

    /// "Restart Claude Code and Codex on orchard so they load Relo. …"; nil when no agent was set up.
    public static func restartHint(agents: [String], computer: String?) -> String? {
        guard !agents.isEmpty else { return nil }
        let names = agents.count > 1 ? agents.dropLast().joined(separator: ", ") + " and " + agents[agents.count - 1] : agents[0]
        return "Restart \(names) on \(computer ?? "the computer") so they load Relo. Sessions already open don't see it until then."
    }

    /// A pushed agent entry (`claude-code` or `claude-code (guide)`): the harness named, its level kept.
    public static func agentLine(_ entry: String) -> String {
        guard let space = entry.firstIndex(of: " ") else { return agentName(entry) }
        return agentName(String(entry[..<space])) + String(entry[space...])
    }
}

/// What the wizard shows for a status, one place for the screen and the Live Activity (state mapping).
public struct ReloSetupProgress: Equatable, Sendable {
    public enum Stage: Int, Comparable, Sendable {
        /// The code is shown; nothing redeemed yet.
        case waiting
        /// Redeemed or key published: the computer is on its way.
        case connecting
        /// The computer reported: it is connected and its agents are known.
        case connected
        /// The first notification arrived.
        case tested
        case expired

        public static func < (lhs: Stage, rhs: Stage) -> Bool { lhs.rawValue < rhs.rawValue }
    }

    public let stage: Stage
    public let computerName: String?
    public let cliVersion: String?
    /// "Claude Code (guide)": set up on the computer.
    public let connectedAgents: [String]
    /// "Claude Code": the agents set up there, without their level.
    public let connectedAgentNames: [String]
    /// What the owner must approve before the computer's cards open here; false once approved (or never needed).
    public let needsApproval: Bool
    /// "Codex": found there, not connected.
    public let foundAgents: [String]
    /// The names of the self-check's failing checks, once there is one.
    public let failingChecks: [String]

    /// `approvedHere`: this phone signed the computer's key itself, so the server's count may lag a poll behind.
    public init(status: ReloComputerInviteStatus?, approvedHere: Bool = false) {
        let computer = status?.computer
        needsApproval = computer?.approval == .waiting && computer?.identityKey != nil && !approvedHere
        connectedAgentNames = computer?.harnesses.filter { $0.level != "none" }.map { ReloComputerSetup.agentName($0.id) } ?? []
        computerName = computer?.name
        cliVersion = computer?.cliVersion
        connectedAgents = computer?.harnesses
            .filter { $0.level != "none" }
            .map { "\(ReloComputerSetup.agentName($0.id)) (\($0.level))" } ?? []
        foundAgents = computer?.harnesses.filter { $0.detected && $0.level == "none" }.map { ReloComputerSetup.agentName($0.id) } ?? []
        failingChecks = computer?.check.map { $0.ok ? [] : $0.failing } ?? []
        switch status?.state {
        case nil, .waiting?: stage = .waiting
        case .redeemed?, .keyPublished?: stage = .connecting
        case .reported?: stage = .connected
        case .tested?: stage = .tested
        case .expired?: stage = .expired
        }
    }

    /// The wizard is over: nothing more will change on the Lock Screen.
    public var isFinished: Bool { stage == .tested || stage == .expired }

    /// The state string the server pushes into the Live Activity (the invite state names).
    public var activityState: String {
        switch stage {
        case .waiting: "waiting"
        case .connecting: "redeemed"
        case .connected: "reported"
        case .tested: "tested"
        case .expired: "expired"
        }
    }

    /// The first-notification step: done only when the notification arrived and the owner's devices can read it.
    public var notificationStep: (done: Bool, title: String, detail: String?) {
        if needsApproval, stage >= .connecting, stage != .expired {
            return (false, "First notification", "It opens here once you approve \(computerName ?? "the computer").")
        }
        if stage == .tested { return (true, "First notification sent", nil) }
        return (false, "First notification", "Sent when setup is done")
    }

    public var headline: String {
        switch stage {
        case .waiting: "Waiting for your computer…"
        case .connecting: computerName.map { "\($0) is connecting…" } ?? "Your computer is connecting…"
        case .connected, .tested: computerName.map { "\($0) connected" } ?? "Computer connected"
        case .expired: "Code expired"
        }
    }
}

/// What this phone does with a status for the code it made.
public enum ReloComputerBindCheck: Equatable, Sendable {
    /// The key or its binding is not published yet.
    case notYet
    /// The binding proves the code's holder published this key: sign `approve-computer` for it.
    case verified(clientID: String, identityKey: String)
    /// The key is not the one the code vouched for. Never approved.
    case mismatch

    public static func evaluate(_ status: ReloComputerInviteStatus, bind: String) -> ReloComputerBindCheck {
        guard let computer = status.computer, let identityKey = computer.identityKey, let binding = computer.binding else { return .notYet }
        return ReloComputerBind.verifies(bind: bind, clientID: computer.clientId, identityKey: identityKey, binding: binding)
            ? .verified(clientID: computer.clientId, identityKey: identityKey) : .mismatch
    }

    /// The marker kept once this key was approved: login id and key.
    public static func marker(clientID: String, identityKey: String) -> String { "\(clientID)|\(identityKey)" }
}

extension ReloClientKey {
    /// The computer a verified status describes, ready to be approved; nil when the key is not a P-256 public key.
    public static func joining(clientID: String, name: String, identityKey: String, now: Date = Date()) -> ReloClientKey? {
        guard let key = try? ReloE2EE.data(base64URL: identityKey, length: 65, field: "identityKey") else { return nil }
        return ReloClientKey(clientId: clientID, name: name, keyId: ReloE2EE.keyID(publicKeyX963: key), publicKey: identityKey,
                             changedAt: ReloKeyRing.timestamp(now))
    }
}
