import Foundation
import ReloCore

/// New devices approved on this trusted phone (docs/ENCRYPTION-PROTOCOL.md, "New devices are
/// approved on a trusted phone"), authenticated as this device.
extension HTTPMobileAPIClient: DeviceApproving {
    private struct PendingDevicesResponse: Decodable { let devices: [ReloPendingDevice] }

    public func pendingDevices(credential: DeviceCredential) async throws -> [ReloPendingDevice] {
        var request = request(path: "api/devices/self/pending-devices")
        request.authorize(bearer: credential.accessToken)
        let (data, response) = try await data(for: request)
        // A server from before device approvals has no such route: nothing is pending.
        if response.statusCode == 404 { return [] }
        guard response.statusCode == 200 else { throw Self.approvalFailure(response.statusCode) }
        guard let decoded = try? JSONDecoder().decode(PendingDevicesResponse.self, from: data) else {
            throw MobileAPIError.invalidResponse
        }
        // The server never lists the calling phone; guard anyway so this phone never approves itself.
        return decoded.devices.filter { $0.deviceId != credential.deviceId }
    }

    public func approveDevice(credential: DeviceCredential, request approval: ReloDeviceApprovalRequest) async throws {
        var request = request(path: "api/devices/self/approvals", method: "POST")
        request.authorize(bearer: credential.accessToken)
        request.httpBody = try JSONEncoder().encode(approval)
        let (_, response) = try await data(for: request)
        switch response.statusCode {
        case 200, 201, 204: return
        case 404: throw DeviceApprovalError.unknownDevice
        case 409: throw DeviceApprovalError.identityMismatch
        default: throw Self.approvalFailure(response.statusCode)
        }
    }

    public func declineDevice(credential: DeviceCredential, deviceID: String) async throws {
        guard ReloDeviceApproval.isDeviceID(deviceID) else { throw MobileAPIError.invalidRequest }
        var request = request(path: "api/devices/self/approvals/\(deviceID)/decline", method: "POST")
        request.authorize(bearer: credential.accessToken)
        let (_, response) = try await data(for: request)
        switch response.statusCode {
        case 200, 204, 404: return // Already gone is declined.
        default: throw Self.approvalFailure(response.statusCode)
        }
    }

    static func approvalFailure(_ status: Int) -> MobileAPIError {
        switch status {
        case 401: .reauthenticationRequired
        case 403: .forbidden
        default: .unavailable
        }
    }
}

/// The account's phones for the Devices screen, authenticated as this device.
extension HTTPMobileAPIClient: AccountDeviceListing {
    private struct AccountPhonesResponse: Decodable { let devices: [ReloAccountPhone] }

    public func accountPhones(credential: DeviceCredential) async throws -> [ReloAccountPhone]? {
        var request = request(path: "api/devices/self/devices")
        request.authorize(bearer: credential.accessToken)
        let (data, response) = try await data(for: request)
        // A server from before the Devices screen has no such route: the screen shows what it knows.
        if response.statusCode == 404 { return nil }
        guard response.statusCode == 200 else { throw Self.approvalFailure(response.statusCode) }
        guard let decoded = try? JSONDecoder().decode(AccountPhonesResponse.self, from: data) else {
            throw MobileAPIError.invalidResponse
        }
        return decoded.devices
    }
}

/// Computers approved once, on any trusted device (docs/ENCRYPTION-PROTOCOL.md), authenticated as this device.
extension HTTPMobileAPIClient: ComputerApproving {
    private struct ApproversResponse: Decodable { let approvers: [ReloApprover] }

    public func approvers(credential: DeviceCredential) async throws -> [ReloApprover] {
        var request = request(path: "api/devices/self/approvers")
        request.authorize(bearer: credential.accessToken)
        let (data, response) = try await data(for: request)
        // A server from before computer approvals: no approver is listed, and nothing changes.
        if response.statusCode == 404 { return [] }
        guard response.statusCode == 200 else { throw Self.approvalFailure(response.statusCode) }
        guard let decoded = try? JSONDecoder().decode(ApproversResponse.self, from: data) else { throw MobileAPIError.invalidResponse }
        return decoded.approvers
    }

    public func revokeComputer(credential: DeviceCredential, clientID: String) async throws {
        guard clientID.hasPrefix("key_"), clientID.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "_" || $0 == "-" }) else {
            throw MobileAPIError.invalidRequest
        }
        var request = request(path: "api/devices/self/computers/\(clientID)/revoke", method: "POST")
        request.authorize(bearer: credential.accessToken)
        let (_, response) = try await data(for: request)
        switch response.statusCode {
        case 200, 204, 404: return // Already signed out is signed out.
        default: throw Self.approvalFailure(response.statusCode)
        }
    }

    public func approveComputer(credential: DeviceCredential, request approval: ReloComputerApprovalRequest) async throws {
        var request = request(path: "api/devices/self/computer-approvals", method: "POST")
        request.authorize(bearer: credential.accessToken)
        request.httpBody = try JSONEncoder().encode(approval)
        let (_, response) = try await data(for: request)
        switch response.statusCode {
        case 200, 201, 204: return
        case 404: throw DeviceApprovalError.unknownDevice
        case 409: throw DeviceApprovalError.identityMismatch
        default: throw Self.approvalFailure(response.statusCode)
        }
    }
}
