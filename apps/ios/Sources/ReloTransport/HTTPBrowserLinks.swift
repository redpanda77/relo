import Foundation
import ReloCore

/// Linked browsers (docs/END-TO-END-ENCRYPTION.md, "Linked browsers"), authenticated as this device.
extension HTTPMobileAPIClient: BrowserLinking {
    private struct LinkedBrowsersResponse: Decodable { let browsers: [ReloLinkedBrowser] }

    public func linkBrowser(credential: DeviceCredential, request link: ReloBrowserLinkRequest) async throws -> ReloLinkedBrowser {
        var request = request(path: "api/devices/self/links", method: "POST")
        request.authorize(bearer: credential.accessToken)
        request.httpBody = try JSONEncoder().encode(link)
        let (data, response) = try await data(for: request)
        switch response.statusCode {
        case 200, 201:
            guard let browser = try? JSONDecoder().decode(ReloLinkedBrowser.self, from: data),
                  browser.browserId == link.browserId else { throw MobileAPIError.invalidResponse }
            return browser
        case 404: throw BrowserLinkError.unknownBrowser
        case 409: throw BrowserLinkError.identityMismatch
        default: throw Self.linkFailure(response.statusCode)
        }
    }

    public func linkedBrowsers(credential: DeviceCredential) async throws -> [ReloLinkedBrowser] {
        var request = request(path: "api/devices/self/links")
        request.authorize(bearer: credential.accessToken)
        let (data, response) = try await data(for: request)
        guard response.statusCode == 200 else { throw Self.linkFailure(response.statusCode) }
        guard let decoded = try? JSONDecoder().decode(LinkedBrowsersResponse.self, from: data) else {
            throw MobileAPIError.invalidResponse
        }
        return decoded.browsers
    }

    public func unlinkBrowser(credential: DeviceCredential, browserID: String) async throws {
        guard ReloBrowserLink.isBrowserID(browserID) else { throw MobileAPIError.invalidRequest }
        var request = request(path: "api/devices/self/links/\(browserID)", method: "DELETE")
        request.authorize(bearer: credential.accessToken)
        let (_, response) = try await data(for: request)
        switch response.statusCode {
        case 200, 204, 404: return // Already gone is unlinked.
        default: throw Self.linkFailure(response.statusCode)
        }
    }

    private static func linkFailure(_ status: Int) -> MobileAPIError {
        switch status {
        case 401: .reauthenticationRequired
        case 403: .forbidden
        default: .unavailable
        }
    }
}
