import Foundation
import ReloCore
import Testing

// SwiftPM builds the shared activity sources as ReloActivityWire; Xcode compiles them into the app.
#if canImport(ReloActivityWire)
@testable import ReloActivityWire
#else
@testable import Relo
#endif

#if DEBUG
    @Suite("Native Live Activity regression fixtures")
    struct LiveActivityReferenceFixtureTests {
        @Test(
            "Every native fixture round-trips through the real wire decoder",
            arguments: ReloLiveActivityReferenceFixtures.names)
        func validWire(name: String) throws {
            let state = try #require(ReloLiveActivityReferenceFixtures.state(named: name))
            let encoded = try JSONEncoder().encode(state)
            let decoded = try JSONDecoder().decode(ReloActivityAttributes.ContentState.self, from: encoded)
            #expect(decoded.presentation == state.presentation)
            #expect(encoded.count < 4_096)
        }

        @Test("Worst-case fixture actually reaches contract text limits")
        func maximumText() throws {
            let p = try #require(ReloLiveActivityReferenceFixtures.state(named: "max-text")).presentation
            #expect(p.title.count == 80)
            #expect(p.subtitle?.count == 120)
            #expect(p.status.count == 80)
        }

        @Test("Many-component fixture reaches the eight-component limit")
        func maximumComponents() throws {
            let p = try #require(ReloLiveActivityReferenceFixtures.state(named: "many-components"))
                .presentation
            #expect(p.components.count == 8)
        }
    }
#endif
