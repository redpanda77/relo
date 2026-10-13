#if DEBUG
    import WidgetKit

    // These fixed names are wire-round-trip tested. Previews are layout tools, not
    // evidence that the system's alert banner, camera mask, or hit regions passed.
    #Preview("Lock Screen states", as: .content, using: ReloLiveActivityReferenceFixtures.attributes) {
        ReloLiveActivityWidget()
    } contentStates: {
        ReloLiveActivityReferenceFixtures.state(named: "decision-with-progress")!
        ReloLiveActivityReferenceFixtures.state(named: "max-text")!
        ReloLiveActivityReferenceFixtures.state(named: "many-components")!
        ReloLiveActivityReferenceFixtures.state(named: "response-denied")!
        ReloLiveActivityReferenceFixtures.state(named: "stale-progress")!
    }

    #Preview(
        "Expanded states", as: .dynamicIsland(.expanded),
        using: ReloLiveActivityReferenceFixtures.attributes
    ) {
        ReloLiveActivityWidget()
    } contentStates: {
        ReloLiveActivityReferenceFixtures.state(named: "decision-with-progress")!
        ReloLiveActivityReferenceFixtures.state(named: "max-text")!
        ReloLiveActivityReferenceFixtures.state(named: "response-denied")!
    }

    #Preview(
        "Compact states", as: .dynamicIsland(.compact),
        using: ReloLiveActivityReferenceFixtures.attributes
    ) {
        ReloLiveActivityWidget()
    } contentStates: {
        ReloLiveActivityReferenceFixtures.state(named: "decision-with-progress")!
        ReloLiveActivityReferenceFixtures.state(named: "full-progress")!
        ReloLiveActivityReferenceFixtures.state(named: "stale-progress")!
    }

    #Preview(
        "Minimal states", as: .dynamicIsland(.minimal),
        using: ReloLiveActivityReferenceFixtures.attributes
    ) {
        ReloLiveActivityWidget()
    } contentStates: {
        ReloLiveActivityReferenceFixtures.state(named: "decision-with-progress")!
        ReloLiveActivityReferenceFixtures.state(named: "full-progress")!
        ReloLiveActivityReferenceFixtures.state(named: "stale-progress")!
    }
#endif
