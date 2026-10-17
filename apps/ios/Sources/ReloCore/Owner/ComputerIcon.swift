import Foundation

/// The icon of a computer (ADR 0011), chosen by the owner or guessed by the CLI, one enum declared once in
/// the contracts (`COMPUTER_ICONS`). A value this build does not know yet reads as a laptop, so a new icon
/// on the server never breaks the screen that shows it.
public enum ComputerIcon: String, Codable, CaseIterable, Equatable, Hashable, Sendable {
    case laptop, desktop, server, cloud, terminal, build

    public init(from decoder: any Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = ComputerIcon(rawValue: raw) ?? .laptop
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }

    /// The SF Symbol drawn for it.
    public var systemImageName: String {
        switch self {
        case .laptop: "laptopcomputer"
        case .desktop: "desktopcomputer"
        case .server: "server.rack"
        case .cloud: "cloud.fill"
        case .terminal: "terminal.fill"
        case .build: "hammer.fill"
        }
    }

    /// The name VoiceOver reads.
    public var label: String {
        switch self {
        case .laptop: "Laptop"
        case .desktop: "Desktop"
        case .server: "Server"
        case .cloud: "Cloud"
        case .terminal: "Terminal"
        case .build: "Build machine"
        }
    }
}
