import Foundation
import ReloCore

/// New devices approved on this trusted phone (docs/END-TO-END-ENCRYPTION.md, "New devices are
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
