import ReloCore
import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public struct HTTPInboxDataSource: InboxDataSource {
    private let baseURL: URL
    private let token: String
    private let session: URLSession

    /// Opens end-to-end sealed items on this phone as they arrive; nil leaves placeholders.
    private let sealedOpener: ReloSealedOpener?
    /// Says why an item stayed sealed ("sealed for another device"), so it never shows a bare placeholder.
    private let sealedDiagnoser: ReloSealedDiagnoser?
    /// Puts real names back for opaque project and topic handles (E2.5) before decoding.
    private let nameResolver: (@Sendable (Data) -> Data)?

    public init(baseURL: URL, token: String, session: URLSession = ReloAPISession.shared, sealedOpener: ReloSealedOpener? = nil,
                nameResolver: (@Sendable (Data) -> Data)? = nil, sealedDiagnoser: ReloSealedDiagnoser? = nil) {
        self.baseURL = baseURL
        self.token = token
        self.session = session
        self.sealedOpener = sealedOpener
        self.sealedDiagnoser = sealedDiagnoser
        self.nameResolver = nameResolver
    }

    private func resolved(_ data: Data) -> Data { nameResolver?(data) ?? data }

    public func fetchSnapshot() async throws -> InboxRepairResponse {
        var request = URLRequest.relo(baseURL.appendingPathComponent("api/inbox/snapshot"), bearer: token)
        request.cachePolicy = .reloadIgnoringLocalCacheData
        let (data, http) = try await data(for: request)
        switch http.statusCode {
        case 200:
            do {
                guard data.count <= 4 * 1_024 * 1_024 else { throw InboxRemoteError.incompatibleResponse }
                let result = try ReloWireJSON.decoder().decode(InboxRepairResponse.self, from: resolved(data))
                guard result.isValid else { throw InboxRemoteError.incompatibleResponse }
                guard let sealedOpener else { return result }
                // Opening teaches names; a second pass shows them on this same snapshot.
                let opened = result.openingSealed(sealedOpener, diagnose: sealedDiagnoser)
                guard nameResolver != nil,
                      let named = try? ReloWireJSON.decoder().decode(InboxRepairResponse.self, from: resolved(data)) else { return opened }
                return named.openingSealed(sealedOpener, diagnose: sealedDiagnoser)
            } catch { throw InboxRemoteError.incompatibleResponse }
        case 401, 403: throw InboxRemoteError.unauthorized
        default: throw InboxRemoteError.unavailable
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

        let request = URLRequest.relo(components.url!, bearer: token)
        let (data, http) = try await data(for: request)
        switch http.statusCode {
        case 200:
            let decoder = ReloWireJSON.decoder()
            do {
                let page = try decoder.decode(InboxHistoryPage.self, from: resolved(data))
                guard InboxHistoryPagePolicy.isValid(page, requestedCursor: cursor) else {
                    throw InboxRemoteError.unavailable
                }
                guard let sealedOpener else { return page }
                // Opening envelopes teaches names; the second pass shows them on this same page.
                let opened = page.openingSealed(sealedOpener, diagnose: sealedDiagnoser)
                guard nameResolver != nil, let named = try? decoder.decode(InboxHistoryPage.self, from: resolved(data)) else { return opened }
                return named.openingSealed(sealedOpener, diagnose: sealedDiagnoser)
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


    public func markReadItems(_ notificationIDs: [String]) async throws -> ReadItemsResponse {
        guard (1...250).contains(notificationIDs.count) else { throw InboxRemoteError.incompatibleResponse }
        var request = URLRequest(url: baseURL.appendingPathComponent("api/inbox/read-items"))
        request.httpMethod = "POST"; request.timeoutInterval = 8
        request.authorize(bearer: token)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(["notificationIds": notificationIDs])
        let (data, http) = try await data(for: request)
        guard http.statusCode == 200 else {
            if [401, 403].contains(http.statusCode) { throw InboxRemoteError.unauthorized }
            if http.statusCode == 400 { throw InboxRemoteError.incompatibleResponse }
            throw InboxRemoteError.unavailable
        }
        do {
            guard data.count <= 1_048_576 else { throw InboxRemoteError.incompatibleResponse }
            let result = try JSONDecoder().decode(ReadItemsResponse.self, from: data)
            guard result.isValid(for: notificationIDs) else { throw InboxRemoteError.incompatibleResponse }
            return result
        } catch { throw InboxRemoteError.incompatibleResponse }
    }


    public func fetchActiveLiveActivities() async throws -> ActiveLiveActivityIdentityPage {
        let request = URLRequest.relo(baseURL.appendingPathComponent("api/inbox/live-activities/active"), bearer: token)
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
        request.authorize(bearer: token)
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        let (data, http) = try await data(for: request)
        guard http.statusCode == 200 else {
            if [401, 403].contains(http.statusCode) { throw InboxRemoteError.unauthorized }
            throw InboxRemoteError.unavailable
        }
        let detail: InboxNotificationDetail
        do { detail = try Self.decoder().decode(InboxNotificationDetail.self, from: resolved(data)) }
        catch { throw InboxRemoteError.incompatibleResponse }
        guard let sealedOpener else { return detail }
        let opened = detail.openingSealed(sealedOpener, diagnose: sealedDiagnoser)
        guard nameResolver != nil, let named = try? Self.decoder().decode(InboxNotificationDetail.self, from: resolved(data)) else { return opened }
        return named.openingSealed(sealedOpener, diagnose: sealedDiagnoser)
    }


    private static func decoder() -> JSONDecoder {
        let decoder = ReloWireJSON.decoder()
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
            throw InboxRemoteError.serverUnreachable
        } catch {
            throw InboxRemoteError.unavailable
        }
    }
}
