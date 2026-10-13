import SwiftUI
import WidgetKit

@main
struct ReloLiveActivityBundle: WidgetBundle {
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
