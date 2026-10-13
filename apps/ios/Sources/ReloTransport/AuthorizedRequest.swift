import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

extension URLRequest {
    /// Authenticates a request with a Relo account session or device credential token.
    mutating func authorize(bearer token: String) {
        setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    }

    /// A JSON request to a Relo server path, authenticated with a session or device token.
    static func relo(_ url: URL, bearer token: String) -> URLRequest {
        var request = URLRequest(url: url)
        request.authorize(bearer: token)
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        return request
    }
}
