import Darwin
import Foundation

enum ReloNotificationPrivacy: Equatable {
    case standard
    case `private`
}

struct ReloNotificationEnvelope: Equatable {
    static let maximumAvatarBytes: Int64 = 2 * 1_024 * 1_024
    static let maximumAttachmentBytes: Int64 = 10 * 1_024 * 1_024

    let notificationID: String
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

enum ReloPublicImageURLPolicy {
    static func validatedURL(_ value: String) -> URL? {
        guard
            let url = URL(string: value),
            url.absoluteString.utf8.count <= 2_048,
            url.scheme?.lowercased() == "https",
            url.user == nil,
            url.password == nil,
            let host = url.host,
            isPublicHost(host)
        else { return nil }
        return url
    }

    static func validatedRedirect(_ request: URLRequest) -> URLRequest? {
        guard let url = request.url, validatedURL(url.absoluteString) != nil else { return nil }
        return request
    }

    private static func isPublicHost(_ value: String) -> Bool {
        let host = value.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
        guard
            !host.isEmpty,
            !host.hasSuffix("."),
            (host.contains(".") || host.contains(":")),
            host != "localhost",
            !host.hasSuffix(".localhost"),
            !host.hasSuffix(".local"),
            !host.hasSuffix(".internal"),
            !host.hasSuffix(".home"),
            !host.hasSuffix(".lan")
        else { return false }

        if let address = parsedIPv4(host) {
            let canonical = address.map(String.init).joined(separator: ".")
            guard host == canonical else { return false }
            return isPublicIPv4(address)
        }

        guard host.contains(":") else { return true }
        var address = in6_addr()
        guard inet_pton(AF_INET6, host, &address) == 1 else { return false }
        let bytes = withUnsafeBytes(of: &address) { Array($0) }
        let isIPv4Mapped = bytes.prefix(10).allSatisfy { $0 == 0 }
            && bytes[10] == 0xff && bytes[11] == 0xff
        let isIPv4Compatible = bytes.prefix(12).allSatisfy { $0 == 0 }
        return !(
            bytes.allSatisfy { $0 == 0 }
                || bytes == Array(repeating: 0, count: 15) + [1]
                || (bytes[0] & 0xfe) == 0xfc
                || (bytes[0] == 0xfe && (bytes[1] & 0xc0) == 0x80)
                || bytes[0] == 0xff
                || Array(bytes.prefix(4)) == [0x20, 0x01, 0x0d, 0xb8]
                || isIPv4Mapped
                || isIPv4Compatible
        )
    }

    private static func parsedIPv4(_ host: String) -> [UInt8]? {
        let components = host.split(separator: ".", omittingEmptySubsequences: false)
        guard (1...4).contains(components.count) else { return nil }
        var values: [UInt64] = []
        for component in components {
            let text = String(component).lowercased()
            let radix: Int
            let digits: Substring
            if text.hasPrefix("0x") {
                radix = 16
                digits = text.dropFirst(2)
            } else if text.count > 1 && text.hasPrefix("0") {
                radix = 8
                digits = text.dropFirst()
            } else {
                radix = 10
                digits = Substring(text)
            }
            guard !digits.isEmpty, let value = UInt64(digits, radix: radix) else { return nil }
            values.append(value)
        }
        let packed: UInt64
        switch values.count {
        case 1 where values[0] <= 0xffff_ffff: packed = values[0]
        case 2 where values[0] <= 0xff && values[1] <= 0xff_ffff:
            packed = (values[0] << 24) | values[1]
        case 3 where values[0] <= 0xff && values[1] <= 0xff && values[2] <= 0xffff:
            packed = (values[0] << 24) | (values[1] << 16) | values[2]
        case 4 where values.allSatisfy({ $0 <= 0xff }):
            packed = (values[0] << 24) | (values[1] << 16) | (values[2] << 8) | values[3]
        default: return nil
        }
        return [24, 16, 8, 0].map { UInt8((packed >> UInt64($0)) & 0xff) }
    }

    private static func isPublicIPv4(_ address: [UInt8]) -> Bool {
        let first = Int(address[0])
        let second = Int(address[1])
        let third = Int(address[2])
        return !(
            first == 0 || first == 10 || first == 127
                || (first == 169 && second == 254)
                || (first == 172 && (16...31).contains(second))
                || (first == 192 && second == 168)
                || (first == 100 && (64...127).contains(second))
                || (first == 192 && second == 0)
                || (first == 198 && (second == 18 || second == 19))
                || (first == 198 && second == 51 && third == 100)
                || (first == 203 && second == 0 && third == 113)
                || first >= 224
        )
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

struct ReloNotificationReceiptStore: @unchecked Sendable {
    private struct StorageEnvelope: Codable {
        let schemaVersion: Int
        let payload: [String]
    }

    private let fileURL: URL
    private let lockURL: URL
    private let maximumStored: Int

    init(
        baseDirectory: URL,
        filename: String = "pending-notification-receipts.json",
        maximumStored: Int = 200
    ) {
        fileURL = baseDirectory.appendingPathComponent(filename)
        lockURL = baseDirectory.appendingPathComponent("\(filename).lock")
        self.maximumStored = maximumStored
        try? FileManager.default.createDirectory(at: baseDirectory, withIntermediateDirectories: true)
    }

    func add(notificationID: String) {
        guard ReloNotificationEnvelope.isSafeReceiptIdentifier(notificationID) else { return }
        withExclusiveLock {
            var identifiers = readUnlocked()
            identifiers.removeAll { $0 == notificationID }
            identifiers.append(notificationID)
            writeUnlocked(Array(identifiers.suffix(maximumStored)))
        }
    }

    func pending(limit: Int) -> [String] {
        guard limit > 0 else { return [] }
        return withExclusiveLock(fallback: []) {
            var seen = Set<String>()
            return Array(readUnlocked().filter {
                ReloNotificationEnvelope.isSafeReceiptIdentifier($0) && seen.insert($0).inserted
            }.prefix(limit))
        }
    }

    func remove(notificationIDs: Set<String>) {
        guard !notificationIDs.isEmpty else { return }
        withExclusiveLock {
            writeUnlocked(Array(readUnlocked().filter { !notificationIDs.contains($0) }.suffix(maximumStored)))
        }
    }

    private func readUnlocked() -> [String] {
        guard let data = try? Data(contentsOf: fileURL) else { return [] }
        if let envelope = try? JSONDecoder().decode(StorageEnvelope.self, from: data),
           envelope.schemaVersion == 1 {
            return envelope.payload
        }
        return []
    }

    private func writeUnlocked(_ identifiers: [String]) {
        guard let data = try? JSONEncoder().encode(StorageEnvelope(schemaVersion: 1, payload: identifiers)) else {
            return
        }
        try? data.write(to: fileURL, options: .atomic)
    }

    private func withExclusiveLock<T>(fallback: T, _ body: () -> T) -> T {
        let descriptor = Darwin.open(lockURL.path, O_CREAT | O_RDWR, S_IRUSR | S_IWUSR)
        guard descriptor >= 0 else { return fallback }
        defer { Darwin.close(descriptor) }
        guard flock(descriptor, LOCK_EX) == 0 else { return fallback }
        defer { flock(descriptor, LOCK_UN) }
        return body()
    }

    private func withExclusiveLock(_ body: () -> Void) {
        withExclusiveLock(fallback: (), body)
    }
}
