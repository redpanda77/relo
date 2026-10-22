import Foundation
import ReloCore

/// A computer's sign-in (`relo auth login`) read and decided by this phone: api/devices/self/sign-ins.
extension HTTPMobileAPIClient: ComputerSignInApproving {
    private struct RequestResponse: Decodable { let request: ReloComputerSignIn.Request }

    public func computerSignIn(credential: DeviceCredential, userCode: String) async throws -> ReloComputerSignIn.Request {
        var request = request(path: "api/devices/self/sign-ins/\(userCode)")
        request.authorize(bearer: credential.accessToken)
        let (data, response) = try await data(for: request)
        switch response.statusCode {
        case 200:
            guard let decoded = try? JSONDecoder().decode(RequestResponse.self, from: data),
                  decoded.request.userCode == userCode else { throw MobileAPIError.invalidResponse }
            return decoded.request
        case 404: throw ReloComputerSignIn.DecisionError.notFound
        default: throw Self.signInFailure(response.statusCode)
        }
    }

    public func decideComputerSignIn(credential: DeviceCredential, userCode: String, approve: Bool) async throws {
        var request = request(path: "api/devices/self/sign-ins/\(userCode)/\(approve ? "approve" : "deny")", method: "POST")
        request.authorize(bearer: credential.accessToken)
        let (data, response) = try await data(for: request)
        switch response.statusCode {
        case 200: return
        case 404: throw ReloComputerSignIn.DecisionError.notFound
        case 409: throw ReloComputerSignIn.DecisionError.alreadyDecided
        case 403 where String(data: data, encoding: .utf8)?.contains("device_pending") == true:
            throw ReloComputerSignIn.DecisionError.phonePending
        default: throw Self.signInFailure(response.statusCode)
        }
    }

    private static func signInFailure(_ status: Int) -> MobileAPIError {
        switch status {
        case 401: .reauthenticationRequired
        case 403: .forbidden
        default: .unavailable
        }
    }
}

/// Add a computer: a one-time command made as this device (`POST /api/devices/self/computer-invites`).
extension HTTPMobileAPIClient: ComputerInviting {
    private struct InviteBody: Encodable { let level: String; let approvals: Bool; let agents: [String]?; let macApp: Bool }

    public func inviteComputer(credential: DeviceCredential, level: String, approvals: Bool, agents: [String], macApp: Bool) async throws -> ReloComputerInvite {
        var request = request(path: "api/devices/self/computer-invites", method: "POST")
        request.authorize(bearer: credential.accessToken)
        request.httpBody = try JSONEncoder().encode(InviteBody(level: level, approvals: approvals, agents: agents.isEmpty ? nil : agents, macApp: macApp))
        let (data, response) = try await data(for: request)
        guard response.statusCode == 201 || response.statusCode == 200 else {
            throw response.statusCode == 404 ? MobileAPIError.unavailable : Self.signInFailure(response.statusCode)
        }
        guard let invite = try? JSONDecoder().decode(ReloComputerInvite.self, from: data) else { throw MobileAPIError.invalidResponse }
        return invite
    }
}

/// Following a code: its status, and this phone's Live Activity for it (`/api/devices/self/computer-invites/:inviteId`).
extension HTTPMobileAPIClient: ComputerInviteTracking {
    private struct ActivityBody: Encodable { let pushToken: String }

    public func inviteStatus(credential: DeviceCredential, inviteId: String) async throws -> ReloComputerInviteStatus? {
        var request = request(path: "api/devices/self/computer-invites/\(inviteId)")
        request.authorize(bearer: credential.accessToken)
        let (data, response) = try await data(for: request)
        switch response.statusCode {
        case 200:
            guard let status = try? JSONDecoder().decode(ReloComputerInviteStatus.self, from: data),
                  status.inviteId == inviteId else { throw MobileAPIError.invalidResponse }
            return status
        case 404: return nil
        default: throw Self.signInFailure(response.statusCode)
        }
    }

    public func registerSetupActivity(credential: DeviceCredential, inviteId: String, pushToken: String) async throws {
        var request = request(path: "api/devices/self/computer-invites/\(inviteId)/activity", method: "PUT")
        request.authorize(bearer: credential.accessToken)
        request.httpBody = try JSONEncoder().encode(ActivityBody(pushToken: pushToken))
        let (_, response) = try await data(for: request)
        guard response.statusCode == 204 || response.statusCode == 200 else { throw Self.signInFailure(response.statusCode) }
    }
}
