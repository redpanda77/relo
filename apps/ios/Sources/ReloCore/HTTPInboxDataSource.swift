import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public struct HTTPInboxDataSource: InboxRemoteDataSource, InboxHistoryRemoteDataSource, Sendable {
    private let baseURL: URL
    private let token: String
    private let session: URLSession

    public init(baseURL: URL, token: String, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.token = token
        self.session = session
    }

    public func fetchPage(after cursor: String?) async throws -> InboxPage {
        var components = URLComponents(
            url: baseURL.appendingPathComponent("api/inbox"),
            resolvingAgainstBaseURL: false
        )!
        components.queryItems = [URLQueryItem(name: "limit", value: "50")]
        if let cursor {
            components.queryItems?.append(URLQueryItem(name: "after", value: cursor))
        }

        var request = URLRequest(url: components.url!)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")

        let (data, http) = try await data(for: request)
        switch http.statusCode {
        case 200:
            let decoder = JSONDecoder()
            decoder.dateDecodingStrategy = .iso8601
            do {
                return try decoder.decode(InboxPage.self, from: data)
            } catch {
                throw InboxRemoteError.incompatibleResponse
            }
        case 401, 403:
            throw InboxRemoteError.unauthorized
        case 409, 410:
            throw InboxRemoteError.cursorExpired
        default:
            throw InboxRemoteError.unavailable
        }
    }

    public func fetchHistoryPage(before cursor: String?) async throws -> InboxHistoryPage {
        var components = URLComponents(
            url: baseURL.appendingPathComponent("api/inbox/history"),
            resolvingAgainstBaseURL: false
        )!
        components.queryItems = [URLQueryItem(name: "limit", value: "100")]
        if let cursor {
            components.queryItems?.append(URLQueryItem(name: "before", value: cursor))
        }

        var request = URLRequest(url: components.url!)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")

        let (data, http) = try await data(for: request)
        switch http.statusCode {
        case 200:
            let decoder = JSONDecoder()
            decoder.dateDecodingStrategy = .iso8601
            do {
                let page = try decoder.decode(InboxHistoryPage.self, from: data)
                guard InboxHistoryPagePolicy.isValid(page, requestedCursor: cursor) else {
                    throw InboxRemoteError.unavailable
                }
                return page
            } catch let error as InboxRemoteError {
                throw error
            } catch {
                throw InboxRemoteError.incompatibleResponse
            }
        case 401, 403:
            throw InboxRemoteError.unauthorized
        case 409, 410:
            throw InboxRemoteError.cursorExpired
        default:
            throw InboxRemoteError.unavailable
        }
    }

    public func markRead(notificationID: String) async throws -> InboxReadMutationResponse {
        try await readMutation(["notificationId": notificationID])
    }

    public func markAllRead(watermark: String) async throws -> InboxReadMutationResponse {
        try await readMutation(["watermark": watermark])
    }

    public func fetchActiveLiveActivities() async throws -> ActiveLiveActivityIdentityPage {
        var request = URLRequest(url: baseURL.appendingPathComponent("api/inbox/live-activities/active"))
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        let (data, http) = try await data(for: request)
        guard http.statusCode == 200 else {
            if [401, 403].contains(http.statusCode) { throw InboxRemoteError.unauthorized }
            throw InboxRemoteError.unavailable
        }
        do { return try Self.decoder().decode(ActiveLiveActivityIdentityPage.self, from: data) }
        catch { throw InboxRemoteError.incompatibleResponse }
    }

    public func fetchDetail(notificationID: String) async throws -> InboxNotificationDetail {
        var request = URLRequest(
            url: baseURL.appendingPathComponent("api/inbox/\(notificationID)")
        )
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        let (data, http) = try await data(for: request)
        guard http.statusCode == 200 else {
            if [401, 403].contains(http.statusCode) { throw InboxRemoteError.unauthorized }
            throw InboxRemoteError.unavailable
        }
        do { return try Self.decoder().decode(InboxNotificationDetail.self, from: data) }
        catch { throw InboxRemoteError.incompatibleResponse }
    }

    private func readMutation(_ body: [String: String]) async throws -> InboxReadMutationResponse {
        var request = URLRequest(url: baseURL.appendingPathComponent("api/inbox/read"))
        request.httpMethod = "POST"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(body)
        let (data, http) = try await data(for: request)
        guard http.statusCode == 200 else {
            if [401, 403].contains(http.statusCode) { throw InboxRemoteError.unauthorized }
            throw InboxRemoteError.unavailable
        }
        do { return try Self.decoder().decode(InboxReadMutationResponse.self, from: data) }
        catch { throw InboxRemoteError.incompatibleResponse }
    }

    private static func decoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }

    private func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse else {
                throw InboxRemoteError.unavailable
            }
            return (data, http)
        } catch let error as InboxRemoteError {
            throw error
        } catch let error as URLError where [
            URLError.cannotFindHost,
            .dnsLookupFailed,
            .notConnectedToInternet,
            .networkConnectionLost,
        ].contains(error.code) {
            throw InboxRemoteError.tailnetUnavailable
        } catch {
            throw InboxRemoteError.unavailable
        }
    }
}
