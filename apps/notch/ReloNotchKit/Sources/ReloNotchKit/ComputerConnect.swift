import Foundation

/// Server mode: connects this Mac's relo command to the server the app is signed in to, so agents set up here can report.
/// The app makes a one-time computer invite with its own device credential (the request the iPhone's Connect a computer
/// makes) and the bundled CLI redeems it (`relo auth join`). Request building and parsing are static and tested; no
/// network runs in tests.
extension LocalServer {
    /// What the invite carries: no agents are set up here (each harness is set up from Settings once connected).
    struct InviteBody: Encodable { let level: String; let approvals: Bool }

    /// `POST {origin}/api/devices/self/computer-invites` with the device credential. The body is the server's
    /// `createInviteSchema` (strict): level, approvals, optional agents, desktopApp. No `agents` and no `desktopApp`.
    /// No bind half is sent: it would only matter to the issuing device checking the computer's key, which the
    /// owner's iPhone does when it approves this Mac.
    public static func computerInviteRequest(origin: URL, bearer: String) -> URLRequest {
        var request = URLRequest(url: origin.appendingPathComponent("api/devices/self/computer-invites"))
        request.httpMethod = "POST"
        request.timeoutInterval = 15
        request.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONEncoder().encode(InviteBody(level: "guide", approvals: false))
        return request
    }

    /// The one-time code (`rci_` plus 32 characters) from the server's 200 or 201 answer; a plain-words failure otherwise.
    public static func parseComputerInvite(status: Int, data: Data) -> Result<String, Failure> {
        switch status {
        case 200, 201:
            if let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let code = object["code"] as? String, isInviteCode(code) { return .success(code) }
            return .failure(Failure("The server's answer was not what Relo expected."))
        case 401: return .failure(Failure("Sign in to Relo again, then connect your agents."))
        case 403: return .failure(Failure("This Mac is not approved to connect agents yet. Approve it on your iPhone first."))
        case 404: return .failure(Failure("This server cannot connect a computer from the app. Use Add a computer in its Dashboard."))
        default: return .failure(Failure("The server could not make the connection code (\(status)). Try again."))
        }
    }

    static func isInviteCode(_ code: String) -> Bool {
        guard code.hasPrefix("rci_"), code.count == 36 else { return false }
        return code.dropFirst(4).allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "_" || $0 == "-") }
    }

    /// A CLI profile name from a host: letters, digits, "-" and "_", at most 40, starting with a letter or digit.
    public static func profileName(forHost host: String) -> String {
        var name = String(host.map { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") ? $0 : "-" })
        while name.hasPrefix("-") || name.hasPrefix("_") { name.removeFirst() }
        name = String(name.prefix(40))
        return name.isEmpty ? "server" : name
    }

    /// `relo auth join CODE --api-url ORIGIN --profile HOST --client-name NAME --no-setup --json`.
    public static func connectArguments(code: String, origin: URL, clientName: String) -> [String] {
        ["auth", "join", code, "--api-url", origin.absoluteString, "--profile", profileName(forHost: origin.host() ?? ""),
         "--client-name", String(clientName.trimmingCharacters(in: .whitespacesAndNewlines).prefix(80)), "--no-setup", "--json"]
    }

    /// What the join said, in plain words: connected (with the one step left to the owner), or why not.
    public static func connectOutcome(status: Int32, stdout: String, stderr: String) -> Result<String, Failure> {
        guard status == 0, firstString("clientName", inJSONLines: stdout) != nil || stdout.contains("\"saved\"") else {
            let said = (firstString("error", inJSONLines: stdout) ?? firstString("message", inJSONLines: stdout)
                ?? stderr.split(whereSeparator: \.isNewline).first.map(String.init) ?? "").lowercased()
            if said.contains("invalid") || said.contains("expired") || said.contains("code") {
                return .failure(Failure("The connection code did not work. Try Connect agents again."))
            }
            if said.contains("name") && said.contains("taken") {
                return .failure(Failure("This Mac's name is already in use on your account. Rename it in Settings, then try again."))
            }
            return .failure(Failure("Relo could not connect this Mac's agents. Try again."))
        }
        return .success("Connected. If Relo asks on your iPhone, approve this Mac there to finish.")
    }

    /// Writes the launcher, makes the invite as this device and redeems it with the bundled CLI. The caller refreshes.
    /// `send` is the network call (injected so tests and previews never reach a server).
    public func connectAgents(
        origin: URL, bearer: String, clientName: String,
        send: @Sendable (URLRequest) async throws -> (Data, Int) = { request in
            let (data, response) = try await URLSession.shared.data(for: request)
            return (data, (response as? HTTPURLResponse)?.statusCode ?? 0)
        }
    ) async throws -> String {
        _ = try installLauncher()
        let (data, status): (Data, Int)
        do { (data, status) = try await send(Self.computerInviteRequest(origin: origin, bearer: bearer)) }
        catch { throw Failure("Relo could not reach \(origin.host() ?? "the server"). Check the connection and try again.") }
        let code = try Self.parseComputerInvite(status: status, data: data).get()
        let result = try await relo(Self.connectArguments(code: code, origin: origin, clientName: clientName))
        return try Self.connectOutcome(status: result.status, stdout: result.stdout, stderr: result.stderr).get()
    }
}
