import Testing
@testable import ReloCore

struct ReloThemeContrastTests {
    @Test(arguments: ["#5ED8B7", "#FF8A2A", "#FF453A", "#4073FF", "#000000", "#FFFFFF"])
    func readableIdentity(hex: String) throws {
        let raw = try #require(ReloReadableColor(hex: hex))
        #expect(raw.readable(onLight: true).contrast(with: .init(red: 1, green: 1, blue: 1)) >= 4.5)
        #expect(raw.readable(onLight: false).contrast(with: .init(red: 0, green: 0, blue: 0)) >= 4.5)
    }
    @Test func filledActionPair() {
        let fill = ReloReadableColor(red: 0.04, green: 0.43, blue: 0.34)
        #expect(fill.contrast(with: .init(red: 1, green: 1, blue: 1)) >= 4.5)
        // Actual native dark grouped cell is #1C1C1E. The adaptive tint stays readable there.
        let tint = ReloReadableColor(red: 0.37, green: 0.85, blue: 0.72)
        #expect(tint.contrast(with: .init(red: 28.0/255, green: 28.0/255, blue: 30.0/255)) >= 4.5)
    }
    @Test("Secondary and error reading roles meet contrast on grouped surfaces") func readingRoles() {
        let lightText = ReloReadableColor(red: 0.37, green: 0.37, blue: 0.39)
        let darkText = ReloReadableColor(red: 0.70, green: 0.70, blue: 0.72)
        let lightError = ReloReadableColor(red: 0.70, green: 0.14, blue: 0.09)
        let darkError = ReloReadableColor(red: 1, green: 0.56, blue: 0.54)
        for background in [ReloReadableColor(red: 1, green: 1, blue: 1),
                           .init(red: 242.0/255, green: 242.0/255, blue: 247.0/255)] {
            #expect(lightText.contrast(with: background) >= 4.5)
            #expect(lightError.contrast(with: background) >= 4.5)
        }
        for background in [ReloReadableColor(red: 0, green: 0, blue: 0),
                           .init(red: 28.0/255, green: 28.0/255, blue: 30.0/255)] {
            #expect(darkText.contrast(with: background) >= 4.5)
            #expect(darkError.contrast(with: background) >= 4.5)
        }
    }

}
