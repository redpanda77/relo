import CryptoKit
import Foundation

/// Relo for Mac's local mode: the server, CLI and Node the app carries (`scripts/release/embed-server.sh`), run on this
/// Mac. This type finds them, asks the server for invites, runs the bundled `relo` command and writes the `relo`
/// launcher in `~/.local/bin`. Paths and the process runner are injected so the parsing and the pure parts are tested.
public struct LocalServer: Sendable {
    public struct ProcessResult: Sendable, Equatable {
        public var stdout: String
        public var stderr: String
        public var status: Int32
        public init(stdout: String, stderr: String, status: Int32) {
            self.stdout = stdout; self.stderr = stderr; self.status = status
        }
    }

    public typealias Runner = @Sendable (_ executable: URL, _ arguments: [String]) async throws -> ProcessResult

    public struct Invite: Sendable, Equatable {
        public let code: String
        public let apiURL: URL
        public let expiresAt: Date?
    }

    public struct Health: Sendable, Equatable {
        public let release: String
        /// The install's own id (config.json `instance`): what makes a server on the port this Mac's own.
        public let instance: String
    }

    /// What answers on the port in config.json.
    public enum Probe: Sendable, Equatable {
        case ours(port: Int, health: Health)
        /// Something answers but it is not this install (another macOS user's Relo, or another program).
        case foreign
        case silent
    }

    public struct Agent: Sendable, Equatable, Identifiable {
        public let id: String
        public let name: String

        public init(id: String, name: String) { self.id = id; self.name = name }
    }

    public struct PKCE: Sendable, Equatable {
        public let verifier: String
        public let challenge: String
    }

    public struct Failure: Error, Sendable, Equatable, LocalizedError {
        public let message: String
        public var errorDescription: String? { message }
        public init(_ message: String) { self.message = message }
    }

    /// `Contents/Resources` of the app, or any folder laid out like it.
    public let resources: URL?
    public let bundleIdentifier: String
    /// "version+build", what the running server reports as its release.
    public let appRelease: String
    public let home: URL
    private let runner: Runner
    private let session: URLSession

    public init(resources: URL?, bundleIdentifier: String, appRelease: String,
                home: URL = FileManager.default.homeDirectoryForCurrentUser,
                runner: @escaping Runner = LocalServer.run, session: URLSession = .shared) {
        self.resources = resources
        self.bundleIdentifier = bundleIdentifier
        self.appRelease = appRelease
        self.home = home
        self.runner = runner
        self.session = session
    }

    public init(bundle: Bundle = .main) {
        let version = bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"
        let build = bundle.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "0"
        self.init(resources: bundle.resourceURL, bundleIdentifier: bundle.bundleIdentifier ?? "ai.relo.notch",
                  appRelease: "\(version)+\(build)")
    }

    // MARK: Paths

    public var serverFolder: URL? { resources?.appendingPathComponent("server") }
    public var nodeURL: URL? { serverFolder?.appendingPathComponent("node") }
    public var cliURL: URL? { serverFolder?.appendingPathComponent("cli/bin/relo.mjs") }
    public var supervisorURL: URL? { serverFolder?.appendingPathComponent("app/server/dist/local/main.js") }
    public var dataRoot: URL { home.appendingPathComponent("Library/Application Support/Relo/server") }
    public var logsFolder: URL { dataRoot.appendingPathComponent("logs") }
    public var configURL: URL { dataRoot.appendingPathComponent("config.json") }
    public var launcherURL: URL { home.appendingPathComponent(".local/bin/relo") }
    /// `Relo.app`, from `Contents/Resources`.
    public var appURL: URL? { resources?.deletingLastPathComponent().deletingLastPathComponent() }
    public var agentLabel: String { "\(bundleIdentifier).server" }
    public var agentPlistName: String { "\(agentLabel).plist" }

    /// Whether this build carries the server (a Debug build from `notch-dev.sh` does not).
    public var isBundled: Bool {
        [nodeURL, cliURL, supervisorURL].allSatisfy { url in url.map { FileManager.default.fileExists(atPath: $0.path) } ?? false }
    }

    public static func isBundled(bundle: Bundle = .main) -> Bool { LocalServer(bundle: bundle).isBundled }

    // MARK: Port and health

    public static func port(fromConfig data: Data) -> Int? {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let port = object["port"] as? Int, (1...65535).contains(port) else { return nil }
        return port
    }

    public static func instance(fromConfig data: Data) -> String? {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let instance = object["instance"] as? String, !instance.isEmpty else { return nil }
        return instance
    }

    /// The port and instance in config.json, read fresh: the supervisor rewrites them when it picks another port.
    public func config() -> (port: Int, instance: String?)? {
        guard let data = try? Data(contentsOf: configURL), let port = Self.port(fromConfig: data) else { return nil }
        return (port, Self.instance(fromConfig: data))
    }

    public func port() -> Int? { config()?.port }

    public static func health(fromResponse data: Data) -> Health? {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              object["status"] as? String == "ok" else { return nil }
        return Health(release: object["release"] as? String ?? "", instance: object["instance"] as? String ?? "")
    }

    /// The server on `port` is this install's only when it names the instance config.json names.
    public static func isOurs(health: Health, configInstance: String?) -> Bool {
        guard let configInstance, !configInstance.isEmpty else { return false }
        return health.instance == configInstance
    }

    public func health(port: Int) async -> Health? {
        guard let url = URL(string: "http://127.0.0.1:\(port)/health/ready") else { return nil }
        var request = URLRequest(url: url)
        request.timeoutInterval = 3
        guard let (data, response) = try? await session.data(for: request),
              (response as? HTTPURLResponse)?.statusCode == 200 else { return nil }
        return Self.health(fromResponse: data)
    }

