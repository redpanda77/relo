import Foundation

/// The one decoder for Relo server JSON. Server timestamps carry milliseconds or microseconds;
/// `JSONDecoder.DateDecodingStrategy.iso8601` rejects fractional seconds before iOS 18, so every
/// server response decodes dates through this tolerant ISO 8601 parser instead.
public enum ReloWireJSON {
    public static func decoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let text = try container.decode(String.self)
            guard let date = date(from: text) else {
                throw DecodingError.dataCorruptedError(in: container, debugDescription: "Invalid ISO 8601 date")
            }
            return date
        }
        return decoder
    }

    /// Parses an ISO 8601 internet date with or without fractional seconds.
    public static func date(from text: String) -> Date? {
        if let date = try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(text) { return date }
        return try? Date.ISO8601FormatStyle().parse(text)
    }
}
