import ReloCore
import ReloNotificationSupport
import SwiftUI
import WidgetKit

@main
struct ReloLiveActivityBundle: WidgetBundle {
    /// End-to-end sealed cards open on this phone while their state is decoded (E5).
    init() {
        ReloSealedCards.install(ReloSealedContent.live().cardOpener)
    }

    /// Exactly one activity configuration per OS. The builder has an `if #available` but no
    /// `else`, so both branches are composed here; registering both would duplicate the card.
    var body: some Widget {
        WidgetBundleBuilder.buildBlock(
            WidgetBundleBuilder.buildOptional(watchCapable),
            WidgetBundleBuilder.buildOptional(phoneOnly))
    }

    private var watchCapable: (any Widget & _LimitedAvailabilityWidgetMarker)? {
        guard #available(iOS 18.0, *) else { return nil }
        return WidgetBundleBuilder.buildLimitedAvailability(ReloLiveActivityWatchWidget())
    }

    private var phoneOnly: (any Widget & _LimitedAvailabilityWidgetMarker)? {
        if #available(iOS 18.0, *) { return nil }
        return WidgetBundleBuilder.buildLimitedAvailability(ReloLiveActivityWidget())
    }
}