    /// Reads config.json, asks the port it names, and says whether the answer is this install's own.
    public func probe() async -> Probe {
        guard let config = config(), let health = await health(port: config.port) else { return .silent }
        return Self.isOurs(health: health, configInstance: config.instance) ? .ours(port: config.port, health: health) : .foreign
    }

    /// The running server's health, or nil when it is not answering (or is not this install's).
    public func currentHealth() async -> (port: Int, health: Health)? {
        if case .ours(let port, let health) = await probe() { return (port, health) }
        return nil
    }

    public static let foreignPortMessage = "Something on this Mac is blocking Relo. Try again."

    /// Waits for this install's server to answer. The port is read again each time, since the supervisor writes it on
    /// first start and picks another when one is taken. A server that is not ours on the port restarts ours once.
    public func waitUntilReady(timeout: TimeInterval = 60) async throws -> (port: Int, health: Health) {
        let deadline = Date().addingTimeInterval(timeout)
        var foreign = false
        var restarted = false
        // A server that is up answers in a second or two: look quickly at first, then back off.
        var delay = 0.2
        repeat {
            switch await probe() {
            case .ours(let port, let health): return (port, health)
            case .foreign:
                foreign = true
                if !restarted { restarted = true; try? await restartServer() }
            case .silent: break
            }
            try await Task.sleep(for: .seconds(delay))
            delay = min(delay * 1.6, 2)
        } while Date() < deadline
        throw Failure(foreign ? Self.foreignPortMessage : "Relo is taking longer than usual to start. Try again.")
    }

    // MARK: Whether it is running

    public static func pid(fromSupervisorJSON data: Data) -> Int32? {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let pid = object["pid"] as? Int, pid > 0 else { return nil }
        return Int32(pid)
    }

    /// PostgreSQL's postmaster.pid: the process id is its first line.
    public static func pid(fromPostmasterFile text: String) -> Int32? {
        text.split(whereSeparator: \.isNewline).first.flatMap { Int32($0.trimmingCharacters(in: .whitespaces)) }.flatMap { $0 > 0 ? $0 : nil }
    }

    private static func isAlive(_ pid: Int32) -> Bool {
        kill(pid, 0) == 0 || errno == EPERM
    }

    /// Whether the server's supervisor or its PostgreSQL still has a live process: what must end before the data goes.
    public func hasLiveProcess() -> Bool {
        let supervisor = (try? Data(contentsOf: dataRoot.appendingPathComponent("run/supervisor.json"))).flatMap(Self.pid(fromSupervisorJSON:))
        let postgres = (try? String(contentsOf: dataRoot.appendingPathComponent("db/postmaster.pid"), encoding: .utf8))
            .flatMap(Self.pid(fromPostmasterFile:))
        return [supervisor, postgres].compactMap { $0 }.contains(where: Self.isAlive)
    }

    // MARK: Where the app runs

    /// Why local setup cannot go ahead here, in words for the owner; nil when it can.
    public static func setupProblem(appURL: URL?, home: URL, appleSilicon: Bool) -> String? {
        guard appleSilicon else { return "Relo for Mac needs a Mac with Apple silicon." }
        let path = appURL?.standardizedFileURL.path ?? ""
        let applications = ["/Applications/", home.appendingPathComponent("Applications").path + "/"]
        let installed = applications.contains { path.hasPrefix($0) } && !path.contains("/AppTranslocation/")
        return installed ? nil : "Move Relo to your Applications folder, then open it again."
    }

    public static var isAppleSilicon: Bool {
        var value: Int32 = 0
        var size = MemoryLayout<Int32>.size
        return sysctlbyname("hw.optional.arm64", &value, &size, nil, 0) == 0 && value == 1
    }

    public func setupProblem() -> String? {
        Self.setupProblem(appURL: appURL, home: home, appleSilicon: Self.isAppleSilicon)
    }

    public static func needsRestart(runningRelease: String, appRelease: String) -> Bool {
        runningRelease != appRelease
    }

    public static func needsRestart(runningRelease: String, appVersion: String) -> Bool {
        needsRestart(runningRelease: runningRelease, appRelease: appVersion)
    }

    public func needsRestart(runningRelease: String) -> Bool {
        Self.needsRestart(runningRelease: runningRelease, appRelease: appRelease)
    }

    public var restartArguments: [String] { ["kickstart", "-k", "gui/\(getuid())/\(agentLabel)"] }

    public func restartServer() async throws {
        let result = try await runner(URL(fileURLWithPath: "/bin/launchctl"), restartArguments)
        guard result.status == 0 else { throw Failure("macOS could not restart Relo's background server.") }
    }

    // MARK: Invites

    public static func parseInvite(_ output: String) -> Invite? {
        for line in output.split(whereSeparator: \.isNewline).reversed() {
            guard let data = line.data(using: .utf8),
                  let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let code = object["code"] as? String, code.hasPrefix("rci_"),
                  let api = (object["apiUrl"] as? String).flatMap(URL.init(string:)),
                  api.host == "127.0.0.1" || api.host == "localhost" else { continue }
            return Invite(code: code, apiURL: api, expiresAt: (object["expiresAt"] as? String).flatMap(Self.parseISO8601))
        }
        return nil
    }

