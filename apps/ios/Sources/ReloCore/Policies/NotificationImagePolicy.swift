import Foundation
import Darwin

public enum NotificationImagePolicy {
    public static func validatedURL(_ url: URL) -> URL? {
        guard
            url.absoluteString.utf8.count <= 2_048,
            url.scheme?.lowercased() == "https",
            url.user == nil,
            url.password == nil,
            let host = url.host,
            isPublicHost(host)
        else { return nil }
        return url
    }

    public static func validatedURL(_ value: String) -> URL? {
        URL(string: value).flatMap(validatedURL)
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
        case 1 where values[0] <= 0xffff_ffff:
            packed = values[0]
        case 2 where values[0] <= 0xff && values[1] <= 0xff_ffff:
            packed = (values[0] << 24) | values[1]
        case 3 where values[0] <= 0xff && values[1] <= 0xff && values[2] <= 0xffff:
            packed = (values[0] << 24) | (values[1] << 16) | values[2]
        case 4 where values.allSatisfy({ $0 <= 0xff }):
            packed = (values[0] << 24) | (values[1] << 16) | (values[2] << 8) | values[3]
        default:
            return nil
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
