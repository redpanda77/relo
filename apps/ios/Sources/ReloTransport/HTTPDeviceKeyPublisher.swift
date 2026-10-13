import Foundation
import ReloCore

/// End-to-end encryption key directory upload (docs/END-TO-END-ENCRYPTION.md, E2.1).
extension HTTPMobileAPIClient: DeviceKeyPublishing {
    public func publishDeviceKeys(credential: DeviceCredential, keys: ReloPublishedDeviceKeys) async throws {
        var request = request(path: "api/devices/self/keys", method: "PUT")
        request.authorize(bearer: credential.accessToken)
        request.httpBody = try JSONEncoder().encode(keys)
        let (_, response) = try await data(for: request)
        switch response.statusCode {
        case 200:
            return
        case 401:
            throw MobileAPIError.reauthenticationRequired
        case 403:
            throw MobileAPIError.forbidden
        default:
            throw MobileAPIError.unavailable
        }
    }
}

extension HTTPMobileAPIClient: ClientKeyDirectory {
    private struct ClientKeysResponse: Decodable { let clients: [ReloClientKey] }

    public func clientKeys(credential: DeviceCredential) async throws -> [ReloClientKey] {
        var request = request(path: "api/clients/keys")
        request.authorize(bearer: credential.accessToken)
        let (data, response) = try await data(for: request)
        switch response.statusCode {
        case 200:
            return try JSONDecoder().decode(ClientKeysResponse.self, from: data).clients
        case 401:
            throw MobileAPIError.reauthenticationRequired
        case 403:
            throw MobileAPIError.forbidden
        default:
            throw MobileAPIError.unavailable
        }
    }
}