    /// The server writes the invite's expiry as an ISO 8601 string, with or without fractional seconds.
    static func parseISO8601(_ text: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: text) { return date }
        return ISO8601DateFormatter().date(from: text)
    }

    public func inviteArguments(level: String, agents: [String]) -> [String]? {
        guard let main = supervisorURL else { return nil }
        return [main.path, "invite", "--root", dataRoot.path, "--mac-app", "--level", level]
            + agents.flatMap { ["--agent", $0] }
    }

    public func invite(level: String = "guide", agents: [String] = []) async throws -> Invite {
        guard let node = nodeURL, let arguments = inviteArguments(level: level, agents: agents) else {
            throw Failure("This build of Relo does not carry the server.")
        }
        let result = try await runner(node, arguments)
        guard result.status == 0, let invite = Self.parseInvite(result.stdout) else {
            throw Failure("Relo could not finish setting up.")
        }
        return invite
    }

    // MARK: PKCE

    public static func pkce(verifierBytes: [UInt8]) -> PKCE {
        let verifier = base64url(Data(verifierBytes))
        return PKCE(verifier: verifier, challenge: base64url(Data(SHA256.hash(data: Data(verifier.utf8)))))
    }

    public static func pkce() -> PKCE {
        pkce(verifierBytes: (0..<32).map { _ in UInt8.random(in: 0...255) })
    }

    static func base64url(_ data: Data) -> String {
        data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    // MARK: The relo command

    /// The line that says Relo for Mac wrote the launcher: only a file that has it is ever rewritten or removed.
    public static let launcherMarker = "# Written by Relo for Mac"

    public static func launcherScript(node: String, cli: String) -> String {
        """
        #!/bin/sh
        \(launcherMarker)
        # It runs the relo command inside the app, so updating the app updates it.
        exec "\(node)" "\(cli)" "$@"
        """ + "\n"
    }

    public static func hasLauncherMarker(_ script: String) -> Bool {
        script.split(whereSeparator: \.isNewline).contains { $0 == Substring(launcherMarker) }
    }

    private var currentLauncher: String? { try? String(contentsOf: launcherURL, encoding: .utf8) }

    /// What `installLauncher` found at `~/.local/bin/relo`.
    public enum LauncherResult: Sendable, Equatable {
        /// Relo for Mac's launcher is there (new, or rewritten over one it wrote).
        case written
        /// Another relo command (an npm link, an install.sh launcher) is there and was left alone.
        case otherInstalled
    }

    /// The words for an owner whose own relo command stays in place.
    public static let otherLauncherNote = "Another relo command is installed; Relo for Mac's agents use it."

    /// Whether a file or symlink is at the launcher's path that Relo for Mac did not write. A missing file, a dangling
    /// symlink and one carrying the marker are Relo's to replace.
    func launcherIsForeign() -> Bool {
        let path = launcherURL.path
        let fm = FileManager.default
        guard (try? fm.attributesOfItem(atPath: path)) != nil else { return false }
        // A symlink whose target is gone points at nothing.
        guard fm.fileExists(atPath: path) else { return false }
        if (try? fm.destinationOfSymbolicLink(atPath: path)) != nil { return true }
        guard let current = currentLauncher else { return true }
        return !Self.hasLauncherMarker(current)
    }

    /// The `@relo/cli` version a foreign `~/.local/bin/relo` runs: a symlink to its `bin/relo.mjs`, or a script that
    /// execs one (`exec node …/bin/relo.mjs`); nil when it names none.
    func foreignLauncherVersion() -> String? {
        let fm = FileManager.default
        let path = launcherURL.path
        var script: URL?
        if let destination = try? fm.destinationOfSymbolicLink(atPath: path) {
            script = URL(fileURLWithPath: destination, relativeTo: launcherURL.deletingLastPathComponent()).standardizedFileURL
        } else if let text = currentLauncher,
                  let range = text.range(of: #"/[^\s"']*/bin/relo\.mjs"#, options: .regularExpression) {
            script = URL(fileURLWithPath: String(text[range]))
        }
        guard let script = script?.resolvingSymlinksInPath(), script.lastPathComponent == "relo.mjs" else { return nil }
        return Self.cliVersion(at: script.deletingLastPathComponent().deletingLastPathComponent())
    }

    /// The version in a `@relo/cli` package folder's package.json.
    static func cliVersion(at folder: URL) -> String? {
        guard let data = try? Data(contentsOf: folder.appendingPathComponent("package.json")),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              object["name"] as? String == "@relo/cli" else { return nil }
        return object["version"] as? String
    }

    /// "0.17.54" < "0.17.64", numerically per part.
    public static func isOlder(_ version: String, than other: String) -> Bool {
        let parts = { (text: String) in text.split(separator: ".").map { Int($0.prefix { $0.isNumber }) ?? 0 } }
        let (a, b) = (parts(version), parts(other))
        for index in 0..<max(a.count, b.count) {
            let (x, y) = (index < a.count ? a[index] : 0, index < b.count ? b[index] : 0)
            if x != y { return x < y }
        }
        return false
    }

    /// What tells the relo command which launcher the agents' hooks run (packages/cli/src/harness/core/launch.mjs).
    public static let hookLauncherVariable = "RELO_HOOK_LAUNCHER"

    /// The backup of an older relo command the launcher replaced, kept beside it.
    public var replacedLauncherURL: URL { launcherURL.deletingLastPathComponent().appendingPathComponent("relo.before-relo-for-mac") }

    @discardableResult
    public func installLauncher() throws -> LauncherResult {
        guard let node = nodeURL, let cli = cliURL else { throw Failure("This build of Relo does not carry the relo command.") }
        let fm = FileManager.default
        try fm.createDirectory(at: launcherURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        if launcherIsForeign() {
            // Another relo command stays, unless it runs an older relo than this app carries: then the agents' hooks
            // would run old code (a Homebrew or npm copy left behind). It is kept beside the launcher, renamed.
            guard let theirs = foreignLauncherVersion(), let ours = Self.cliVersion(at: cli.deletingLastPathComponent().deletingLastPathComponent()),
                  Self.isOlder(theirs, than: ours) else {
                unsetenv(Self.hookLauncherVariable)
                return .otherInstalled
            }
            try? fm.removeItem(at: replacedLauncherURL)
            try fm.moveItem(at: launcherURL, to: replacedLauncherURL)
        }
        // A file Relo wrote (or a dangling symlink) is replaced, never written through.
        try? fm.removeItem(at: launcherURL)
        try Self.launcherScript(node: node.path, cli: cli.path).write(to: launcherURL, atomically: true, encoding: .utf8)
        try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: launcherURL.path)
        // Setup run by this app from now on writes hooks that run this launcher by path (the CLI's RELO_HOOK_LAUNCHER):
        // they follow the app on every update, whatever other relo is first on the agents' PATH.
        setenv(Self.hookLauncherVariable, launcherURL.path, 1)
        return .written
    }

    /// Whether the launcher is Relo for Mac's and names another copy of the app than this one (the app moved).
    public func launcherIsStale() -> Bool {
        guard let node = nodeURL, let cli = cliURL, let current = currentLauncher, Self.hasLauncherMarker(current) else { return false }
        return current != Self.launcherScript(node: node.path, cli: cli.path)
    }

    /// Points a launcher this app wrote at this copy of the app; any other `relo` is left alone.
    public func refreshLauncherIfMoved() {
        if launcherIsStale() { try? installLauncher() }
    }

    /// Removes the launcher only when Relo for Mac wrote it: another install's `relo` stays.
    public func removeLauncher() {
        guard let current = currentLauncher, Self.hasLauncherMarker(current) else { return }
        try? FileManager.default.removeItem(at: launcherURL)
    }

    /// Runs the bundled relo command: `relo(["setup", "--path"])`.
    @discardableResult
    public func relo(_ arguments: [String]) async throws -> ProcessResult {
        guard let node = nodeURL, let cli = cliURL else { throw Failure("This build of Relo does not carry the relo command.") }
        return try await runner(node, [cli.path] + arguments)
    }

    private func reloChecked(_ arguments: [String], failure: String) async throws -> ProcessResult {
        let result = try await relo(arguments)
        guard result.status == 0 else { throw Failure(failure) }
        return result
    }

    public func setUpPath() async throws {
        _ = try await reloChecked(["setup", "--path"], failure: "Relo could not add ~/.local/bin to your shell's PATH.")
    }

    public func setManagedUpdates() async throws {
        _ = try await reloChecked(["update", "--mode", "managed"], failure: "Relo could not hand its updates to the app.")
    }

    /// Hands the CLI's updates back to itself (uninstall).
    public func setAutomaticUpdates() async throws {
        _ = try await reloChecked(["update", "--mode", "auto"], failure: "Relo could not hand its updates back.")
    }

    /// Removes the local profile from the CLI (works with the server down); other profiles stay.
    public func logoutLocalProfile() async throws {
        _ = try await reloChecked(["auth", "logout", "--profile", Self.localProfile, "--only-local"], failure: "Relo could not leave Relo on this Mac.")
    }

    /// Refreshes what Relo wrote into the agents; it gives up after `timeout` seconds, ending the command.
    public func refreshAgents(timeout: TimeInterval = 60) async throws {
        let failure = "Relo could not refresh your agents' setup."
        try await Self.withTimeout(timeout, failure: failure) { _ = try await self.reloChecked(["setup", "--refresh"], failure: failure) }
    }

    /// Runs `work`, and throws `failure` when it has not finished in `seconds` (the work is cancelled, which ends a
    /// command `run` started).
    static func withTimeout(_ seconds: TimeInterval, failure: String, _ work: @escaping @Sendable () async throws -> Void) async throws {
        try await withThrowingTaskGroup(of: Void.self) { group in
            group.addTask { try await work() }
            group.addTask {
                try await Task.sleep(for: .seconds(seconds))
                throw Failure(failure)
            }
            defer { group.cancelAll() }
            _ = try await group.next()
        }
    }

    public func uninstallAgents() async throws {
        _ = try await reloChecked(["uninstall", "--apply"], failure: "Relo could not remove its setup from your agents.")
    }

    /// Sets up the named agents (`relo setup --agent …`), writing only Relo's own block; no prompt can appear.
    /// `approvals` adds `--approvals on|off` (permission prompts answered from the iPhone; only with session tracking).
    public static func setUpAgentsArguments(agents: [String], computer: String, level: String? = nil, approvals: Bool? = nil) -> [String] {
        ["setup", "--computer", computer, "--json"]
            + (level.map { ["--level", $0] } ?? [])
            + (approvals.map { ["--approvals", $0 ? "on" : "off"] } ?? [])
            + agents.flatMap { ["--agent", $0] }
    }

    /// What setup said it did: the parts it changed, in plain words, and what the owner still does once.
    public struct SetUpResult: Equatable, Sendable {
        public let steps: [String]
        public let ownerSteps: [String]
        public init(steps: [String], ownerSteps: [String]) { self.steps = steps; self.ownerSteps = ownerSteps }
    }

    /// Sets the agents up; returns what the owner still does once in one of them (Codex runs only the hooks they
    /// trusted in /hooks), from setup's `ownerSteps`.
    @discardableResult
    public func setUpAgents(_ agents: [String], computer: String, level: String = "guide", approvals: Bool? = nil) async throws -> [String] {
        try await setUpAgentsResult(agents, computer: computer, level: level, approvals: approvals).ownerSteps
    }

    public func setUpAgentsResult(_ agents: [String], computer: String, level: String = "guide", approvals: Bool? = nil) async throws -> SetUpResult {
        guard !agents.isEmpty else { return SetUpResult(steps: [], ownerSteps: []) }
        let result = try await reloChecked(Self.setUpAgentsArguments(agents: agents, computer: computer, level: level, approvals: approvals),
                                           failure: "Relo could not set up your agents.")
        return Self.parseSetUpResult(result.stdout)
    }

    /// The parts setup changed (`changed` rows with a `kind`), as plain sentences, plus its owner steps. Unknown kinds
    /// are skipped; a missing `changed` list gives no steps.
    public static func parseSetUpResult(_ output: String) -> SetUpResult {
        var steps: [String] = []
        for line in output.split(whereSeparator: \.isNewline) {
            guard let data = line.data(using: .utf8),
                  let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let rows = object["changed"] as? [[String: Any]] else { continue }
            for row in rows {
                let removed = (row["action"] as? String) == "removed"
                let words: String?
                switch row["kind"] as? String {
                case "block": words = removed ? "Removed instructions" : "Added instructions"
                case "skill": words = removed ? "Removed the Relo skill" : "Installed the Relo skill"
                case "hooks": words = removed ? "Removed session tracking" : "Added session tracking"
                case "mcp": words = removed ? "Removed the Relo connection" : "Added the Relo connection"
                default: words = nil
                }
                if let words, !steps.contains(words) { steps.append(words) }
            }
            break
        }
        return SetUpResult(steps: steps, ownerSteps: ownerSteps(inJSONLines: output))
    }

    /// The `step` of each `ownerSteps` row on setup's JSON line, in order; none when there are none.
    public static func ownerSteps(inJSONLines output: String) -> [String] {
        for line in output.split(whereSeparator: \.isNewline) {
            guard let data = line.data(using: .utf8),
                  let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let rows = object["ownerSteps"] as? [[String: Any]] else { continue }
            return rows.compactMap { $0["step"] as? String }
        }
        return []
    }

    // MARK: Preparing

    public var prepareArguments: [String]? {
        supervisorURL.map { [$0.path, "prepare", "--root", dataRoot.path] }
    }

    /// First-run work without serving or any login item: layout, secrets, database, owner (the supervisor's `prepare`).
    /// Safe to run again; skipped while this install's server already answers (it would be using the database).
    public func prepare() async throws {
        guard let node = nodeURL, let arguments = prepareArguments else {
            throw Failure("This build of Relo does not carry the server.")
        }
        if case .ours = await probe() { return }
        let result = try await runner(node, arguments)
        guard result.status == 0 else { throw Failure("Relo could not get ready on this Mac.") }
    }

    // MARK: What the owner sees of this Mac

    /// "0.2.32" from the release "0.2.32+257": the number the owner knows, never the build.
    public static func shortVersion(ofRelease release: String) -> String {
        String(release.split(separator: "+", maxSplits: 1).first ?? "")
    }

    /// The host of the server a relo command on this Mac is already signed in to: the active profile of the CLI's config
    /// (`profiles[activeProfile]`), unless Relo for Mac made it (`local == true`). The address never decides: an SSH
    /// tunnel to a remote server is loopback too.
    public static func remoteLoginHost(inConfig data: Data) -> String? {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let profiles = object["profiles"] as? [String: Any], !profiles.isEmpty else { return nil }
        let name = (object["activeProfile"] as? String).flatMap { profiles[$0] != nil ? $0 : nil } ?? profiles.keys.sorted()[0]
        guard let profile = profiles[name] as? [String: Any], profile["local"] as? Bool != true,
              let text = profile["apiUrl"] as? String, let host = URL(string: text)?.host(), !host.isEmpty else { return nil }
        return host
    }

    public func existingRemoteLoginHost() -> String? {
        let config = home.appendingPathComponent("Library/Application Support/relo/config.json")
        return (try? Data(contentsOf: config)).flatMap(Self.remoteLoginHost(inConfig:))
    }

    // MARK: Joining

    /// The first JSON object with a string at `key`, searched through the CLI's JSON lines.
    public static func firstString(_ key: String, inJSONLines output: String) -> String? {
        func find(_ value: Any) -> String? {
            if let dict = value as? [String: Any] {
                if let text = dict[key] as? String { return text }
                for child in dict.values { if let found = find(child) { return found } }
            } else if let array = value as? [Any] {
                for child in array { if let found = find(child) { return found } }
            }
            return nil
        }
        for line in output.split(whereSeparator: \.isNewline) {
            if let data = line.data(using: .utf8), let object = try? JSONSerialization.jsonObject(with: data),
               let found = find(object) { return found }
        }
        return nil
    }

    /// The CLI profile this app's local mode lives in; the owner's other profiles are never touched.
    public static let localProfile = "local"

    /// `setUpAgents: false` adds `--no-setup`: link the command and the app only, never touch an agent (skipping agents,
    /// and reconnecting after the sign-in was lost). The CLI must know that flag.
    public static func joinArguments(code: String, apiURL: URL, challenge: String, clientName: String,
                                     setUpAgents: Bool = true) -> [String] {
        ["auth", "join", code, "--api-url", apiURL.absoluteString, "--local", "--profile", localProfile,
         "--client-name", clientName, "--mac-app-challenge", challenge] + (setUpAgents ? [] : ["--no-setup"])
    }

    /// Signs the CLI in to the local server (and sets up the agents the invite named); returns the app's sign-in code.
    public func join(code: String, apiURL: URL, challenge: String, clientName: String, setUpAgents: Bool = true) async throws -> String {
        let result = try await relo(Self.joinArguments(code: code, apiURL: apiURL, challenge: challenge, clientName: clientName,
                                                       setUpAgents: setUpAgents))
        guard result.status == 0, let signIn = Self.firstString("macAppSignInCode", inJSONLines: result.stdout) else {
            throw Failure(setUpAgents ? "Relo could not finish setting up." : "Relo could not link this Mac.")
        }
        return signIn
    }

    // MARK: Agents

    /// The harnesses' names as Relo shows them.
    public static let agentNames = ["claude-code": "Claude Code", "opencode": "OpenCode", "codex": "Codex", "cursor": "Cursor",
                                    "gemini": "Gemini CLI", "antigravity": "Antigravity", "copilot": "Copilot", "amp": "Amp",
                                    "vscode": "VS Code", "claude-desktop": "Claude Desktop"]

    /// How one part of the setup stands (`relo setup --show --json` `parts`).
    public enum PartState: String, Equatable, Sendable {
        case current, outdated, none, notApplicable = "n/a"
        public var isInstalled: Bool { self == .current || self == .outdated }
    }

    /// What is installed in a harness, part by part. Absent from older relo commands.
    public struct Parts: Equatable, Sendable {
        public var instructions: PartState
        public var skill: PartState
        /// The level the hooks run at, "off" when none, "n/a" when the harness has no hooks.
        public var hooks: String
        public var mcp: Bool
        public var approvals: Bool
        public init(instructions: PartState, skill: PartState, hooks: String, mcp: Bool = false, approvals: Bool = false) {
            self.instructions = instructions; self.skill = skill; self.hooks = hooks; self.mcp = mcp; self.approvals = approvals
        }
        public var hasHooks: Bool { !["off", "n/a", "none", ""].contains(hooks) }
        public var supportsHooks: Bool { hooks != "n/a" }
    }

    /// A harness on this Mac and what Relo has set up in it (`relo setup --show`).
    public struct Harness: Identifiable, Equatable, Sendable {
        public let id: String
        public let name: String
        /// notify, track, guide or optimize; "none" when Relo is not set up in it.
        public let level: String
        /// Something Relo installed there is older than the relo command (`relo setup --refresh` brings it up to date).
        public let outdated: Bool
        /// The agent is installed on this Mac (older relo commands list only installed ones: true when not said).
        public let installed: Bool
        /// What the relo command says is configured; when it says nothing, whether a level is set.
        public let configuredFlag: Bool?
        public let parts: Parts?
        public var isSetUp: Bool { configuredFlag ?? (level != "none") }

        public init(id: String, name: String, level: String, outdated: Bool, installed: Bool = true,
                    configured: Bool? = nil, parts: Parts? = nil) {
            self.id = id; self.name = name; self.level = level; self.outdated = outdated
            self.installed = installed; self.configuredFlag = configured; self.parts = parts
        }

        /// Session tracking (hooks) is installed, or, with no parts to read, the level implies it.
        public var hasSessionTracking: Bool { parts?.hasHooks ?? ["guide", "optimize"].contains(level) }
        private var hasSkill: Bool { parts.map { $0.skill.isInstalled } ?? (level != "notify") }
        /// The harness has no hooks to install (the relo command said so).
        public var lacksSessionTracking: Bool { parts.map { !$0.supportsHooks } ?? false }

        /// Where the setup stands, in the owner's words: a title and, when set up, what it gives.
        public var statusTitle: String {
            guard isSetUp else { return "Not set up" }
            return (hasSessionTracking || hasSkill) ? "Shows its work in Relo" : "Instructions only"
        }

        public var statusDetail: String? {
            guard isSetUp else { return nil }
            if hasSessionTracking { return "Live cards and session tracking" }
            if hasSkill { return "Live cards" }
            return level == "notify" ? "Notifications and questions" : nil
        }

        /// "Shows its work in Relo · Live cards and session tracking".
        public var statusLine: String { [statusTitle, statusDetail].compactMap { $0 }.joined(separator: " · ") }

        /// What is installed, in plain words ("Instructions, Relo skill, session tracking"); nil when it cannot be read.
        public var installedSummary: String? {
            guard isSetUp, let parts else { return nil }
            var items: [String] = []
            if parts.instructions.isInstalled { items.append("Instructions") }
            if parts.skill.isInstalled { items.append("Relo skill") }
            if parts.hasHooks { items.append("session tracking") }
            if parts.mcp { items.append("Relo connection") }
            if parts.approvals { items.append("permission prompts on your iPhone") }
            guard !items.isEmpty else { return nil }
            return items.joined(separator: ", ")
        }

        public var updateReadyText: String? { isSetUp && outdated ? "An update is ready" : nil }

        /// The choice the setup sheet starts on: this setup's, or the recommended one.
        public var currentChoice: SetupChoice {
            guard isSetUp else { return .recommended(for: self) }
            if hasSessionTracking && !lacksSessionTracking { return .guide }
            return level == "notify" ? .notify : (hasSessionTracking ? .guide : .track)
        }
    }

    /// One way to set an agent up, as the setup sheet offers it.
    public struct SetupChoice: Identifiable, Equatable, Sendable {
        public let level: String
        public let title: String
        public let detail: String
        public let needsSessionTracking: Bool
        public var id: String { level }

        public static let notify = SetupChoice(level: "notify", title: "Notifications and questions",
            detail: "The agent can ask you questions and notify you. No live cards.", needsSessionTracking: false)
        public static let track = SetupChoice(level: "track", title: "Live cards",
            detail: "Adds a live card with the agent's plan and progress. No session tracking.", needsSessionTracking: false)
        public static let guide = SetupChoice(level: "guide", title: "Live cards and session tracking",
            detail: "Adds Relo following the session itself (working, waiting on you, idle) through small session tracking (hooks) the agent runs.",
            needsSessionTracking: true)
        public static let all = [notify, track, guide]

        /// Recommended: live cards and session tracking, or live cards for a harness without hooks.
        public static func recommended(for harness: Harness) -> SetupChoice { harness.lacksSessionTracking ? .track : .guide }
    }

    /// The harnesses `relo setup --show --json` lists, in the order Relo shows them: Claude Code and OpenCode first.
    public static func parseHarnesses(_ output: String) -> [Harness] {
        var rows: [[String: Any]] = []
        for line in output.split(whereSeparator: \.isNewline) {
            guard let data = line.data(using: .utf8),
                  let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let found = object["harnesses"] as? [[String: Any]], !found.isEmpty else { continue }
            rows = found
            break
        }
        let harnesses = rows.compactMap { row -> Harness? in
            guard let id = row["harness"] as? String else { return nil }
            var parts: Parts?
            if let raw = row["parts"] as? [String: Any] {
                func state(_ key: String) -> PartState { (raw[key] as? String).flatMap(PartState.init(rawValue:)) ?? .notApplicable }
                parts = Parts(instructions: state("instructions"), skill: state("skill"), hooks: raw["hooks"] as? String ?? "n/a",
                              mcp: raw["mcp"] as? Bool ?? false, approvals: raw["approvals"] as? Bool ?? false)
            }
            let outdated = (row["skill"] as? String) == "outdated" || parts.map { $0.skill == .outdated || $0.instructions == .outdated } == true
            return Harness(id: id, name: agentNames[id] ?? id.capitalized, level: row["level"] as? String ?? "none",
                           outdated: outdated, installed: row["installed"] as? Bool ?? true,
                           configured: row["configured"] as? Bool, parts: parts)
        }
        let first = ["claude-code", "opencode"]
        return harnesses.filter { first.contains($0.id) }.sorted { first.firstIndex(of: $0.id)! < first.firstIndex(of: $1.id)! }
            + harnesses.filter { !first.contains($0.id) }
    }

    /// The harnesses on this Mac with what Relo set up in each, read without changing anything; none when it fails.
    public func harnesses() async -> [Harness] {
        // `--all` also lists agents that are not installed (the page folds them); an older relo command refuses it.
        for arguments in [["setup", "--show", "--all", "--json"], ["setup", "--show", "--json"]] {
            if let result = try? await relo(arguments), result.status == 0 { return Self.parseHarnesses(result.stdout) }
        }
        return []
    }

    public static func removeAgentArguments(_ agent: String) -> [String] { ["uninstall", "--agent", agent, "--apply", "--json"] }

    /// Takes Relo's parts out of one harness (its block, skill, hooks); the others and the relo command stay.
    public func removeAgent(_ agent: String) async throws {
        _ = try await reloChecked(Self.removeAgentArguments(agent), failure: "Relo could not remove its setup from that agent.")
    }

    /// Whether the relo command on this Mac is signed in, and to which server (`relo auth status`): agents report
    /// only through it.
    public struct CommandSignIn: Equatable, Sendable {
        public let signedIn: Bool
        public let server: URL?
        public init(signedIn: Bool, server: URL?) { self.signedIn = signedIn; self.server = server }
    }

    public static func parseCommandSignIn(_ output: String) -> CommandSignIn {
        for line in output.split(whereSeparator: \.isNewline) {
            guard let data = line.data(using: .utf8),
                  let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let signedIn = object["signedIn"] as? Bool else { continue }
            return CommandSignIn(signedIn: signedIn, server: (object["server"] as? String).flatMap(URL.init(string:)))
        }
        return CommandSignIn(signedIn: false, server: nil)
    }

    public func commandSignIn() async -> CommandSignIn {
        guard let result = try? await relo(["auth", "status", "--json"]) else { return CommandSignIn(signedIn: false, server: nil) }
        return Self.parseCommandSignIn(result.stdout)
    }

    /// `relo doctor`'s advice about several relo commands on this Mac (`warnings.relos`): what to show in Settings.
    public struct RelosWarning: Equatable, Sendable {
        public let state: String
        public let hint: String
        public init(state: String, hint: String) { self.state = state; self.hint = hint }
    }

    public static func parseRelosWarning(_ output: String) -> RelosWarning? {
        for line in output.split(whereSeparator: \.isNewline) {
            guard let data = line.data(using: .utf8),
                  let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
            let warnings = (object["warnings"] as? [String: Any]) ?? ((object["data"] as? [String: Any])?["warnings"] as? [String: Any])
            guard let warnings else { continue }
            guard let relos = warnings["relos"] as? [String: Any], let hint = relos["hint"] as? String, !hint.isEmpty else { return nil }
            return RelosWarning(state: (relos["state"] as? String) ?? "several", hint: hint)
        }
        return nil
    }

    /// The relo-command warning `relo doctor --json` gives, or nil when there is none (or doctor cannot run).
    public func relosWarning() async -> RelosWarning? {
        guard let result = try? await relo(["doctor", "--json"]) else { return nil }
        return Self.parseRelosWarning(result.stdout)
    }

    /// Whether `~/.local/bin/relo` is the launcher Relo for Mac wrote (never a foreign relo, never missing).
    public func launcherIsApps() -> Bool {
        guard let current = currentLauncher else { return false }
        return Self.hasLauncherMarker(current)
    }

    /// Agents the CLI knows, in the order Relo shows them: Claude Code and OpenCode first.
    public static func parseAgents(_ output: String) -> [Agent] {
        let names = agentNames
        var ids: [String] = []
        for line in output.split(whereSeparator: \.isNewline) {
            guard let data = line.data(using: .utf8),
                  let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
            let rows = (object["harnesses"] as? [[String: Any]]) ?? []
            // Only harnesses actually installed here (a CLI that says nothing about it: all of them).
            ids = rows.filter { ($0["installed"] as? Bool) != false }.compactMap { $0["harness"] as? String }
            if !rows.isEmpty { break }
        }
        let first = ["claude-code", "opencode"]
        let ordered = first.filter(ids.contains) + ids.filter { !first.contains($0) }
        return ordered.map { Agent(id: $0, name: names[$0] ?? $0.capitalized) }
    }

    /// The agents on this Mac, read without changing anything (`relo setup --show`); none when the CLI finds none.
    public func detectAgents() async -> [Agent] {
        guard let result = try? await relo(["setup", "--show", "--json"]), result.status == 0 else { return [] }
        return Self.parseAgents(result.stdout)
    }

    // MARK: Processes

    /// Names taken from the owner's login shell; everything else comes from the app's own environment.
    public static func isLoginEnvironmentName(_ name: String) -> Bool {
        if ["PATH", "HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME"].contains(name) { return true }
        if name.hasPrefix("GEMINI_") || name.hasPrefix("XDG_") { return !looksSecret(name) }
        return name.hasPrefix("RELO_") && !looksSecret(name)
    }

    private static func looksSecret(_ name: String) -> Bool {
        ["TOKEN", "SECRET", "KEY", "PASSWORD", "PASSWD", "CREDENTIAL"].contains { name.contains($0) }
    }

    /// The allow-listed variables of `env` output (`NAME=value` lines; a line that is not one continues the value
    /// before it, as a multi-line value prints).
    public static func parseLoginEnvironment(_ output: String) -> [String: String] {
        var all: [String: String] = [:]
        var last: String?
        for line in output.split(separator: "\n", omittingEmptySubsequences: false) {
            if let eq = line.firstIndex(of: "="), !line.hasPrefix("="),
               line[line.startIndex..<eq].allSatisfy({ $0.isLetter || $0.isNumber || $0 == "_" }),
               !(line.first?.isNumber ?? true) {
                let name = String(line[line.startIndex..<eq])
                all[name] = String(line[line.index(after: eq)...])
                last = name
            } else if let name = last {
                all[name, default: ""] += "\n" + line
            }
        }
        return all.filter { isLoginEnvironmentName($0.key) && !$0.value.isEmpty }
    }

    /// The environment a command runs with: the app's, with the login shell's allow-listed values over it. The
    /// launcher variable the app set for its own hooks always stays the app's.
    public static func childEnvironment(base: [String: String], login: [String: String]) -> [String: String] {
        var merged = base
        for (name, value) in login where name != hookLauncherVariable { merged[name] = value }
        return merged
    }

    /// `/bin/zsh -lic env` (or the user's shell), read once; empty when the shell fails or takes over 5 seconds, so
    /// the current environment is used as it is.
    public static let loginEnvironment: [String: String] = {
        let shell = ProcessInfo.processInfo.environment["SHELL"].flatMap { FileManager.default.isExecutableFile(atPath: $0) ? $0 : nil } ?? "/bin/zsh"
        return captureLoginEnvironment(shell: shell, timeout: 5) ?? [:]
    }()

    static func captureLoginEnvironment(shell: String, timeout: TimeInterval) -> [String: String]? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: shell)
        process.arguments = ["-lic", "env"]
        let out = Pipe()
        process.standardOutput = out
        process.standardError = FileHandle.nullDevice
        process.standardInput = FileHandle.nullDevice
        let exited = DispatchSemaphore(value: 0)
        process.terminationHandler = { _ in exited.signal() }
        do { try process.run() } catch { return nil }
        let data = LockedBox<Data>(Data())
        let read = DispatchSemaphore(value: 0)
        DispatchQueue.global().async { data.value = out.fileHandleForReading.readDataToEndOfFile(); read.signal() }
        guard exited.wait(timeout: .now() + timeout) == .success else { process.terminate(); return nil }
        _ = read.wait(timeout: .now() + 1)
        return parseLoginEnvironment(String(decoding: data.value, as: UTF8.self))
    }

    public static func run(executable: URL, arguments: [String]) async throws -> ProcessResult {
        let running = LockedBox<Process?>(nil)
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                let process = Process()
                running.value = process
                process.executableURL = executable
                process.arguments = arguments
                // The relo command runs with the owner's shell environment, not launchd's (no CLAUDE_CONFIG_DIR,
                // CODEX_HOME or shell PATH there), so setup finds the same agent folders a terminal does.
                process.environment = childEnvironment(base: ProcessInfo.processInfo.environment, login: loginEnvironment)
                let out = Pipe(), err = Pipe()
                process.standardOutput = out
                process.standardError = err
                process.standardInput = FileHandle.nullDevice
                do { try process.run() } catch { continuation.resume(throwing: error); return }
                // Both pipes drain before the exit is awaited, so a chatty command cannot fill one and hang.
                let errData = LockedBox<Data>(Data())
                let group = DispatchGroup()
                group.enter()
                DispatchQueue.global().async { errData.value = err.fileHandleForReading.readDataToEndOfFile(); group.leave() }
                let outData = out.fileHandleForReading.readDataToEndOfFile()
                group.wait()
                process.waitUntilExit()
                continuation.resume(returning: ProcessResult(
                    stdout: String(decoding: outData, as: UTF8.self),
                    stderr: String(decoding: errData.value, as: UTF8.self), status: process.terminationStatus))
            }
            }
        } onCancel: {
            // A command that was given up on (a timeout) ends, so it does not run on unseen.
            if let process = running.value, process.isRunning { process.terminate() }
        }
    }
}

private final class LockedBox<T>: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: T
    init(_ value: T) { stored = value }
    var value: T {
        get { lock.lock(); defer { lock.unlock() }; return stored }
        set { lock.lock(); defer { lock.unlock() }; stored = newValue }
    }
}
