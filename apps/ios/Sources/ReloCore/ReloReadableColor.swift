import Foundation

/// Resolves a colored foreground against its actual solid host background.
public struct ReloReadableColor: Equatable, Sendable {
    public let red: Double
    public let green: Double
    public let blue: Double
    public init(red: Double, green: Double, blue: Double) { self.red = red; self.green = green; self.blue = blue }
    public init?(hex: String) {
        guard hex.count == 7, hex.first == "#", let rgb = UInt32(hex.dropFirst(), radix: 16) else { return nil }
        self.init(red: Double((rgb >> 16) & 255) / 255, green: Double((rgb >> 8) & 255) / 255, blue: Double(rgb & 255) / 255)
    }
    public var luminance: Double {
        func linear(_ c: Double) -> Double { c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4) }
        return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue)
    }
    public func contrast(with background: Self) -> Double {
        (max(luminance, background.luminance) + 0.05) / (min(luminance, background.luminance) + 0.05)
    }
    public func readable(onLight: Bool) -> Self {
        let background = Self(red: onLight ? 1 : 0, green: onLight ? 1 : 0, blue: onLight ? 1 : 0)
        var color = self
        for _ in 0..<100 {
            if color.contrast(with: background) >= 4.5 { break }
            let target = onLight ? 0.0 : 1.0
            color = Self(red: color.red + (target - color.red) * 0.05,
                         green: color.green + (target - color.green) * 0.05,
                         blue: color.blue + (target - color.blue) * 0.05)
        }
        return color
    }
}
