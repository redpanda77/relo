import Foundation
import ReloCore

/// Reads `GET api/now?since=` (device bearer). Display only: the summary is the server's derivation.
public struct HTTPNowSource: NowSource {
    private let baseURL: URL
    private let token: String
    private let session: URLSession
    /// Puts real names back for opaque project and topic handles (E2.5) before decoding.
    private let nameResolver: (@Sendable (Data) -> Data)?

    public init(baseURL: URL, token: String, session: URLSession = ReloAPISession.shared,
                nameResolver: (@Sendable (Data) -> Data)? = nil) {
        self.baseURL = baseURL; self.token = token; self.session = session; self.nameResolver = nameResolver
    }

    public func fetchNow(since: Date?) async throws -> NowSummary {
        try decode(try await fetchNowData(since: since))
    }

    /// The summary exactly as the server sent it (sealed text still sealed, handles unresolved), for a
    /// cache that must never hold plaintext. Decode it with `decode(_:)`.
    public func fetchNowData(since: Date?) async throws -> Data {
        try Task.checkCancellation()
        let request = try request(since: since)
        let data: Data
        let response: URLResponse
        do { (data, response) = try await session.data(for: request) }
        catch { throw mapped(error) }
        guard let http = response as? HTTPURLResponse else { throw InboxRemoteError.incompatibleResponse }
        switch http.statusCode {
        case 200: break
        case 401, 403: throw InboxRemoteError.unauthorized
        default: throw InboxRemoteError.unavailable
        }
        guard data.count <= 2_097_152 else { throw InboxRemoteError.incompatibleResponse }
        _ = try decode(data)
        return data
    }

    /// Decodes a summary the server sent, with known names put back for opaque handles.
    public func decode(_ data: Data) throws -> NowSummary {
        let resolved = nameResolver?(data) ?? data
        do { return try ReloWireJSON.decoder().decode(NowSummary.self, from: resolved) }
        catch { throw InboxRemoteError.incompatibleResponse }
    }

    func request(since: Date?) throws -> URLRequest {
        guard var url = URLComponents(url: baseURL.appendingPathComponent("api/now"), resolvingAgainstBaseURL: false),
              ["https", "http"].contains(url.scheme?.lowercased() ?? ""), url.host != nil,
              url.user == nil, url.password == nil else { throw CurrentStateQueryError.invalidQuery }
        if let since {
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            url.queryItems = [URLQueryItem(name: "since", value: formatter.string(from: since))]
        }
        url.fragment = nil
        guard let address = url.url else { throw CurrentStateQueryError.invalidQuery }
        var request = URLRequest(url: address, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 10)
        request.authorize(bearer: token)
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        return request
    }

    private func mapped(_ error: Error) -> Error {
        if Task.isCancelled || (error as? URLError)?.code == .cancelled { return CancellationError() }
        if let network = error as? URLError,
           [.cannotFindHost, .dnsLookupFailed, .notConnectedToInternet, .networkConnectionLost, .cannotConnectToHost].contains(network.code) {
            return InboxRemoteError.serverUnreachable
        }
        if error is URLError { return InboxRemoteError.unavailable }
        return error
    }
}
