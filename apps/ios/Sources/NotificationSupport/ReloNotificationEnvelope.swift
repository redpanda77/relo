import ReloCore
import Foundation

enum ReloNotificationPrivacy: Equatable {
    case standard
    case `private`
}

struct ReloNotificationEnvelope: Equatable {
    static let maximumAvatarBytes: Int64 = 2 * 1_024 * 1_024
    static let maximumAttachmentBytes: Int64 = 10 * 1_024 * 1_024

    let notificationID: String
    let receiptScope: ReceiptScope?
    let privacy: ReloNotificationPrivacy
    let sourceName: String?
    let conversationIdentifier: String?
    let avatarURL: URL?
    let imageURL: URL?

    var supportsCommunicationStyle: Bool {
        privacy == .standard && sourceName != nil && conversationIdentifier != nil
    }

    init?(userInfo: [AnyHashable: Any], requestIdentifier: String) {
        guard let payload = Self.payload(from: userInfo) else { return nil }
        notificationID = Self.identifier(payload["notificationId"] as? String)
            ?? Self.identifier(requestIdentifier)
            ?? "notification"
        privacy = payload["privacy"] as? String == "private" ? .private : .standard
        if let scope = payload["receiptScope"] as? [String: Any],
           let bytes = try? JSONSerialization.data(withJSONObject: scope) {
            receiptScope = try? JSONDecoder().decode(ReceiptScope.self, from: bytes)
        } else { receiptScope = nil }

        guard privacy == .standard else {
            sourceName = nil
            conversationIdentifier = nil
            avatarURL = nil
            imageURL = nil
            return
        }

        sourceName = Self.displayName(payload["sourceName"] as? String)
        let suppliedConversation = Self.identifier(payload["conversationId"] as? String)
            ?? Self.identifier(payload["serviceId"] as? String)
        conversationIdentifier = suppliedConversation
            ?? sourceName.map { "source-\(Self.stableSlug($0))" }
        avatarURL = (payload["avatarUrl"] as? String).flatMap(ReloPublicImageURLPolicy.validatedURL)
        imageURL = (payload["imageUrl"] as? String).flatMap(ReloPublicImageURLPolicy.validatedURL)
    }

    private static func payload(from userInfo: [AnyHashable: Any]) -> [String: Any]? {
        if let payload = userInfo["relo"] as? [String: Any] { return payload }
        if let body = userInfo["relo"] as? String,
           let data = body.data(using: .utf8),
           let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            return payload
        }
        return nil
    }

    private static func displayName(_ value: String?) -> String? {
        guard let value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard
            (1...80).contains(trimmed.count),
            trimmed.unicodeScalars.allSatisfy({ !CharacterSet.controlCharacters.contains($0) })
        else { return nil }
        return trimmed
    }

    private static func identifier(_ value: String?) -> String? {
        guard let value, (1...200).contains(value.count) else { return nil }
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "_-.:"))
        guard value.unicodeScalars.allSatisfy(allowed.contains) else { return nil }
        return value
    }

    static func isSafeReceiptIdentifier(_ value: String) -> Bool {
        guard (1...200).contains(value.count) else { return false }
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "_-"))
        return value.unicodeScalars.allSatisfy(allowed.contains)
    }

    private static func stableSlug(_ value: String) -> String {
        let allowed = CharacterSet.alphanumerics
        let scalars = value.lowercased().unicodeScalars.map { allowed.contains($0) ? Character(String($0)) : "-" }
        let collapsed = String(scalars).split(separator: "-").joined(separator: "-")
        return String((collapsed.isEmpty ? "relo" : collapsed).prefix(80))
    }

}

/// Public HTTPS images only; the rule itself lives in ReloCore's NotificationImagePolicy.
enum ReloPublicImageURLPolicy {
    static func validatedURL(_ value: String) -> URL? {
        NotificationImagePolicy.validatedURL(value)
    }

    static func validatedRedirect(_ request: URLRequest) -> URLRequest? {
        guard let url = request.url, validatedURL(url.absoluteString) != nil else { return nil }
        return request
    }
}

final class ReloPublicImageRedirectDelegate: NSObject, URLSessionTaskDelegate {
    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest
    ) async -> URLRequest? {
        ReloPublicImageURLPolicy.validatedRedirect(request)
    }
}

enum ReloNotificationMediaPolicy {
    static func fileExtension(response: URLResponse, sourceURL: URL) -> String? {
        switch response.mimeType?.lowercased() {
        case "image/jpeg", "image/jpg": return "jpg"
        case "image/png": return "png"
        case "image/gif": return "gif"
        default:
            let candidate = sourceURL.pathExtension.lowercased()
            return ["jpg", "jpeg", "png", "gif"].contains(candidate) ? candidate : nil
        }
    }

    static func accepts(response: URLResponse, fileSize: Int64, maximumBytes: Int64) -> Bool {
        guard
            let response = response as? HTTPURLResponse,
            (200..<300).contains(response.statusCode),
            fileSize > 0,
            fileSize <= maximumBytes
        else { return false }
        return response.expectedContentLength <= 0 || response.expectedContentLength <= maximumBytes
    }
}

enum ReloNotificationServiceOutcome: Equatable {
    case passthrough
    case privateContent
    case donationFailed
    case donationSucceeded
    case contentUpdateFailed
    case timeout
}

struct ReloNotificationPresentationMetadata: Equatable {
    let categoryIdentifier: String
    let threadIdentifier: String
    let badgeNumber: Int?

    func resolved(
        for outcome: ReloNotificationServiceOutcome,
        conversationIdentifier: String?
    ) -> ReloNotificationPresentationMetadata {
        guard
            outcome == .donationSucceeded,
            threadIdentifier.isEmpty,
            let conversationIdentifier
        else { return self }
        return ReloNotificationPresentationMetadata(
            categoryIdentifier: categoryIdentifier,
            threadIdentifier: conversationIdentifier,
            badgeNumber: badgeNumber
        )
    }
}

struct ReloNotificationServicePolicy {
    static func shouldAttemptDonation(for envelope: ReloNotificationEnvelope) -> Bool {
        envelope.supportsCommunicationStyle
    }

    static func usesCommunicationUpdate(for outcome: ReloNotificationServiceOutcome) -> Bool {
        outcome == .donationSucceeded
    }
}

struct ReloNotificationReceiptStore: Sendable {
    private let file: NotificationReceiptFile

    init(baseDirectory: URL, filename: String = "pending-notification-receipts.json", maximumStored: Int = 200) {
        file = NotificationReceiptFile(baseDirectory: baseDirectory, filename: filename, maximumStored: maximumStored)
    }
    @discardableResult
    func add(notificationID: String, lockWait: TimeInterval? = nil) throws -> ReceiptAppendResult {
        if let lockWait, !lockWait.isFinite || lockWait < 0 { return .notRecordedWithinBudget }
        return try file.append(id: notificationID, lockDeadline: lockWait.map { .now.advanced(by: .seconds($0)) })
    }
    @discardableResult
    func add(record: NotificationReceiptRecord, lockWait: TimeInterval) throws -> ReceiptAppendResult {
        guard lockWait.isFinite, lockWait >= 0 else { return .notRecordedWithinBudget }
        return try file.append(record: record, lockDeadline: .now.advanced(by: .seconds(lockWait)))
    }
    func pending(limit: Int) throws -> [String] { try file.pending(limit: limit) }
    func remove(notificationIDs: Set<String>) throws { try file.remove(ids: notificationIDs) }
}
